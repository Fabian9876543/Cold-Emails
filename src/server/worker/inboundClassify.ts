import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import { DateTime } from "luxon";
import { snippet, stripQuotedText } from "../../shared/quote";

// Einordnung eingehender Mails: Bounce, Abwesenheitsnotiz, Abmeldung oder echte Antwort.

export interface BounceInfo {
  recipients: string[];
  hard: boolean;
  status: string | null;
  diagnostic: string | null;
  originalMessageIds: string[];
}

export interface InboundAnalysis {
  kind: "bounce" | "auto_reply" | "reply" | "unsubscribe";
  fromEmail: string;
  fromName: string;
  subject: string;
  messageId: string | null;
  /** In-Reply-To und References (Message-IDs mit spitzen Klammern). */
  refs: string[];
  /** Antworttext ohne zitierten Verlauf. */
  text: string;
  snippet: string;
  date: number | null;
  bounce?: BounceInfo;
  returnDate?: string | null;
}

const BOUNCE_SENDERS = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon|mailer_daemon)$/i;
const AUTO_REPLY_SUBJECT =
  /^(automatische antwort|automatic reply|auto(matic)?[- ]?reply|autoreply|abwesenheitsnotiz|abwesenheit|abwesend|out of (the )?office|ooo\b|urlaubsbedingt|im urlaub|nicht im büro|außer haus|ausser haus|vacation|r[ée]ponse automatique|risposta automatica)/i;
const UNSUBSCRIBE_INTENT =
  /\b(abmelden|abmeldung|abbestellen|austragen|unsubscribe|remove me|opt[- ]?out|keine (weiteren )?(e-?mails|mails|nachrichten|werbung|kontaktaufnahmen?)|nicht mehr (kontaktieren|anschreiben|schreiben|anmailen|belästigen)|bitte (aus (ihrem|dem) verteiler )?(entfernen|löschen)|aus (dem|ihrem) verteiler|(schreiben|kontaktieren|anschreiben|mailen|senden) sie (mir|uns) (bitte )?(keine|nicht mehr))\b/i;
const HARD_BOUNCE_TEXT =
  /(user unknown|unknown user|does not exist|doesn't exist|no such user|address not found|adresse nicht gefunden|nicht gefunden|unbekannt|existiert nicht|mailbox unavailable|invalid recipient|recipient rejected|recipient address rejected|account (has been )?disabled|no mailbox|mailbox not found|unrouteable|domain not found)/i;
const SOFT_BOUNCE_TEXT = /(mailbox (is )?full|over quota|quota exceeded|temporar|vorübergehend|delayed|verzögert|try again later|zustellung verzögert|delivery delayed)/i;

function addresses(obj: AddressObject | AddressObject[] | undefined): { address: string; name: string }[] {
  if (!obj) return [];
  const list = Array.isArray(obj) ? obj : [obj];
  return list.flatMap((o) => o.value).map((v) => ({ address: (v.address ?? "").toLowerCase(), name: v.name ?? "" }));
}

function headerValue(mail: ParsedMail, name: string): string {
  const v = mail.headers.get(name);
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "value" in (v as object)) return String((v as { value: unknown }).value ?? "");
  return String(v);
}

function messageIdsIn(text: string): string[] {
  return [...new Set((text.match(/<[^<>\s]+@[^<>\s]+>/g) ?? []).map((m) => m.trim()))];
}

function refsOf(mail: ParsedMail): string[] {
  const refs = new Set<string>();
  const add = (v: string | string[] | undefined) => {
    if (!v) return;
    for (const x of Array.isArray(v) ? v : [v]) for (const id of messageIdsIn(x)) refs.add(id);
  };
  add(mail.inReplyTo);
  add(mail.references);
  return [...refs];
}

function parseDsn(text: string): { recipients: string[]; status: string | null; diagnostic: string | null } {
  const recipients = [...text.matchAll(/^(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/gim)].map((m) => (m[1] ?? "").toLowerCase());
  const status = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(text)?.[1] ?? null;
  const diagnostic = /^Diagnostic-Code:\s*(?:smtp;)?\s*(.+(?:\n[ \t].+)*)/im.exec(text)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  return { recipients: [...new Set(recipients)], status, diagnostic };
}

function analyzeBounce(mail: ParsedMail, text: string): BounceInfo {
  const parts: string[] = [];
  const originalIds = new Set<string>(refsOf(mail));
  for (const att of mail.attachments ?? []) {
    const ct = (att.contentType ?? "").toLowerCase();
    const content = att.content?.toString("utf8") ?? "";
    if (ct === "message/delivery-status" || ct === "message/global-delivery-status") parts.push(content);
    if (ct === "message/rfc822" || ct === "text/rfc822-headers" || ct === "message/rfc822-headers") {
      const mid = /^Message-ID:\s*(<[^>]+>)/im.exec(content)?.[1];
      if (mid) originalIds.add(mid.trim());
    }
  }
  // Manche Server hängen den Original-Header als Text an
  const inlineMid = /^Message-ID:\s*(<[^>]+>)/im.exec(text)?.[1];
  if (inlineMid) originalIds.add(inlineMid.trim());

  // mailparser liefert message/delivery-status teils als Text, teils als Anhang
  const dsn = parseDsn(`${parts.join("\n")}\n${text}`);
  const failed = headerValue(mail, "x-failed-recipients")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
  const recipients = [...new Set([...failed, ...dsn.recipients])];
  const status = dsn.status ?? /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1] ?? null;
  const diagnostic = dsn.diagnostic ?? (snippet(text, 300) || null);
  let hard: boolean;
  if (status) hard = status.startsWith("5");
  else hard = HARD_BOUNCE_TEXT.test(text) && !SOFT_BOUNCE_TEXT.test(text);
  if (/delay|verzögert/i.test(mail.subject ?? "")) hard = false;
  return { recipients, hard, status, diagnostic, originalMessageIds: [...originalIds] };
}

