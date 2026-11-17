import { describe, expect, it } from "vitest";
import { addTestMailbox, createTestEnv, fakeDns, type TestEnv } from "../helpers";
import { runSendTick } from "../../src/server/worker/sender";
import { runInboxPoll } from "../../src/server/worker/inboxPoller";
import { analyzeInbound, findReturnDate } from "../../src/server/worker/inboundClassify";
import * as mails from "../fixtures/mails";
import type { CampaignDto, DashboardDto, InboundDto, Paged } from "../../src/shared/types";

const NOW = Date.UTC(2025, 2, 4, 8, 0, 0);

describe("Einordnung eingehender Mails", () => {
  it("erkennt einen Gmail-Bounce mit Empfänger, Status und Original-Message-ID", async () => {
    const a = await analyzeInbound(Buffer.from(mails.gmailBounce("weg@firma.de", "<orig-1@absender.de>")), NOW);
    expect(a.kind).toBe("bounce");
    expect(a.bounce).toMatchObject({ recipients: ["weg@firma.de"], hard: true, status: "5.1.1" });
    expect(a.bounce?.originalMessageIds).toContain("<orig-1@absender.de>");
  });

  it("erkennt einen Outlook-Unzustellbarkeitsbericht", async () => {
    const a = await analyzeInbound(Buffer.from(mails.outlookNdr("x@becker-logistik.de")), NOW);
    expect(a.kind).toBe("bounce");
    expect(a.bounce).toMatchObject({ recipients: ["x@becker-logistik.de"], hard: true });
  });

  it("wertet Verzögerungen nicht als harten Bounce", async () => {
    const a = await analyzeInbound(Buffer.from(mails.delayNotice("x@firma.de")), NOW);
    expect(a.kind).toBe("bounce");
    expect(a.bounce?.hard).toBe(false);
  });

  it("erkennt Abwesenheitsnotizen und das Rückkehrdatum", async () => {
    const outlook = await analyzeInbound(Buffer.from(mails.outlookOutOfOffice("julia@becker.de", "<a@b>")), NOW);
    expect(outlook.kind).toBe("auto_reply");
    expect(outlook.returnDate).toBe("2025-03-14");
    const gmail = await analyzeInbound(Buffer.from(mails.gmailVacation("tom@werk.de", "<a@b>")), NOW);
    expect(gmail.kind).toBe("auto_reply");
    expect(gmail.returnDate).toBe("2025-03-10");
  });

  it("trennt bei echten Antworten den zitierten Verlauf ab", async () => {
    const a = await analyzeInbound(Buffer.from(mails.humanReply("julia@becker.de", "<orig@absender.de>")), NOW);
    expect(a.kind).toBe("reply");
    expect(a.text).toContain("klingt interessant");
    expect(a.text).not.toContain("Kein Interesse?");
    expect(a.refs).toEqual(["<orig@absender.de>"]);
  });

  it("erkennt Abmeldewünsche per Antwort und per Gmail-Knopf", async () => {
    expect((await analyzeInbound(Buffer.from(mails.unsubscribeReply("anna@nord.de", "<x@y>")), NOW)).kind).toBe("unsubscribe");
    expect((await analyzeInbound(Buffer.from(mails.gmailUnsubscribeButton("anna@nord.de")), NOW)).kind).toBe("unsubscribe");
  });

  it("findet Rückkehrdaten in verschiedenen Schreibweisen", () => {
    expect(findReturnDate("Ich bin ab dem 10.03. wieder im Büro.", NOW)).toBe("2025-03-10");
    expect(findReturnDate("Abwesend bis 3. April 2025", NOW)).toBe("2025-04-03");
    expect(findReturnDate("Telefon: 0561 12.34.56", NOW)).toBeNull();
  });
});

const GOOD_DNS = fakeDns({
  txt: { "absender.de": ["v=spf1 include:_spf.google.com ~all"], "google._domainkey.absender.de": ["v=DKIM1; p=ABC"], "_dmarc.absender.de": ["v=DMARC1; p=none"] },
});

