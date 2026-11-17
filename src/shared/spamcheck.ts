import type { SpamCheckResult, SpamFinding } from "./types";
import { extractPlaceholders } from "./template";

// Lokaler Spam-Check für Cold-Emails. Bewertet typische Auslöser von Spamfiltern
// und gibt konkrete, verständliche Tipps. Kein externer Dienst nötig.

const SPAM_PHRASES: { pattern: RegExp; label: string; weight: number }[] = [
  { pattern: /\bkostenlos\w*/i, label: "„kostenlos“", weight: 2 },
  { pattern: /\bgratis\b/i, label: "„gratis“", weight: 2 },
  { pattern: /\b100\s?%/i, label: "„100 %“", weight: 2 },
  { pattern: /\bgarantiert\w*/i, label: "„garantiert“", weight: 2 },
  { pattern: /\brisikofrei\b/i, label: "„risikofrei“", weight: 2 },
  { pattern: /\bjetzt kaufen\b/i, label: "„jetzt kaufen“", weight: 3 },
  { pattern: /\b(hier|jetzt) klicken\b|\bklicken sie hier\b/i, label: "„hier klicken“", weight: 3 },
  { pattern: /\bnur (heute|noch heute|für kurze zeit)\b/i, label: "künstliche Verknappung („nur heute“)", weight: 3 },
  { pattern: /\b(einmalig\w*|limitiert\w*)\b/i, label: "„einmalig/limitiert“", weight: 1 },
  { pattern: /\bdringend\b/i, label: "„dringend“", weight: 2 },
  { pattern: /\brabatt\w*/i, label: "„Rabatt“", weight: 2 },
  { pattern: /\bsonderangebot\w*/i, label: "„Sonderangebot“", weight: 2 },
  { pattern: /\bgewinn(spiel|en sie|er)\b/i, label: "„Gewinn…“", weight: 3 },
  { pattern: /\bgeld verdienen\b/i, label: "„Geld verdienen“", weight: 3 },
  { pattern: /\bschnell reich\b/i, label: "„schnell reich“", weight: 3 },
  { pattern: /\bkeine kosten\b/i, label: "„keine Kosten“", weight: 1 },
  { pattern: /\bfree\b/i, label: "„free“", weight: 2 },
  { pattern: /\bguarantee\w*/i, label: "„guarantee“", weight: 2 },
  { pattern: /\b(act|buy|order) now\b/i, label: "„act/buy now“", weight: 3 },
  { pattern: /\bclick here\b/i, label: "„click here“", weight: 3 },
  { pattern: /\blimited time\b/i, label: "„limited time“", weight: 2 },
  { pattern: /\b(winner|cash bonus|risk[- ]free|no obligation)\b/i, label: "englische Werbefloskel", weight: 2 },
  { pattern: /\burgent\b/i, label: "„urgent“", weight: 2 },
];

const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|tiny\.cc)\//i;
const URL_RE = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;

export interface SpamCheckInput {
  subject: string;
  body: string;
  /** Erster Schritt (Erstkontakt) – Links wiegen hier schwerer. */
  isFirstStep: boolean;
}

