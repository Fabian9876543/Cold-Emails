import type { AppContext } from "../context";
import { logEvent } from "../lib/events";
import { getSettings, type AppSettings } from "../lib/settings";
import { addSuppression, getLeadRow, isSuppressed, stopLeadEverywhere, type LeadRow } from "../leads/repo";
import { effectiveDailyLimit, getMailboxRow, sentToday, type MailboxRow } from "../mail/mailboxes";
import { classifySmtpError, explainSmtpError } from "../mail/smtpErrors";
import { buildOutgoing, newMessageId, renderStep, unsubscribeUrl } from "../campaigns/compose";
import { checkCampaignHealth, completeFinishedCampaigns } from "../campaigns/health";
import { getCampaignMailboxIds, getSteps, windowOf, type CampaignLeadRow, type CampaignRow, type StepRow } from "../campaigns/repo";
import {
  computeGapMs,
  dailyStartOffsetMs,
  dayKey,
  isWithinWindow,
  scheduleFollowUp,
  startOfNextDay,
  windowEndMs,
  windowStartMs,
  type SendWindow,
} from "./schedule";
import { extractPlaceholders, usesPlaceholder } from "../../shared/template";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30 * 60 * 1000;

interface MailboxState {
  row: MailboxRow;
  remaining: number;
  availableAt: number;
}

export interface TickResult {
  sent: number;
  failed: number;
  skipped: number;
}

/** Braucht die Kampagne fertige KI-Einstiege, bevor ein Kontakt angeschrieben wird? */
export function campaignNeedsAi(c: Pick<CampaignRow, "ai_enabled">, steps: Pick<StepRow, "subject" | "body">[]): boolean {
  return !!c.ai_enabled && steps.some((s) => usesPlaceholder(s.body, "ki_einstieg") || usesPlaceholder(s.subject, "ki_einstieg"));
}

/**
 * Welche KI-Status dürfen angeschrieben werden? Freigegeben immer; "zur Prüfung" bei automatischer Freigabe;
 * "Fehler" nur, wenn jede Verwendung von {{ki_einstieg}} einen Ersatztext hat.
 */
export function allowedAiStatuses(c: Pick<CampaignRow, "ai_auto_approve">, steps: Pick<StepRow, "subject" | "body">[]): string {
  const statuses = ["'approved'"];
  if (c.ai_auto_approve) statuses.push("'done'");
  const usages = steps.flatMap((s) => extractPlaceholders(`${s.subject}\n${s.body}`).filter((p) => p.key === "ki_einstieg"));
  if (usages.length > 0 && usages.every((p) => p.hasFallback)) statuses.push("'error'");
  return statuses.join(",");
}

/** Hängende Sendungen nach einem Neustart: als "unklar" markieren und nie automatisch erneut senden. */
export function recoverInterruptedSends(ctx: AppContext): number {
  const stuck = ctx.db.prepare("SELECT id, campaign_lead_id, campaign_id, to_email FROM messages WHERE status = 'sending'").all() as {
    id: number;
    campaign_lead_id: number | null;
    campaign_id: number | null;
    to_email: string;
  }[];
  const now = ctx.clock.now();
  for (const m of stuck) {
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE messages SET status = 'unknown', error = ? WHERE id = ?").run("Versand wurde unterbrochen – unklar, ob die Mail verschickt wurde.", m.id);
      if (m.campaign_lead_id) {
        ctx.db
          .prepare("UPDATE campaign_leads SET status = 'error', status_reason = ?, next_send_at = NULL WHERE id = ? AND status IN ('queued','active')")
          .run("Versand wurde durch einen Neustart unterbrochen. Bitte im Gesendet-Ordner prüfen und den Kontakt bei Bedarf erneut einreihen.", m.campaign_lead_id);
      }
    })();
    logEvent(ctx.db, now, "warn", "send.interrupted", `Versand an ${m.to_email} wurde unterbrochen – zur Sicherheit nicht erneut gesendet.`, { campaignId: m.campaign_id });
  }
  return stuck.length;
}

function mailboxState(ctx: AppContext, row: MailboxRow, now: number, tz: string, w: SendWindow): MailboxState {
  const remaining = effectiveDailyLimit(row, now, tz) - sentToday(ctx.db, row.id, now, tz);
  const dailyStart = windowStartMs(now, w) + dailyStartOffsetMs(row.id, dayKey(now, w.timezone));
  return { row, remaining, availableAt: Math.max(row.next_available_at, dailyStart) };
}

