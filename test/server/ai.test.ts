import { afterEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { addTestMailbox, createTestEnv, fakeDns, type TestEnv } from "../helpers";
import type { AiGateway } from "../../src/server/ai/client";
import { processOpeners, processReplies, pollBatches, resetAiJobState, runAiJobs, submitBatches } from "../../src/server/ai/jobs";
import { validateOpener } from "../../src/server/ai/opener";
import { extractText, isPrivateAddress, normalizeUrl } from "../../src/server/ai/website";
import { runSendTick } from "../../src/server/worker/sender";
import { runInboxPoll } from "../../src/server/worker/inboxPoller";
import * as mails from "../fixtures/mails";
import type { CampaignDto, CampaignLeadDto, Paged } from "../../src/shared/types";

type ParseParams = Record<string, unknown> & { system: { text: string; cache_control?: unknown }[]; messages: { content: string }[] };

class FakeAnthropic {
  calls: ParseParams[] = [];
  /** Antworten der Reihe nach; Funktion erhält die Anfrage. */
  responder: (p: ParseParams) => unknown = () => ({ einstieg: "mir ist aufgefallen, dass Sie Kühltransporte für Apotheken anbieten.", qualitaet: "hoch", begruendung: "Leistung aus den Kontaktdaten" });
  error: unknown = null;
  batchRequests: { custom_id: string; params: Record<string, unknown> }[] = [];
  batchResults: unknown[] = [];
  beta = {
    messages: {
      parse: async (p: ParseParams) => {
        this.calls.push(p);
        if (this.error) throw this.error;
        return { model: p.model, stop_reason: "end_turn", parsed_output: this.responder(p), usage: { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } };
      },
    },
  };
  messages = {
    batches: {
      create: async ({ requests }: { requests: { custom_id: string; params: Record<string, unknown> }[] }) => {
        this.batchRequests = requests;
        return { id: "msgbatch_1", processing_status: "in_progress" };
      },
      retrieve: async () => ({ id: "msgbatch_1", processing_status: "ended" }),
      results: async () => {
        const items = this.batchResults;
        return (async function* () {
          for (const i of items) yield i;
        })();
      },
    },
  };
  models = {
    list: () =>
      (async function* () {
        yield { id: "claude-opus-test", display_name: "Opus Test", line: "opus", created_at: "2026-10-01T00:00:00Z", lifecycle: "active", capabilities: null };
        yield { id: "claude-haiku-test", display_name: "Haiku Test", line: "haiku", created_at: "2026-09-01T00:00:00Z", lifecycle: "active", capabilities: null };
      })(),
  };
}

function fakeAi(client: FakeAnthropic, model = "claude-opus-test"): AiGateway {
  return {
    client: () => client as unknown as Anthropic,
    keySource: () => "settings",
    resolveModel: async () => model,
    modelSource: () => "auto",
    listModels: async () => [],
    lineOf: async (m) => (m.includes("haiku") ? "haiku" : "opus"),
    invalidate: () => undefined,
  };
}

const GOOD_DNS = fakeDns({
  txt: { "absender.de": ["v=spf1 include:_spf.google.com ~all"], "google._domainkey.absender.de": ["v=DKIM1; p=ABC"], "_dmarc.absender.de": ["v=DMARC1; p=none"] },
});

async function aiCampaign(env: TestEnv, extra: Record<string, unknown> = {}) {
  const mailboxId = await addTestMailbox(env);
  const now = env.clock.now();
  const listId = Number(env.ctx.db.prepare("INSERT INTO lead_lists (name, created_at) VALUES ('L', ?)").run(now).lastInsertRowid);
  for (const [email, first, company] of [
    ["julia@becker.de", "Julia", "Becker GmbH"],
    ["tom@werk.de", "Tom", "Werk AG"],
  ]) {
    const id = Number(env.ctx.db.prepare("INSERT INTO leads (email, first_name, company, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(email, first, company, now, now).lastInsertRowid);
    env.ctx.db.prepare("INSERT INTO lead_list_members (list_id, lead_id) VALUES (?, ?)").run(listId, id);
  }
  const res = await env.api<CampaignDto>("POST", "/api/campaigns", {
    name: "KI",
    mailboxIds: [mailboxId],
    listIds: [listId],
    aiEnabled: true,
    aiUseWebsite: false,
    aiContext: "Wir bieten Tourenplanung für Kühltransporte.",
    steps: [{ position: 1, waitDays: 0, subject: "Frage zu {{firma}}", body: "{{begruessung}},\n\n{{ki_einstieg}}\n\nKurze Frage." }],
    ...extra,
  });
  return res.body;
}

afterEach(() => resetAiJobState());

describe("KI-Einstiege", () => {
  it("erstellt Einstiege mit zwischengespeichertem System-Prompt und Refusal-Fallback", async () => {
    const client = new FakeAnthropic();
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client) });
    const c = await aiCampaign(env);
    const gen = await env.api<{ queued: number }>("POST", `/api/campaigns/${c.id}/ai/generate`, { scope: "missing" });
    expect(gen.body.queued).toBe(2);
    await processOpeners(env.ctx);
    expect(client.calls).toHaveLength(2);
    const call = client.calls[0]!;
    expect(call.system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(call.system[0]?.cache_control).toBeUndefined();
    expect(call.system[1]?.text).toContain("Tourenplanung für Kühltransporte");
    expect(call.fallbacks).toBe("default");
    expect(call.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect((call.output_config as { effort: string }).effort).toBe("low");
    expect(call.messages[0]?.content).toContain("Firma: Becker GmbH");

    const leads = await env.api<Paged<CampaignLeadDto>>("GET", `/api/campaigns/${c.id}/leads`);
    expect(leads.body.items.every((l) => l.aiStatus === "done")).toBe(true);
    expect(leads.body.items[0]?.aiOpener).toContain("Kühltransporte");
    // Kosten werden erfasst
    const usage = await env.api<{ current: { requests: number; costUsd: number } }>("GET", "/api/ai/usage");
    expect(usage.body.current.requests).toBe(2);
    expect(usage.body.current.costUsd).toBeGreaterThan(0);
  });

  it("sendet erst nach der Freigabe – mit dem Einstieg im Text", async () => {
    const client = new FakeAnthropic();
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client) });
    const c = await aiCampaign(env);
    await env.api("POST", `/api/campaigns/${c.id}/start`, {});
    await processOpeners(env.ctx);
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    expect(env.mail.sent).toHaveLength(0); // noch nicht freigegeben
    const approved = await env.api<{ approved: number }>("POST", `/api/campaigns/${c.id}/ai/approve`, {});
    expect(approved.body.approved).toBe(2);
    env.clock.advance(5 * 60_000);
    await runSendTick(env.ctx);
    expect(env.mail.sent).toHaveLength(1);
    expect(env.mail.sent[0]?.mail.text).toContain("mir ist aufgefallen, dass Sie Kühltransporte");
  });

  it("verwirft Einstiege, die gegen die Regeln verstoßen", async () => {
    expect(validateOpener("Hallo Julia, schön Sie kennenzulernen.")).toContain("Begrüßung");
    expect(validateOpener("Schauen Sie auf www.beispiel.de vorbei.")).toContain("Link");
    expect(validateOpener("Ihr {{firma}} ist toll.")).toContain("Platzhalter");
    expect(validateOpener("mir ist aufgefallen, dass Sie Kühltransporte anbieten.")).toBeNull();
    const client = new FakeAnthropic();
    client.responder = () => ({ einstieg: "Hallo Julia! Schauen Sie mal auf https://x.de", qualitaet: "hoch", begruendung: "-" });
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client) });
    const c = await aiCampaign(env);
    await env.api("POST", `/api/campaigns/${c.id}/ai/generate`, {});
    await processOpeners(env.ctx);
    const leads = await env.api<Paged<CampaignLeadDto>>("GET", `/api/campaigns/${c.id}/leads`);
    expect(leads.body.items[0]?.aiStatus).toBe("error");
  });

  it("wartet bei Limit-Fehlern und versucht es später erneut", async () => {
    const client = new FakeAnthropic();
    client.error = new Anthropic.RateLimitError(429, {}, "rate limited", new Headers());
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client) });
    const c = await aiCampaign(env);
    await env.api("POST", `/api/campaigns/${c.id}/ai/generate`, {});
    await runAiJobs(env.ctx);
    const leads = await env.api<Paged<CampaignLeadDto>>("GET", `/api/campaigns/${c.id}/leads`);
    expect(leads.body.items.every((l) => l.aiStatus === "pending")).toBe(true);
  });

  it("lässt Einstiege von Hand bearbeiten und freigeben", async () => {
    const client = new FakeAnthropic();
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client) });
    const c = await aiCampaign(env);
    const leads = await env.api<Paged<CampaignLeadDto>>("GET", `/api/campaigns/${c.id}/leads`);
    const id = leads.body.items[0]!.id;
    const bad = await env.api<{ error: string }>("PATCH", `/api/campaign-leads/${id}/opener`, { text: "Hallo! Siehe www.x.de" });
    expect(bad.status).toBe(400);
    const ok = await env.api("PATCH", `/api/campaign-leads/${id}/opener`, { text: "ich habe gesehen, dass Sie in Kassel ein neues Lager eröffnet haben.", approve: true });
    expect(ok.status).toBe(200);
    const after = await env.api<Paged<CampaignLeadDto>>("GET", `/api/campaigns/${c.id}/leads`);
    expect(after.body.items[0]).toMatchObject({ aiStatus: "approved" });
  });

  it("schätzt die Kosten vorab", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(new FakeAnthropic()) });
    const c = await aiCampaign(env);
    const est = await env.api<{ count: number; usd: number; batchUsd: number; model: string }>("GET", `/api/campaigns/${c.id}/ai/estimate`);
    expect(est.body.count).toBe(2);
    expect(est.body.usd).toBeGreaterThan(0);
    expect(est.body.batchUsd).toBeCloseTo(est.body.usd / 2);
  });

  it("nutzt für die Haiku-Familie keinen Server-Fallback", async () => {
    const client = new FakeAnthropic();
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client, "claude-haiku-test") });
    const c = await aiCampaign(env);
    await env.api("POST", `/api/campaigns/${c.id}/ai/generate`, {});
    await processOpeners(env.ctx);
    expect(client.calls[0]?.fallbacks).toBeUndefined();
  });
});

