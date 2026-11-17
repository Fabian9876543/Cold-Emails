import path from "node:path";
import { pino } from "pino";
import { ConfigError, ensureDataDir, loadConfig, type AppConfig } from "./config";
import { databaseFile, openDatabase } from "./db/client";
import { loadOrCreateAppSecret, SecretBox } from "./lib/crypto";
import { createRuntimeContext } from "./runtime";
import { buildApp } from "./app";
import { startWorker } from "./worker";

async function main() {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n✖ ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const log = pino({
    level: process.env.LOG_LEVEL ?? "info",
    transport: config.isProduction ? undefined : { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } },
  });

  ensureDataDir(config.dataDir);
  const db = openDatabase(databaseFile(config.dataDir));
  const secrets = new SecretBox(loadOrCreateAppSecret(config.dataDir, config.appSecret));
  const ctx = createRuntimeContext({ config, db, secrets, log });

  const app = await buildApp(ctx, { webDir: path.resolve("dist/web") });
  await app.listen({ port: config.port, host: config.host });
  log.info(`Cold-Emails läuft: http://localhost:${config.port}${config.publicBaseUrl ? ` (öffentlich: ${config.publicBaseUrl})` : ""}`);

  const worker = config.startWorker ? startWorker(ctx) : null;

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`${signal} empfangen – fahre herunter …`);
    await worker?.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
