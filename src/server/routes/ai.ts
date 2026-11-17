import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import type { AppContext } from "../context";
import { badRequest, HttpError, idParam, notFound, parseBody, parseQuery } from "../lib/http";
import { getSettings } from "../lib/settings";
import { parseCustom } from "../leads/repo";
import { getCampaignLeadRow, getCampaignRow } from "../campaigns/repo";
import { AiError, callStructured } from "../ai/call";
import { usageForMonth } from "../ai/usage";
import { improveText, writeSequence } from "../ai/writer";
import { validateOpener } from "../ai/opener";
import type { AiModelDto } from "../../shared/types";

function aiHttpError(err: unknown): never {
  if (err instanceof AiError) throw new HttpError(err.kind === "not_configured" ? 400 : err.kind === "rate" ? 429 : 400, err.message);
  throw err;
}

const SCOPES = {
  missing: "cl.ai_status = 'none'",
  errors: "cl.ai_status = 'error'",
  all: "cl.ai_status IN ('none','error','done')",
} as const;

// Erfahrungswerte je Kontakt (Tokens) für die Kostenschätzung
const EST = { system: 1300, user: 220, website: 1100, output: 350 };

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/ai/models", async (): Promise<AiModelDto[]> => {
    if (!ctx.ai.client()) return [];
    try {
      return await ctx.ai.listModels();
    } catch (err) {
      throw new HttpError(400, `Modelle konnten nicht geladen werden: ${(err as Error).message}`);
    }
  });

  app.post("/api/ai/test", async () => {
    try {
      const { model } = await callStructured(ctx, {
        feature: "test",
        schema: z.object({ ok: z.boolean() }),
        system: ["Antworte ausschließlich im vorgegebenen JSON-Format."],
        user: "Setze ok auf true.",
        effort: "low",
        maxTokens: 1000,
      });
      return { ok: true, model };
    } catch (err) {
      aiHttpError(err);
    }
  });

  app.get("/api/ai/usage", async () => {
    const tz = getSettings(ctx.db).timezone;
    const month = DateTime.fromMillis(ctx.clock.now(), { zone: tz }).startOf("month");
    return { current: usageForMonth(ctx, month), previous: usageForMonth(ctx, month.minus({ months: 1 })) };
  });

  app.post("/api/ai/write-sequence", async (request) => {
    const body = parseBody(
      z.object({
        offer: z.string().max(2000).default(""),
        audience: z.string().max(1000).default(""),
        goal: z.string().max(500).default(""),
        proof: z.string().max(1000).default(""),
        tone: z.string().max(300).default(""),
        formality: z.enum(["sie", "du"]).default("sie"),
        emails: z.number().int().min(1).max(5).default(3),
        useAi: z.boolean().default(true),
      }),
      request,
    );
    if (!body.offer.trim()) throw badRequest("Bitte beschreiben Sie kurz Ihr Angebot.");
    const rows = ctx.db.prepare("SELECT DISTINCT custom_json FROM leads WHERE custom_json != '{}' LIMIT 500").all() as { custom_json: string }[];
    const customFields = [...new Set(rows.flatMap((r) => Object.keys(parseCustom(r.custom_json))))].slice(0, 20);
    try {
      return await writeSequence(ctx, { ...body, customFields });
    } catch (err) {
      aiHttpError(err);
    }
  });

  app.post("/api/ai/improve", async (request) => {
    const body = parseBody(
      z.object({
        subject: z.string().max(300),
        body: z.string().min(1).max(10_000),
        instruction: z.string().min(2).max(500),
        formality: z.enum(["sie", "du"]).default("sie"),
        position: z.number().int().min(1).default(1),
      }),
      request,
    );
    try {
      return await improveText(ctx, { ...body, isFollowUp: body.position > 1 });
    } catch (err) {
      aiHttpError(err);
    }
  });

  // --- Einstiege einer Kampagne ---
  app.get("/api/campaigns/:id/ai/estimate", async (request) => {
    const id = idParam(request);
    const c = getCampaignRow(ctx.db, id);
    if (!c) throw notFound("Kampagne");
    const { scope } = parseQuery(z.object({ scope: z.enum(["missing", "errors", "all"]).default("missing") }), request);
    const count = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM campaign_leads cl WHERE cl.campaign_id = ? AND cl.status IN ('queued','active') AND cl.next_step = 1 AND ${SCOPES[scope]}`).get(id) as { n: number }).n;
    let model: string | null = null;
    try {
      model = ctx.ai.client() ? await ctx.ai.resolveModel() : null;
    } catch {
      model = null;
    }
    const line = model ? await ctx.ai.lineOf(model) : null;
    const p = getSettings(ctx.db).aiPrices[line ?? "opus"];
    const userTokens = EST.user + (c.ai_use_website ? EST.website : 0);
    const usd = count === 0 ? 0 : (EST.system * p.input * 1.25 + (count - 1) * EST.system * p.input * 0.1 + count * userTokens * p.input + count * EST.output * p.output) / 1_000_000;
    return { count, model, usd, batchUsd: usd / 2 };
  });

  app.post("/api/campaigns/:id/ai/generate", async (request) => {
    const id = idParam(request);
    const c = getCampaignRow(ctx.db, id);
    if (!c) throw notFound("Kampagne");
    if (!ctx.ai.client()) throw badRequest("Bitte zuerst in den Einstellungen einen Claude-API-Schlüssel hinterlegen.");
    const body = parseBody(z.object({ scope: z.enum(["missing", "errors", "all", "selected"]).default("missing"), ids: z.array(z.number().int()).max(10_000).optional(), batch: z.boolean().default(false) }), request);
    let queued = 0;
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE campaigns SET ai_enabled = 1, ai_batch = ?, updated_at = ? WHERE id = ?").run(body.batch ? 1 : 0, ctx.clock.now(), id);
      if (body.scope === "selected") {
        const upd = ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'pending', ai_error = NULL WHERE id = ? AND campaign_id = ? AND ai_status != 'generating' AND next_step = 1");
        for (const x of body.ids ?? []) queued += upd.run(x, id).changes;
      } else {
        queued = ctx.db
          .prepare(`UPDATE campaign_leads SET ai_status = 'pending', ai_error = NULL WHERE campaign_id = ? AND status IN ('queued','active') AND next_step = 1 AND ${SCOPES[body.scope].replace(/cl\./g, "")}`)
          .run(id).changes;
      }
    })();
    return { queued };
  });

  app.post("/api/campaigns/:id/ai/approve", async (request) => {
    const id = idParam(request);
    if (!getCampaignRow(ctx.db, id)) throw notFound("Kampagne");
    const { ids } = parseBody(z.object({ ids: z.array(z.number().int()).max(10_000).optional() }), request);
    let approved = 0;
    if (ids?.length) {
      const upd = ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'approved' WHERE id = ? AND campaign_id = ? AND ai_status = 'done'");
      ctx.db.transaction(() => ids.forEach((x) => (approved += upd.run(x, id).changes)))();
    } else {
      approved = ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'approved' WHERE campaign_id = ? AND ai_status = 'done'").run(id).changes;
    }
    return { approved };
  });

  app.patch("/api/campaign-leads/:id/opener", async (request) => {
    const id = idParam(request);
    const cl = getCampaignLeadRow(ctx.db, id);
    if (!cl) throw notFound("Eintrag");
    const { text, approve } = parseBody(z.object({ text: z.string().max(400), approve: z.boolean().default(true) }), request);
    const problem = validateOpener(text);
    if (problem) throw badRequest(problem);
    ctx.db
      .prepare("UPDATE campaign_leads SET ai_opener = ?, ai_status = ?, ai_error = NULL, ai_quality = COALESCE(ai_quality, 'manuell'), ai_reason = CASE WHEN ai_reason IS NULL THEN 'Von Hand geschrieben' ELSE ai_reason END WHERE id = ?")
      .run(text.trim(), approve ? "approved" : "done", id);
    return { ok: true };
  });

  app.post("/api/campaign-leads/:id/opener/regenerate", async (request) => {
    const id = idParam(request);
    const cl = getCampaignLeadRow(ctx.db, id);
    if (!cl) throw notFound("Eintrag");
    if (cl.next_step > 1) throw badRequest("Dieser Kontakt wurde bereits angeschrieben.");
    const c = getCampaignRow(ctx.db, cl.campaign_id)!;
    if (c.ai_batch) ctx.db.prepare("UPDATE campaigns SET ai_batch = 0 WHERE id = ?").run(c.id); // Einzelne Neuerstellung sofort
    ctx.db.prepare("UPDATE campaign_leads SET ai_status = 'pending', ai_error = NULL WHERE id = ?").run(id);
    return { ok: true };
  });
}
