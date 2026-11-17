import type { AppContext } from "../context";
import { logEvent } from "../lib/events";
import { addSuppression, getLeadRow, leadDisplayName, stopLeadEverywhere, type LeadRow } from "../leads/repo";
import { explainConnectionError } from "../mail/explain";
import { getMailboxRow, type MailboxRow } from "../mail/mailboxes";
import { checkCampaignHealth } from "../campaigns/health";
import { getCampaignLeadRow, getCampaignRow, windowOf, type CampaignLeadRow } from "../campaigns/repo";
import { analyzeInbound, type InboundAnalysis } from "./inboundClassify";
import { nextWindowOpening } from "./schedule";
import { DateTime } from "luxon";

const POLL_INTERVAL_MS = 3 * 60 * 1000;

/** Prüft alle Postfächer, deren letzter Abruf länger als 3 Minuten zurückliegt. */
export async function runInboxPoll(ctx: AppContext, opts: { force?: boolean } = {}): Promise<{ processed: number }> {
  const now = ctx.clock.now();
  const due = ctx.db
    .prepare("SELECT id FROM mailboxes WHERE imap_enabled = 1 AND (imap_last_poll_at IS NULL OR imap_last_poll_at <= ?) ORDER BY COALESCE(imap_last_poll_at, 0)")
    .all(opts.force ? now : now - POLL_INTERVAL_MS) as { id: number }[];
  let processed = 0;
  for (const { id } of due) {
    const mb = getMailboxRow(ctx.db, id);
    if (mb) processed += await pollMailbox(ctx, mb);
  }
  return { processed };
}

export async function pollMailbox(ctx: AppContext, mb: MailboxRow): Promise<number> {
  const now = ctx.clock.now();
  let result;
  try {
    result = await ctx.inbox.fetchNew(mb, { uidValidity: mb.imap_uidvalidity, lastUid: mb.imap_last_uid });
  } catch (err) {
    const message = explainConnectionError(err, "IMAP", mb.auth_type);
    if (!mb.imap_error) logEvent(ctx.db, now, "warn", "inbox.error", `Posteingang ${mb.email}: ${message}`, { mailboxId: mb.id });
    ctx.db.prepare("UPDATE mailboxes SET imap_error = ?, imap_last_poll_at = ? WHERE id = ?").run(message, now, mb.id);
    return 0;
  }
  let processed = 0;
  for (const m of result.messages) {
    try {
      if (await processInbound(ctx, mb, m.source)) processed++;
    } catch (err) {
      ctx.log.warn({ err }, `Mail ${m.uid} in ${mb.email} konnte nicht verarbeitet werden`);
    }
  }
  ctx.db
    .prepare("UPDATE mailboxes SET imap_uidvalidity = ?, imap_last_uid = ?, imap_last_poll_at = ?, imap_error = NULL WHERE id = ?")
    .run(result.uidValidity, result.lastUid, now, mb.id);
  return processed;
}

