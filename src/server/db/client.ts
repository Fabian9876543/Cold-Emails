import Database from "better-sqlite3";
import path from "node:path";
import { migrate } from "./migrations";

export type DB = Database.Database;

/** Öffnet die SQLite-Datenbank (oder ":memory:" für Tests) und spielt Migrationen ein. */
export function openDatabase(fileOrMemory: string): DB {
  const db = new Database(fileOrMemory);
  if (fileOrMemory !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

export function databaseFile(dataDir: string): string {
  return path.join(dataDir, "cold-emails.db");
}

/** Kleiner Helfer für dynamische UPDATE-Statements aus einem Objekt. */
export function buildUpdate(table: string, values: Record<string, unknown>, where: string): { sql: string; params: unknown[] } {
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${where}`;
  return { sql, params: keys.map((k) => normalizeParam(values[k])) };
}

export function normalizeParam(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}