function usable(s: MailboxState | undefined, now: number, busy: Set<number>): s is MailboxState {
  if (!s) return false;
  if (s.row.status !== "active") return false;
  if (s.row.paused_until && s.row.paused_until > now) return false;
  return !busy.has(s.row.id) && s.remaining > 0 && s.availableAt <= now;
}

export async function runSendTick(ctx: AppContext): Promise<TickResult> {
  const result: TickResult = { sent: 0, failed: 0, skipped: 0 };
  const settings = getSettings(ctx.db);
  const campaigns = ctx.db.prepare("SELECT * FROM campaigns WHERE status = 'active' ORDER BY id").all() as CampaignRow[];
  const busy = new Set<number>();

  for (const campaign of campaigns) {
    const now = ctx.clock.now();
    const w = windowOf(campaign);
    if (!isWithinWindow(now, w)) continue;
    const steps = getSteps(ctx.db, campaign.id);
    if (steps.length === 0) continue;

    const states = new Map<number, MailboxState>();
    const stateFor = (id: number): MailboxState | undefined => {
      if (!states.has(id)) {
        const row = getMailboxRow(ctx.db, id);
        if (row) states.set(id, mailboxState(ctx, row, now, settings.timezone, w));
      }
      return states.get(id);
    };
    const campaignMailboxes = getCampaignMailboxIds(ctx.db, campaign.id);
    if (campaignMailboxes.length === 0) continue;

    // Erstkontakte warten auf freigegebene KI-Einstiege (sofern die Vorlage sie nutzt)
    const aiGate = campaignNeedsAi(campaign, steps) ? `AND (cl.next_step > 1 OR cl.ai_status IN (${allowedAiStatuses(campaign, steps)}))` : "";
    const candidates = ctx.db
      .prepare(
        `SELECT cl.* FROM campaign_leads cl
         WHERE cl.campaign_id = ? AND cl.status IN ('queued','active') AND (cl.next_send_at IS NULL OR cl.next_send_at <= ?)
         ${aiGate}
         ORDER BY CASE WHEN cl.next_step > 1 THEN 0 ELSE 1 END, COALESCE(cl.next_send_at, 0), cl.id
         LIMIT 300`,
      )
      .all(campaign.id, now) as CampaignLeadRow[];

    for (const cl of candidates) {
      const tickNow = ctx.clock.now();
      let mailboxId: number | null = cl.mailbox_id;
      if (mailboxId !== null) {
        if (!usable(stateFor(mailboxId), tickNow, busy)) continue;
      } else {
        const options = campaignMailboxes.map(stateFor).filter((s): s is MailboxState => usable(s, tickNow, busy));
        if (options.length === 0) continue; // Follow-ups mit festem Postfach können noch passen
        options.sort((a, b) => b.remaining - a.remaining || a.row.id - b.row.id);
        mailboxId = options[0]!.row.id;
      }
      const state = stateFor(mailboxId)!;
      const outcome = await sendOne(ctx, campaign, steps, cl, state, settings, w);
      busy.add(mailboxId);
      state.remaining -= outcome === "sent" ? 1 : 0;
      if (outcome === "sent") result.sent++;
      else if (outcome === "failed") result.failed++;
      else {
        result.skipped++;
        busy.delete(mailboxId); // übersprungene Kontakte verbrauchen keinen Versand
      }
      // Kein Postfach mehr frei → nächste Kampagne
      campaignMailboxes.forEach(stateFor);
      if (![...states.values()].some((s) => usable(s, ctx.clock.now(), busy))) break;
    }
    checkCampaignHealth(ctx, campaign.id);
  }
  completeFinishedCampaigns(ctx);
  return result;
}

type Outcome = "sent" | "failed" | "skipped";

function finishLead(ctx: AppContext, cl: CampaignLeadRow, status: CampaignLeadRow["status"], reason: string | null): void {
  ctx.db.prepare("UPDATE campaign_leads SET status = ?, status_reason = ?, next_send_at = NULL WHERE id = ?").run(status, reason, cl.id);
}

