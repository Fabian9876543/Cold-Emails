import crypto from "node:crypto";
import type { AppContext } from "../context";
import { domainAcceptsMail } from "../deliverability/dns";
import type { ParsedTable } from "./parse";
import { isSuppressed, parseCustom } from "./repo";
import { checkEmailOffline, domainOf, type EmailFlag } from "../../shared/emailCheck";
import { normalizeSalutation, normalizeWebsite, splitFullName, type FieldMapping } from "../../shared/fields";
import { normalizeKey } from "../../shared/template";
import type { ImportReportDto } from "../../shared/types";

interface PendingImport {
  fileName: string;
  table: ParsedTable;
  createdAt: number;
}

const pending = new Map<string, PendingImport>();
const TTL_MS = 60 * 60 * 1000;

export function storePendingImport(fileName: string, table: ParsedTable): string {
  const now = Date.now();
  for (const [id, p] of pending) if (now - p.createdAt > TTL_MS) pending.delete(id);
  const id = crypto.randomUUID();
  pending.set(id, { fileName, table, createdAt: now });
  return id;
}

export function getPendingImport(id: string): PendingImport | undefined {
  return pending.get(id);
}

export function dropPendingImport(id: string): void {
  pending.delete(id);
}

interface MappedRecord {
  rowNumber: number;
  rawEmail: string;
  email: string;
  salutation: string;
  first_name: string;
  last_name: string;
  company: string;
  position: string;
  website: string;
  custom: Record<string, string>;
  flags: EmailFlag[];
}

