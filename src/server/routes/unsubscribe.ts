import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../context";
import { logEvent } from "../lib/events";
import { getSettings } from "../lib/settings";
import { addSuppression, getLeadRow, stopLeadEverywhere } from "../leads/repo";
import { getCampaignLeadRow } from "../campaigns/repo";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function page(reply: FastifyReply, status: number, title: string, body: string): FastifyReply {
  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: #f4f6f8; color: #1f2933; }
  @media (prefers-color-scheme: dark) { body { background: #16191d; color: #e4e7eb; } .card { background: #1f2329 !important; border-color: #2f353d !important; } }
  .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
  .card { background: #fff; border: 1px solid #e1e5ea; border-radius: 12px; padding: 32px; max-width: 460px; width: 100%; box-sizing: border-box; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { line-height: 1.55; margin: 0 0 16px; }
  button { background: #1c7ed6; color: #fff; border: 0; border-radius: 8px; padding: 12px 18px; font-size: 15px; cursor: pointer; width: 100%; }
  button:hover { background: #1971c2; }
  .muted { font-size: 13px; opacity: .7; margin: 16px 0 0; }
</style></head>
<body><div class="wrap"><div class="card">${body}</div></div></body></html>`;
  return reply.status(status).header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store").send(html);
}

/** Meldet einen Kontakt ab: Sperrliste, Status, alle offenen Sequenzen stoppen. */
export function unsubscribeCampaignLead(ctx: AppContext, campaignLeadId: number, source: string): { email: string; already: boolean } | null {
  const cl = getCampaignLeadRow(ctx.db, campaignLeadId);
  if (!cl) return null;
  const lead = getLeadRow(ctx.db, cl.lead_id);
  if (!lead) return null;
  const now = ctx.clock.now();
  const already = lead.status === "unsubscribed";
  ctx.db.transaction(() => {
    addSuppression(ctx.db, now, lead.email, "unsubscribe", source);
    if (lead.status === "active") ctx.db.prepare("UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE id = ?").run(now, lead.id);
    stopLeadEverywhere(ctx.db, lead.id, "unsubscribed", source);
    if (!already) {
      ctx.db
        .prepare(
          `INSERT INTO inbound (mailbox_id, campaign_id, campaign_lead_id, lead_id, kind, category, from_email, subject, snippet, handled, received_at, created_at)
           VALUES (?, ?, ?, ?, 'unsubscribe', 'abmelden', ?, ?, ?, 1, ?, ?)`,
        )
        .run(cl.mailbox_id, cl.campaign_id, cl.id, lead.id, lead.email, "Abmeldung", source, now, now);
    }
  })();
  if (!already) logEvent(ctx.db, now, "info", "lead.unsubscribed", `${lead.email} hat sich abgemeldet (${source}).`, { campaignId: cl.campaign_id });
  return { email: lead.email, already };
}

export function registerUnsubscribeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const resolve = (token: string): number | null => {
    const value = ctx.secrets.verifyToken(token);
    if (!value || !value.startsWith("c")) return null;
    const id = Number(value.slice(1));
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const sender = () => getSettings(ctx.db).companyName || "dem Absender";

  app.get("/u/:token", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const id = resolve(token);
    const cl = id ? getCampaignLeadRow(ctx.db, id) : undefined;
    const lead = cl ? getLeadRow(ctx.db, cl.lead_id) : undefined;
    if (!cl || !lead) {
      return page(reply, 404, "Link ungültig", `<h1>Dieser Link ist ungültig</h1><p>Bitte antworten Sie einfach auf die E-Mail mit „Abmelden“ – wir tragen Sie dann sofort aus.</p>`);
    }
    if (lead.status === "unsubscribed") {
      return page(reply, 200, "Bereits abgemeldet", `<h1>Sie sind bereits abgemeldet</h1><p>Sie erhalten keine weiteren E-Mails von ${escapeHtml(sender())}.</p>`);
    }
    // Bestätigung per Klick: automatische Link-Scanner (Virenschutz) sollen niemanden abmelden.
    return page(
      reply,
      200,
      "Abmelden",
      `<h1>Keine weiteren E-Mails?</h1><p>Möchten Sie keine weiteren E-Mails von ${escapeHtml(sender())} an <b>${escapeHtml(lead.email)}</b> erhalten?</p>
       <form method="post" action="/u/${escapeHtml(token)}"><button type="submit">Ja, abmelden</button></form>
       <p class="muted">Ihre Adresse wird sofort auf unsere Sperrliste gesetzt.</p>`,
    );
  });

  // Bestätigung aus dem Formular sowie Ein-Klick-Abmeldung nach RFC 8058 (z. B. Gmail-Schaltfläche "Abbestellen")
  app.post("/u/:token", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const id = resolve(token);
    const result = id ? unsubscribeCampaignLead(ctx, id, "Abmelde-Link") : null;
    if (!result) {
      return page(reply, 404, "Link ungültig", `<h1>Dieser Link ist ungültig</h1><p>Bitte antworten Sie einfach auf die E-Mail mit „Abmelden“.</p>`);
    }
    return page(reply, 200, "Abgemeldet", `<h1>Sie wurden abgemeldet</h1><p>Sie erhalten keine weiteren E-Mails von ${escapeHtml(sender())}. Entschuldigen Sie die Störung.</p>`);
  });
}
