import type { FastifyInstance } from "fastify";
import { IANAZone } from "luxon";
import { z } from "zod";
import type { AppContext } from "../context";
import { listEvents, logEvent } from "../lib/events";
import { badRequest, HttpError, idParam, notFound, parseBody, parseQuery } from "../lib/http";
import { getSettings } from "../lib/settings";
import { getLeadRow, type LeadRow } from "../leads/repo";
import { getMailboxRow, listMailboxRows, type MailboxRow } from "../mail/mailboxes";
import { explainConnectionError } from "../mail/explain";
import { buildOutgoing, newMessageId, renderStep, SAMPLE_LEAD } from "../campaigns/compose";
import { runPreflight } from "../campaigns/preflight";
import {
  getCampaignLeadRow,
  getCampaignMailboxIds,
  getCampaignRow,
  getSteps,
  toCampaignDto,
  toCampaignLeadDto,
  type CampaignLeadRow,
  type CampaignRow,
} from "../campaigns/repo";
import { usesPlaceholder } from "../../shared/template";
import { isValidEmailSyntax, normalizeEmail } from "../../shared/emailCheck";
import type { CampaignDto, CampaignLeadDto, Paged, PreflightDto, PreviewDto } from "../../shared/types";

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:MM");
const stepSchema = z.object({
  position: z.number().int().min(1).max(10),
  waitDays: z.number().int().min(0).max(90),
  subject: z.string().max(250),
  body: z.string().max(10_000),
});

const campaignFields = z.object({
  name: z.string().trim().min(1, "Bitte einen Namen angeben.").max(200),
  timezone: z.string(),
  sendDays: z.array(z.number().int().min(1).max(7)).min(1, "Mindestens ein Versandtag."),
  windowStart: hm,
  windowEnd: hm,
  formality: z.enum(["sie", "du"]),
  stopOnReplyAll: z.boolean(),
  skipRecentDays: z.number().int().min(0).max(365),
  optOutMode: z.enum(["text", "link", "none"]),
  aiEnabled: z.boolean(),
  aiContext: z.string().max(5000),
  aiUseWebsite: z.boolean(),
  aiAutoApprove: z.boolean(),
  steps: z.array(stepSchema).min(1).max(10),
  mailboxIds: z.array(z.number().int()).max(200),
  listIds: z.array(z.number().int()).max(200),
});

const updateSchema = campaignFields.partial();
const createSchema = campaignFields.partial().extend({ name: campaignFields.shape.name });

type CampaignInput = z.infer<typeof updateSchema>;

function normalizeSteps(steps: z.infer<typeof stepSchema>[]): z.infer<typeof stepSchema>[] {
  const sorted = [...steps].sort((a, b) => a.position - b.position).map((s, i) => ({ ...s, position: i + 1 }));
  return sorted.map((s) => ({ ...s, waitDays: s.position === 1 ? 0 : Math.max(1, s.waitDays) }));
}

