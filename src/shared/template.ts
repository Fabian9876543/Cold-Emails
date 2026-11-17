// Platzhalter-Engine: {{vorname}} oder mit Ersatztext {{vorname|zusammen}}.

const PLACEHOLDER = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

/** Normalisiert Variablennamen: "Vorname" → "vorname", "Straße Nr." → "strasse_nr". */
export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface RenderResult {
  text: string;
  /** Platzhalter ohne Wert und ohne Ersatztext. */
  missing: string[];
}

export function render(template: string, values: Record<string, string | null | undefined>): RenderResult {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v !== null && v !== undefined) normalized[normalizeKey(k)] = String(v);
  }
  const missing = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_m, rawKey: string, fallback: string | undefined) => {
    const key = normalizeKey(rawKey);
    const value = normalized[key];
    if (value !== undefined && value.trim() !== "") return value.trim();
    if (fallback !== undefined) return fallback;
    missing.add(key);
    return "";
  });
  return { text: tidyWhitespace(text), missing: [...missing] };
}

/** Entfernt doppelte Leerzeichen, die durch leere Ersatztexte entstehen, ohne Zeilenumbrüche anzutasten. */
function tidyWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?;:])/g, "$1").replace(/[ \t]+$/g, ""))
    .join("\n");
}

/** Alle in einer Vorlage verwendeten Platzhalter (normalisiert). */
export function extractPlaceholders(template: string): { key: string; hasFallback: boolean }[] {
  const found = new Map<string, boolean>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    const key = normalizeKey(m[1] ?? "");
    found.set(key, (found.get(key) ?? false) || m[2] !== undefined);
  }
  return [...found.entries()].map(([key, hasFallback]) => ({ key, hasFallback }));
}

export function usesPlaceholder(template: string, key: string): boolean {
  return extractPlaceholders(template).some((p) => p.key === key);
}

export interface VariableInfo {
  key: string;
  label: string;
  example: string;
  group: "kontakt" | "absender" | "system";
}

/** Standard-Platzhalter, die immer verfügbar sind. */
export const STANDARD_VARIABLES: VariableInfo[] = [
  { key: "anrede", label: "Anrede (Herr/Frau)", example: "Frau", group: "kontakt" },
  { key: "vorname", label: "Vorname", example: "Julia", group: "kontakt" },
  { key: "nachname", label: "Nachname", example: "Becker", group: "kontakt" },
  { key: "firma", label: "Firma", example: "Becker Logistik GmbH", group: "kontakt" },
  { key: "position", label: "Position", example: "Geschäftsführerin", group: "kontakt" },
  { key: "website", label: "Website", example: "becker-logistik.de", group: "kontakt" },
  { key: "email", label: "E-Mail des Kontakts", example: "julia@becker-logistik.de", group: "kontakt" },
  { key: "ki_einstieg", label: "KI-Einstieg (persönlicher erster Satz)", example: "Ihr neues Lager in Kassel ...", group: "system" },
  { key: "absender_name", label: "Absender: Name", example: "Max Mustermann", group: "absender" },
  { key: "absender_vorname", label: "Absender: Vorname", example: "Max", group: "absender" },
  { key: "absender_email", label: "Absender: E-Mail", example: "max@firma.de", group: "absender" },
  { key: "signatur", label: "Signatur des Postfachs", example: "Max Mustermann\nFirma GmbH", group: "absender" },
  { key: "abmelden_link", label: "Abmelde-Link", example: "https://…/u/…", group: "system" },
];

export const STANDARD_KEYS = new Set(STANDARD_VARIABLES.map((v) => v.key));
