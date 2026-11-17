import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  adminPassword: string;
  /** Explizit gesetztes Geheimnis; sonst wird eines im Datenordner erzeugt. */
  appSecret: string | null;
  /** Öffentliche Adresse der Plattform, z. B. https://mail.firma.de (ohne Slash am Ende). */
  publicBaseUrl: string | null;
  anthropicApiKey: string | null;
  claudeModel: string | null;
  googleClientId: string | null;
  googleClientSecret: string | null;
  isProduction: boolean;
  /** Hintergrund-Worker (Versand, Posteingang, KI) starten. In Tests aus. */
  startWorker: boolean;
}

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  ADMIN_PASSWORD: z.preprocess(emptyToNull, z.string().min(8).optional()),
  APP_SECRET: z.preprocess(emptyToNull, z.string().min(16).optional()),
  PUBLIC_BASE_URL: z.preprocess(emptyToNull, z.string().url().optional()),
  ANTHROPIC_API_KEY: z.preprocess(emptyToNull, z.string().optional()),
  CLAUDE_MODEL: z.preprocess(emptyToNull, z.string().optional()),
  GOOGLE_CLIENT_ID: z.preprocess(emptyToNull, z.string().optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess(emptyToNull, z.string().optional()),
  NODE_ENV: z.string().default("development"),
  WORKER: z.preprocess(emptyToNull, z.enum(["on", "off"]).optional()),
});

export class ConfigError extends Error {}

/** Liest .env (falls vorhanden) und prüft die Umgebungsvariablen. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    try {
      process.loadEnvFile(path.resolve(".env"));
    } catch {
      // keine .env-Datei – Umgebungsvariablen reichen
    }
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Ungültige Konfiguration: ${details}`);
  }
  const e = parsed.data;
  if (!e.ADMIN_PASSWORD) {
    throw new ConfigError(
      "ADMIN_PASSWORD fehlt. Bitte in der Datei .env ein Passwort mit mindestens 8 Zeichen setzen (Vorlage: .env.example).",
    );
  }
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: path.resolve(e.DATA_DIR),
    adminPassword: e.ADMIN_PASSWORD,
    appSecret: e.APP_SECRET ?? null,
    publicBaseUrl: e.PUBLIC_BASE_URL ? e.PUBLIC_BASE_URL.replace(/\/+$/, "") : null,
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    claudeModel: e.CLAUDE_MODEL ?? null,
    googleClientId: e.GOOGLE_CLIENT_ID ?? null,
    googleClientSecret: e.GOOGLE_CLIENT_SECRET ?? null,
    isProduction: e.NODE_ENV === "production",
    startWorker: e.WORKER !== "off",
  };
}

export function ensureDataDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
