import { pino } from "pino";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../src/server/config";
import type { AppContext } from "../src/server/context";
import { openDatabase } from "../src/server/db/client";
import { SecretBox } from "../src/server/lib/crypto";
import type { MailTransport, OutgoingMail } from "../src/server/mail/transport";
import type { FetchedMessage, InboxCursor, InboxReader } from "../src/server/mail/inbox";
import type { MailboxRow } from "../src/server/mail/mailboxes";
import type { DnsResolver } from "../src/server/deliverability/dns";
import type { AiGateway } from "../src/server/ai/client";
import { buildApp } from "../src/server/app";

export const TEST_PASSWORD = "test-passwort-123";

export class FakeClock {
  constructor(public t: number) {}
  now = () => this.t;
  set(t: number) {
    this.t = t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export interface SentMail {
  mailboxId: number;
  mailbox: string;
  mail: OutgoingMail;
}

export class FakeMail implements MailTransport {
  sent: SentMail[] = [];
  verifyError: unknown = null;
  /** Fehler, die bei den nächsten send()-Aufrufen geworfen werden (der Reihe nach). */
  sendErrors: unknown[] = [];
  async send(mailbox: MailboxRow, mail: OutgoingMail) {
    const err = this.sendErrors.shift();
    if (err) throw err;
    this.sent.push({ mailboxId: mailbox.id, mailbox: mailbox.email, mail });
    return { response: "250 OK", accepted: [mail.to.address], rejected: [] };
  }
  async verify() {
    if (this.verifyError) throw this.verifyError;
  }
}

export class FakeInbox implements InboxReader {
  /** Neue Rohmails je Postfach-ID. */
  queued = new Map<number, Buffer[]>();
  verifyError: unknown = null;
  private uid = 100;
  push(mailboxId: number, raw: string) {
    this.queued.set(mailboxId, [...(this.queued.get(mailboxId) ?? []), Buffer.from(raw)]);
  }
  async fetchNew(mailbox: MailboxRow, cursor: InboxCursor) {
    if (cursor.uidValidity !== "1") return { uidValidity: "1", lastUid: this.uid, messages: [] };
    const raws = this.queued.get(mailbox.id) ?? [];
    this.queued.set(mailbox.id, []);
    const messages: FetchedMessage[] = raws.map((source) => ({ uid: ++this.uid, source }));
    return { uidValidity: "1", lastUid: this.uid, messages };
  }
  async verify() {
    if (this.verifyError) throw this.verifyError;
  }
}

/** DNS, das für jede Domain einen MX-Eintrag liefert – außer für ausdrücklich gesperrte Domains. */
export function fakeDns(opts: { noMx?: string[]; txt?: Record<string, string[]> } = {}): DnsResolver {
  const notFound = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return {
    async resolveMx(domain) {
      if (opts.noMx?.includes(domain)) throw notFound();
      return [{ exchange: `mx.${domain}`, priority: 10 }];
    },
    async resolveTxt(name) {
      const r = opts.txt?.[name];
      if (!r) throw notFound();
      return r.map((x) => [x]);
    },
    async resolve4() {
      throw notFound();
    },
  };
}

export function noAi(): AiGateway {
  return {
    client: () => null,
    keySource: () => null,
    resolveModel: async () => {
      throw new Error("KI nicht eingerichtet");
    },
    modelSource: () => null,
    listModels: async () => [],
    lineOf: async () => null,
    invalidate: () => undefined,
  };
}

export interface TestEnv {
  ctx: AppContext;
  clock: FakeClock;
  mail: FakeMail;
  inbox: FakeInbox;
  app: FastifyInstance;
  cookie: string;
  api<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }>;
}

export async function createTestEnv(opts: { now?: number; publicBaseUrl?: string | null; ai?: AiGateway; dns?: DnsResolver } = {}): Promise<TestEnv> {
  // Standard: Dienstag, 4. März 2025, 09:00 Uhr Berlin
  const clock = new FakeClock(opts.now ?? Date.UTC(2025, 2, 4, 8, 0, 0));
  const config: AppConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir: "/tmp/cold-emails-test",
    adminPassword: TEST_PASSWORD,
    appSecret: "test-geheimnis-fuer-unit-tests",
    publicBaseUrl: opts.publicBaseUrl === undefined ? "https://mail.example.de" : opts.publicBaseUrl,
    anthropicApiKey: null,
    claudeModel: null,
    googleClientId: null,
    googleClientSecret: null,
    isProduction: false,
    startWorker: false,
  };
  const mail = new FakeMail();
  const inbox = new FakeInbox();
  let seed = 42;
  const ctx: AppContext = {
    config,
    db: openDatabase(":memory:"),
    secrets: new SecretBox(config.appSecret!),
    clock,
    log: pino({ level: "silent" }),
    mail,
    inbox,
    dns: opts.dns ?? fakeDns(),
    ai: opts.ai ?? noAi(),
    // deterministischer Pseudo-Zufall
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    },
  };
  const app = await buildApp(ctx, { webDir: null });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: TEST_PASSWORD } });
  const setCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  const api = async <T,>(method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as "GET", url, payload: body as object | undefined, headers: { cookie } });
    let parsed: unknown = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // kein JSON
    }
    return { status: res.statusCode, body: parsed as T };
  };
  return { ctx, clock, mail, inbox, app, cookie, api };
}

export async function addTestMailbox(env: TestEnv, email = "max@absender.de", extra: Record<string, unknown> = {}) {
  const res = await env.api<{ id: number; error?: string }>("POST", "/api/mailboxes", {
    authType: "google_app_password",
    email,
    fromName: "Max Mustermann",
    password: "abcd efgh ijkl mnop",
    dailyLimit: 30,
    warmupEnabled: false,
    warmupStart: 5,
    warmupStep: 2,
    signature: "Max Mustermann\nMuster GmbH",
    imapEnabled: true,
    ...extra,
  });
  if (res.status !== 200) throw new Error(`Postfach anlegen fehlgeschlagen: ${JSON.stringify(res.body)}`);
  return res.body.id;
}