async function sendFirstMails(env: TestEnv) {
  const mailboxId = await addTestMailbox(env);
  const now = env.clock.now();
  const listId = Number(env.ctx.db.prepare("INSERT INTO lead_lists (name, created_at) VALUES ('L', ?)").run(now).lastInsertRowid);
  for (const [email, first, last, company] of [
    ["julia@becker-logistik.de", "Julia", "Becker", "Becker GmbH"],
    ["tom@werk.de", "Tom", "Werner", "Werk AG"],
    ["anna@nord.de", "Anna", "Nord", "Nord KG"],
  ]) {
    const id = Number(env.ctx.db.prepare("INSERT INTO leads (email, first_name, last_name, company, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(email, first, last, company, now, now).lastInsertRowid);
    env.ctx.db.prepare("INSERT INTO lead_list_members (list_id, lead_id) VALUES (?, ?)").run(listId, id);
  }
  const c = await env.api<CampaignDto>("POST", "/api/campaigns", {
    name: "K",
    mailboxIds: [mailboxId],
    listIds: [listId],
    steps: [
      { position: 1, waitDays: 0, subject: "Frage zu {{firma}}", body: "{{begruessung}},\n\nkurze Frage." },
      { position: 2, waitDays: 3, subject: "", body: "{{begruessung}},\n\nnachgehakt." },
    ],
  });
  await env.api("POST", `/api/campaigns/${c.body.id}/start`, {});
  await runInboxPoll(env.ctx, { force: true }); // Cursor setzen
  for (let i = 0; i < 40 && env.mail.sent.length < 3; i++) {
    env.clock.advance(20 * 60_000);
    await runSendTick(env.ctx);
  }
  expect(env.mail.sent).toHaveLength(3);
  const idFor = (email: string) => env.mail.sent.find((s) => s.mail.to.address === email)!.mail.messageId;
  return { mailboxId, campaignId: c.body.id, idFor };
}

const statusOf = (env: TestEnv, email: string) =>
  env.ctx.db.prepare("SELECT cl.status, cl.next_send_at FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = ?").get(email) as { status: string; next_send_at: number | null };

describe("Posteingang verarbeiten", () => {
  it("stoppt die Sequenz bei einer Antwort und zeigt sie unter Antworten", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { mailboxId, idFor } = await sendFirstMails(env);
    env.inbox.push(mailboxId, mails.humanReply("julia@becker-logistik.de", idFor("julia@becker-logistik.de")));
    env.inbox.push(mailboxId, mails.unrelatedMail());
    await runInboxPoll(env.ctx, { force: true });

    expect(statusOf(env, "julia@becker-logistik.de").status).toBe("replied");
    const inbox = await env.api<Paged<InboundDto>>("GET", "/api/inbox?kind=reply");
    expect(inbox.body.total).toBe(1);
    expect(inbox.body.items[0]).toMatchObject({ leadName: "Julia Becker", company: "Becker GmbH", handled: false, campaignName: "K" });
    expect(inbox.body.items[0]?.snippet).toContain("klingt interessant");
    expect(inbox.body.items[0]?.gmailLink).toContain("rfc822msgid");
    // Fremde Mails werden nicht gespeichert
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM inbound").get()).toEqual({ n: 1 });

    // Keine Nachfass-Mail mehr an Julia (Dienstag + 6 Tage = Montag, Versandtag)
    env.clock.advance(6 * 86_400_000);
    for (let i = 0; i < 40; i++) {
      env.clock.advance(20 * 60_000);
      await runSendTick(env.ctx);
    }
    expect(env.mail.sent.filter((s) => s.mail.to.address === "julia@becker-logistik.de")).toHaveLength(1);
    expect(env.mail.sent.filter((s) => s.mail.to.address === "tom@werk.de")).toHaveLength(2);

    const dash = await env.api<DashboardDto>("GET", "/api/dashboard");
    expect(dash.body.unhandledReplies).toBe(1);
  });

  it("ordnet Antworten von Kollegen über die Message-ID zu", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { mailboxId, idFor } = await sendFirstMails(env);
    env.inbox.push(mailboxId, mails.colleagueReply(idFor("julia@becker-logistik.de")));
    await runInboxPoll(env.ctx, { force: true });
    expect(statusOf(env, "julia@becker-logistik.de").status).toBe("replied");
  });

  it("setzt Bounces auf die Sperrliste", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { mailboxId, idFor } = await sendFirstMails(env);
    env.inbox.push(mailboxId, mails.gmailBounce("tom@werk.de", idFor("tom@werk.de")));
    await runInboxPoll(env.ctx, { force: true });
    expect(statusOf(env, "tom@werk.de").status).toBe("bounced");
    expect(env.ctx.db.prepare("SELECT status FROM leads WHERE email = 'tom@werk.de'").get()).toEqual({ status: "bounced" });
    expect(env.ctx.db.prepare("SELECT reason FROM suppressions WHERE value = 'tom@werk.de'").get()).toEqual({ reason: "bounce" });
  });

  it("verschiebt die nächste Mail bei Abwesenheit hinter das Rückkehrdatum", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { mailboxId, idFor } = await sendFirstMails(env);
    env.inbox.push(mailboxId, mails.outlookOutOfOffice("julia@becker-logistik.de", idFor("julia@becker-logistik.de")));
    await runInboxPoll(env.ctx, { force: true });
    const s = statusOf(env, "julia@becker-logistik.de");
    expect(s.status).toBe("active");
    expect(s.next_send_at!).toBeGreaterThanOrEqual(Date.UTC(2025, 2, 14, 23, 0));
  });

  it("meldet bei einer Abmeldung per Antwort ab", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { mailboxId, idFor } = await sendFirstMails(env);
    env.inbox.push(mailboxId, mails.unsubscribeReply("anna@nord.de", idFor("anna@nord.de")));
    env.inbox.push(mailboxId, mails.gmailUnsubscribeButton("tom@werk.de"));
    await runInboxPoll(env.ctx, { force: true });
    expect(statusOf(env, "anna@nord.de").status).toBe("unsubscribed");
    expect(statusOf(env, "tom@werk.de").status).toBe("unsubscribed");
    const supp = env.ctx.db.prepare("SELECT value FROM suppressions ORDER BY value").all();
    expect(supp).toEqual([{ value: "anna@nord.de" }, { value: "tom@werk.de" }]);
  });

  it("verarbeitet dieselbe Mail nur einmal", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { mailboxId, idFor } = await sendFirstMails(env);
    const raw = mails.humanReply("julia@becker-logistik.de", idFor("julia@becker-logistik.de"));
    env.inbox.push(mailboxId, raw);
    env.inbox.push(mailboxId, raw);
    await runInboxPoll(env.ctx, { force: true });
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM inbound").get()).toEqual({ n: 1 });
  });

  it("markiert Antworten als erledigt und meldet manuell ab", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const { mailboxId, idFor } = await sendFirstMails(env);
    env.inbox.push(mailboxId, mails.humanReply("julia@becker-logistik.de", idFor("julia@becker-logistik.de")));
    await runInboxPoll(env.ctx, { force: true });
    const item = (await env.api<Paged<InboundDto>>("GET", "/api/inbox")).body.items[0]!;
    const patched = await env.api<InboundDto>("PATCH", `/api/inbox/${item.id}`, { handled: true, category: "interessiert" });
    expect(patched.body).toMatchObject({ handled: true, category: "interessiert" });
    const unsub = await env.api<InboundDto>("POST", `/api/inbox/${item.id}/unsubscribe`);
    expect(unsub.body.category).toBe("abmelden");
    expect(env.ctx.db.prepare("SELECT status FROM leads WHERE email = 'julia@becker-logistik.de'").get()).toEqual({ status: "unsubscribed" });
  });

  it("meldet Probleme beim Abruf am Postfach", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const mailboxId = await addTestMailbox(env);
    env.inbox.fetchNew = async () => {
      throw Object.assign(new Error("Command failed"), { authenticationFailed: true });
    };
    await runInboxPoll(env.ctx, { force: true });
    const mb = env.ctx.db.prepare("SELECT imap_error FROM mailboxes WHERE id = ?").get(mailboxId) as { imap_error: string };
    expect(mb.imap_error).toContain("App-Passwort");
  });
});
