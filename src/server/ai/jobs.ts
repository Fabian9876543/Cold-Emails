import { DateTime } from "luxon";
import type { AppContext } from "../context";
import { logEvent } from "../lib/events";
import { addSuppression, getLeadRow, stopLeadEverywhere, type LeadRow } from "../leads/repo";
import { getCampaignLeadRow, getCampaignRow, getSteps, windowOf, type CampaignRow } from "../campaigns/repo";
import { nextWindowOpening } from "../worker/schedule";
import { AiError, jsonFormat, systemBlocks, toAiError } from "./call";
import { generateOpener, openerSystem, openerUser, validateOpener } from "./opener";
import { classifyReply } from "./replyClassifier";
import { OpenerSchema } from "./prompts";
import { recordUsage } from "./usage";

let pausedUntil = 0;
let lastAuthEvent = 0;
const lastBatchPoll = new Map<string, number>();

const OPENER_CONCURRENCY = 3;
const REPLY_CONCURRENCY = 3;
const BATCH_MAX_REQUESTS = 500;
const BATCH_POLL_MS = 60_000;

/** Nach einem Neustart: abgebrochene Einzel-Anfragen erneut einreihen. */
export function recoverInterruptedAi(ctx: AppContext): void {
  ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'pending' WHERE ai_status = 'generating' AND ai_batch_id IS NULL").run();
}

function pauseFor(ctx: AppContext, err: AiError): void {
  const now = ctx.clock.now();
  if (err.kind === "rate") pausedUntil = now + 60_000;
  if (err.kind === "auth" || err.kind === "not_configured") {
    pausedUntil = now + 10 * 60_000;
    if (now - lastAuthEvent > 60 * 60_000) {
      lastAuthEvent = now;
      logEvent(ctx.db, now, "error", "ai.auth", err.message);
    }
  }
}

const isRetryable = (e: AiError) => e.kind === "rate" || e.kind === "auth" || e.kind === "not_configured";

export async function runAiJobs(ctx: AppContext): Promise<void> {
  if (!ctx.ai.client()) return;
  if (ctx.clock.now() < pausedUntil) return;
  try {
    await pollBatches(ctx);
    await submitBatches(ctx);
    await processOpeners(ctx);
    await processReplies(ctx);
  } catch (err) {
    const e = toAiError(err, "");
    pauseFor(ctx, e);
    if (!isRetryable(e)) ctx.log.warn({ err }, "KI-Aufgabe fehlgeschlagen");
  }
}

function saveOpener(ctx: AppContext, id: number, campaign: CampaignRow, out: { einstieg: string; qualitaet: string; begruendung: string }): void {
  ctx.db
    .prepare("UPDATE campaign_leads SET ai_opener = ?, ai_quality = ?, ai_reason = ?, ai_error = NULL, ai_status = ?, ai_batch_id = NULL WHERE id = ?")
    .run(out.einstieg, out.qualitaet, out.begruendung, campaign.ai_auto_approve ? "approved" : "done", id);
}

function failOpener(ctx: AppContext, id: number, message: string): void {
  ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'error', ai_error = ?, ai_batch_id = NULL WHERE id = ?").run(message.slice(0, 500), id);
}

export async function processOpeners(ctx: AppContext, limit = OPENER_CONCURRENCY): Promise<number> {
  const rows = ctx.db
    .prepare(
      `SELECT cl.id, cl.lead_id, cl.campaign_id FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE cl.ai_status = 'pending' AND c.ai_enabled = 1 AND c.ai_batch = 0 AND c.status != 'completed' AND cl.status IN ('queued','active')
       ORDER BY cl.id LIMIT ?`,
    )
    .all(limit) as { id: number; lead_id: number; campaign_id: number }[];
  if (rows.length === 0) return 0;
  const mark = ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'generating' WHERE id = ?");
  rows.forEach((r) => mark.run(r.id));
  const results = await Promise.allSettled(
    rows.map(async (r) => {
      const campaign = getCampaignRow(ctx.db, r.campaign_id)!;
      const lead = getLeadRow(ctx.db, r.lead_id);
      if (!lead) return failOpener(ctx, r.id, "Kontakt nicht gefunden.");
      try {
        const out = await generateOpener(ctx, campaign, getSteps(ctx.db, campaign.id)[0], lead);
        saveOpener(ctx, r.id, campaign, out);
      } catch (err) {
        const e = toAiError(err, "");
        if (isRetryable(e)) {
          ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'pending' WHERE id = ?").run(r.id);
          throw e;
        }
        failOpener(ctx, r.id, e.message);
      }
    }),
  );
  const retryable = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (retryable) throw retryable.reason;
  return rows.length;
}

