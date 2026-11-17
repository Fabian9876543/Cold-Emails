import type { DB } from "../db/client";
import type { SendWindow } from "../worker/schedule";
import type {
  AiStatus,
  CampaignDto,
  CampaignLeadDto,
  CampaignLeadStatus,
  CampaignStats,
  CampaignStatus,
  CampaignStepDto,
  Formality,
  OptOutMode,
} from "../../shared/types";

export interface CampaignRow {
  id: number;
  name: string;
  status: CampaignStatus;
  pause_reason: string | null;
  timezone: string;
  send_days: string;
  window_start: string;
  window_end: string;
  formality: Formality;
  stop_on_reply_all: number;
  skip_recent_days: number;
  opt_out_mode: OptOutMode;
  ai_enabled: number;
  ai_context: string;
  ai_use_website: number;
  ai_auto_approve: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface StepRow {
  id: number;
  campaign_id: number;
  position: number;
  wait_days: number;
  subject: string;
  body: string;
}

export interface CampaignLeadRow {
  id: number;
  campaign_id: number;
  lead_id: number;
  mailbox_id: number | null;
  status: CampaignLeadStatus;
  status_reason: string | null;
  next_step: number;
  next_send_at: number | null;
  thread_message_id: string | null;
  thread_subject: string | null;
  last_message_id: string | null;
  references_chain: string;
  attempts: number;
  ai_opener: string | null;
  ai_status: AiStatus;
  ai_quality: string | null;
  ai_reason: string | null;
  ai_error: string | null;
  last_sent_at: number | null;
  created_at: number;
}

export function getCampaignRow(db: DB, id: number): CampaignRow | undefined {
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
}

export function getSteps(db: DB, campaignId: number): StepRow[] {
  return db.prepare("SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position").all(campaignId) as StepRow[];
}

export function getCampaignMailboxIds(db: DB, campaignId: number): number[] {
  return (db.prepare("SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ? ORDER BY mailbox_id").all(campaignId) as { mailbox_id: number }[]).map((r) => r.mailbox_id);
}

export function getCampaignLeadRow(db: DB, id: number): CampaignLeadRow | undefined {
  return db.prepare("SELECT * FROM campaign_leads WHERE id = ?").get(id) as CampaignLeadRow | undefined;
}

export function windowOf(c: Pick<CampaignRow, "timezone" | "send_days" | "window_start" | "window_end">): SendWindow {
  return {
    timezone: c.timezone,
    sendDays: c.send_days.split(",").map(Number).filter((n) => n >= 1 && n <= 7),
    start: c.window_start,
    end: c.window_end,
  };
}

export function campaignStats(db: DB, campaignId: number): CampaignStats {
  const byStatus = Object.fromEntries(
    (db.prepare("SELECT status, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? GROUP BY status").all(campaignId) as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  ) as Record<string, number>;
  const byAi = Object.fromEntries(
    (db.prepare("SELECT ai_status, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? GROUP BY ai_status").all(campaignId) as { ai_status: string; n: number }[]).map((r) => [r.ai_status, r.n]),
  ) as Record<string, number>;
  const sent = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ? AND status = 'sent' AND is_test = 0").get(campaignId) as { n: number }).n;
  const contacted = (db.prepare("SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND last_sent_at IS NOT NULL").get(campaignId) as { n: number }).n;
  const perStepSent = db.prepare("SELECT step AS position, COUNT(*) AS n FROM messages WHERE campaign_id = ? AND status = 'sent' AND is_test = 0 GROUP BY step").all(campaignId) as { position: number; n: number }[];
  const perStepReplies = db
    .prepare(
      `SELECT (SELECT MAX(m.step) FROM messages m WHERE m.campaign_lead_id = i.campaign_lead_id AND m.status = 'sent' AND m.sent_at <= i.received_at) AS position, COUNT(*) AS n
       FROM inbound i WHERE i.campaign_id = ? AND i.kind = 'reply' GROUP BY position`,
    )
    .all(campaignId) as { position: number | null; n: number }[];
  const steps = getSteps(db, campaignId);
  const n = (k: string) => byStatus[k] ?? 0;
  const leads = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return {
    leads,
    queued: n("queued"),
    active: n("active"),
    finished: n("finished"),
    replied: n("replied"),
    bounced: n("bounced"),
    unsubscribed: n("unsubscribed"),
    skipped: n("skipped"),
    error: n("error"),
    sent,
    replyRate: contacted > 0 ? n("replied") / contacted : 0,
    bounceRate: contacted > 0 ? n("bounced") / contacted : 0,
    aiPending: (byAi.pending ?? 0) + (byAi.generating ?? 0),
    aiDone: byAi.done ?? 0,
    aiApproved: byAi.approved ?? 0,
    aiError: byAi.error ?? 0,
    perStep: steps.map((s) => ({
      position: s.position,
      sent: perStepSent.find((p) => p.position === s.position)?.n ?? 0,
      replies: perStepReplies.find((p) => p.position === s.position)?.n ?? 0,
    })),
  };
}

export function toStepDto(s: StepRow): CampaignStepDto {
  return { position: s.position, waitDays: s.wait_days, subject: s.subject, body: s.body };
}

export function toCampaignDto(db: DB, c: CampaignRow): CampaignDto {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    pauseReason: c.pause_reason,
    timezone: c.timezone,
    sendDays: windowOf(c).sendDays,
    windowStart: c.window_start,
    windowEnd: c.window_end,
    formality: c.formality,
    stopOnReplyAll: !!c.stop_on_reply_all,
    skipRecentDays: c.skip_recent_days,
    optOutMode: c.opt_out_mode,
    aiEnabled: !!c.ai_enabled,
    aiContext: c.ai_context,
    aiUseWebsite: !!c.ai_use_website,
    aiAutoApprove: !!c.ai_auto_approve,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    startedAt: c.started_at,
    completedAt: c.completed_at,
    steps: getSteps(db, c.id).map(toStepDto),
    mailboxIds: getCampaignMailboxIds(db, c.id),
    stats: campaignStats(db, c.id),
  };
}

export function toCampaignLeadDto(r: CampaignLeadRow & { email: string; first_name: string; last_name: string; company: string; website: string; mailbox_email: string | null }): CampaignLeadDto {
  return {
    id: r.id,
    leadId: r.lead_id,
    email: r.email,
    name: `${r.first_name} ${r.last_name}`.trim(),
    company: r.company,
    website: r.website,
    status: r.status,
    statusReason: r.status_reason,
    nextStep: r.next_step,
    nextSendAt: r.next_send_at,
    mailboxEmail: r.mailbox_email,
    lastSentAt: r.last_sent_at,
    aiOpener: r.ai_opener,
    aiStatus: r.ai_status,
    aiQuality: r.ai_quality,
    aiReason: r.ai_reason,
    aiError: r.ai_error,
  };
}
