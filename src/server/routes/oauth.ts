import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { logEvent } from "../lib/events";
import { parseQuery } from "../lib/http";
import { buildAuthUrl, emailFromIdToken, exchangeCode, getGoogleOAuthClient } from "../mail/googleOAuth";
import { GOOGLE_SERVER, getMailboxRow, mailboxDomain, type MailboxRow } from "../mail/mailboxes";
import { verifyMailbox } from "./mailboxes";
import { ensureDomain, refreshDomainCheck } from "./domains";

const OAUTH_COOKIE = "ce_oauth";
const PENDING_TTL_MS = 15 * 60 * 1000;

interface PendingOAuth {
  createdAt: number;
  fromName: string;
  email: string;
  dailyLimit: number;
  warmup: boolean;
  signature: string;
}

const pending = new Map<string, PendingOAuth>();

export function redirectUri(ctx: AppContext, request: FastifyRequest): string {
  const origin = ctx.config.publicBaseUrl ?? `${request.protocol}://${request.headers.host}`;
  return `${origin}/api/oauth/google/callback`;
}

function back(reply: FastifyReply, params: Record<string, string>): FastifyReply {
  return reply.redirect(`/postfaecher?${new URLSearchParams(params).toString()}`);
}

export function registerOAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/oauth/google/redirect-uri", async (request) => ({ redirectUri: redirectUri(ctx, request) }));

  app.get("/api/oauth/google/start", async (request, reply) => {
    const q = parseQuery(
      z.object({
        fromName: z.string().max(120).optional(),
        email: z.string().max(320).optional(),
        dailyLimit: z.coerce.number().int().min(1).max(500).optional(),
        warmup: z.enum(["0", "1"]).optional(),
        signature: z.string().max(3000).optional(),
      }),
      request,
    );
    const client = getGoogleOAuthClient(ctx.config, ctx.db, ctx.secrets);
    if (!client) return back(reply, { oauth: "error", message: "Google-OAuth ist noch nicht eingerichtet (Einstellungen → Google)." });
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
    const nonce = crypto.randomBytes(18).toString("base64url");
    pending.set(nonce, {
      createdAt: now,
      fromName: q.fromName?.trim() ?? "",
      email: q.email?.trim().toLowerCase() ?? "",
      dailyLimit: q.dailyLimit ?? 30,
      warmup: q.warmup !== "0",
      signature: q.signature ?? "",
    });
    reply.setCookie(OAUTH_COOKIE, nonce, { path: "/api/oauth", httpOnly: true, sameSite: "lax", secure: request.protocol === "https", maxAge: PENDING_TTL_MS / 1000 });
    return reply.redirect(buildAuthUrl(client, redirectUri(ctx, request), ctx.secrets.createToken(nonce), q.email || undefined));
  });

  app.get("/api/oauth/google/callback", async (request, reply) => {
    const q = parseQuery(z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), request);
    if (q.error) return back(reply, { oauth: "error", message: q.error === "access_denied" ? "Der Zugriff wurde bei Google abgelehnt." : `Google meldet: ${q.error}` });
    const nonce = q.state ? ctx.secrets.verifyToken(q.state) : null;
    const setup = nonce ? pending.get(nonce) : undefined;
    if (!nonce || !setup || request.cookies?.[OAUTH_COOKIE] !== nonce || Date.now() - setup.createdAt > PENDING_TTL_MS) {
      return back(reply, { oauth: "error", message: "Die Anmeldung ist abgelaufen oder ungültig. Bitte erneut verbinden." });
    }
    pending.delete(nonce);
    reply.clearCookie(OAUTH_COOKIE, { path: "/api/oauth" });
    const client = getGoogleOAuthClient(ctx.config, ctx.db, ctx.secrets);
    if (!client || !q.code) return back(reply, { oauth: "error", message: "Google-OAuth ist nicht eingerichtet." });

    let tokens;
    try {
      tokens = await exchangeCode(client, q.code, redirectUri(ctx, request));
    } catch (err) {
      return back(reply, { oauth: "error", message: (err as Error).message });
    }
    const email = emailFromIdToken(tokens.id_token);
    if (!email) return back(reply, { oauth: "error", message: "Google hat keine E-Mail-Adresse übermittelt." });
    if (!tokens.refresh_token) {
      return back(reply, {
        oauth: "error",
        message: "Google hat keinen dauerhaften Zugang erteilt. Bitte unter myaccount.google.com/permissions den Zugriff von „Cold-Emails“ entfernen und erneut verbinden.",
      });
    }
    if (!(tokens.scope ?? "").includes("https://mail.google.com/")) {
      return back(reply, { oauth: "error", message: "Der Zugriff auf Gmail wurde nicht erlaubt. Bitte beim Verbinden alle Häkchen setzen." });
    }

    const now = ctx.clock.now();
    const secret = ctx.secrets.encrypt(tokens.refresh_token);
    const existing = ctx.db.prepare("SELECT id FROM mailboxes WHERE email = ?").get(email) as { id: number } | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
      ctx.db
        .prepare(
          `UPDATE mailboxes SET auth_type = 'google_oauth', smtp_host = ?, smtp_port = ?, smtp_security = ?, imap_host = ?, imap_port = ?, imap_security = ?,
             username = ?, secret_enc = ?, status = 'active', last_error = NULL, consecutive_failures = 0, paused_until = NULL, imap_error = NULL WHERE id = ?`,
        )
        .run(GOOGLE_SERVER.smtpHost, GOOGLE_SERVER.smtpPort, GOOGLE_SERVER.smtpSecurity, GOOGLE_SERVER.imapHost, GOOGLE_SERVER.imapPort, GOOGLE_SERVER.imapSecurity, email, secret, id);
    } else {
      const fromName = setup.fromName || email.split("@")[0]!;
      id = Number(
        ctx.db
          .prepare(
            `INSERT INTO mailboxes (email, from_name, auth_type, smtp_host, smtp_port, smtp_security, imap_host, imap_port, imap_security, username, secret_enc,
               daily_limit, warmup_enabled, warmup_start, warmup_step, warmup_started_at, signature, created_at)
             VALUES (?, ?, 'google_oauth', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5, 2, ?, ?, ?)`,
          )
          .run(
            email, fromName, GOOGLE_SERVER.smtpHost, GOOGLE_SERVER.smtpPort, GOOGLE_SERVER.smtpSecurity, GOOGLE_SERVER.imapHost, GOOGLE_SERVER.imapPort,
            GOOGLE_SERVER.imapSecurity, email, secret, setup.dailyLimit, setup.warmup ? 1 : 0, now, setup.signature, now,
          ).lastInsertRowid,
      );
    }
    const row = getMailboxRow(ctx.db, id) as MailboxRow;
    const check = await verifyMailbox(ctx, row);
    if (!check.smtp.ok || !check.imap.ok) {
      const message = [check.smtp.error, check.imap.error].filter(Boolean).join(" ");
      ctx.db.prepare("UPDATE mailboxes SET status = 'error', last_error = ?, last_error_at = ? WHERE id = ?").run(message, now, id);
      return back(reply, { oauth: "error", message: `Verbunden, aber der Test ist fehlgeschlagen: ${message}` });
    }
    ensureDomain(ctx, mailboxDomain(email));
    void refreshDomainCheck(ctx, mailboxDomain(email)).catch(() => undefined);
    logEvent(ctx.db, now, "info", "mailbox.oauth", `Postfach ${email} über Google verbunden.`, { mailboxId: id });
    return back(reply, { oauth: "ok", email });
  });
}