describe("Batch-Modus", () => {
  it("beauftragt einen Batch und übernimmt die Ergebnisse", async () => {
    const client = new FakeAnthropic();
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client) });
    const c = await aiCampaign(env);
    await env.api("POST", `/api/campaigns/${c.id}/ai/generate`, { scope: "missing", batch: true });
    await submitBatches(env.ctx);
    expect(client.batchRequests).toHaveLength(2);
    const params = client.batchRequests[0]!.params as { output_config: { format: { type: string } }; fallbacks?: unknown };
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.fallbacks).toBeUndefined();

    client.batchResults = client.batchRequests.map((r, i) => ({
      custom_id: r.custom_id,
      result:
        i === 0
          ? { type: "succeeded", message: { model: "claude-opus-test", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: "text", text: JSON.stringify({ einstieg: "Ihr Fokus auf Kühllogistik ist mir aufgefallen.", qualitaet: "mittel", begruendung: "Branche" }) }] } }
          : { type: "errored", error: { type: "error", error: { type: "overloaded_error", message: "overloaded" } } },
    }));
    await pollBatches(env.ctx);
    const leads = await env.api<Paged<CampaignLeadDto>>("GET", `/api/campaigns/${c.id}/leads`);
    expect(leads.body.items.map((l) => l.aiStatus).sort()).toEqual(["done", "error"]);
    const usage = env.ctx.db.prepare("SELECT batch FROM ai_usage").get() as { batch: number };
    expect(usage.batch).toBe(1);
  });
});

