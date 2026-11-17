import { normalizeKey } from "./template";

// Zuordnung von Spaltenüberschriften (CSV/Excel) zu Kontaktfeldern.

export type StandardField =
  | "email"
  | "salutation"
  | "first_name"
  | "last_name"
  | "full_name"
  | "company"
  | "position"
  | "website";

/** "ignore", ein Standardfeld oder "custom:<schlüssel>" für eigene Spalten. */
export type FieldMapping = StandardField | "ignore" | `custom:${string}`;

export const STANDARD_FIELD_LABELS: Record<StandardField, string> = {
  email: "E-Mail",
  salutation: "Anrede",
  first_name: "Vorname",
  last_name: "Nachname",
  full_name: "Vollständiger Name (wird aufgeteilt)",
  company: "Firma",
  position: "Position",
  website: "Website",
};

const SYNONYMS: Record<StandardField, string[]> = {
  email: ["email", "e_mail", "mail", "emailadresse", "e_mail_adresse", "email_adresse", "emailaddress", "email_address", "mailadresse", "e_mail_address"],
  salutation: ["anrede", "salutation", "gender", "geschlecht", "titel_anrede"],
  first_name: ["vorname", "firstname", "first_name", "first", "given_name", "givenname", "rufname"],
  last_name: ["nachname", "lastname", "last_name", "surname", "familienname", "family_name", "zuname"],
  full_name: ["name", "fullname", "full_name", "kontakt", "ansprechpartner", "kontaktperson", "contact_name", "vollstaendiger_name"],
  company: ["firma", "unternehmen", "company", "firmenname", "company_name", "organisation", "organization", "organisation_name", "arbeitgeber", "account", "account_name"],
  position: ["position", "titel", "title", "jobtitle", "job_title", "rolle", "funktion", "role", "jobbezeichnung", "berufsbezeichnung"],
  website: ["website", "webseite", "homepage", "url", "domain", "internetseite", "web", "internet", "company_website", "firmenwebsite"],
};

const LOOKUP = new Map<string, StandardField>();
for (const [field, names] of Object.entries(SYNONYMS) as [StandardField, string[]][]) {
  for (const n of names) LOOKUP.set(n, field);
}

export function customKeyFromHeader(header: string): string {
  return normalizeKey(header) || "spalte";
}

export function suggestMapping(headers: string[]): Record<string, FieldMapping> {
  const result: Record<string, FieldMapping> = {};
  const used = new Set<StandardField>();
  for (const h of headers) {
    const key = normalizeKey(h);
    const field = LOOKUP.get(key);
    if (field && !used.has(field)) {
      result[h] = field;
      used.add(field);
    } else if (key) {
      result[h] = `custom:${customKeyFromHeader(h)}`;
    } else {
      result[h] = "ignore";
    }
  }
  // Falls Vor- und Nachname einzeln vorhanden sind, braucht es keinen "Namen".
  if (used.has("first_name") && used.has("last_name")) {
    for (const [h, f] of Object.entries(result)) if (f === "full_name") result[h] = "ignore";
  }
  return result;
}

/** "Dr. Julia Becker" → { first: "Julia", last: "Becker" } (Titel werden ignoriert). */
export function splitFullName(full: string): { first: string; last: string } {
  const parts = full
    .trim()
    .split(/\s+/)
    .filter((p) => !/^(dr\.?|prof\.?|dipl\.?-?\w*\.?|mag\.?|ing\.?|herr|frau|mr\.?|mrs\.?|ms\.?)$/i.test(p));
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0] ?? "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] ?? "" };
}

/** Normalisiert Anreden: "Herr", "Hr.", "m", "male" → "Herr"; "Frau", "Fr.", "w", "female" → "Frau". */
export function normalizeSalutation(raw: string): string {
  const v = raw.trim().toLowerCase().replace(/\.$/, "");
  if (["herr", "hr", "m", "male", "mann", "mr"].includes(v)) return "Herr";
  if (["frau", "fr", "w", "f", "female", "mrs", "ms"].includes(v)) return "Frau";
  return raw.trim();
}

export function normalizeWebsite(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  return v.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
}
