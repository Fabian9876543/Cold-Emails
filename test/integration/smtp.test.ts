import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import type { AddressInfo } from "node:net";
import { createTestEnv } from "../helpers";
import { createSmtpTransport } from "../../src/server/mail/transport";
import { runSendTick } from "../../src/server/worker/sender";
import type { CampaignDto } from "../../src/shared/types";

// Echter Versandweg: nodemailer → lokaler SMTP-Server. Prüft die tatsächlich erzeugte Mail.

const received: { from: string; to: string[]; raw: string; user?: string }[] = [];
let server: SMTPServer;
let port = 0;

beforeAll(async () => {
  server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    onAuth(auth, _session, cb) {
      if (auth.username === "max@absender.de" && auth.password === "abcdefghijklmnop") return cb(null, { user: auth.username });
      cb(new Error("535 5.7.8 Username and Password not accepted"));
    },
    onRcptTo(address, _session, cb) {
      if (address.address.startsWith("gibtsnicht@")) {
        const err = Object.assign(new Error("5.1.1 The email account that you tried to reach does not exist"), { responseCode: 550 });
        return cb(err);
      }
      cb();
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      stream.on("end", () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string | undefined });
        cb();
      });
    },
    logger: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("Versand über SMTP (nodemailer)", () => {
  it("erzeugt saubere, personalisierte Text-Mails mit Thread- und Abmelde-Kopfzeilen", async () => {
    const env = await createTestEnv();
    env.ctx.mail = createSmtpTransport({ secretFor: (mb) => env.ctx.secrets.decrypt(mb.secret_enc), oauthClient: () => null });
    // Postfach direkt anlegen (Server = lokaler Test-SMTP)
    const now = env.clock.now();
    const mb = env.ctx.db
      .prepare(
        `INSERT INTO mailboxes (email, from_name, auth_type, smtp_host, smtp_port, smtp_security, imap_host, imap_port, imap_security, username, secret_enc,
           daily_limit, warmup_enabled, warmup_started_at, signature, imap_enabled, created_at)
         VALUES ('max@absender.de', 'Max Müller', 'smtp', '127.0.0.1', ?, 'none', '127.0.0.1', 1, 'none', 'max@absender.de', ?, 30, 0, ?, 'Max Müller\nMuster GmbH', 0, ?)`,
      )
      .run(port, env.ctx.secrets.encrypt("abcdefghijklmnop"), now, now);
    const listId = Number(env.ctx.db.prepare("INSERT INTO lead_lists (name, created_at) VALUES ('L', ?)").run(now).lastInsertRowid);
    for (const [email, first, last, company] of [
      ["jürgen@größe.example", "Jürgen", "Weiß", "Größe & Söhne"],
      ["gibtsnicht@firma.example", "Nie", "Mand", "Firma"],
    ]) {
      const id = Number(env.ctx.db.prepare("INSERT INTO leads (email, salutation, first_name, last_name, company, created_at, updated_at) VALUES (?, 'Herr', ?, ?, ?, ?, ?)").run(email, first, last, company, now, now).lastInsertRowid);
      env.ctx.db.prepare("INSERT INTO lead_list_members (list_id, lead_id) VALUES (?, ?)").run(listId, id);
    }
    const c = await env.api<CampaignDto>("POST", "/api/campaigns", {
      name: "SMTP",
      mailboxIds: [Number(mb.lastInsertRowid)],
      listIds: [listId],
      steps: [
        { position: 1, waitDays: 0, subject: "Frage zu {{firma}}", body: "{{begruessung}},\n\nkurze Frage zu {{firma}}: Wie lösen Sie das heute?\n\nViele Grüße" },
        { position: 2, waitDays: 2, subject: "", body: "{{begruessung}},\n\nich hake kurz nach." },
      ],
    });
    const started = await env.api<{ ok: boolean }>("POST", `/api/campaigns/${c.body.id}/start`, { ignoreDns: true });
    expect(started.body.ok).toBe(true);

    for (let i = 0; i < 30; i++) {
      env.clock.advance(20 * 60_000);
      await runSendTick(env.ctx);
    }
    // Ein Empfänger wurde vom Server abgelehnt → Bounce
    expect(env.ctx.db.prepare("SELECT status FROM leads WHERE email = 'gibtsnicht@firma.example'").get()).toEqual({ status: "bounced" });
    expect(received).toHaveLength(1);
    expect(received[0]!.user).toBe("max@absender.de");

    const first = await simpleParser(received[0]!.raw);
    expect(first.subject).toBe("Frage zu Größe & Söhne");
    expect(first.from?.value[0]).toMatchObject({ name: "Max Müller", address: "max@absender.de" });
    expect(first.to && !Array.isArray(first.to) ? first.to.value[0] : null).toMatchObject({ name: "Jürgen Weiß" });
    expect(first.text).toContain("Guten Tag Herr Weiß,");
    expect(first.text).toContain("Max Müller\nMuster GmbH");
    expect(first.html).toBe(false); // reiner Text
    expect(first.headers.get("x-mailer")).toBeUndefined();
    // List-*-Kopfzeilen direkt im Rohtext prüfen (mailparser fasst sie unter "list" zusammen)
    const head = received[0]!.raw.split("\r\n\r\n")[0]!.replace(/\r\n[ \t]+/g, " ");
    expect(head).toMatch(/^List-Unsubscribe: <mailto:max@absender\.de\?subject=Abmelden>, <https:\/\/mail\.example\.de\/u\/c\d+\.[\w-]+>$/m);
    expect(head).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    expect(head).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(first.messageId).toMatch(/@absender\.de>$/);

    // Follow-up zwei Tage später im selben Verlauf (Dienstag 19 Uhr → Donnerstag 8 Uhr)
    env.clock.advance(37 * 3_600_000);
    for (let i = 0; i < 30 && received.length < 2; i++) {
      env.clock.advance(20 * 60_000);
      await runSendTick(env.ctx);
    }
    expect(received).toHaveLength(2);
    const second = await simpleParser(received[1]!.raw);
    expect(second.subject).toBe("Re: Frage zu Größe & Söhne");
    expect(second.inReplyTo).toBe(first.messageId);
    expect(second.references).toBe(first.messageId);
  });

  it("meldet falsche Zugangsdaten verständlich", async () => {
    const env = await createTestEnv();
    env.ctx.mail = createSmtpTransport({ secretFor: (mb) => env.ctx.secrets.decrypt(mb.secret_enc), oauthClient: () => null });
    const res = await env.api<{ error: string }>("POST", "/api/mailboxes", {
      authType: "smtp",
      email: "max@absender.de",
      fromName: "Max",
      password: "falsch",
      smtpHost: "127.0.0.1",
      smtpPort: port,
      smtpSecurity: "none",
      imapHost: "127.0.0.1",
      imapPort: 1,
      imapSecurity: "none",
      username: "max@absender.de",
      dailyLimit: 30,
      warmupEnabled: true,
      warmupStart: 5,
      warmupStep: 2,
      signature: "",
      imapEnabled: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Benutzername oder Passwort");
  });
});
