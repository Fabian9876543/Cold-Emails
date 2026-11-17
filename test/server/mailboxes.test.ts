import { describe, expect, it } from "vitest";
import { addTestMailbox, createTestEnv } from "../helpers";
import type { MailboxDto } from "../../src/shared/types";
import { effectiveDailyLimit } from "../../src/server/mail/mailboxes";

describe("Postfächer", () => {
  it("verlangt eine Anmeldung", async () => {
    const env = await createTestEnv();
    const res = await env.app.inject({ method: "GET", url: "/api/mailboxes" });
    expect(res.statusCode).toBe(401);
  });

  it("verbindet ein Google-Postfach, entfernt Leerzeichen im App-Passwort und verschlüsselt es", async () => {
    const env = await createTestEnv();
    const id = await addTestMailbox(env);
    const row = env.ctx.db.prepare("SELECT * FROM mailboxes WHERE id = ?").get(id) as { secret_enc: string; smtp_host: string; username: string };
    expect(row.smtp_host).toBe("smtp.gmail.com");
    expect(row.username).toBe("max@absender.de");
    expect(row.secret_enc).not.toContain("abcd");
    expect(env.ctx.secrets.decrypt(row.secret_enc)).toBe("abcdefghijklmnop");
    const list = await env.api<MailboxDto[]>("GET", "/api/mailboxes");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty("secret_enc");
    expect(JSON.stringify(list.body)).not.toContain("abcd");
  });

  it("zeigt bei falschem App-Passwort einen verständlichen Hinweis", async () => {
    const env = await createTestEnv();
    env.mail.verifyError = Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 });
    const res = await env.api<{ error: string }>("POST", "/api/mailboxes", {
      authType: "google_app_password",
      email: "max@absender.de",
      fromName: "Max",
      password: "falsch",
      dailyLimit: 30,
      warmupEnabled: true,
      warmupStart: 5,
      warmupStep: 2,
      signature: "",
      imapEnabled: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("App-Passwort");
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM mailboxes").get()).toEqual({ n: 0 });
  });

  it("lehnt doppelte Postfächer ab", async () => {
    const env = await createTestEnv();
    await addTestMailbox(env);
    await expect(addTestMailbox(env)).rejects.toThrow(/bereits verbunden/);
  });

  it("verschickt eine Testmail an die eigene Adresse", async () => {
    const env = await createTestEnv();
    const id = await addTestMailbox(env);
    const res = await env.api<{ to: string }>("POST", `/api/mailboxes/${id}/test-email`, {});
    expect(res.status).toBe(200);
    expect(env.mail.sent).toHaveLength(1);
    expect(env.mail.sent[0]?.mail.to.address).toBe("max@absender.de");
    expect(env.mail.sent[0]?.mail.messageId).toMatch(/^<.+@absender\.de>$/);
    // Testmails zählen nicht zum Tageslimit
    const list = await env.api<MailboxDto[]>("GET", "/api/mailboxes");
    expect(list.body[0]?.sentToday).toBe(0);
  });

  it("pausiert und setzt fort", async () => {
    const env = await createTestEnv();
    const id = await addTestMailbox(env);
    let res = await env.api<MailboxDto>("PATCH", `/api/mailboxes/${id}`, { status: "paused" });
    expect(res.body.status).toBe("paused");
    res = await env.api<MailboxDto>("PATCH", `/api/mailboxes/${id}`, { status: "active" });
    expect(res.body.status).toBe("active");
  });
});

describe("Hochfahren (Warm-up)", () => {
  const day = 86_400_000;
  const start = Date.UTC(2025, 2, 3, 9, 0, 0);
  const mb = { daily_limit: 30, warmup_enabled: 1, warmup_start: 5, warmup_step: 2, warmup_started_at: start };
  it("steigert das Limit täglich bis zum Ziel", () => {
    expect(effectiveDailyLimit(mb, start, "Europe/Berlin")).toBe(5);
    expect(effectiveDailyLimit(mb, start + day, "Europe/Berlin")).toBe(7);
    expect(effectiveDailyLimit(mb, start + 5 * day, "Europe/Berlin")).toBe(15);
    expect(effectiveDailyLimit(mb, start + 60 * day, "Europe/Berlin")).toBe(30);
  });
  it("ohne Hochfahren gilt sofort das Tageslimit", () => {
    expect(effectiveDailyLimit({ ...mb, warmup_enabled: 0 }, start, "Europe/Berlin")).toBe(30);
  });
});
