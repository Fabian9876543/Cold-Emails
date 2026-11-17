// Gemeinsame Datentypen für API (Server) und Oberfläche (Web).

export type MailboxAuthType = "google_app_password" | "google_oauth" | "smtp";
export type Security = "ssl" | "starttls" | "none";
export type MailboxStatus = "active" | "paused" | "error";

export interface MailboxDto {
  id: number;
  email: string;
  fromName: string;
  authType: MailboxAuthType;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: Security;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  imapEnabled: boolean;
  username: string;
  dailyLimit: number;
  warmupEnabled: boolean;
  warmupStart: number;
  warmupStep: number;
  warmupStartedAt: number;
  signature: string;
  status: MailboxStatus;
  lastError: string | null;
  lastErrorAt: number | null;
  pausedUntil: number | null;
  imapError: string | null;
  imapLastPollAt: number | null;
  sentToday: number;
  effectiveLimit: number;
  createdAt: number;
}

export type CheckStatus = "ok" | "warn" | "error";

export interface CheckItem {
  status: CheckStatus;
  title: string;
  detail: string;
  found?: string[];
  /** Fertiger DNS-Eintrag oder Anleitung zum Beheben. */
  fix?: { host?: string; type?: string; value?: string; steps?: string[] };
}

export interface DomainCheckResult {
  mx: CheckItem;
  spf: CheckItem;
  dkim: CheckItem;
  dmarc: CheckItem;
  overall: CheckStatus;
}

export interface DomainDto {
  domain: string;
  dkimSelector: string;
  checkedAt: number | null;
  result: DomainCheckResult | null;
  mailboxes: string[];
}

export type LeadStatus = "active" | "unsubscribed" | "bounced" | "invalid";

