// Prüfung von E-Mail-Adressen ohne Netzwerkzugriff (Syntax, Rollen-, Freemail- und Wegwerf-Adressen).

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function normalizeEmail(raw: string): string {
  return raw.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
}

export function isValidEmailSyntax(email: string): boolean {
  if (email.length > 254) return false;
  if (!EMAIL_RE.test(email)) return false;
  const [local] = email.split("@");
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return true;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

const ROLE_LOCAL_PARTS = new Set([
  "info", "kontakt", "contact", "office", "mail", "post", "hello", "hallo", "hi", "support", "service", "sales",
  "vertrieb", "verkauf", "admin", "administrator", "webmaster", "postmaster", "hostmaster", "noreply", "no-reply",
  "donotreply", "buchhaltung", "rechnung", "rechnungen", "invoice", "billing", "bewerbung", "jobs", "karriere",
  "career", "careers", "presse", "press", "marketing", "team", "empfang", "zentrale", "anfrage", "anfragen",
  "kundenservice", "datenschutz", "privacy", "abuse", "security", "it", "hr", "personal",
]);

const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com", "web.de", "t-online.de",
  "yahoo.com", "yahoo.de", "ymail.com", "hotmail.com", "hotmail.de", "outlook.com", "outlook.de", "live.com",
  "live.de", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "aol.de", "freenet.de", "posteo.de",
  "posteo.net", "mailbox.org", "protonmail.com", "proton.me", "pm.me", "arcor.de", "online.de", "email.de",
  "magenta.de", "vodafone.de", "bluewin.ch", "aon.at", "chello.at", "kabelmail.de", "yandex.com", "mail.ru",
]);

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.de", "10minutemail.com", "temp-mail.org", "yopmail.com",
  "trashmail.com", "trashmail.de", "wegwerfemail.de", "sharklasers.com", "getnada.com", "dispostable.com",
  "maildrop.cc", "throwawaymail.com", "mailnesia.com", "spambog.com", "spamgourmet.com", "fakeinbox.com",
  "tempmail.dev", "emailondeck.com", "mohmal.com", "einrot.com", "byom.de",
]);

export type EmailFlag = "role" | "freemail" | "disposable" | "no_mx";

export interface EmailCheck {
  email: string;
  valid: boolean;
  reason?: string;
  flags: EmailFlag[];
}

export function checkEmailOffline(raw: string): EmailCheck {
  const email = normalizeEmail(raw);
  if (!email) return { email, valid: false, reason: "Keine E-Mail-Adresse", flags: [] };
  if (!isValidEmailSyntax(email)) return { email, valid: false, reason: "Ungültiges Format", flags: [] };
  const flags: EmailFlag[] = [];
  const local = email.slice(0, email.lastIndexOf("@"));
  const domain = domainOf(email);
  if (ROLE_LOCAL_PARTS.has(local.split("+")[0] ?? "")) flags.push("role");
  if (FREEMAIL_DOMAINS.has(domain)) flags.push("freemail");
  if (DISPOSABLE_DOMAINS.has(domain)) {
    flags.push("disposable");
    return { email, valid: false, reason: "Wegwerf-Adresse", flags };
  }
  return { email, valid: true, flags };
}

export const FLAG_LABELS: Record<EmailFlag, string> = {
  role: "Rollenadresse (info@, kontakt@ …)",
  freemail: "Private Freemail-Adresse",
  disposable: "Wegwerf-Adresse",
  no_mx: "Domain kann keine E-Mails empfangen",
};