function findByMessageIds(ctx: AppContext, ids: string[]): CampaignLeadRow | undefined {
  if (ids.length === 0) return undefined;
  const row = ctx.db
    .prepare(`SELECT campaign_lead_id FROM messages WHERE message_id IN (${ids.map(() => "?").join(",")}) AND campaign_lead_id IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(...ids) as { campaign_lead_id: number } | undefined;
  return row ? getCampaignLeadRow(ctx.db, row.campaign_lead_id) : undefined;
}

function findLeadByEmail(ctx: AppContext, email: string): LeadRow | undefined {
  return ctx.db.prepare("SELECT * FROM leads WHERE email = ?").get(email) as LeadRow | undefined;
}

function latestCampaignLead(ctx: AppContext, leadId: number, mailboxId: number): CampaignLeadRow | undefined {
  return ctx.db
    .prepare("SELECT * FROM campaign_leads WHERE lead_id = ? ORDER BY CASE WHEN mailbox_id = ? THEN 0 ELSE 1 END, COALESCE(last_sent_at, 0) DESC, id DESC LIMIT 1")
    .get(leadId, mailboxId) as CampaignLeadRow | undefined;
}

function insertInbound(
  ctx: AppContext,
  mb: MailboxRow,
  a: InboundAnalysis,
  x: { kind: InboundAnalysis["kind"]; cl?: CampaignLeadRow; lead?: LeadRow; category?: string | null; handled: boolean; aiPending: boolean; snippet?: string },
): boolean {
  const now = ctx.clock.now();
  const res = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO inbound (mailbox_id, campaign_id, campaign_lead_id, lead_id, kind, category, return_date, from_email, subject, snippet, message_id, handled, ai_status, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mb.id,
      x.cl?.campaign_id ?? null,
      x.cl?.id ?? null,
      x.lead?.id ?? null,
      x.kind,
      x.category ?? null,
      a.returnDate ?? null,
      a.fromEmail,
      a.subject.slice(0, 500),
      (x.snippet ?? a.snippet).slice(0, 2000),
      a.messageId,
      x.handled ? 1 : 0,
      x.aiPending ? "pending" : "none",
      a.date && a.date <= now ? a.date : now,
      now,
    );
  return res.changes > 0;
}

/** Verarbeitet eine eingehende Mail. Gibt true zurück, wenn sie einem Kontakt zugeordnet wurde. */
export async function processInbound(ctx: AppContext, mb: MailboxRow, raw: Buffer): Promise<boolean> {
  const now = ctx.clock.now();
  const a = await analyzeInbound(raw, now);
  if (a.fromEmail && a.fromEmail === mb.email.toLowerCase()) return false; // eigene Mail
  if (a.messageId && ctx.db.prepare("SELECT 1 FROM inbound WHERE mailbox_id = ? AND message_id = ?").get(mb.id, a.messageId)) return false;

  if (a.kind === "bounce" && a.bounce) {
    let cl = findByMessageIds(ctx, a.bounce.originalMessageIds);
    let lead = cl ? getLeadRow(ctx.db, cl.lead_id) : undefined;
    if (!lead) {
      for (const r of a.bounce.recipients) {
        lead = findLeadByEmail(ctx, r);
        if (lead) {
          cl = latestCampaignLead(ctx, lead.id, mb.id);
          break;
        }
      }
    }
    if (!lead) return false; // Bounce gehört nicht zu unseren Kampagnen
    if (!a.bounce.hard) {
      logEvent(ctx.db, now, "info", "inbox.soft_bounce", `${lead.email}: vorübergehend nicht zustellbar (${a.bounce.status ?? "ohne Status"}).`, { campaignId: cl?.campaign_id ?? null, mailboxId: mb.id });
      return true;
    }
    const reason = `Unzustellbar${a.bounce.status ? ` (${a.bounce.status})` : ""}: ${(a.bounce.diagnostic ?? "").slice(0, 200)}`;
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE leads SET status = 'bounced', updated_at = ? WHERE id = ?").run(now, lead!.id);
      addSuppression(ctx.db, now, lead!.email, "bounce", (a.bounce!.diagnostic ?? "").slice(0, 200));
      if (cl) ctx.db.prepare("UPDATE campaign_leads SET status = 'bounced', status_reason = ?, next_send_at = NULL WHERE id = ?").run(reason, cl.id);
      stopLeadEverywhere(ctx.db, lead!.id, "bounced", reason);
      insertInbound(ctx, mb, a, { kind: "bounce", cl, lead, handled: true, aiPending: false, snippet: reason });
    })();
    logEvent(ctx.db, now, "warn", "inbox.bounce", `${lead.email} ist unzustellbar – auf die Sperrliste gesetzt.`, { campaignId: cl?.campaign_id ?? null, mailboxId: mb.id });
    if (cl) checkCampaignHealth(ctx, cl.campaign_id);
    return true;
  }

  // Antwort, Abwesenheit oder Abmeldung: Kontakt über Message-IDs oder Absender finden
  let cl = findByMessageIds(ctx, a.refs);
  let lead = cl ? getLeadRow(ctx.db, cl.lead_id) : undefined;
  if (!lead && a.fromEmail) {
    lead = findLeadByEmail(ctx, a.fromEmail);
    if (lead) cl = latestCampaignLead(ctx, lead.id, mb.id);
  }
  if (!lead) return false; // nicht zu unseren Kontakten – wird nicht gespeichert (Datenschutz)

  if (a.kind === "auto_reply") {
    insertInbound(ctx, mb, a, { kind: "auto_reply", cl, lead, category: "abwesend", handled: true, aiPending: false });
    if (a.returnDate && cl && cl.status === "active") {
      const campaign = getCampaignRow(ctx.db, cl.campaign_id);
      if (campaign) {
        const w = windowOf(campaign);
        const back = DateTime.fromISO(a.returnDate, { zone: w.timezone }).plus({ days: 1 }).startOf("day").toMillis();
        const at = nextWindowOpening(back, w) + Math.floor(ctx.random() * 3 * 60 * 60 * 1000);
        if (!cl.next_send_at || cl.next_send_at < at) {
          ctx.db.prepare("UPDATE campaign_leads SET next_send_at = ? WHERE id = ?").run(at, cl.id);
          logEvent(ctx.db, now, "info", "inbox.ooo", `${lead.email} ist bis ${DateTime.fromISO(a.returnDate).toFormat("dd.MM.yyyy")} abwesend – nächste Mail danach.`, { campaignId: cl.campaign_id });
        }
      }
    }
    return true;
  }

  const unsubscribe = a.kind === "unsubscribe";
  const campaign = cl ? getCampaignRow(ctx.db, cl.campaign_id) : undefined;
  const stopAll = unsubscribe || !campaign || !!campaign.stop_on_reply_all;
  const status = unsubscribe ? "unsubscribed" : "replied";
  const reason = unsubscribe ? "Hat per Antwort um Abmeldung gebeten." : "Hat geantwortet.";
  const aiReady = !unsubscribe && ctx.ai.keySource() !== null;
  ctx.db.transaction(() => {
    if (cl && (cl.status === "queued" || cl.status === "active" || cl.status === "finished")) {
      ctx.db.prepare("UPDATE campaign_leads SET status = ?, status_reason = ?, next_send_at = NULL WHERE id = ?").run(status, reason, cl.id);
    }
    if (stopAll) stopLeadEverywhere(ctx.db, lead!.id, status, reason);
    if (unsubscribe) {
      addSuppression(ctx.db, now, lead!.email, "unsubscribe", "Abmeldung per Antwort");
      ctx.db.prepare("UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE id = ? AND status = 'active'").run(now, lead!.id);
    }
    insertInbound(ctx, mb, a, { kind: unsubscribe ? "unsubscribe" : "reply", cl, lead, category: unsubscribe ? "abmelden" : null, handled: unsubscribe, aiPending: aiReady });
  })();
  logEvent(
    ctx.db,
    now,
    "info",
    unsubscribe ? "inbox.unsubscribe" : "inbox.reply",
    unsubscribe ? `${leadDisplayName(lead)} möchte keine weiteren Mails – abgemeldet.` : `Neue Antwort von ${leadDisplayName(lead)}${lead.company ? ` (${lead.company})` : ""}.`,
    { campaignId: cl?.campaign_id ?? null, mailboxId: mb.id },
  );
  return true;
}