describe("Antworten einordnen", () => {
  it("ordnet Antworten ein und meldet bei Abmeldewunsch ab", async () => {
    const client = new FakeAnthropic();
    client.responder = () => ({ kategorie: "abmelden", zusammenfassung: "Möchte keine weiteren E-Mails erhalten.", rueckkehr_datum: null });
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client) });
    const c = await aiCampaign(env, { aiEnabled: false, steps: [{ position: 1, waitDays: 0, subject: "Frage", body: "{{begruessung}},\n\nTest" }] });
    await env.api("POST", `/api/campaigns/${c.id}/start`, {});
    await runInboxPoll(env.ctx, { force: true });
    env.clock.advance(25 * 60_000);
    await runSendTick(env.ctx);
    const sent = env.mail.sent[0]!.mail;
    env.inbox.push(1, mails.humanReply(sent.to.address, sent.messageId).replace("klingt interessant", "das brauchen wir nicht, bitte sehen Sie davon ab"));
    await runInboxPoll(env.ctx, { force: true });
    expect(env.ctx.db.prepare("SELECT ai_status FROM inbound").get()).toEqual({ ai_status: "pending" });
    await processReplies(env.ctx);
    const row = env.ctx.db.prepare("SELECT category, summary, handled FROM inbound").get() as { category: string; summary: string; handled: number };
    expect(row).toEqual({ category: "abmelden", summary: "Möchte keine weiteren E-Mails erhalten.", handled: 1 });
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM suppressions").get()).toEqual({ n: 1 });
  });
});

