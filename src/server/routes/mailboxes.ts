import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { buildUpdate } from "../db/client";
import { logEvent } from "../lib/events";
import { badRequest, idParam, notFound, parseBody } from "../lib/http";
import { getSettings } from "../lib/settings";
import { explainConnectionError } from "../mail/explain";
import {
  GOOGLE_SERVER,
  getMailboxRow,
  listMailboxRows,
  mailboxDomain,
  toMailboxDto,
  type MailboxRow,
} from "../mail/mailboxes";
import { ensureDomain, refreshDomainCheck } from "./domains";
import { isValidEmailSyntax, normalizeEmail } from "../../shared/emailCheck";
import type { MailboxDto } from "../../shared/types";

const security = z.enum(["ssl", "starttls", "none"]);

const serverFields = {
  smtpHost: z.string().min(1).max(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecurity: security,
  imapHost: z.string().min(1).max(255),
  imapPort: z.number().int().min(1).max(65535),
  imapSecurity: security,
  username: z.string().min(1).max(320),
};

const limitFields = {
  dailyLimit: z.number().int().min(1, "Mindestens 1 Mail pro Tag.").max(500, "Mehr als 500 Mails pro Tag und Postfach sind für Cold-Emails nicht sinnvoll."),
  warmupEnabled: z.boolean(),
  warmupStart: z.number().int().min(1).max(200),
  warmupStep: z.number().int().min(1).max(50),
  signature: z.string().max(3000),
  imapEnabled: z.boolean(),
};

const createSchema = z.discriminatedUnion("authType", [
  z.object({
    authType: z.literal("google_app_password"),
    email: z.string(),
    fromName: z.string().min(1, "Bitte einen Absendernamen angeben.").max(120),
    password: z.string().min(1, "Bitte das App-Passwort eingeben."),
    skipVerify: z.boolean().optional(),
    ...limitFields,
  }),
  z.object({
    authType: z.literal("smtp"),
    email: z.string(),
    fromName: z.string().min(1, "Bitte einen Absendernamen angeben.").max(120),
    password: z.string(),
    skipVerify: z.boolean().optional(),
    ...serverFields,
    ...limitFields,
  }),
]);

const updateSchema = z
  .object({
    fromName: z.string().min(1).max(120),
    password: z.string().min(1),
    status: z.enum(["active", "paused"]),
    skipVerify: z.boolean(),
    ...serverFields,
    ...limitFields,
  })
  .partial();

export interface VerifyResult {
  smtp: { ok: boolean; error?: string };
  imap: { ok: boolean; error?: string; skipped?: boolean };
}

export async function verifyMailbox(ctx: AppContext, mailbox: MailboxRow): Promise<VerifyResult> {
  const result: VerifyResult = { smtp: { ok: false }, imap: { ok: false } };
  const [smtp, imap] = await Promise.allSettled([
    ctx.mail.verify(mailbox),
    mailbox.imap_enabled ? ctx.inbox.verify(mailbox) : Promise.resolve("skipped" as const),
  ]);
  result.smtp = smtp.status === "fulfilled" ? { ok: true } : { ok: false, error: explainConnectionError(smtp.reason, "SMTP", mailbox.auth_type) };
  if (imap.status === "fulfilled") result.imap = imap.value === "skipped" ? { ok: true, skipped: true } : { ok: true };
  else result.imap = { ok: false, error: explainConnectionError(imap.reason, "IMAP", mailbox.auth_type) };
  return result;
}

function verifyMessage(r: VerifyResult): string {
  return [r.smtp.error, r.imap.error].filter(Boolean).join(" ");
}

export function registerMailboxRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tz = () => getSettings(ctx.db).timezone;

  app.get("/api/mailboxes", async (): Promise<MailboxDto[]> => {
    const now = ctx.clock.now();
    return listMailboxRows(ctx.db).map((r) => toMailboxDto(ctx.db, r, now, tz()));
  });

  app.post("/api/mailboxes", async (request): Promise<MailboxDto> => {
    const body = parseBody(createSchema, request);
    const email = normalizeEmail(body.email);
    if (!isValidEmailSyntax(email)) throw badRequest("Bitte eine gültige E-Mail-Adresse angeben.");
    if (ctx.db.prepare("SELECT 1 FROM mailboxes WHERE email = ?").get(email)) throw badRequest("Dieses Postfach ist bereits verbunden.");
    const now = ctx.clock.now();
    const server =
      body.authType === "google_app_password"
        ? { ...GOOGLE_SERVER, username: email }
        : { smtpHost: body.smtpHost.trim(), smtpPort: body.smtpPort, smtpSecurity: body.smtpSecurity, imapHost: body.imapHost.trim(), imapPort: body.imapPort, imapSecurity: body.imapSecurity, username: body.username.trim() };
    // Google zeigt App-Passwörter mit Leerzeichen an – diese gehören nicht zum Passwort.
    const password = body.authType === "google_app_password" ? body.password.replace(/\s+/g, "") : body.password;

    const row: MailboxRow = {
      id: 0,
      email,
      from_name: body.fromName.trim(),
      auth_type: body.authType,
      smtp_host: server.smtpHost,
      smtp_port: server.smtpPort,
      smtp_security: server.smtpSecurity,
      imap_host: server.imapHost,
      imap_port: server.imapPort,
      imap_security: server.imapSecurity,
      username: server.username,
      secret_enc: ctx.secrets.encrypt(password),
      daily_limit: body.dailyLimit,
      warmup_enabled: body.warmupEnabled ? 1 : 0,
      warmup_start: body.warmupStart,
      warmup_step: body.warmupStep,
      warmup_started_at: now,
      signature: body.signature,
      status: "active",
      last_error: null,
      last_error_at: null,
      consecutive_failures: 0,
      paused_until: null,
      next_available_at: 0,
      imap_enabled: body.imapEnabled ? 1 : 0,
      imap_uidvalidity: null,
      imap_last_uid: 0,
      imap_last_poll_at: null,
      imap_error: null,
      created_at: now,
    };

    if (!body.skipVerify) {
      const v = await verifyMailbox(ctx, row);
      if (!v.smtp.ok || !v.imap.ok) throw badRequest(verifyMessage(v));
    }

    const info = ctx.db
      .prepare(
        `INSERT INTO mailboxes (email, from_name, auth_type, smtp_host, smtp_port, smtp_security, imap_host, imap_port, imap_security,
          username, secret_enc, daily_limit, warmup_enabled, warmup_start, warmup_step, warmup_started_at, signature, imap_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.email, row.from_name, row.auth_type, row.smtp_host, row.smtp_port, row.smtp_security, row.imap_host, row.imap_port, row.imap_security,
        row.username, row.secret_enc, row.daily_limit, row.warmup_enabled, row.warmup_start, row.warmup_step, row.warmup_started_at, row.signature,
        row.imap_enabled, row.created_at,
      );
    const id = Number(info.lastInsertRowid);
    const domain = mailboxDomain(email);
    ensureDomain(ctx, domain);
    void refreshDomainCheck(ctx, domain).catch((err) => ctx.log.warn({ err }, "DNS-Prüfung fehlgeschlagen"));
    logEvent(ctx.db, now, "info", "mailbox.created", `Postfach ${email} verbunden.`, { mailboxId: id });
    return toMailboxDto(ctx.db, getMailboxRow(ctx.db, id)!, now, tz());
  });

  app.patch("/api/mailboxes/:id", async (request): Promise<MailboxDto> => {
    const id = idParam(request);
    const current = getMailboxRow(ctx.db, id);
    if (!current) throw notFound("Postfach");
    const body = parseBody(updateSchema, request);
    const now = ctx.clock.now();
    const values: Record<string, unknown> = {
      from_name: body.fromName?.trim(),
      daily_limit: body.dailyLimit,
      warmup_enabled: body.warmupEnabled,
      warmup_start: body.warmupStart,
      warmup_step: body.warmupStep,
      signature: body.signature,
      imap_enabled: body.imapEnabled,
    };
    if (current.auth_type === "smtp") {
      Object.assign(values, {
        smtp_host: body.smtpHost?.trim(),
        smtp_port: body.smtpPort,
        smtp_security: body.smtpSecurity,
        imap_host: body.imapHost?.trim(),
        imap_port: body.imapPort,
        imap_security: body.imapSecurity,
        username: body.username?.trim(),
      });
    }
    const credentialsChanged = body.password !== undefined || ["smtpHost", "smtpPort", "smtpSecurity", "imapHost", "imapPort", "imapSecurity", "username"].some((k) => k in body);
    if (body.password !== undefined) {
      const pw = current.auth_type === "google_app_password" ? body.password.replace(/\s+/g, "") : body.password;
      values.secret_enc = ctx.secrets.encrypt(pw);
    }
    if (credentialsChanged && !body.skipVerify) {
      const candidate = { ...current, ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) } as MailboxRow;
      const v = await verifyMailbox(ctx, candidate);
      if (!v.smtp.ok || !v.imap.ok) throw badRequest(verifyMessage(v));
    }
    if (body.status === "active" || credentialsChanged) {
      Object.assign(values, { status: "active", last_error: null, last_error_at: null, consecutive_failures: 0, paused_until: null, imap_error: null });
    } else if (body.status === "paused") {
      values.status = "paused";
    }
    if (Object.values(values).some((v) => v !== undefined)) {
      const { sql, params } = buildUpdate("mailboxes", values, "id = ?");
      ctx.db.prepare(sql).run(...params, id);
    }
    if (body.status) {
      logEvent(ctx.db, now, "info", "mailbox.status", `Postfach ${current.email} ${body.status === "paused" ? "pausiert" : "fortgesetzt"}.`, { mailboxId: id });
    }
    return toMailboxDto(ctx.db, getMailboxRow(ctx.db, id)!, now, tz());
  });

  app.delete("/api/mailboxes/:id", async (request) => {
    const id = idParam(request);
    const current = getMailboxRow(ctx.db, id);
    if (!current) throw notFound("Postfach");
    ctx.db.prepare("DELETE FROM mailboxes WHERE id = ?").run(id);
    logEvent(ctx.db, ctx.clock.now(), "info", "mailbox.deleted", `Postfach ${current.email} entfernt.`);
    return { ok: true };
  });

  app.post("/api/mailboxes/:id/test", async (request): Promise<VerifyResult> => {
    const id = idParam(request);
    const mailbox = getMailboxRow(ctx.db, id);
    if (!mailbox) throw notFound("Postfach");
    const result = await verifyMailbox(ctx, mailbox);
    if (result.smtp.ok && result.imap.ok && mailbox.status === "error") {
      ctx.db.prepare("UPDATE mailboxes SET status = 'active', last_error = NULL, consecutive_failures = 0, imap_error = NULL WHERE id = ?").run(id);
    }
    return result;
  });

  app.post("/api/mailboxes/:id/test-email", async (request) => {
    const id = idParam(request);
    const mailbox = getMailboxRow(ctx.db, id);
    if (!mailbox) throw notFound("Postfach");
    const { to } = parseBody(z.object({ to: z.string().optional() }), request);
    const recipient = normalizeEmail(to || mailbox.email);
    if (!isValidEmailSyntax(recipient)) throw badRequest("Ungültige Empfängeradresse.");
    const now = ctx.clock.now();
    const messageId = `<${crypto.randomUUID()}@${mailboxDomain(mailbox.email)}>`;
    const text = [
      "Hallo,",
      "",
      "diese Testmail wurde über Cold-Emails verschickt. Wenn Sie sie lesen, funktioniert der Versand über dieses Postfach.",
      "",
      "Tipp: Öffnen Sie die Mail in Gmail, klicken Sie auf die drei Punkte → „Original anzeigen“ und prüfen Sie, ob SPF, DKIM und DMARC auf „PASS“ stehen.",
      "",
      mailbox.signature || mailbox.from_name,
    ].join("\n");
    try {
      await ctx.mail.send(mailbox, {
        from: { name: mailbox.from_name, address: mailbox.email },
        to: { address: recipient },
        subject: "Testmail von Cold-Emails",
        text,
        messageId,
        date: new Date(now),
      });
    } catch (err) {
      throw badRequest(explainConnectionError(err, "SMTP", mailbox.auth_type));
    }
    ctx.db
      .prepare(
        "INSERT INTO messages (mailbox_id, to_email, message_id, subject, body, status, is_test, created_at, sent_at) VALUES (?, ?, ?, ?, ?, 'sent', 1, ?, ?)",
      )
      .run(id, recipient, messageId, "Testmail von Cold-Emails", text, now, now);
    return { ok: true, to: recipient };
  });

  app.post("/api/mailboxes/:id/restart-warmup", async (request): Promise<MailboxDto> => {
    const id = idParam(request);
    if (!getMailboxRow(ctx.db, id)) throw notFound("Postfach");
    const now = ctx.clock.now();
    ctx.db.prepare("UPDATE mailboxes SET warmup_started_at = ? WHERE id = ?").run(now, id);
    return toMailboxDto(ctx.db, getMailboxRow(ctx.db, id)!, now, tz());
  });
}