export async function processReplies(ctx: AppContext, limit = REPLY_CONCURRENCY): Promise<number> {
  const rows = ctx.db.prepare("SELECT * FROM inbound WHERE ai_status = 'pending' AND kind = 'reply' ORDER BY id LIMIT ?").all(limit) as {
    id: number;
    subject: string;
    snippet: string;
    lead_id: number | null;
    campaign_lead_id: number | null;
    from_email: string;
  }[];
  for (const r of rows) {
    let out;
    try {
      out = await classifyReply(ctx, r);
    } catch (err) {
      const e = toAiError(err, "");
      if (isRetryable(e)) throw e;
      ctx.db.prepare("UPDATE inbound SET ai_status = 'error' WHERE id = ?").run(r.id);
      continue;
    }
    const now = ctx.clock.now();
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE inbound SET category = ?, summary = ?, return_date = ?, ai_status = 'done' WHERE id = ?").run(out.kategorie, out.zusammenfassung, out.rueckkehr_datum, r.id);
      if (out.kategorie === "abmelden") {
        const lead = r.lead_id ? (getLeadRow(ctx.db, r.lead_id) as LeadRow | undefined) : undefined;
        addSuppression(ctx.db, now, lead?.email ?? r.from_email, "unsubscribe", "Abmeldung per Antwort (von der KI erkannt)");
        if (lead) {
          ctx.db.prepare("UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE id = ? AND status = 'active'").run(now, lead.id);
          stopLeadEverywhere(ctx.db, lead.id, "unsubscribed", "Hat um Abmeldung gebeten.");
          ctx.db.prepare("UPDATE campaign_leads SET status = 'unsubscribed' WHERE lead_id = ? AND status = 'replied'").run(lead.id);
        }
        ctx.db.prepare("UPDATE inbound SET handled = 1 WHERE id = ?").run(r.id);
      }
      if (out.kategorie === "abwesend") {
        // Abwesenheit ohne typische Kopfzeilen: Sequenz nach der Rückkehr fortsetzen
        ctx.db.prepare("UPDATE inbound SET kind = 'auto_reply', handled = 1 WHERE id = ?").run(r.id);
        const cl = r.campaign_lead_id ? getCampaignLeadRow(ctx.db, r.campaign_lead_id) : undefined;
        const campaign = cl ? getCampaignRow(ctx.db, cl.campaign_id) : undefined;
        if (cl && campaign && cl.status === "replied" && cl.status_reason === "Hat geantwortet." && cl.next_step <= getSteps(ctx.db, campaign.id).length) {
          const w = windowOf(campaign);
          const base = out.rueckkehr_datum ? DateTime.fromISO(out.rueckkehr_datum, { zone: w.timezone }).plus({ days: 1 }).toMillis() : now + 5 * 86_400_000;
          ctx.db.prepare("UPDATE campaign_leads SET status = 'active', status_reason = NULL, next_send_at = ? WHERE id = ?").run(nextWindowOpening(base, w) + Math.floor(ctx.random() * 3 * 3_600_000), cl.id);
        }
      }
    })();
  }
  return rows.length;
}

// --- Batch-Modus (50 % günstiger, Ergebnisse meist innerhalb einer Stunde) ---

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++] as T);
    }),
  );
}

