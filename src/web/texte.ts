// Zentrale deutsche Bezeichnungen für Status-Werte und längere Hilfetexte.
import type {
  AiStatus,
  CampaignLeadStatus,
  CampaignStatus,
  InboundKind,
  LeadStatus,
  MailboxStatus,
  ReplyCategory,
} from "../shared/types";

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; color: string }> = {
  draft: { label: "Entwurf", color: "gray" },
  active: { label: "Läuft", color: "teal" },
  paused: { label: "Pausiert", color: "yellow" },
  completed: { label: "Abgeschlossen", color: "blue" },
};

export const CAMPAIGN_LEAD_STATUS: Record<CampaignLeadStatus, { label: string; color: string }> = {
  queued: { label: "Wartet", color: "gray" },
  active: { label: "In Sequenz", color: "blue" },
  finished: { label: "Sequenz beendet", color: "dark" },
  replied: { label: "Hat geantwortet", color: "teal" },
  bounced: { label: "Unzustellbar", color: "red" },
  unsubscribed: { label: "Abgemeldet", color: "orange" },
  skipped: { label: "Übersprungen", color: "gray" },
  error: { label: "Fehler", color: "red" },
};

export const LEAD_STATUS: Record<LeadStatus, { label: string; color: string }> = {
  active: { label: "Aktiv", color: "teal" },
  unsubscribed: { label: "Abgemeldet", color: "orange" },
  bounced: { label: "Unzustellbar", color: "red" },
  invalid: { label: "Ungültig", color: "gray" },
};

export const MAILBOX_STATUS: Record<MailboxStatus, { label: string; color: string }> = {
  active: { label: "Aktiv", color: "teal" },
  paused: { label: "Pausiert", color: "yellow" },
  error: { label: "Fehler", color: "red" },
};

export const AI_STATUS: Record<AiStatus, { label: string; color: string }> = {
  none: { label: "Noch nicht erstellt", color: "gray" },
  pending: { label: "In Warteschlange", color: "gray" },
  generating: { label: "Wird erstellt …", color: "blue" },
  done: { label: "Zur Prüfung", color: "yellow" },
  approved: { label: "Freigegeben", color: "teal" },
  error: { label: "Fehler", color: "red" },
};

export const INBOUND_KIND: Record<InboundKind, { label: string; color: string }> = {
  reply: { label: "Antwort", color: "teal" },
  auto_reply: { label: "Abwesenheitsnotiz", color: "gray" },
  bounce: { label: "Unzustellbar", color: "red" },
  unsubscribe: { label: "Abmeldung", color: "orange" },
};

export const REPLY_CATEGORY: Record<ReplyCategory, { label: string; color: string }> = {
  interessiert: { label: "Interessiert", color: "teal" },
  spaeter: { label: "Später melden", color: "cyan" },
  frage: { label: "Hat eine Frage", color: "blue" },
  kein_interesse: { label: "Kein Interesse", color: "gray" },
  abmelden: { label: "Möchte abgemeldet werden", color: "orange" },
  falsche_person: { label: "Falsche Person", color: "grape" },
  abwesend: { label: "Abwesend", color: "gray" },
  sonstiges: { label: "Sonstiges", color: "dark" },
};

export const WEEKDAYS = [
  { value: "1", label: "Mo" },
  { value: "2", label: "Di" },
  { value: "3", label: "Mi" },
  { value: "4", label: "Do" },
  { value: "5", label: "Fr" },
  { value: "6", label: "Sa" },
  { value: "7", label: "So" },
];

export const LEGAL_NOTICE = {
  title: "Wichtig: Rechtliche Lage bei Cold-Emails",
  paragraphs: [
    "In Deutschland ist Werbung per E-Mail nach § 7 Abs. 2 Nr. 2 UWG grundsätzlich nur mit vorheriger ausdrücklicher Einwilligung erlaubt – auch gegenüber Unternehmen (B2B). Verstöße können abgemahnt werden. In Österreich und der Schweiz gelten ähnlich strenge Regeln, andere Länder haben eigene Vorgaben.",
    "Bitte lassen Sie Ihr Vorgehen rechtlich prüfen. Die Plattform unterstützt Sie bei den Pflichten (Abmeldemöglichkeit in jeder Mail, Sperrliste, Impressum und Datenschutz-Link in der Signatur, sparsame Datenhaltung), kann aber unerlaubte Werbung nicht zulässig machen.",
    "Datenschutz (DSGVO): Für die Verarbeitung der Kontaktdaten brauchen Sie eine Rechtsgrundlage und müssen die Betroffenen informieren. Mit Google (Postfächer) und Anthropic (KI-Funktionen) sollten Auftragsverarbeitungsverträge bestehen.",
  ],
};
