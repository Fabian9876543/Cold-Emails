import { DateTime } from "luxon";
import type { DB } from "../db/client";
import type { MailboxDto, MailboxAuthType, MailboxStatus, Security } from "../../shared/types";

export interface MailboxRow {
  id: number;
  email: string;
  from_name: string;
  auth_type: MailboxAuthType;
  smtp_host: string;
  smtp_port: number;
  smtp_security: Security;
  imap_host: string;
  imap_port: number;
  imap_security: Security;
  username: string;
  secret_enc: string;
  daily_limit: number;
  warmup_enabled: number;
  warmup_start: number;
  warmup_step: number;
  warmup_started_at: number;
  signature: string;
  status: MailboxStatus;
  last_error: string | null;
  last_error_at: number | null;
  consecutive_failures: number;
  paused_until: number | null;
  next_available_at: number;
  imap_enabled: number;
  imap_uidvalidity: string | null;
  imap_last_uid: number;
  imap_last_poll_at: number | null;
  imap_error: string | null;
  created_at: number;
}

export const GOOGLE_SERVER = {
  smtpHost: "smtp.gmail.com",
  smtpPort: 465,
  smtpSecurity: "ssl" as Security,
  imapHost: "imap.gmail.com",
  imapPort: 993,
  imapSecurity: "ssl" as Security,
};

export function getMailboxRow(db: DB, id: number): MailboxRow | undefined {
  return db.prepare("SELECT * FROM mailboxes WHERE id = ?").get(id) as MailboxRow | undefined;
}

export function listMailboxRows(db: DB): MailboxRow[] {
  return db.prepare("SELECT * FROM mailboxes ORDER BY email").all() as MailboxRow[];
}

export function startOfDayMs(now: number, timezone: string): number {
  return DateTime.fromMillis(now, { zone: timezone }).startOf("day").toMillis();
}

/** Anzahl der heute (Zeitzone der Plattform) über dieses Postfach verschickten Kampagnen-Mails. */
export function sentToday(db: DB, mailboxId: number, now: number, timezone: string): number {
  const since = startOfDayMs(now, timezone);
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ? AND is_test = 0 AND status IN ('sent','sending','unknown') AND created_at >= ?",
    )
    .get(mailboxId, since) as { n: number };
  return row.n;
}

/** Tageslimit unter Berücksichtigung des langsamen Hochfahrens (Warm-up). */
export function effectiveDailyLimit(mb: Pick<MailboxRow, "daily_limit" | "warmup_enabled" | "warmup_start" | "warmup_step" | "warmup_started_at">, now: number, timezone: string): number {
  if (!mb.warmup_enabled) return mb.daily_limit;
  const start = DateTime.fromMillis(mb.warmup_started_at, { zone: timezone }).startOf("day");
  const today = DateTime.fromMillis(now, { zone: timezone }).startOf("day");
  const days = Math.max(0, Math.round(today.diff(start, "days").days));
  return Math.min(mb.daily_limit, mb.warmup_start + mb.warmup_step * days);
}

export function toMailboxDto(db: DB, row: MailboxRow, now: number, timezone: string): MailboxDto {
  return {
    id: row.id,
    email: row.email,
    fromName: row.from_name,
    authType: row.auth_type,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecurity: row.smtp_security,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecurity: row.imap_security,
    imapEnabled: !!row.imap_enabled,
    username: row.username,
    dailyLimit: row.daily_limit,
    warmupEnabled: !!row.warmup_enabled,
    warmupStart: row.warmup_start,
    warmupStep: row.warmup_step,
    warmupStartedAt: row.warmup_started_at,
    signature: row.signature,
    status: row.status,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    pausedUntil: row.paused_until,
    imapError: row.imap_error,
    imapLastPollAt: row.imap_last_poll_at,
    sentToday: sentToday(db, row.id, now, timezone),
    effectiveLimit: effectiveDailyLimit(row, now, timezone),
    createdAt: row.created_at,
  };
}

export function mailboxDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

export function senderFirstName(fromName: string): string {
  return fromName.trim().split(/\s+/)[0] ?? "";
}
