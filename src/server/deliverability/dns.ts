import { Resolver } from "node:dns/promises";
import type { CheckItem, CheckStatus, DomainCheckResult } from "../../shared/types";

export interface DnsResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
}

export function createSystemResolver(): DnsResolver {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  return {
    resolveMx: (d) => resolver.resolveMx(d),
    resolveTxt: (n) => resolver.resolveTxt(n),
    resolve4: (n) => resolver.resolve4(n),
  };
}

const NOT_FOUND = new Set(["ENODATA", "ENOTFOUND", "ENONAME", "NXDOMAIN"]);

/** Liefert [] bei "kein Eintrag" und wirft nur bei echten DNS-Problemen (Timeout usw.). */
async function lookup<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (NOT_FOUND.has(code)) return [];
    throw err;
  }
}

async function txt(dns: DnsResolver, name: string): Promise<string[]> {
  const records = await lookup(() => dns.resolveTxt(name));
  return records.map((chunks) => chunks.join(""));
}

export function analyzeMx(records: { exchange: string; priority: number }[]): CheckItem {
  if (records.length === 0) {
    return {
      status: "error",
      title: "MX-Eintrag",
      detail: "Für die Domain ist kein MX-Eintrag vorhanden – Antworten und Bounces können nicht empfangen werden.",
      fix: { steps: ["In der Google-Admin-Konsole die Domain einrichten und die angezeigten MX-Einträge beim Domain-Anbieter eintragen."] },
    };
  }
  const hosts = [...records].sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());
  const google = hosts.some((h) => /(^|\.)google\.com$|(^|\.)googlemail\.com$/.test(h));
  return {
    status: google ? "ok" : "warn",
    title: "MX-Eintrag",
    detail: google
      ? "Die Domain empfängt E-Mails über Google."
      : "Die Domain empfängt E-Mails nicht über Google. Das ist in Ordnung, wenn die Postfächer bewusst woanders liegen.",
    found: hosts,
  };
}

export function analyzeSpf(records: string[], provider: "google" | "other" = "google"): CheckItem {
  const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  const suggested = provider === "google" ? "v=spf1 include:_spf.google.com ~all" : "v=spf1 include:<SPF-Domain Ihres Anbieters> ~all";
  if (spf.length === 0) {
    return {
      status: "error",
      title: "SPF",
      detail: "Kein SPF-Eintrag gefunden. Ohne SPF lehnen Gmail & Co. Mails zunehmend ab.",
      fix: { host: "@", type: "TXT", value: suggested },
    };
  }
  if (spf.length > 1) {
    return {
      status: "error",
      title: "SPF",
      detail: "Es gibt mehrere SPF-Einträge. Erlaubt ist genau einer – bitte zu einem Eintrag zusammenführen.",
      found: spf,
      fix: { host: "@", type: "TXT", value: suggested },
    };
  }
  const record = spf[0] ?? "";
  const lower = record.toLowerCase();
  const lookups = (lower.match(/\b(include:|a\b|a:|mx\b|mx:|ptr|exists:|redirect=)/g) ?? []).length;
  if (/[+]all\b/.test(lower)) {
    return { status: "error", title: "SPF", detail: "„+all“ erlaubt jedem Server, in Ihrem Namen zu senden. Bitte auf „~all“ ändern.", found: spf, fix: { host: "@", type: "TXT", value: record.replace(/\+all/i, "~all") } };
  }
  if (provider === "google" && !lower.includes("include:_spf.google.com")) {
    const fixed = record.replace(/\s+([~\-?]all)/i, " include:_spf.google.com $1");
    return {
      status: "warn",
      title: "SPF",
      detail: "Der SPF-Eintrag erlaubt Google nicht als Absender. Bitte „include:_spf.google.com“ ergänzen.",
      found: spf,
      fix: { host: "@", type: "TXT", value: fixed.includes("_spf.google.com") ? fixed : suggested },
    };
  }
  if (lookups > 10) {
    return { status: "warn", title: "SPF", detail: `Der SPF-Eintrag braucht vermutlich mehr als 10 DNS-Abfragen (${lookups}). Das führt zu Fehlern bei der Prüfung.`, found: spf };
  }
  if (/\?all\b/.test(lower)) {
    return { status: "warn", title: "SPF", detail: "„?all“ ist sehr schwach. Empfohlen ist „~all“.", found: spf };
  }
  return { status: "ok", title: "SPF", detail: "SPF ist korrekt eingerichtet.", found: spf };
}