async function sendOne(
  ctx: AppContext,
  campaign: CampaignRow,
  steps: StepRow[],
  cl: CampaignLeadRow,
  state: MailboxState,
  settings: AppSettings,
  w: SendWindow,
): Promise<Outcome> {
  const now = ctx.clock.now();
  const lead = getLeadRow(ctx.db, cl.lead_id);
  if (!lead) {
    finishLead(ctx, cl, "skipped", "Kontakt wurde gelöscht.");
    return "skipped";
  }
  if (lead.status !== "active") {
    const map = { unsubscribed: "unsubscribed", bounced: "bounced", invalid: "skipped" } as const;
    finishLead(ctx, cl, map[lead.status], "Kontakt ist nicht mehr aktiv.");
    return "skipped";
  }
  if (isSuppressed(ctx.db, lead.email)) {
    finishLead(ctx, cl, "unsubscribed", "Steht auf der Sperrliste.");
    return "skipped";
  }
  if (cl.next_step === 1) {
    if (campaign.skip_recent_days > 0) {
      const recent = ctx.db
        .prepare("SELECT 1 FROM messages WHERE lead_id = ? AND status = 'sent' AND is_test = 0 AND campaign_id IS NOT ? AND sent_at >= ? LIMIT 1")
        .get(lead.id, campaign.id, now - campaign.skip_recent_days * 86_400_000);
      if (recent) {
        finishLead(ctx, cl, "skipped", `Wurde in den letzten ${campaign.skip_recent_days} Tagen bereits angeschrieben.`);
        return "skipped";
      }
    }
    const replied = ctx.db.prepare("SELECT 1 FROM inbound WHERE lead_id = ? AND kind IN ('reply','unsubscribe') LIMIT 1").get(lead.id);
    if (replied) {
      finishLead(ctx, cl, "skipped", "Hat bereits auf eine frühere Kampagne geantwortet.");
      return "skipped";
    }
  }
  const step = steps.find((s) => s.position === cl.next_step);
  if (!step) {
    finishLead(ctx, cl, "finished", null);
    return "skipped";
  }

  const mailbox = state.row;
  const rendered = renderStep(step, {
    campaign,
    lead,
    mailbox,
    campaignLead: cl,
    settings,
    publicBaseUrl: ctx.config.publicBaseUrl,
    secrets: ctx.secrets,
    firstStepSubject: steps[0]?.subject ?? "",
  });
  if (rendered.missing.length > 0) {
    finishLead(ctx, cl, "error", `Fehlende Angaben: ${rendered.missing.map((m) => `{{${m}}}`).join(", ")}. Kontakt ergänzen oder in der Vorlage einen Ersatztext verwenden, z. B. {{${rendered.missing[0]}|…}}.`);
    return "skipped";
  }
  if (!rendered.subject) {
    finishLead(ctx, cl, "error", "Der Betreff ist leer.");
    return "skipped";
  }

  const messageId = newMessageId(mailbox);
  const references = cl.references_chain.split(" ").filter(Boolean);
  const outgoing = buildOutgoing({
    mailbox,
    lead,
    subject: rendered.subject,
    body: rendered.body,
    messageId,
    inReplyTo: cl.next_step > 1 ? cl.last_message_id : null,
    references: cl.next_step > 1 ? references : [],
    oneClickUrl: unsubscribeUrl(ctx.config.publicBaseUrl, ctx.secrets, cl.id),
    now,
  });

  // 1) Reservieren: Protokolleintrag "sending" + nächster freier Zeitpunkt des Postfachs
  const gap = computeGapMs(now, windowEndMs(now, w), state.remaining, ctx.random);
  let messageRowId = 0;
  ctx.db.transaction(() => {
    const res = ctx.db
      .prepare(
        `INSERT INTO messages (campaign_lead_id, campaign_id, lead_id, mailbox_id, step, to_email, message_id, subject, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?)`,
      )
      .run(cl.id, campaign.id, lead.id, mailbox.id, step.position, lead.email, messageId, rendered.subject, rendered.body, now);
    messageRowId = Number(res.lastInsertRowid);
    ctx.db.prepare("UPDATE mailboxes SET next_available_at = ? WHERE id = ?").run(now + gap, mailbox.id);
  })();
  state.row.next_available_at = now + gap;
  state.availableAt = now + gap;

  // 2) Senden
  try {
    await ctx.mail.send(mailbox, outgoing);
  } catch (err) {
    handleSendError(ctx, err, { campaign, cl, lead, mailbox, messageRowId, step });
    return "failed";
  }

  // 3) Erfolg festhalten und nächsten Schritt planen
  const sentAt = ctx.clock.now();
  const nextStep = steps.find((s) => s.position === step.position + 1);
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE messages SET status = 'sent', sent_at = ? WHERE id = ?").run(sentAt, messageRowId);
    ctx.db
      .prepare(
        `UPDATE campaign_leads SET status = ?, status_reason = NULL, mailbox_id = ?, next_step = ?, next_send_at = ?, attempts = 0,
           thread_message_id = COALESCE(thread_message_id, ?), thread_subject = COALESCE(thread_subject, ?),
           last_message_id = ?, references_chain = TRIM(references_chain || ' ' || ?), last_sent_at = ?
         WHERE id = ?`,
      )
      .run(
        nextStep ? "active" : "finished",
        mailbox.id,
        step.position + 1,
        nextStep ? scheduleFollowUp(sentAt, nextStep.wait_days, w, ctx.random) : null,
        messageId,
        step.position === 1 ? rendered.subject : null,
        messageId,
        messageId,
        sentAt,
        cl.id,
      );
    ctx.db.prepare("UPDATE mailboxes SET consecutive_failures = 0 WHERE id = ?").run(mailbox.id);
  })();
  return "sent";
}

