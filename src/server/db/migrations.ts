import type Database from "better-sqlite3";

interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Datenbank-Migrationen. Neue Änderungen immer als neuen Eintrag anhängen,
 * bestehende Einträge nie nachträglich ändern.
 * Zeitstempel sind Millisekunden seit 1970 (UTC), Wahrheitswerte 0/1.
 */
export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE mailboxes (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  from_name TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('google_app_password','google_oauth','smtp')),
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_security TEXT NOT NULL CHECK (smtp_security IN ('ssl','starttls','none')),
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_security TEXT NOT NULL CHECK (imap_security IN ('ssl','starttls','none')),
  username TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 30,
  warmup_enabled INTEGER NOT NULL DEFAULT 1,
  warmup_start INTEGER NOT NULL DEFAULT 5,
  warmup_step INTEGER NOT NULL DEFAULT 2,
  warmup_started_at INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
  last_error TEXT,
  last_error_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER,
  next_available_at INTEGER NOT NULL DEFAULT 0,
  imap_enabled INTEGER NOT NULL DEFAULT 1,
  imap_uidvalidity TEXT,
  imap_last_uid INTEGER NOT NULL DEFAULT 0,
  imap_last_poll_at INTEGER,
  imap_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE domains (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  dkim_selector TEXT NOT NULL DEFAULT 'google',
  check_json TEXT,
  checked_at INTEGER
);

CREATE TABLE lead_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  salutation TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  custom_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unsubscribed','bounced','invalid')),
  check_flags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX leads_status ON leads (status);

CREATE TABLE lead_list_members (
  list_id INTEGER NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, lead_id)
);
CREATE INDEX lead_list_members_lead ON lead_list_members (lead_id);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed')),
  pause_reason TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
  send_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  window_start TEXT NOT NULL DEFAULT '08:00',
  window_end TEXT NOT NULL DEFAULT '17:00',
  formality TEXT NOT NULL DEFAULT 'sie' CHECK (formality IN ('sie','du')),
  stop_on_reply_all INTEGER NOT NULL DEFAULT 1,
  skip_recent_days INTEGER NOT NULL DEFAULT 90,
  opt_out_mode TEXT NOT NULL DEFAULT 'text' CHECK (opt_out_mode IN ('text','link','none')),
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  ai_context TEXT NOT NULL DEFAULT '',
  ai_use_website INTEGER NOT NULL DEFAULT 1,
  ai_auto_approve INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE campaign_steps (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  wait_days INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  UNIQUE (campaign_id, position)
);

CREATE TABLE campaign_mailboxes (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, mailbox_id)
);

CREATE TABLE campaign_leads (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','finished','replied','bounced','unsubscribed','skipped','error')),
  status_reason TEXT,
  next_step INTEGER NOT NULL DEFAULT 1,
  next_send_at INTEGER,
  thread_message_id TEXT,
  thread_subject TEXT,
  last_message_id TEXT,
  references_chain TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  ai_opener TEXT,
  ai_status TEXT NOT NULL DEFAULT 'none' CHECK (ai_status IN ('none','pending','generating','done','approved','error')),
  ai_quality TEXT,
  ai_reason TEXT,
  ai_error TEXT,
  last_sent_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX campaign_leads_due ON campaign_leads (campaign_id, status, next_send_at);
CREATE INDEX campaign_leads_lead ON campaign_leads (lead_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  step INTEGER NOT NULL DEFAULT 0,
  to_email TEXT NOT NULL,
  message_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','unknown')),
  error TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX messages_mailbox_created ON messages (mailbox_id, created_at);
CREATE INDEX messages_message_id ON messages (message_id);
CREATE INDEX messages_campaign ON messages (campaign_id, status);
CREATE INDEX messages_lead ON messages (lead_id, sent_at);

CREATE TABLE inbound (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply','auto_reply','bounce','unsubscribe')),
  category TEXT,
  summary TEXT,
  return_date TEXT,
  from_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  message_id TEXT,
  handled INTEGER NOT NULL DEFAULT 0,
  ai_status TEXT NOT NULL DEFAULT 'none' CHECK (ai_status IN ('none','pending','done','error')),
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX inbound_received ON inbound (received_at);
CREATE UNIQUE INDEX inbound_message ON inbound (mailbox_id, message_id) WHERE message_id IS NOT NULL;

CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL CHECK (type IN ('email','domain')),
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribe','bounce','manual','complaint')),
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  batch INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);

CREATE TABLE ai_batches (
  id TEXT PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE website_cache (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  content TEXT NOT NULL,
  error TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  campaign_id INTEGER,
  mailbox_id INTEGER
);
CREATE INDEX events_created ON events (created_at);
`,
  },
];

export function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id),
  );
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, Date.now());
    })();
  }
}