const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, april: 4, apr: 4, mai: 5, juni: 6, jun: 6, juli: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
};

/** Sucht ein Rückkehrdatum ("bis 14.03.", "ab dem 3. März wieder", "back on 2025-03-14"). */
export function findReturnDate(text: string, now: number, zone = "Europe/Berlin"): string | null {
  const today = DateTime.fromMillis(now, { zone }).startOf("day");
  const build = (d: number, m: number, y?: number) => {
    let year = y ? (y < 100 ? 2000 + y : y) : today.year;
    let dt = DateTime.fromObject({ year, month: m, day: d }, { zone });
    if (!dt.isValid) return null;
    if (!y && dt < today.minus({ days: 1 })) {
      year += 1;
      dt = DateTime.fromObject({ year, month: m, day: d }, { zone });
    }
    if (dt < today.minus({ days: 1 }) || dt > today.plus({ days: 120 })) return null;
    return dt.toISODate();
  };
  const ctx = /(bis|ab|zurück|wieder|until|back|return)/i;
  const numeric = /(?:bis|ab|zurück am|wieder (?:da|erreichbar|im büro)?\s*(?:ab|am)?|until|back on|returning on)?\s*(?:einschließlich\s*)?(?:dem|zum)?\s*(\d{1,2})\.\s?(\d{1,2})\.(\d{2,4})?/gi;
  for (const m of text.matchAll(numeric)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + m[0].length);
    if (!ctx.test(before)) continue;
    const r = build(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
    if (r) return r;
  }
  const named = /(\d{1,2})\.\s*(januar|jan|februar|feb|märz|maerz|mär|april|apr|mai|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|dezember|dez)\.?\s*(\d{4})?/gi;
  for (const m of text.matchAll(named)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + m[0].length);
    if (!ctx.test(before)) continue;
    const r = build(Number(m[1]), MONTHS[(m[2] ?? "").toLowerCase()] ?? 0, m[3] ? Number(m[3]) : undefined);
    if (r) return r;
  }
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso && ctx.test(text)) return build(Number(iso[3]), Number(iso[2]), Number(iso[1]));
  return null;
}

export async function analyzeInbound(raw: Buffer, now: number = Date.now()): Promise<InboundAnalysis> {
  const mail = await simpleParser(raw, { skipHtmlToText: false, skipImageLinks: true, skipTextToHtml: true });
  const from = addresses(mail.from)[0] ?? { address: "", name: "" };
  const subject = (mail.subject ?? "").trim();
  const fullText = (mail.text ?? "").replace(/\r\n/g, "\n");
  const text = stripQuotedText(fullText);
  const base = {
    fromEmail: from.address,
    fromName: from.name,
    subject,
    messageId: mail.messageId ? mail.messageId.trim() : null,
    refs: refsOf(mail),
    text,
    snippet: snippet(text || fullText, 600),
    date: mail.date ? mail.date.getTime() : null,
  };

  const localPart = from.address.split("@")[0] ?? "";
  const ct = mail.headers.get("content-type") as { value?: string; params?: Record<string, string> } | string | undefined;
  const reportType = typeof ct === "object" && ct ? (ct.params?.["report-type"] ?? "").toLowerCase() : /report-type="?([\w-]+)/i.exec(String(ct ?? ""))?.[1]?.toLowerCase() ?? "";
  const isBounce =
    BOUNCE_SENDERS.test(localPart) ||
    /mail delivery (subsystem|system)|mail delivery failure|delivery status notification/i.test(from.name) ||
    reportType === "delivery-status" ||
    !!headerValue(mail, "x-failed-recipients") ||
    (mail.attachments ?? []).some((a) => (a.contentType ?? "").toLowerCase() === "message/delivery-status");
  if (isBounce) {
    const bounce = analyzeBounce(mail, fullText);
    return { ...base, kind: "bounce", bounce, snippet: bounce.diagnostic ?? base.snippet };
  }

  const autoSubmitted = headerValue(mail, "auto-submitted").toLowerCase();
  const precedence = headerValue(mail, "precedence").toLowerCase();
  const isAuto =
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    !!headerValue(mail, "x-autoreply") ||
    !!headerValue(mail, "x-autorespond") ||
    !!headerValue(mail, "x-autoresponse") ||
    ["auto_reply", "bulk", "junk"].includes(precedence) ||
    AUTO_REPLY_SUBJECT.test(subject.replace(/^(re|aw|antw|wg|fwd?):\s*/i, ""));
  if (isAuto) {
    return { ...base, kind: "auto_reply", returnDate: findReturnDate(fullText, now) };
  }

  const head = `${subject}\n${text.slice(0, 600)}`;
  if (UNSUBSCRIBE_INTENT.test(head) || /^\s*stop\s*$/i.test(text)) {
    return { ...base, kind: "unsubscribe" };
  }
  return { ...base, kind: "reply" };
}
