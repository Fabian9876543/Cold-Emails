import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { idParam, notFound, parseBody, parseQuery, sendCsv } from "../lib/http";
import { addSuppression, stopLeadEverywhere } from "../leads/repo";
import { runInboxPoll } from "../worker/inboxPoller";
import type { InboundDto, Paged, ReplyCategory } from "../../shared/types";

const CATEGORIES = ["interessiert", "spaeter", "kein_interesse", "abmelden", "falsche_person", "abwesend", "frage", "sonstiges"] as const;

interface InboundRow {
  id: number;
  kind: InboundDto["kind"];
  category: string | null;
  summary: string | null;
  return_date: string | null;
  from_email: string;
  subject: string;
  snippet: string;
  received_at: number;
  handled: number;
  campaign_id: number | null;
  campaign_name: string | null;
  lead_id: number | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  mailbox_email: string | null;
  auth_type: string | null;
  message_id: string | null;
}

export function gmailLink(mailboxEmail: string | null, authType: string | null, messageId: string | null): string | null {
  if (!mailboxEmail || !messageId || authType === "smtp") return null;
  const id = messageId.replace(/^<|>$/g, "");
  return `https://mail.google.com/mail/u/${encodeURIComponent(mailboxEmail)}/#search/rfc822msgid%3A${encodeURIComponent(id)}`;
}

function toDto(r: InboundRow): InboundDto {
  const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
  return {
    id: r.id,
    kind: r.kind,
    category: (r.category as ReplyCategory | null) ?? null,
    summary: r.summary,
    returnDate: r.return_date,
    fromEmail: r.from_email,
    subject: r.subject,
    snippet: r.snippet,
    receivedAt: r.received_at,
    handled: !!r.handled,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    leadId: r.lead_id,
    leadName: name || null,
    company: r.company || null,
    mailboxEmail: r.mailbox_email,
    gmailLink: gmailLink(r.mailbox_email, r.auth_type, r.message_id),
  };
}

const SELECT = `SELECT i.*, c.name AS campaign_name, l.first_name, l.last_name, l.company, m.email AS mailbox_email, m.auth_type
  FROM inbound i LEFT JOIN campaigns c ON c.id = i.campaign_id LEFT JOIN leads l ON l.id = i.lead_id LEFT JOIN mailboxes m ON m.id = i.mailbox_id`;

const listQuery = z.object({
  kind: z.string().optional(),
  category: z.string().optional(),
  handled: z.enum(["0", "1"]).optional(),
  campaignId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(30),
});

function filter(q: z.infer<typeof listQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.kind) {
    const kinds = q.kind.split(",");
    where.push(`i.kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  if (q.category) {
    where.push("i.category = ?");
    params.push(q.category);
  }
  if (q.handled) {
    where.push("i.handled = ?");
    params.push(Number(q.handled));
  }
  if (q.campaignId) {
    where.push("i.campaign_id = ?");
    params.push(q.campaignId);
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function registerInboxRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/inbox", async (request): Promise<Paged<InboundDto>> => {
    const q = parseQuery(listQuery, request);
    const { where, params } = filter(q);
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM inbound i ${where}`).get(...params) as { n: number }).n;
    const rows = ctx.db.prepare(`${SELECT} ${where} ORDER BY i.received_at DESC, i.id DESC LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as InboundRow[];
    return { items: rows.map(toDto), total, page: q.page, pageSize: q.pageSize };
  });

  app.patch("/api/inbox/:id", async (request): Promise<InboundDto> => {
    const id = idParam(request);
    const body = parseBody(z.object({ handled: z.boolean().optional(), category: z.enum(CATEGORIES).nullable().optional() }), request);
    const res = ctx.db
      .prepare("UPDATE inbound SET handled = COALESCE(?, handled), category = CASE WHEN ? THEN ? ELSE category END WHERE id = ?")
      .run(body.handled === undefined ? null : body.handled ? 1 : 0, body.category !== undefined ? 1 : 0, body.category ?? null, id);
    if (res.changes === 0) throw notFound("Antwort");
    return toDto(ctx.db.prepare(`${SELECT} WHERE i.id = ?`).get(id) as InboundRow);
  });

  /** Kontakt aus einer Antwort heraus manuell abmelden (z. B. „bitte nicht mehr schreiben“). */
  app.post("/api/inbox/:id/unsubscribe", async (request): Promise<InboundDto> => {
    const id = idParam(request);
    const row = ctx.db.prepare("SELECT lead_id, from_email FROM inbound WHERE id = ?").get(id) as { lead_id: number | null; from_email: string } | undefined;
    if (!row) throw notFound("Antwort");
    const now = ctx.clock.now();
    ctx.db.transaction(() => {
      const lead = row.lead_id ? (ctx.db.prepare("SELECT email FROM leads WHERE id = ?").get(row.lead_id) as { email: string } | undefined) : undefined;
      addSuppression(ctx.db, now, lead?.email ?? row.from_email, "unsubscribe", "Manuell aus Antwort abgemeldet");
      if (row.lead_id) {
        ctx.db.prepare("UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE id = ? AND status = 'active'").run(now, row.lead_id);
        stopLeadEverywhere(ctx.db, row.lead_id, "unsubscribed", "Manuell abgemeldet.");
      }
      ctx.db.prepare("UPDATE inbound SET category = 'abmelden', handled = 1 WHERE id = ?").run(id);
    })();
    return toDto(ctx.db.prepare(`${SELECT} WHERE i.id = ?`).get(id) as InboundRow);
  });

  app.post("/api/inbox/poll", async () => runInboxPoll(ctx, { force: true }));

  app.get("/api/inbox/export.csv", async (request, reply) => {
    const q = parseQuery(listQuery, request);
    const { where, params } = filter(q);
    const rows = (ctx.db.prepare(`${SELECT} ${where} ORDER BY i.received_at DESC`).all(...params) as InboundRow[]).map(toDto);
    return sendCsv(reply, "antworten.csv", [
      ["Datum", "Art", "Kategorie", "Name", "Firma", "E-Mail", "Kampagne", "Betreff", "Zusammenfassung", "Text"],
      ...rows.map((r) => [new Date(r.receivedAt).toISOString(), r.kind, r.category ?? "", r.leadName ?? "", r.company ?? "", r.fromEmail, r.campaignName ?? "", r.subject, r.summary ?? "", r.snippet]),
    ]);
  });
}
