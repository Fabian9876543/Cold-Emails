import { describe, expect, it } from "vitest";
import { addTestMailbox, createTestEnv, fakeDns, type TestEnv } from "../helpers";
import { recoverInterruptedSends, runSendTick } from "../../src/server/worker/sender";
import type { CampaignDto, CampaignLeadDto, Paged, PreflightDto, PreviewDto } from "../../src/shared/types";

const GOOD_DNS = fakeDns({
  txt: {
    "absender.de": ["v=spf1 include:_spf.google.com ~all"],
    "google._domainkey.absender.de": ["v=DKIM1; k=rsa; p=ABC"],
    "_dmarc.absender.de": ["v=DMARC1; p=none"],
  },
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function setupCampaign(env: TestEnv, opts: { leads?: string[]; steps?: { subject: string; body: string; waitDays: number }[]; extra?: Record<string, unknown> } = {}) {
  const mailboxId = await addTestMailbox(env);
  const leads = opts.leads ?? ["julia@becker.de;Julia;Becker GmbH", "tom@werk.de;Tom;Werk AG", "anna@nord.de;Anna;Nord KG"];
  const now = env.clock.now();
  const listId = Number(env.ctx.db.prepare("INSERT INTO lead_lists (name, created_at) VALUES ('Test', ?)").run(now).lastInsertRowid);
  for (const l of leads) {
    const [email, first, company] = l.split(";");
    const id = Number(
      env.ctx.db.prepare("INSERT INTO leads (email, first_name, company, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(email, first ?? "", company ?? "", now, now).lastInsertRowid,
    );
    env.ctx.db.prepare("INSERT INTO lead_list_members (list_id, lead_id) VALUES (?, ?)").run(listId, id);
  }
  const steps = (opts.steps ?? [
    { subject: "Frage zu {{firma}}", body: "Hallo {{vorname}},\n\nkurze Frage zu {{firma}}.\n\nViele Grüße", waitDays: 0 },
    { subject: "", body: "Hallo {{vorname}},\n\nich wollte nur kurz nachhaken.", waitDays: 3 },
  ]).map((s, i) => ({ ...s, position: i + 1 }));
  const res = await env.api<CampaignDto>("POST", "/api/campaigns", {
    name: "Testkampagne",
    steps,
    mailboxIds: [mailboxId],
    listIds: [listId],
    sendDays: [1, 2, 3, 4, 5],
    windowStart: "08:00",
    windowEnd: "17:00",
    ...opts.extra,
  });
  expect(res.status).toBe(200);
  return { campaign: res.body, mailboxId, listId };
}

describe("Kampagnenlauf", () => {
  it("verschickt personalisiert, verteilt über den Tag und setzt Follow-ups im selben Thread fort", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env);
    expect(campaign.stats.queued).toBe(3);

    const start = await env.api<{ ok: boolean; preflight: PreflightDto }>("POST", `/api/campaigns/${campaign.id}/start`, {});
    expect(start.body.preflight.blocking).toEqual([]);
    expect(start.body.ok).toBe(true);

    // Erster Tick: genau eine Mail (ein Postfach), danach Abstand
    env.clock.advance(25 * 60_000); // nach dem täglichen Startversatz
    let r = await runSendTick(env.ctx);
    expect(r.sent).toBe(1);
    r = await runSendTick(env.ctx);
    expect(r.sent).toBe(0); // Abstand noch nicht erreicht

    const first = env.mail.sent[0]!.mail;
    expect(first.to.address).toBe("julia@becker.de");
    expect(first.subject).toBe("Frage zu Becker GmbH");
    expect(first.text).toContain("Hallo Julia,");
    expect(first.text).toContain("Max Mustermann\nMuster GmbH"); // Signatur angehängt
    expect(first.text).toContain("Kein Interesse?"); // Abmeldehinweis angehängt
    expect(first.headers?.["List-Unsubscribe"]).toMatch(/^<mailto:max@absender\.de\?subject=Abmelden>, <https:\/\/mail\.example\.de\/u\/c\d+\..+>$/);
    expect(first.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(first.inReplyTo).toBeUndefined();

    // Im Laufe des Tages gehen alle Erstkontakte raus
    for (let i = 0; i < 40 && env.mail.sent.length < 3; i++) {
      env.clock.advance(20 * 60_000);
      await runSendTick(env.ctx);
    }
    expect(env.mail.sent.map((s) => s.mail.to.address).sort()).toEqual(["anna@nord.de", "julia@becker.de", "tom@werk.de"]);
    const gaps = env.mail.sent.slice(1).map((s, i) => (s.mail.date!.getTime() - env.mail.sent[i]!.mail.date!.getTime()) / 60_000);
    gaps.forEach((g) => expect(g).toBeGreaterThanOrEqual(2));

    // Drei Tage später: Follow-ups als Antwort im selben Thread
    env.clock.advance(3 * DAY);
    for (let i = 0; i < 60 && env.mail.sent.length < 6; i++) {
      env.clock.advance(20 * 60_000);
      await runSendTick(env.ctx);
    }
    expect(env.mail.sent).toHaveLength(6);
    const followUp = env.mail.sent.find((s, i) => i >= 3 && s.mail.to.address === "julia@becker.de")!.mail;
    expect(followUp.subject).toBe("Re: Frage zu Becker GmbH");
    expect(followUp.inReplyTo).toBe(first.messageId);
    expect(followUp.references).toEqual([first.messageId]);

    const dto = (await env.api<CampaignDto>("GET", `/api/campaigns/${campaign.id}`)).body;
    expect(dto.stats.sent).toBe(6);
    expect(dto.stats.finished).toBe(3);
    expect(dto.status).toBe("completed");
  });

  it("hält Tageslimit und Hochfahren ein", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const leads = Array.from({ length: 12 }, (_, i) => `kontakt${i}@firma${i}.de;K${i};Firma ${i}`);
    const { campaign, mailboxId } = await setupCampaign(env, { leads });
    env.ctx.db.prepare("UPDATE mailboxes SET warmup_enabled = 1, warmup_start = 5, warmup_step = 2, warmup_started_at = ? WHERE id = ?").run(env.clock.now(), mailboxId);
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    for (let i = 0; i < 30; i++) {
      env.clock.advance(20 * 60_000);
      await runSendTick(env.ctx);
    }
    expect(env.mail.sent).toHaveLength(5); // Tag 1 des Hochfahrens: 5 Mails
  });

  it("überspringt Kontakte mit fehlenden Angaben statt leere Platzhalter zu senden", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env, { leads: ["ohne@vorname.de;;Firma X"] });
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    expect(env.mail.sent).toHaveLength(0);
    const leads = await env.api<Paged<CampaignLeadDto>>("GET", `/api/campaigns/${campaign.id}/leads`);
    expect(leads.body.items[0]?.status).toBe("error");
    expect(leads.body.items[0]?.statusReason).toContain("{{vorname}}");
  });

  it("nutzt Ersatztexte für fehlende Angaben", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env, {
      leads: ["ohne@vorname.de;;Firma X"],
      steps: [{ subject: "Hallo", body: "Hallo {{vorname|zusammen}},\n\nTest", waitDays: 0 }],
    });
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    expect(env.mail.sent[0]?.mail.text).toMatch(/^Hallo zusammen,/);
  });

  it("behandelt unzustellbare Empfänger: Bounce, Sperrliste, kein erneuter Versuch", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env, { leads: ["weg@firma.de;Weg;Firma"] });
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    env.mail.sendErrors.push(Object.assign(new Error("550"), { responseCode: 550, command: "RCPT TO", response: "550 5.1.1 user unknown" }));
    env.clock.advance(25 * 60_000);
    const r = await runSendTick(env.ctx);
    expect(r.failed).toBe(1);
    const lead = env.ctx.db.prepare("SELECT status FROM leads WHERE email = 'weg@firma.de'").get() as { status: string };
    expect(lead.status).toBe("bounced");
    expect(env.ctx.db.prepare("SELECT reason FROM suppressions WHERE value = 'weg@firma.de'").get()).toEqual({ reason: "bounce" });
  });

  it("stoppt das Postfach bei abgelehntem Login", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign, mailboxId } = await setupCampaign(env);
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    env.mail.sendErrors.push(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535, response: "535 5.7.8 bad credentials" }));
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    const mb = env.ctx.db.prepare("SELECT status, last_error FROM mailboxes WHERE id = ?").get(mailboxId) as { status: string; last_error: string };
    expect(mb.status).toBe("error");
    expect(mb.last_error).toContain("App-Passwort");
    // Kontakt bleibt in der Warteschlange
    const queued = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM campaign_leads WHERE status = 'queued'").get() as { n: number };
    expect(queued.n).toBe(3);
  });

  it("versucht vorübergehende Fehler später erneut", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env, { leads: ["a@firma.de;A;Firma"] });
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    env.mail.sendErrors.push(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    expect(env.mail.sent).toHaveLength(0);
    env.clock.advance(31 * 60_000);
    await runSendTick(env.ctx);
    expect(env.mail.sent).toHaveLength(1);
  });

  it("sendet nach einem Absturz nicht doppelt", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env, { leads: ["a@firma.de;A;Firma"] });
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    // Simulierter Absturz mitten im Versand: Eintrag steht auf "sending"
    const cl = env.ctx.db.prepare("SELECT id, lead_id FROM campaign_leads").get() as { id: number; lead_id: number };
    env.ctx.db
      .prepare("INSERT INTO messages (campaign_lead_id, campaign_id, lead_id, mailbox_id, step, to_email, message_id, subject, body, status, created_at) VALUES (?, ?, ?, 1, 1, 'a@firma.de', '<x@absender.de>', 's', 'b', 'sending', ?)")
      .run(cl.id, campaign.id, cl.lead_id, env.clock.now());
    expect(recoverInterruptedSends(env.ctx)).toBe(1);
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    expect(env.mail.sent).toHaveLength(0);
    const row = env.ctx.db.prepare("SELECT status FROM campaign_leads WHERE id = ?").get(cl.id) as { status: string };
    expect(row.status).toBe("error");
  });

  it("verschickt nichts an gesperrte Adressen und Domains", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env);
    await env.api("POST", "/api/suppressions", { entries: "werk.de\njulia@becker.de" });
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    for (let i = 0; i < 20; i++) {
      env.clock.advance(20 * 60_000);
      await runSendTick(env.ctx);
    }
    expect(env.mail.sent.map((s) => s.mail.to.address)).toEqual(["anna@nord.de"]);
  });

  it("sendet nicht außerhalb des Versandfensters", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS, now: Date.UTC(2025, 2, 8, 10, 0) }); // Samstag
    const { campaign } = await setupCampaign(env);
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    await runSendTick(env.ctx);
    expect(env.mail.sent).toHaveLength(0);
  });

  it("pausiert automatisch bei vielen Bounces", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const leads = Array.from({ length: 25 }, (_, i) => `k${i}@f${i}.de;K;F`);
    const { campaign, mailboxId } = await setupCampaign(env, { leads });
    env.ctx.db.prepare("UPDATE mailboxes SET daily_limit = 100 WHERE id = ?").run(mailboxId);
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    // 20 Kontakte bereits angeschrieben, 2 davon unzustellbar (10 %)
    env.ctx.db.prepare("UPDATE campaign_leads SET last_sent_at = ?, status = 'active', next_send_at = ? WHERE id IN (SELECT id FROM campaign_leads LIMIT 20)").run(env.clock.now(), env.clock.now() + 10 * DAY);
    env.ctx.db.prepare("UPDATE campaign_leads SET status = 'bounced' WHERE id IN (SELECT id FROM campaign_leads LIMIT 2)").run();
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    const c = (await env.api<CampaignDto>("GET", `/api/campaigns/${campaign.id}`)).body;
    expect(c.status).toBe("paused");
    expect(c.pauseReason).toContain("unzustellbar");
  });
});