describe("Schreibhilfe", () => {
  it("erstellt eine Sequenz und erzwingt Antworten im selben Verlauf", async () => {
    const client = new FakeAnthropic();
    client.responder = () => ({
      schritte: [
        { betreff: "Frage zu {{firma}}", text: "{{begruessung}},\n\n{{ki_einstieg|ich bin auf Sie gestoßen.}}\n\nKurze Frage?\n\nViele Grüße", wartetage: 0 },
        { betreff: "Nachfass", text: "{{begruessung}},\n\nnoch einmal kurz.\n\nViele Grüße", wartetage: 0 },
      ],
      hinweise: ["Bitte [Referenzkunde] ergänzen."],
    });
    const env = await createTestEnv({ dns: GOOD_DNS, ai: fakeAi(client) });
    const res = await env.api<{ steps: { position: number; subject: string; waitDays: number }[]; hints: string[] }>("POST", "/api/ai/write-sequence", { offer: "Tourenplanung", emails: 2 });
    expect(res.status).toBe(200);
    expect(res.body.steps[1]).toMatchObject({ position: 2, subject: "", waitDays: 3 }); // 0 Tage → Standard 3
    expect(res.body.hints).toHaveLength(1);
    expect((client.calls[0]!.output_config as { effort: string }).effort).toBe("medium");
  });

  it("meldet fehlenden API-Schlüssel verständlich", async () => {
    const env = await createTestEnv({ dns: GOOD_DNS });
    const res = await env.api<{ error: string }>("POST", "/api/ai/write-sequence", { offer: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("API-Schlüssel");
  });
});

describe("Website-Auszug", () => {
  it("blockiert private und lokale Adressen", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2a00:1450:4001::1")).toBe(false);
  });

  it("akzeptiert nur normale Web-Adressen", () => {
    expect(normalizeUrl("becker-logistik.de")?.href).toBe("https://becker-logistik.de/");
    expect(normalizeUrl("http://127.0.0.1/admin")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("https://user:pw@host.de")).toBeNull();
  });

  it("extrahiert Titel, Beschreibung und Inhalte", () => {
    const text = extractText(`<html><head><title>Becker Logistik</title><meta name="description" content="Kühltransporte in Nordhessen"><script>alert(1)</script></head>
      <body><nav>Menü</nav><h1>Temperaturgeführte Transporte</h1><p>Seit 1998 für Apotheken unterwegs.</p><p>Wir nutzen Cookies.</p></body></html>`);
    expect(text).toContain("Titel: Becker Logistik");
    expect(text).toContain("Beschreibung: Kühltransporte in Nordhessen");
    expect(text).toContain("## Temperaturgeführte Transporte");
    expect(text).toContain("Seit 1998");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Cookies");
  });
});