export function checkSpam(input: SpamCheckInput): SpamCheckResult {
  const findings: SpamFinding[] = [];
  let score = 0;
  const add = (severity: SpamFinding["severity"], message: string, points: number) => {
    findings.push({ severity, message });
    score += points;
  };

  const subject = input.subject.trim();
  const body = input.body;
  const bodyNoPlaceholders = body.replace(/\{\{[^}]*\}\}/g, "X");
  const words = bodyNoPlaceholders.split(/\s+/).filter(Boolean);

  // Betreff
  if (input.isFirstStep) {
    if (!subject) add("high", "Der Betreff fehlt.", 3);
    else {
      if (subject.length > 60) add("warn", "Betreff ist lang (über 60 Zeichen). Kurz und neutral wirkt persönlicher, z. B. „Frage zu {{firma}}“.", 1);
      if (/!/.test(subject)) add("warn", "Ausrufezeichen im Betreff wirken werblich.", 1);
      if (/^(re|aw|fwd?|wg)\s*:/i.test(subject)) add("high", "Betreff täuscht eine Antwort/Weiterleitung vor (Re:/Fwd:). Das schadet dem Vertrauen und der Zustellbarkeit.", 3);
      if (countShouting(subject) > 0) add("warn", "Wörter in GROSSBUCHSTABEN im Betreff vermeiden.", 1);
    }
  }

  // Länge
  if (words.length > 200) add("warn", `Der Text ist mit ${words.length} Wörtern lang. Cold-Emails mit 50–125 Wörtern bekommen die meisten Antworten.`, 1);
  if (words.length > 0 && words.length < 15) add("info", "Sehr kurzer Text – passt er wirklich zum Anliegen?", 0);

  // Links
  const urls = body.match(URL_RE) ?? [];
  if (urls.some((u) => SHORTENERS.test(u + "/"))) add("high", "Link-Kürzer (bit.ly & Co.) werden von Spamfiltern stark abgestraft. Bitte die vollständige Adresse verwenden.", 3);
  if (urls.length > 2) add("warn", `${urls.length} Links im Text. Höchstens 1–2 Links verwenden.`, 2);
  else if (input.isFirstStep && urls.length > 0) add("info", "Tipp: Im Erstkontakt möglichst ganz ohne Links schreiben – das verbessert die Zustellbarkeit.", 0.5);

  // Reizwörter
  const hits = SPAM_PHRASES.filter((p) => p.pattern.test(subject) || p.pattern.test(body));
  for (const h of hits) {
    add(h.weight >= 3 ? "high" : "warn", `Reizwort ${h.label} – besser sachlich formulieren.`, h.weight);
  }

  // Satzzeichen & Großbuchstaben
  const exclamations = (body.match(/!/g) ?? []).length;
  if (/!{2,}/.test(body)) add("high", "Mehrere Ausrufezeichen hintereinander („!!“) vermeiden.", 2);
  else if (exclamations > 2) add("warn", `${exclamations} Ausrufezeichen – ruhiger formulieren wirkt seriöser.`, 1);
  if (countShouting(body) > 2) add("warn", "Mehrere Wörter in GROSSBUCHSTABEN – wirkt wie Werbung.", 1);
  if (/(€|\$)\s?\d|\d\s?(€|\$|euro)/i.test(body)) add("info", "Preise im Erstkontakt eher weglassen – erst Interesse wecken.", 0.5);

  // Format
  if (/<\/?(html|body|div|p|span|img|table|a)\b/i.test(body)) add("warn", "HTML-Elemente gefunden. Reiner Text wirkt wie eine persönliche E-Mail und landet seltener im Spam.", 1);
  if (/\p{Extended_Pictographic}/u.test(subject + body)) add("info", "Emojis wirken in geschäftlichen Erstkontakten oft werblich.", 0.5);

  // Personalisierung
  const placeholders = extractPlaceholders(subject + "\n" + body).map((p) => p.key);
  const personal = placeholders.some((k) => !["signatur", "abmelden_link", "absender_name", "absender_vorname", "absender_email"].includes(k));
  if (input.isFirstStep && !personal) add("warn", "Keine Personalisierung gefunden. Mindestens {{vorname}}, {{firma}} oder {{ki_einstieg}} verwenden – identische Massen-Texte fallen Spamfiltern auf.", 2);

  const rounded = Math.round(score * 10) / 10;
  const level: SpamCheckResult["level"] = rounded >= 5 ? "hoch" : rounded >= 2 ? "mittel" : "niedrig";
  if (findings.length === 0) findings.push({ severity: "info", message: "Keine Auffälligkeiten gefunden." });
  return { score: rounded, level, findings };
}

function countShouting(text: string): number {
  return (text.replace(/\{\{[^}]*\}\}/g, "").match(/\b[A-ZÄÖÜ]{4,}\b/g) ?? []).filter((w) => !KNOWN_ACRONYMS.has(w)).length;
}

const KNOWN_ACRONYMS = new Set(["GMBH", "DSGVO", "HTML", "CRM", "ERP", "SAAS", "B2B", "B2C", "KMU", "IHK", "HTTP", "HTTPS", "API", "SEO", "USA", "EU"]);