export async function submitBatches(ctx: AppContext): Promise<void> {
  const client = ctx.ai.client();
  if (!client) return;
  const campaigns = ctx.db.prepare("SELECT * FROM campaigns WHERE ai_enabled = 1 AND ai_batch = 1 AND status != 'completed'").all() as CampaignRow[];
  for (const campaign of campaigns) {
    const rows = ctx.db
      .prepare("SELECT id, lead_id FROM campaign_leads WHERE campaign_id = ? AND ai_status = 'pending' AND status IN ('queued','active') ORDER BY id LIMIT ?")
      .all(campaign.id, BATCH_MAX_REQUESTS) as { id: number; lead_id: number }[];
    if (rows.length === 0) continue;
    const model = await ctx.ai.resolveModel();
    const step1 = getSteps(ctx.db, campaign.id)[0];
    const system = systemBlocks(openerSystem(campaign, step1));
    const { format } = jsonFormat(OpenerSchema);
    const requests: { custom_id: string; params: Record<string, unknown> }[] = [];
    await mapLimit(rows, 8, async (r) => {
      const lead = getLeadRow(ctx.db, r.lead_id);
      if (!lead) return failOpener(ctx, r.id, "Kontakt nicht gefunden.");
      requests.push({
        custom_id: `cl-${r.id}`,
        params: { model, max_tokens: 4000, system, messages: [{ role: "user", content: await openerUser(ctx, campaign, lead) }], output_config: { effort: "low", format } },
      });
    });
    if (requests.length === 0) continue;
    let batch;
    try {
      batch = await client.messages.batches.create({ requests: requests as never });
    } catch (err) {
      throw toAiError(err, model);
    }
    const now = ctx.clock.now();
    ctx.db.transaction(() => {
      ctx.db.prepare("INSERT INTO ai_batches (id, campaign_id, model, status, request_count, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(batch.id, campaign.id, model, batch.processing_status, requests.length, now);
      const upd = ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'generating', ai_batch_id = ? WHERE id = ?");
      for (const r of requests) upd.run(batch.id, Number(r.custom_id.slice(3)));
    })();
    logEvent(ctx.db, now, "info", "ai.batch", `${requests.length} KI-Einstiege als Batch beauftragt (Ergebnis meist innerhalb einer Stunde).`, { campaignId: campaign.id });
  }
}

export async function pollBatches(ctx: AppContext): Promise<void> {
  const client = ctx.ai.client();
  if (!client) return;
  const open = ctx.db.prepare("SELECT * FROM ai_batches WHERE status != 'ended' ORDER BY created_at").all() as { id: string; campaign_id: number; model: string }[];
  for (const b of open) {
    const now = ctx.clock.now();
    if (now - (lastBatchPoll.get(b.id) ?? 0) < BATCH_POLL_MS) continue;
    lastBatchPoll.set(b.id, now);
    let info;
    try {
      info = await client.messages.batches.retrieve(b.id);
    } catch (err) {
      throw toAiError(err, b.model);
    }
    if (info.processing_status !== "ended") {
      ctx.db.prepare("UPDATE ai_batches SET status = ? WHERE id = ?").run(info.processing_status, b.id);
      continue;
    }
    const campaign = getCampaignRow(ctx.db, b.campaign_id);
    const { parse } = jsonFormat(OpenerSchema);
    let ok = 0;
    for await (const r of await client.messages.batches.results(b.id)) {
      const id = Number(String(r.custom_id).replace(/^cl-/, ""));
      if (!campaign || !Number.isInteger(id)) continue;
      if (r.result.type !== "succeeded") {
        failOpener(ctx, id, r.result.type === "errored" ? "Die Anfrage ist fehlgeschlagen. Bitte neu erstellen." : "Die Anfrage wurde abgebrochen oder ist abgelaufen.");
        continue;
      }
      const message = r.result.message;
      await recordUsage(ctx, "opener", message.model ?? b.model, message.usage, true);
      if (message.stop_reason === "refusal") {
        failOpener(ctx, id, "Die KI hat diese Anfrage abgelehnt.");
        continue;
      }
      const text = message.content.find((c) => c.type === "text");
      try {
        const out = parse(text && "text" in text ? text.text : "");
        const problem = validateOpener(out.einstieg);
        if (problem) failOpener(ctx, id, `${problem} Bitte neu erstellen oder von Hand anpassen.`);
        else {
          saveOpener(ctx, id, campaign, { ...out, einstieg: out.einstieg.trim() });
          ok++;
        }
      } catch {
        failOpener(ctx, id, "Die Antwort der KI hatte ein unerwartetes Format.");
      }
    }
    ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'error', ai_error = 'Kein Ergebnis im Batch.', ai_batch_id = NULL WHERE ai_batch_id = ? AND ai_status = 'generating'").run(b.id);
    ctx.db.prepare("UPDATE ai_batches SET status = 'ended', ended_at = ? WHERE id = ?").run(ctx.clock.now(), b.id);
    logEvent(ctx.db, ctx.clock.now(), "info", "ai.batch_done", `Batch fertig: ${ok} KI-Einstiege erstellt.`, { campaignId: b.campaign_id });
  }
}

/** Nur für Tests: Pausen-Zustand zurücksetzen. */
export function resetAiJobState(): void {
  pausedUntil = 0;
  lastAuthEvent = 0;
  lastBatchPoll.clear();
}