export function mapRow(row: string[], headers: string[], mapping: Record<string, FieldMapping>): Omit<MappedRecord, "rowNumber" | "email" | "flags"> & { fullName: string } {
  const rec = { rawEmail: "", salutation: "", first_name: "", last_name: "", company: "", position: "", website: "", fullName: "", custom: {} as Record<string, string> };
  headers.forEach((h, i) => {
    const target = mapping[h] ?? "ignore";
    const value = (row[i] ?? "").trim();
    if (!value || target === "ignore") return;
    switch (target) {
      case "email":
        rec.rawEmail = value;
        break;
      case "salutation":
        rec.salutation = normalizeSalutation(value);
        break;
      case "first_name":
        rec.first_name = value;
        break;
      case "last_name":
        rec.last_name = value;
        break;
      case "full_name":
        rec.fullName = value;
        break;
      case "company":
        rec.company = value;
        break;
      case "position":
        rec.position = value;
        break;
      case "website":
        rec.website = normalizeWebsite(value);
        break;
      default:
        if (target.startsWith("custom:")) {
          const key = normalizeKey(target.slice("custom:".length));
          if (key) rec.custom[key] = value;
        }
    }
  });
  if (rec.fullName && !rec.first_name && !rec.last_name) {
    const split = splitFullName(rec.fullName);
    rec.first_name = split.first;
    rec.last_name = split.last;
  }
  return rec;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface CommitOptions {
  mapping: Record<string, FieldMapping>;
  listName: string;
  updateExisting: boolean;
  checkMx: boolean;
}

export async function commitImport(ctx: AppContext, fileName: string, table: ParsedTable, opts: CommitOptions): Promise<ImportReportDto> {
  if (!Object.values(opts.mapping).includes("email")) {
    throw new Error("Bitte die Spalte mit der E-Mail-Adresse zuordnen.");
  }
  const now = ctx.clock.now();
  const report: ImportReportDto = {
    listId: 0,
    listName: opts.listName,
    total: table.rows.length,
    imported: 0,
    updated: 0,
    duplicatesInFile: 0,
    suppressed: 0,
    invalid: [],
    warnings: { role: 0, freemail: 0, disposable: 0, noMx: 0 },
  };

  const seen = new Set<string>();
  const records: MappedRecord[] = [];
  table.rows.forEach((row, idx) => {
    const rowNumber = idx + 2; // Zeile 1 = Überschriften
    const rec = mapRow(row, table.headers, opts.mapping);
    const check = checkEmailOffline(rec.rawEmail);
    if (!check.valid) {
      if (check.flags.includes("disposable")) report.warnings.disposable++;
      if (rec.rawEmail || row.some((c) => c.trim())) report.invalid.push({ row: rowNumber, email: rec.rawEmail, reason: check.reason ?? "Ungültig" });
      return;
    }
    if (seen.has(check.email)) {
      report.duplicatesInFile++;
      return;
    }
    seen.add(check.email);
    records.push({ ...rec, rowNumber, email: check.email, flags: check.flags });
  });

  // MX-Prüfung je Domain (parallel, mit Zwischenspeicher)
  if (opts.checkMx && records.length > 0) {
    const domains = [...new Set(records.map((r) => domainOf(r.email)))];
    const results = await mapLimit(domains, 20, (d) => domainAcceptsMail(ctx.dns, d));
    const noMail = new Set(domains.filter((_, i) => results[i] === false));
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!;
      if (noMail.has(domainOf(r.email))) {
        report.warnings.noMx++;
        report.invalid.push({ row: r.rowNumber, email: r.email, reason: "Domain kann keine E-Mails empfangen" });
        records.splice(i, 1);
      }
    }
  }

  const db = ctx.db;
  const findLead = db.prepare("SELECT id, custom_json FROM leads WHERE email = ?");
  const insertLead = db.prepare(
    `INSERT INTO leads (email, salutation, first_name, last_name, company, position, website, custom_json, status, check_flags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  );
  const updateLead = db.prepare(
    `UPDATE leads SET
       salutation = CASE WHEN ? != '' THEN ? ELSE salutation END,
       first_name = CASE WHEN ? != '' THEN ? ELSE first_name END,
       last_name = CASE WHEN ? != '' THEN ? ELSE last_name END,
       company = CASE WHEN ? != '' THEN ? ELSE company END,
       position = CASE WHEN ? != '' THEN ? ELSE position END,
       website = CASE WHEN ? != '' THEN ? ELSE website END,
       custom_json = ?, check_flags = ?, updated_at = ?
     WHERE id = ?`,
  );
  const addMember = db.prepare("INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?, ?)");

  db.transaction(() => {
    const list = db.prepare("INSERT INTO lead_lists (name, created_at) VALUES (?, ?)").run(opts.listName, now);
    report.listId = Number(list.lastInsertRowid);
    for (const r of records) {
      if (isSuppressed(db, r.email)) {
        report.suppressed++;
        continue;
      }
      if (r.flags.includes("role")) report.warnings.role++;
      if (r.flags.includes("freemail")) report.warnings.freemail++;
      const flags = r.flags.join(",");
      const existing = findLead.get(r.email) as { id: number; custom_json: string } | undefined;
      let leadId: number;
      if (existing) {
        leadId = existing.id;
        if (opts.updateExisting) {
          const custom = { ...parseCustom(existing.custom_json), ...r.custom };
          updateLead.run(
            r.salutation, r.salutation, r.first_name, r.first_name, r.last_name, r.last_name, r.company, r.company,
            r.position, r.position, r.website, r.website, JSON.stringify(custom), flags, now, leadId,
          );
        }
        report.updated++;
      } else {
        const res = insertLead.run(r.email, r.salutation, r.first_name, r.last_name, r.company, r.position, r.website, JSON.stringify(r.custom), flags, now, now);
        leadId = Number(res.lastInsertRowid);
        report.imported++;
      }
      addMember.run(report.listId, leadId);
    }
  })();

  report.invalid.sort((a, b) => a.row - b.row);
  if (report.invalid.length > 500) report.invalid = report.invalid.slice(0, 500);
  return report;
}

export function defaultListName(fileName: string, now: number): string {
  const base = fileName.replace(/\.[^.]+$/, "").slice(0, 80) || "Import";
  const date = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(now));
  return `${base} (${date})`;
}
