import type { DB } from "../db/client";
import type { EventDto } from "../../shared/types";

export type EventLevel = "info" | "warn" | "error";

/** Schreibt einen Eintrag ins Aktivitätsprotokoll (sichtbar in der Oberfläche). */
export function logEvent(
  db: DB,
  now: number,
  level: EventLevel,
  type: string,
  message: string,
  refs: { campaignId?: number | null; mailboxId?: number | null } = {},
): void {
  db.prepare(
    "INSERT INTO events (created_at, level, type, message, campaign_id, mailbox_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(now, level, type, message, refs.campaignId ?? null, refs.mailboxId ?? null);
}

export function listEvents(db: DB, opts: { campaignId?: number; mailboxId?: number; limit?: number } = {}): EventDto[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.campaignId) {
    where.push("campaign_id = ?");
    params.push(opts.campaignId);
  }
  if (opts.mailboxId) {
    where.push("mailbox_id = ?");
    params.push(opts.mailboxId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, opts.limit ?? 100) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    createdAt: r.created_at as number,
    level: r.level as EventDto["level"],
    type: r.type as string,
    message: r.message as string,
    campaignId: (r.campaign_id as number | null) ?? null,
    mailboxId: (r.mailbox_id as number | null) ?? null,
  }));
}

export function pruneEvents(db: DB, now: number, keepDays = 120): void {
  db.prepare("DELETE FROM events WHERE created_at < ?").run(now - keepDays * 86_400_000);
}