describe("Startprüfung", () => {
  it("blockiert ohne SPF/DKIM, außer bei bewusstem Übergehen", async () => {
    const env = await createTestEnv({ dns: fakeDns() });
    const { campaign } = await setupCampaign(env);
    const pf = (await env.api<PreflightDto>("GET", `/api/campaigns/${campaign.id}/preflight`)).body;
    expect(pf.ok).toBe(false);
    expect(pf.blocking.map((b) => b.code)).toContain("dns");
    const start = await env.api<{ ok: boolean }>("POST", `/api/campaigns/${campaign.id}/start`, { ignoreDns: true });
    expect(start.body.ok).toBe(true);
  });

  it("meldet unbekannte Platzhalter und schätzt die Dauer", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env, { steps: [{ subject: "Hallo", body: "Hallo {{vorname}}, {{gibtsnicht}}", waitDays: 0 }] });
    const pf = (await env.api<PreflightDto>("GET", `/api/campaigns/${campaign.id}/preflight`)).body;
    expect(pf.blocking.map((b) => b.code)).toContain("placeholders");
    expect(pf.estimate.leads).toBe(3);
    expect(pf.estimate.emailsTotal).toBe(3);
  });
});

describe("Vorschau und Abmeldung", () => {
  it("zeigt eine Vorschau mit echtem Kontakt", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env);
    const res = await env.api<PreviewDto>("POST", "/api/campaigns/preview", { campaignId: campaign.id, steps: campaign.steps, position: 2, optOutMode: "text" });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe("Re: Frage zu Becker GmbH");
    expect(res.body.body).toContain("Hallo Julia,");
    expect(res.body.missing).toEqual([]);
  });

  it("meldet über den Link ab und stoppt alle Sequenzen", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env);
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    const header = env.mail.sent[0]!.mail.headers!["List-Unsubscribe"]!;
    const url = /<(https:[^>]+)>/.exec(header)![1]!;
    const path = new URL(url).pathname;

    const get = await env.app.inject({ method: "GET", url: path });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain("Ja, abmelden");
    // GET allein meldet nicht ab (Link-Scanner)
    expect((env.ctx.db.prepare("SELECT status FROM leads WHERE email = 'julia@becker.de'").get() as { status: string }).status).toBe("active");

    // Ein-Klick-Abmeldung nach RFC 8058
    const post = await env.app.inject({ method: "POST", url: path, payload: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(post.statusCode).toBe(200);
    expect(post.body).toContain("abgemeldet");
    expect((env.ctx.db.prepare("SELECT status FROM leads WHERE email = 'julia@becker.de'").get() as { status: string }).status).toBe("unsubscribed");
    expect(env.ctx.db.prepare("SELECT reason FROM suppressions WHERE value = 'julia@becker.de'").get()).toEqual({ reason: "unsubscribe" });

    const bad = await env.app.inject({ method: "GET", url: "/u/c1.falsch" });
    expect(bad.statusCode).toBe(404);
  });
});

describe("Lückentexte und Begrüßung", () => {
  it("blockiert den Start, solange [Lückentexte] in der Vorlage stehen", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env, { steps: [{ subject: "Frage", body: "{{begruessung}},\n\nWir helfen [Zielgruppe] dabei …", waitDays: 0 }] });
    const pf = (await env.api<PreflightDto>("GET", `/api/campaigns/${campaign.id}/preflight`)).body;
    expect(pf.blocking.map((b) => b.code)).toContain("gaps");
  });

  it("setzt die Begrüßung passend zur Ansprache", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { campaign } = await setupCampaign(env, {
      leads: ["julia@becker.de;Julia;Becker GmbH"],
      steps: [{ subject: "Frage", body: "{{begruessung}},\n\nTest", waitDays: 0 }],
      extra: { formality: "du" },
    });
    await env.api("POST", `/api/campaigns/${campaign.id}/start`, {});
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    expect(env.mail.sent[0]?.mail.text).toMatch(/^Hallo Julia,/);
  });
});
