import type { Logger } from "pino";
import type { AppConfig } from "./config";
import type { DB } from "./db/client";
import type { SecretBox } from "./lib/crypto";
import type { MailTransport } from "./mail/transport";
import type { InboxReader } from "./mail/inbox";
import type { DnsResolver } from "./deliverability/dns";
import type { AiGateway } from "./ai/client";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Alles, was Routen und Hintergrund-Worker brauchen. In Tests werden einzelne Teile ersetzt. */
export interface AppContext {
  config: AppConfig;
  db: DB;
  secrets: SecretBox;
  clock: Clock;
  log: Logger;
  mail: MailTransport;
  inbox: InboxReader;
  dns: DnsResolver;
  ai: AiGateway;
  /** Zufallszahl in [0, 1) – austauschbar für reproduzierbare Tests. */
  random: () => number;
}