export function analyzeDkim(records: string[], selector: string): CheckItem {
  const dkim = records.filter((r) => /v=DKIM1|(^|;)\s*p=/i.test(r));
  const steps = [
    "Google-Admin-Konsole öffnen: Apps → Google Workspace → Gmail → E-Mails authentifizieren.",
    "Domain auswählen und „Neuen Eintrag generieren“ (2048 Bit) klicken.",
    `Den angezeigten TXT-Eintrag beim Domain-Anbieter unter „${selector}._domainkey“ anlegen.`,
    "Nach einigen Minuten in der Admin-Konsole „Authentifizierung starten“ klicken.",
  ];
  if (dkim.length === 0) {
    return {
      status: "error",
      title: "DKIM",
      detail: `Kein DKIM-Schlüssel unter „${selector}._domainkey“ gefunden. Ohne DKIM landen Mails deutlich häufiger im Spam.`,
      fix: { host: `${selector}._domainkey`, type: "TXT", steps },
    };
  }
  const record = dkim[0] ?? "";
  if (/(^|;)\s*p=\s*(;|$)/i.test(record)) {
    return { status: "error", title: "DKIM", detail: "Der DKIM-Schlüssel ist leer (widerrufen).", found: dkim, fix: { host: `${selector}._domainkey`, type: "TXT", steps } };
  }
  return { status: "ok", title: "DKIM", detail: `DKIM-Schlüssel unter „${selector}._domainkey“ gefunden.`, found: [record.length > 90 ? `${record.slice(0, 90)}…` : record] };
}

export function analyzeDmarc(records: string[], domain: string): CheckItem {
  const dmarc = records.filter((r) => /^v=DMARC1/i.test(r.trim()));
  const suggested = `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; adkim=r; aspf=r`;
  if (dmarc.length === 0) {
    return {
      status: "warn",
      title: "DMARC",
      detail: "Kein DMARC-Eintrag gefunden. Gmail und Yahoo verlangen DMARC für größere Mengen. Ein Eintrag mit „p=none“ genügt für den Anfang.",
      fix: { host: "_dmarc", type: "TXT", value: suggested },
    };
  }
  if (dmarc.length > 1) {
    return { status: "error", title: "DMARC", detail: "Mehrere DMARC-Einträge gefunden – erlaubt ist genau einer.", found: dmarc, fix: { host: "_dmarc", type: "TXT", value: suggested } };
  }
  const record = dmarc[0] ?? "";
  const policy = /(^|;)\s*p=\s*(none|quarantine|reject)/i.exec(record)?.[2]?.toLowerCase();
  if (!policy) {
    return { status: "error", title: "DMARC", detail: "Der DMARC-Eintrag hat keine gültige Richtlinie (p=…).", found: dmarc, fix: { host: "_dmarc", type: "TXT", value: suggested } };
  }
  return {
    status: "ok",
    title: "DMARC",
    detail:
      policy === "none"
        ? "DMARC ist eingerichtet (p=none). Das erfüllt die Anforderungen; später kann auf „quarantine“ verschärft werden."
        : `DMARC ist eingerichtet (p=${policy}).`,
    found: dmarc,
  };
}

function worst(items: CheckItem[]): CheckStatus {
  if (items.some((i) => i.status === "error")) return "error";
  if (items.some((i) => i.status === "warn")) return "warn";
  return "ok";
}

function lookupFailed(title: string, err: unknown): CheckItem {
  return { status: "warn", title, detail: `DNS-Abfrage fehlgeschlagen (${(err as Error).message ?? err}). Bitte später erneut prüfen.` };
}

export async function checkDomain(dns: DnsResolver, domain: string, selector: string): Promise<DomainCheckResult> {
  const [mx, spf, dkim, dmarc] = await Promise.all([
    lookup(() => dns.resolveMx(domain)).then(analyzeMx, (e) => lookupFailed("MX-Eintrag", e)),
    txt(dns, domain).then((r) => analyzeSpf(r), (e) => lookupFailed("SPF", e)),
    txt(dns, `${selector}._domainkey.${domain}`).then((r) => analyzeDkim(r, selector), (e) => lookupFailed("DKIM", e)),
    txt(dns, `_dmarc.${domain}`).then((r) => analyzeDmarc(r, domain), (e) => lookupFailed("DMARC", e)),
  ]);
  return { mx, spf, dkim, dmarc, overall: worst([mx, spf, dkim, dmarc]) };
}

/** Kann die Domain E-Mails empfangen? (MX, ersatzweise A-Eintrag). null = unbekannt (DNS-Fehler). */
export async function domainAcceptsMail(dns: DnsResolver, domain: string): Promise<boolean | null> {
  try {
    const mx = await lookup(() => dns.resolveMx(domain));
    if (mx.length > 0) return !(mx.length === 1 && mx[0]?.exchange === ""); // "Null MX" (RFC 7505)
    const a = await lookup(() => dns.resolve4(domain));
    return a.length > 0;
  } catch {
    return null;
  }
}
