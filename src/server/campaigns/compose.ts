import crypto from "node:crypto";
import type { SecretBox } from "../lib/crypto";
import type { AppSettings } from "../lib/settings";
import type { LeadRow } from "../leads/repo";
import { parseCustom } from "../leads/repo";
import { mailboxDomain, senderFirstName, type MailboxRow } from "../mail/mailboxes";
import type { OutgoingMail } from "../mail/transport";
import type { CampaignLeadRow, CampaignRow, StepRow } from "./repo";
import { greeting, normalizeKey, render, usesPlaceholder } from "../../shared/template";

const OPT_OUT_HINT = /abmelden|abbestellen|austragen|keine weiteren (e-?mails|nachrichten)|melde ich mich nicht mehr|nicht mehr (kontaktieren|anschreiben|schreiben)|unsubscribe|opt[- ]?out/i;

export function unsubscribeToken(secrets: SecretBox, campaignLeadId: number): string {
  return secrets.createToken(`c${campaignLeadId}`);
}

export function unsubscribeUrl(publicBaseUrl: string | null, secrets: SecretBox, campaignLeadId: number | null): string | null {
  if (!publicBaseUrl || campaignLeadId === null) return null;
  return `${publicBaseUrl}/u/${unsubscribeToken(secrets, campaignLeadId)}`;
}

export function mailtoUnsubscribe(mailbox: Pick<MailboxRow, "email">): string {
  return `mailto:${mailbox.email}?subject=Abmelden`;
}

export interface RenderContext {
  campaign: Pick<CampaignRow, "opt_out_mode" | "formality">;
  lead: LeadRow;
  mailbox: MailboxRow;
  campaignLead: Pick<CampaignLeadRow, "id" | "ai_opener" | "ai_status" | "thread_subject"> | null;
  settings: AppSettings;
  publicBaseUrl: string | null;
  secrets: SecretBox;
  /** Betreff des ersten Schritts – für "Re: …" bei Follow-ups ohne eigenen Betreff. */
  firstStepSubject: string;
}

export function buildVariables(rc: RenderContext): Record<string, string> {
  const { lead, mailbox, campaignLead } = rc;
  const custom = parseCustom(lead.custom_json);
  const globals = Object.fromEntries(Object.entries(rc.settings.globalVariables).map(([k, v]) => [normalizeKey(k), v]));
  const link = unsubscribeUrl(rc.publicBaseUrl, rc.secrets, campaignLead?.id ?? null) ?? mailtoUnsubscribe(mailbox);
  const vars: Record<string, string> = {
    ...globals,
    ...custom,
    begruessung: greeting(rc.campaign.formality, lead.salutation, lead.first_name, lead.last_name),
    anrede: lead.salutation,
    vorname: lead.first_name,
    nachname: lead.last_name,
    firma: lead.company,
    position: lead.position,
    website: lead.website,
    email: lead.email,
    absender_name: mailbox.from_name,
    absender_vorname: senderFirstName(mailbox.from_name),
    absender_email: mailbox.email,
    signatur: mailbox.signature,
    abmelden_link: link,
  };
  if (campaignLead?.ai_opener && (campaignLead.ai_status === "approved" || campaignLead.ai_status === "done")) {
    vars.ki_einstieg = campaignLead.ai_opener;
  }
  return vars;
}

export interface RenderedMail {
  subject: string;
  body: string;
  missing: string[];
}

export function renderStep(step: Pick<StepRow, "position" | "subject" | "body">, rc: RenderContext): RenderedMail {
  const vars = buildVariables(rc);
  let subjectTemplate = step.subject.trim();
  let isReply = false;
  if (step.position > 1 && !subjectTemplate) {
    isReply = true;
    subjectTemplate = rc.campaignLead?.thread_subject ?? rc.firstStepSubject;
  }
  const subject = render(subjectTemplate, vars);
  const body = render(step.body, vars);
  const missing = new Set([...subject.missing, ...body.missing]);
  let text = body.text.trim();

  if (!usesPlaceholder(step.body, "signatur") && rc.mailbox.signature.trim()) {
    text += `\n\n${rc.mailbox.signature.trim()}`;
  }
  const mode = rc.campaign.opt_out_mode;
  if (mode === "text" && !usesPlaceholder(step.body, "abmelden_link") && !OPT_OUT_HINT.test(step.body)) {
    text += `\n\n${rc.settings.optOutText.trim()}`;
  } else if (mode === "link" && !usesPlaceholder(step.body, "abmelden_link")) {
    const r = render(rc.settings.optOutLinkText, vars);
    r.missing.forEach((m) => missing.add(m));
    text += `\n\n${r.text.trim()}`;
  }

  let finalSubject = subject.text.trim();
  if (isReply && finalSubject && !/^re:/i.test(finalSubject)) finalSubject = `Re: ${finalSubject}`;
  return { subject: finalSubject, body: text, missing: [...missing] };
}

export function hasOptOut(stepBody: string, mode: CampaignRow["opt_out_mode"]): boolean {
  return mode !== "none" || usesPlaceholder(stepBody, "abmelden_link") || OPT_OUT_HINT.test(stepBody);
}

export function newMessageId(mailbox: Pick<MailboxRow, "email">): string {
  return `<${crypto.randomUUID()}@${mailboxDomain(mailbox.email)}>`;
}

export function buildOutgoing(args: {
  mailbox: MailboxRow;
  lead: Pick<LeadRow, "email" | "first_name" | "last_name">;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  oneClickUrl: string | null;
  now: number;
}): OutgoingMail {
  const toName = `${args.lead.first_name} ${args.lead.last_name}`.trim();
  const listUnsubscribe = [`<${mailtoUnsubscribe(args.mailbox)}>`];
  const headers: Record<string, string> = {};
  if (args.oneClickUrl?.startsWith("https://")) {
    listUnsubscribe.push(`<${args.oneClickUrl}>`);
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  headers["List-Unsubscribe"] = listUnsubscribe.join(", ");
  return {
    from: { name: args.mailbox.from_name, address: args.mailbox.email },
    to: toName ? { name: toName, address: args.lead.email } : { address: args.lead.email },
    subject: args.subject,
    text: args.body,
    messageId: args.messageId,
    inReplyTo: args.inReplyTo ?? undefined,
    references: args.references && args.references.length ? args.references : undefined,
    headers,
    date: new Date(args.now),
  };
}

/** Beispiel-Kontakt für die Vorschau, wenn noch keine Kontakte zugeordnet sind. */
export const SAMPLE_LEAD: LeadRow = {
  id: 0,
  email: "julia.becker@beispiel-logistik.de",
  salutation: "Frau",
  first_name: "Julia",
  last_name: "Becker",
  company: "Becker Logistik GmbH",
  position: "Geschäftsführerin",
  website: "beispiel-logistik.de",
  custom_json: "{}",
  status: "active",
  check_flags: "",
  created_at: 0,
  updated_at: 0,
};