function applyCampaignInput(ctx: AppContext, id: number, input: CampaignInput): void {
  const db = ctx.db;
  if (input.timezone !== undefined && !IANAZone.isValidZone(input.timezone)) throw badRequest("Unbekannte Zeitzone.");
  if (input.windowStart && input.windowEnd && input.windowEnd <= input.windowStart) throw badRequest("Das Versandfenster muss nach dem Start enden.");
  const set: [string, unknown][] = [];
  const add = (col: string, v: unknown) => v !== undefined && set.push([col, typeof v === "boolean" ? (v ? 1 : 0) : v]);
  add("name", input.name);
  add("timezone", input.timezone);
  add("send_days", input.sendDays ? [...new Set(input.sendDays)].sort().join(",") : undefined);
  add("window_start", input.windowStart);
  add("window_end", input.windowEnd);
  add("formality", input.formality);
  add("stop_on_reply_all", input.stopOnReplyAll);
  add("skip_recent_days", input.skipRecentDays);
  add("opt_out_mode", input.optOutMode);
  add("ai_enabled", input.aiEnabled);
  add("ai_context", input.aiContext);
  add("ai_use_website", input.aiUseWebsite);
  add("ai_auto_approve", input.aiAutoApprove);
  set.push(["updated_at", ctx.clock.now()]);
  db.prepare(`UPDATE campaigns SET ${set.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...set.map(([, v]) => v), id);

  if (input.steps) {
    const steps = normalizeSteps(input.steps);
    db.prepare("DELETE FROM campaign_steps WHERE campaign_id = ?").run(id);
    const ins = db.prepare("INSERT INTO campaign_steps (campaign_id, position, wait_days, subject, body) VALUES (?, ?, ?, ?, ?)");
    for (const s of steps) ins.run(id, s.position, s.waitDays, s.subject.trim(), s.body.replace(/\r\n/g, "\n"));
  }
  if (input.mailboxIds) {
    db.prepare("DELETE FROM campaign_mailboxes WHERE campaign_id = ?").run(id);
    const ins = db.prepare("INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) SELECT ?, id FROM mailboxes WHERE id = ?");
    for (const m of input.mailboxIds) ins.run(id, m);
  }
  if (input.listIds?.length) addLeads(ctx, id, { listIds: input.listIds });
}

/** Fügt Kontakte hinzu (nur aktive, nicht gesperrte, noch nicht enthaltene). */
export function addLeads(ctx: AppContext, campaignId: number, src: { listIds?: number[]; leadIds?: number[] }): { added: number; skipped: number } {
  const c = getCampaignRow(ctx.db, campaignId);
  if (!c) throw notFound("Kampagne");
  const ids = new Set<number>();
  if (src.listIds?.length) {
    const rows = ctx.db
      .prepare(`SELECT DISTINCT lead_id FROM lead_list_members WHERE list_id IN (${src.listIds.map(() => "?").join(",")})`)
      .all(...src.listIds) as { lead_id: number }[];
    rows.forEach((r) => ids.add(r.lead_id));
  }
  src.leadIds?.forEach((id) => ids.add(id));
  const now = ctx.clock.now();
  const aiStatus = c.ai_enabled && c.status !== "draft" ? "pending" : "none";
  const insert = ctx.db.prepare(
    `INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, status, ai_status, created_at)
     SELECT ?, l.id, 'queued', ?, ? FROM leads l
     WHERE l.id = ? AND l.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE (s.type = 'email' AND s.value = l.email)
                         OR (s.type = 'domain' AND s.value = substr(l.email, instr(l.email, '@') + 1)))`,
  );
  let added = 0;
  ctx.db.transaction(() => {
    for (const id of ids) added += insert.run(campaignId, aiStatus, now, id).changes;
    if (added > 0 && c.status === "completed") {
      ctx.db.prepare("UPDATE campaigns SET status = 'active', completed_at = NULL, updated_at = ? WHERE id = ?").run(now, campaignId);
    }
  })();
  return { added, skipped: ids.size - added };
}

function requireCampaign(ctx: AppContext, id: number): CampaignRow {
  const c = getCampaignRow(ctx.db, id);
  if (!c) throw notFound("Kampagne");
  return c;
}

/** Vorschau-Postfach, falls noch keins verbunden ist. */
function sampleMailbox(ctx: AppContext): MailboxRow {
  const s = getSettings(ctx.db);
  return {
    id: 0, email: "max@ihre-firma.de", from_name: "Max Mustermann", auth_type: "smtp", smtp_host: "", smtp_port: 0, smtp_security: "ssl",
    imap_host: "", imap_port: 0, imap_security: "ssl", username: "", secret_enc: "", daily_limit: 30, warmup_enabled: 0, warmup_start: 5,
    warmup_step: 2, warmup_started_at: 0, signature: ["Max Mustermann", s.companyName].filter(Boolean).join("\n"), status: "active", last_error: null,
    last_error_at: null, consecutive_failures: 0, paused_until: null, next_available_at: 0, imap_enabled: 0, imap_uidvalidity: null,
    imap_last_uid: 0, imap_last_poll_at: null, imap_error: null, created_at: 0,
  };
}

const previewSchema = z.object({
  campaignId: z.number().int().nullable().optional(),
  steps: z.array(stepSchema).min(1).max(10),
  position: z.number().int().min(1).max(10),
  leadId: z.number().int().nullable().optional(),
  mailboxId: z.number().int().nullable().optional(),
  optOutMode: z.enum(["text", "link", "none"]).default("text"),
  formality: z.enum(["sie", "du"]).default("sie"),
});

export function registerCampaignRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/campaigns", async (): Promise<CampaignDto[]> => {
    const rows = ctx.db.prepare("SELECT * FROM campaigns ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, updated_at DESC").all() as CampaignRow[];
    return rows.map((r) => toCampaignDto(ctx.db, r));
  });

  app.post("/api/campaigns", async (request): Promise<CampaignDto> => {
    const body = parseBody(createSchema, request);
    const now = ctx.clock.now();
    const tz = getSettings(ctx.db).timezone;
    const id = ctx.db.transaction(() => {
      const res = ctx.db.prepare("INSERT INTO campaigns (name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?)").run(body.name.trim(), tz, now, now);
      const newId = Number(res.lastInsertRowid);
      applyCampaignInput(ctx, newId, { steps: [{ position: 1, waitDays: 0, subject: "", body: "" }], ...body });
      if (!body.mailboxIds) {
        // Standard: alle aktiven Postfächer
        ctx.db.prepare("INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) SELECT ?, id FROM mailboxes WHERE status = 'active'").run(newId);
      }
      return newId;
    })();
    logEvent(ctx.db, now, "info", "campaign.created", `Kampagne „${body.name}“ angelegt.`, { campaignId: id });
    return toCampaignDto(ctx.db, getCampaignRow(ctx.db, id)!);
  });

  app.get("/api/campaigns/:id", async (request): Promise<CampaignDto> => toCampaignDto(ctx.db, requireCampaign(ctx, idParam(request))));

  app.put("/api/campaigns/:id", async (request): Promise<CampaignDto> => {
    const id = idParam(request);
    const c = requireCampaign(ctx, id);
    const body = parseBody(updateSchema, request);
    ctx.db.transaction(() => applyCampaignInput(ctx, id, body))();
    // KI wurde für eine laufende Kampagne eingeschaltet → Einstiege anstoßen
    if (body.aiEnabled && !c.ai_enabled && c.status !== "draft") {
      ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'pending' WHERE campaign_id = ? AND ai_status = 'none' AND status IN ('queued','active')").run(id);
    }
    return toCampaignDto(ctx.db, getCampaignRow(ctx.db, id)!);
  });

  app.delete("/api/campaigns/:id", async (request) => {
    const id = idParam(request);
    const c = requireCampaign(ctx, id);
    ctx.db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
    logEvent(ctx.db, ctx.clock.now(), "info", "campaign.deleted", `Kampagne „${c.name}“ gelöscht.`);
    return { ok: true };
  });

  app.post("/api/campaigns/:id/duplicate", async (request): Promise<CampaignDto> => {
    const id = idParam(request);
    const c = requireCampaign(ctx, id);
    const now = ctx.clock.now();
    const newId = ctx.db.transaction(() => {
      const res = ctx.db
        .prepare(
          `INSERT INTO campaigns (name, timezone, send_days, window_start, window_end, formality, stop_on_reply_all, skip_recent_days, opt_out_mode,
             ai_enabled, ai_context, ai_use_website, ai_auto_approve, created_at, updated_at)
           SELECT ?, timezone, send_days, window_start, window_end, formality, stop_on_reply_all, skip_recent_days, opt_out_mode,
             ai_enabled, ai_context, ai_use_website, ai_auto_approve, ?, ? FROM campaigns WHERE id = ?`,
        )
        .run(`${c.name} (Kopie)`, now, now, id);
      const nid = Number(res.lastInsertRowid);
      ctx.db.prepare("INSERT INTO campaign_steps (campaign_id, position, wait_days, subject, body) SELECT ?, position, wait_days, subject, body FROM campaign_steps WHERE campaign_id = ?").run(nid, id);
      ctx.db.prepare("INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) SELECT ?, mailbox_id FROM campaign_mailboxes WHERE campaign_id = ?").run(nid, id);
      return nid;
    })();
    return toCampaignDto(ctx.db, getCampaignRow(ctx.db, newId)!);
  });

  // --- Kontakte der Kampagne ---
  app.get("/api/campaigns/:id/leads", async (request): Promise<Paged<CampaignLeadDto>> => {
    const id = idParam(request);
    requireCampaign(ctx, id);
    const q = parseQuery(
      z.object({
        status: z.string().optional(),
        ai: z.string().optional(),
        q: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(50),
      }),
      request,
    );
    const where = ["cl.campaign_id = ?"];
    const params: unknown[] = [id];
    if (q.status) {
      where.push(`cl.status IN (${q.status.split(",").map(() => "?").join(",")})`);
      params.push(...q.status.split(","));
    }
    if (q.ai) {
      where.push(`cl.ai_status IN (${q.ai.split(",").map(() => "?").join(",")})`);
      params.push(...q.ai.split(","));
    }
    if (q.q?.trim()) {
      const like = `%${q.q.trim()}%`;
      where.push("(l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ? OR l.company LIKE ?)");
      params.push(like, like, like, like);
    }
    const sqlWhere = where.join(" AND ");
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE ${sqlWhere}`).get(...params) as { n: number }).n;
    const rows = ctx.db
      .prepare(
        `SELECT cl.*, l.email, l.first_name, l.last_name, l.company, l.website, m.email AS mailbox_email
         FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN mailboxes m ON m.id = cl.mailbox_id
         WHERE ${sqlWhere} ORDER BY cl.id LIMIT ? OFFSET ?`,
      )
      .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Parameters<typeof toCampaignLeadDto>[0][];
    return { items: rows.map(toCampaignLeadDto), total, page: q.page, pageSize: q.pageSize };
  });

  app.post("/api/campaigns/:id/leads", async (request) => {
    const id = idParam(request);
    const body = parseBody(z.object({ listIds: z.array(z.number().int()).optional(), leadIds: z.array(z.number().int()).optional() }), request);
    return addLeads(ctx, id, body);
  });

  app.post("/api/campaigns/:id/leads/remove", async (request) => {
    const id = idParam(request);
    const { ids } = parseBody(z.object({ ids: z.array(z.number().int()).min(1).max(10_000) }), request);
    const del = ctx.db.prepare("DELETE FROM campaign_leads WHERE id = ? AND campaign_id = ?");
    let removed = 0;
    ctx.db.transaction(() => ids.forEach((x) => (removed += del.run(x, id).changes)))();
    return { removed };
  });

  app.post("/api/campaigns/:id/leads/requeue", async (request) => {
    const id = idParam(request);
    const { ids } = parseBody(z.object({ ids: z.array(z.number().int()).min(1).max(10_000) }), request);
    const upd = ctx.db.prepare(
      `UPDATE campaign_leads SET status = CASE WHEN last_sent_at IS NULL THEN 'queued' ELSE 'active' END, status_reason = NULL,
         attempts = 0, next_send_at = NULL WHERE id = ? AND campaign_id = ? AND status IN ('error','skipped')`,
    );
    let n = 0;
    ctx.db.transaction(() => ids.forEach((x) => (n += upd.run(x, id).changes)))();
    return { requeued: n };
  });

  // --- Vorschau, Testmail, Prüfung, Start ---
  app.post("/api/campaigns/preview", async (request): Promise<PreviewDto> => {
    const body = parseBody(previewSchema, request);
    const steps = normalizeSteps(body.steps);
    const step = steps.find((s) => s.position === body.position) ?? steps[0]!;
    let lead: LeadRow | undefined;
    let cl: CampaignLeadRow | undefined;
    if (body.leadId) lead = getLeadRow(ctx.db, body.leadId);
    if (body.campaignId) {
      if (lead) cl = ctx.db.prepare("SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?").get(body.campaignId, lead.id) as CampaignLeadRow | undefined;
      else {
        cl = ctx.db.prepare("SELECT * FROM campaign_leads WHERE campaign_id = ? ORDER BY CASE WHEN status IN ('queued','active') THEN 0 ELSE 1 END, id LIMIT 1").get(body.campaignId) as CampaignLeadRow | undefined;
        if (cl) lead = getLeadRow(ctx.db, cl.lead_id);
      }
    }
    const usedLead = lead ?? SAMPLE_LEAD;
    let mailbox: MailboxRow | undefined;
    if (body.mailboxId) mailbox = getMailboxRow(ctx.db, body.mailboxId);
    if (!mailbox && cl?.mailbox_id) mailbox = getMailboxRow(ctx.db, cl.mailbox_id);
    if (!mailbox && body.campaignId) {
      const ids = getCampaignMailboxIds(ctx.db, body.campaignId);
      if (ids[0]) mailbox = getMailboxRow(ctx.db, ids[0]);
    }
    mailbox ??= listMailboxRows(ctx.db)[0] ?? sampleMailbox(ctx);
    const usesAi = steps.some((s) => usesPlaceholder(s.body, "ki_einstieg") || usesPlaceholder(s.subject, "ki_einstieg"));
    const opener = cl?.ai_opener && ["done", "approved"].includes(cl.ai_status) ? cl.ai_opener : usesAi ? `[Hier steht der persönliche KI-Einstieg für ${usedLead.first_name || usedLead.company || "diesen Kontakt"}]` : null;
    const r = renderStep(step, {
      campaign: { opt_out_mode: body.optOutMode, formality: body.formality },
      lead: usedLead,
      mailbox,
      campaignLead: { id: cl?.id ?? 0, ai_opener: opener, ai_status: "approved", thread_subject: cl?.thread_subject ?? null },
      settings: getSettings(ctx.db),
      publicBaseUrl: ctx.config.publicBaseUrl,
      secrets: ctx.secrets,
      firstStepSubject: steps[0]?.subject ?? "",
    });
    const leadName = `${usedLead.first_name} ${usedLead.last_name}`.trim();
    return {
      leadId: lead?.id ?? null,
      leadLabel: lead ? `${leadName || lead.email}${lead.company ? ` (${lead.company})` : ""}` : "Beispielkontakt",
      from: `${mailbox.from_name} <${mailbox.email}>`,
      to: leadName ? `${leadName} <${usedLead.email}>` : usedLead.email,
      subject: r.subject,
      body: r.body,
      missing: r.missing,
    };
  });

  app.post("/api/campaigns/:id/test-email", async (request) => {
    const id = idParam(request);
    const c = requireCampaign(ctx, id);
    const body = parseBody(z.object({ position: z.number().int().min(1).default(1), leadId: z.number().int().optional(), to: z.string().optional() }), request);
    const steps = getSteps(ctx.db, id);
    const step = steps.find((s) => s.position === body.position);
    if (!step) throw badRequest("Diese E-Mail gibt es nicht.");
    const mailboxes = getCampaignMailboxIds(ctx.db, id).map((m) => getMailboxRow(ctx.db, m)).filter((m): m is MailboxRow => !!m);
    const mailbox = mailboxes.find((m) => m.status === "active") ?? mailboxes[0];
    if (!mailbox) throw badRequest("Bitte zuerst ein Absender-Postfach auswählen.");
    let lead: LeadRow | undefined = body.leadId ? getLeadRow(ctx.db, body.leadId) : undefined;
    let cl: CampaignLeadRow | undefined;
    if (!lead) {
      cl = ctx.db.prepare("SELECT * FROM campaign_leads WHERE campaign_id = ? ORDER BY id LIMIT 1").get(id) as CampaignLeadRow | undefined;
      if (cl) lead = getLeadRow(ctx.db, cl.lead_id);
    } else {
      cl = ctx.db.prepare("SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?").get(id, lead.id) as CampaignLeadRow | undefined;
    }
    const usedLead = lead ?? SAMPLE_LEAD;
    const r = renderStep(step, {
      campaign: c,
      lead: usedLead,
      mailbox,
      campaignLead: cl ? { ...cl, ai_opener: cl.ai_opener ?? "[KI-Einstieg]", ai_status: "approved" } : { id: 0, ai_opener: "[KI-Einstieg]", ai_status: "approved", thread_subject: null },
      settings: getSettings(ctx.db),
      publicBaseUrl: ctx.config.publicBaseUrl,
      secrets: ctx.secrets,
      firstStepSubject: steps[0]?.subject ?? "",
    });
    const to = normalizeEmail(body.to || mailbox.email);
    if (!isValidEmailSyntax(to)) throw badRequest("Ungültige Empfängeradresse.");
    const now = ctx.clock.now();
    const messageId = newMessageId(mailbox);
    try {
      await ctx.mail.send(
        mailbox,
        buildOutgoing({ mailbox, lead: { email: to, first_name: "", last_name: "" }, subject: `[TEST] ${r.subject}`, body: r.body, messageId, oneClickUrl: null, now }),
      );
    } catch (err) {
      throw badRequest(explainConnectionError(err, "SMTP", mailbox.auth_type));
    }
    ctx.db
      .prepare("INSERT INTO messages (mailbox_id, campaign_id, to_email, message_id, subject, body, status, is_test, step, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', 1, ?, ?, ?)")
      .run(mailbox.id, id, to, messageId, `[TEST] ${r.subject}`, r.body, step.position, now, now);
    return { ok: true, to, missing: r.missing };
  });

  app.get("/api/campaigns/:id/preflight", async (request): Promise<PreflightDto> => {
    const id = idParam(request);
    const { ignoreDns } = parseQuery(z.object({ ignoreDns: z.enum(["0", "1"]).optional() }), request);
    return runPreflight(ctx, requireCampaign(ctx, id), { ignoreDns: ignoreDns === "1" });
  });

  const start = async (id: number, ignoreDns: boolean, verb: "gestartet" | "fortgesetzt") => {
    const c = requireCampaign(ctx, id);
    const preflight = await runPreflight(ctx, c, { ignoreDns });
    if (!preflight.ok) return { ok: false, preflight };
    const now = ctx.clock.now();
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE campaigns SET status = 'active', pause_reason = NULL, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?").run(now, now, id);
      if (c.ai_enabled) {
        ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'pending' WHERE campaign_id = ? AND ai_status = 'none' AND status IN ('queued','active')").run(id);
      }
    })();
    logEvent(ctx.db, now, "info", "campaign.started", `Kampagne „${c.name}“ ${verb}.`, { campaignId: id });
    return { ok: true, preflight, campaign: toCampaignDto(ctx.db, getCampaignRow(ctx.db, id)!) };
  };

  app.post("/api/campaigns/:id/start", async (request) => {
    const { ignoreDns } = parseBody(z.object({ ignoreDns: z.boolean().optional() }), request);
    return start(idParam(request), ignoreDns ?? false, "gestartet");
  });

  app.post("/api/campaigns/:id/resume", async (request) => {
    const { ignoreDns } = parseBody(z.object({ ignoreDns: z.boolean().optional() }), request);
    return start(idParam(request), ignoreDns ?? false, "fortgesetzt");
  });

  app.post("/api/campaigns/:id/pause", async (request): Promise<CampaignDto> => {
    const id = idParam(request);
    const c = requireCampaign(ctx, id);
    if (c.status !== "active") throw new HttpError(409, "Die Kampagne läuft gerade nicht.");
    const now = ctx.clock.now();
    ctx.db.prepare("UPDATE campaigns SET status = 'paused', pause_reason = 'Manuell pausiert.', updated_at = ? WHERE id = ?").run(now, id);
    logEvent(ctx.db, now, "info", "campaign.paused", `Kampagne „${c.name}“ pausiert.`, { campaignId: id });
    return toCampaignDto(ctx.db, getCampaignRow(ctx.db, id)!);
  });

  app.get("/api/campaigns/:id/events", async (request) => listEvents(ctx.db, { campaignId: idParam(request), limit: 100 }));

  app.get("/api/campaign-leads/:id", async (request) => {
    const row = getCampaignLeadRow(ctx.db, idParam(request));
    if (!row) throw notFound("Eintrag");
    const messages = ctx.db.prepare("SELECT id, step, subject, body, status, error, sent_at, created_at FROM messages WHERE campaign_lead_id = ? ORDER BY id").all(row.id);
    return { ...row, messages };
  });
}