function handleSendError(
  ctx: AppContext,
  err: unknown,
  x: { campaign: CampaignRow; cl: CampaignLeadRow; lead: LeadRow; mailbox: MailboxRow; messageRowId: number; step: StepRow },
): void {
  const now = ctx.clock.now();
  const c = classifySmtpError(err);
  const explanation = explainSmtpError(c);
  const refs = { campaignId: x.campaign.id, mailboxId: x.mailbox.id };
  ctx.db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(c.message.slice(0, 1000), x.messageRowId);
  // Fehlgeschlagene Sendungen blockieren das Postfach nicht unnötig lange
  ctx.db.prepare("UPDATE mailboxes SET next_available_at = ? WHERE id = ?").run(now + 60_000, x.mailbox.id);

  const mailboxFailure = (status: "error" | "active", pausedUntil: number | null) => {
    ctx.db
      .prepare("UPDATE mailboxes SET status = ?, last_error = ?, last_error_at = ?, paused_until = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?")
      .run(status, `${explanation} (${c.message.slice(0, 300)})`, now, pausedUntil, x.mailbox.id);
  };

  switch (c.kind) {
    case "recipient":
      ctx.db.transaction(() => {
        ctx.db.prepare("UPDATE leads SET status = 'bounced', updated_at = ? WHERE id = ?").run(now, x.lead.id);
        addSuppression(ctx.db, now, x.lead.email, "bounce", c.message.slice(0, 200));
        finishLead(ctx, x.cl, "bounced", explanation);
        stopLeadEverywhere(ctx.db, x.lead.id, "bounced", explanation, x.cl.id);
      })();
      logEvent(ctx.db, now, "warn", "send.bounce", `${x.lead.email}: ${explanation}`, refs);
      checkCampaignHealth(ctx, x.campaign.id);
      return;
    case "auth":
    case "policy":
      mailboxFailure("error", null);
      logEvent(ctx.db, now, "error", `send.${c.kind}`, `Postfach ${x.mailbox.email}: ${explanation}`, refs);
      return;
    case "quota":
      mailboxFailure("active", startOfNextDay(now, getSettings(ctx.db).timezone));
      logEvent(ctx.db, now, "warn", "send.quota", `Postfach ${x.mailbox.email}: ${explanation}`, refs);
      return;
    case "rate":
      mailboxFailure("active", now + 60 * 60 * 1000);
      logEvent(ctx.db, now, "warn", "send.rate", `Postfach ${x.mailbox.email}: ${explanation}`, refs);
      return;
    case "rejected":
      finishLead(ctx, x.cl, "error", `${explanation} ${c.message.slice(0, 300)}`);
      logEvent(ctx.db, now, "warn", "send.rejected", `${x.lead.email}: ${c.message.slice(0, 300)}`, refs);
      return;
    case "temporary": {
      const attempts = x.cl.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        finishLead(ctx, x.cl, "error", `Nach ${MAX_ATTEMPTS} Versuchen nicht zustellbar: ${c.message.slice(0, 300)}`);
      } else {
        ctx.db.prepare("UPDATE campaign_leads SET attempts = ?, next_send_at = ? WHERE id = ?").run(attempts, now + RETRY_DELAY_MS, x.cl.id);
      }
      const failures = x.mailbox.consecutive_failures + 1;
      if (failures >= 3) {
        mailboxFailure("error", null);
        logEvent(ctx.db, now, "error", "send.mailbox_error", `Postfach ${x.mailbox.email}: 3 Fehler in Folge – Versand gestoppt. ${c.message.slice(0, 200)}`, refs);
      } else {
        ctx.db.prepare("UPDATE mailboxes SET consecutive_failures = ? WHERE id = ?").run(failures, x.mailbox.id);
        logEvent(ctx.db, now, "warn", "send.temporary", `${x.lead.email}: ${explanation} (${c.message.slice(0, 200)})`, refs);
      }
      return;
    }
  }
}
