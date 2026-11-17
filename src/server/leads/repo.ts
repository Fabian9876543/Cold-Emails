import type { DB } from "../db/client";
import { domainOf, normalizeEmail } from "../../shared/emailCheck";
import type { LeadDto, LeadStatus, SuppressionDto } from "../../shared/types";

export interface LeadRow {
  id: number;
  email: string;
  salutation: string;
  first_name: string;
  last_name: string;
  company: string;
  position: string;
  website: string;
  custom_json: string;
  status: LeadStatus;
  check_flags: string;
  created_at: number;
  updated_at: number;
}

export function parseCustom(json: string): Record<string, string> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function toLeadDto(r: LeadRow): LeadDto {
  return {
    id: r.id,
    email: r.email,
    salutation: r.salutation,
    firstName: r.first_name,
    lastName: r.last_name,
    company: r.company,
    position: r.position,
    website: r.website,
    custom: parseCustom(r.custom_json),
    status: r.status,
    checkFlags: r.check_flags ? r.check_flags.split(",").filter(Boolean) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getLeadRow(db: DB, id: number): LeadRow | undefined {
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as LeadRow | undefined;
}

export function leadDisplayName(r: Pick<LeadRow, "first_name" | "last_name" | "email">): string {
  const name = `${r.first_name} ${r.last_name}`.trim();
  return name || r.email;
}

/** Steht die Adresse oder ihre Domain auf der Sperrliste? */
export function isSuppressed(db: DB, email: string): boolean {
  const e = normalizeEmail(email);
  const row = db
    .prepare("SELECT 1 FROM suppressions WHERE (type = 'email' AND value = ?) OR (type = 'domain' AND value = ?) LIMIT 1")
    .get(e, domainOf(e));
  return !!row;
}

export function addSuppression(
  db: DB,
  now: number,
  value: string,
  reason: SuppressionDto["reason"],
  note: string | null = null,
): void {
  const v = value.trim().toLowerCase().replace(/^@/, "");
  const type = v.includes("@") ? "email" : "domain";
  db.prepare(
    "INSERT INTO suppressions (value, type, reason, note, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(value) DO NOTHING",
  ).run(v, type, reason, note, now);
}

export function toSuppressionDto(r: Record<string, unknown>): SuppressionDto {
  return {
    id: r.id as number,
    value: r.value as string,
    type: r.type as SuppressionDto["type"],
    reason: r.reason as SuppressionDto["reason"],
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

/**
 * Stoppt alle offenen Sequenzen eines Kontakts (z. B. nach Abmeldung oder Bounce).
 * Gibt die Anzahl der betroffenen Kampagnen-Einträge zurück.
 */
export function stopLeadEverywhere(
  db: DB,
  leadId: number,
  status: "unsubscribed" | "bounced" | "replied",
  reason: string,
  exceptCampaignLeadId?: number,
): number {
  const res = db
    .prepare(
      `UPDATE campaign_leads SET status = ?, status_reason = ?, next_send_at = NULL
       WHERE lead_id = ? AND status IN ('queued','active') AND id != ?`,
    )
    .run(status, reason, leadId, exceptCampaignLeadId ?? -1);
  return res.changes;
}