export interface LeadDto {
  id: number;
  email: string;
  salutation: string;
  firstName: string;
  lastName: string;
  company: string;
  position: string;
  website: string;
  custom: Record<string, string>;
  status: LeadStatus;
  checkFlags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface LeadListDto {
  id: number;
  name: string;
  createdAt: number;
  leadCount: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ImportPreviewDto {
  importId: string;
  fileName: string;
  headers: string[];
  sample: string[][];
  totalRows: number;
  mapping: Record<string, string>;
}

export interface ImportReportDto {
  listId: number;
  listName: string;
  total: number;
  imported: number;
  updated: number;
  duplicatesInFile: number;
  suppressed: number;
  invalid: { row: number; email: string; reason: string }[];
  warnings: { role: number; freemail: number; disposable: number; noMx: number };
}

export interface SuppressionDto {
  id: number;
  value: string;
  type: "email" | "domain";
  reason: "unsubscribe" | "bounce" | "manual" | "complaint";
  note: string | null;
  createdAt: number;
}

export type CampaignStatus = "draft" | "active" | "paused" | "completed";
export type Formality = "sie" | "du";
export type OptOutMode = "text" | "link" | "none";

export interface CampaignStepDto {
  position: number;
  waitDays: number;
  subject: string;
  body: string;
}

export interface CampaignStats {
  leads: number;
  queued: number;
  active: number;
  finished: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  skipped: number;
  error: number;
  sent: number;
  replyRate: number;
  bounceRate: number;
  aiPending: number;
  aiDone: number;
  aiApproved: number;
  aiError: number;
  perStep: { position: number; sent: number; replies: number }[];
}

export interface CampaignDto {
  id: number;
  name: string;
  status: CampaignStatus;
  pauseReason: string | null;
  timezone: string;
  sendDays: number[];
  windowStart: string;
  windowEnd: string;
  formality: Formality;
  stopOnReplyAll: boolean;
  skipRecentDays: number;
  optOutMode: OptOutMode;
  aiEnabled: boolean;
  aiContext: string;
  aiUseWebsite: boolean;
  aiAutoApprove: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  steps: CampaignStepDto[];
  mailboxIds: number[];
  stats: CampaignStats;
}

export type CampaignLeadStatus =
  | "queued"
  | "active"
  | "finished"
  | "replied"
  | "bounced"
  | "unsubscribed"
  | "skipped"
  | "error";

export type AiStatus = "none" | "pending" | "generating" | "done" | "approved" | "error";

export interface CampaignLeadDto {
  id: number;
  leadId: number;
  email: string;
  name: string;
  company: string;
  website: string;
  status: CampaignLeadStatus;
  statusReason: string | null;
  nextStep: number;
  nextSendAt: number | null;
  mailboxEmail: string | null;
  lastSentAt: number | null;
  aiOpener: string | null;
  aiStatus: AiStatus;
  aiQuality: string | null;
  aiReason: string | null;
  aiError: string | null;
}

export interface PreflightItem {
  code: string;
  message: string;
}

export interface PreflightDto {
  ok: boolean;
  blocking: PreflightItem[];
  warnings: PreflightItem[];
  estimate: { leads: number; emailsTotal: number; perDay: number; days: number };
}

export interface PreviewDto {
  leadId: number | null;
  leadLabel: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  missing: string[];
}

export type InboundKind = "reply" | "auto_reply" | "bounce" | "unsubscribe";
export type ReplyCategory =
  | "interessiert"
  | "spaeter"
  | "kein_interesse"
  | "abmelden"
  | "falsche_person"
  | "abwesend"
  | "frage"
  | "sonstiges";

export interface InboundDto {
  id: number;
  kind: InboundKind;
  category: ReplyCategory | null;
  summary: string | null;
  returnDate: string | null;
  fromEmail: string;
  subject: string;
  snippet: string;
  receivedAt: number;
  handled: boolean;
  campaignId: number | null;
  campaignName: string | null;
  leadId: number | null;
  leadName: string | null;
  company: string | null;
  mailboxEmail: string | null;
  gmailLink: string | null;
}

export interface EventDto {
  id: number;
  createdAt: number;
  level: "info" | "warn" | "error";
  type: string;
  message: string;
  campaignId: number | null;
  mailboxId: number | null;
}

export interface DashboardDto {
  setup: { mailbox: boolean; domain: boolean; leads: boolean; campaign: boolean };
  today: { sent: number; capacity: number; replies: number; bounces: number };
  last30: { sent: number; replies: number; bounces: number; replyRate: number; bounceRate: number };
  daily: { date: string; sent: number; replies: number }[];
  mailboxes: { id: number; email: string; sentToday: number; effectiveLimit: number; status: MailboxStatus; problem: string | null }[];
  activeCampaigns: { id: number; name: string; status: CampaignStatus; sent: number; replied: number; leads: number }[];
  unhandledReplies: number;
  warnings: { level: "warn" | "error"; message: string; link?: string }[];
}

export type ModelLine = "opus" | "sonnet" | "haiku" | "fable" | "mythos";

export interface AiPriceDto {
  input: number;
  output: number;
}

export interface SettingsDto {
  companyName: string;
  companyAddress: string;
  companyLegal: string;
  privacyUrl: string;
  timezone: string;
  optOutText: string;
  globalVariables: Record<string, string>;
  legalNoticeAccepted: boolean;
  ai: {
    keyConfigured: boolean;
    keySource: "env" | "settings" | null;
    model: string | null;
    modelSource: "env" | "settings" | "auto" | null;
    prices: Record<ModelLine, AiPriceDto>;
  };
  publicBaseUrl: string | null;
  googleOAuthConfigured: boolean;
}

export interface AiModelDto {
  id: string;
  displayName: string;
  line: ModelLine | null;
  createdAt: string;
}

export interface AiUsageDto {
  month: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface SpamFinding {
  severity: "info" | "warn" | "high";
  message: string;
}

export interface SpamCheckResult {
  score: number;
  level: "niedrig" | "mittel" | "hoch";
  findings: SpamFinding[];
}
