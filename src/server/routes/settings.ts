import type { FastifyInstance } from "fastify";
import { IANAZone } from "luxon";
import { z } from "zod";
import type { AppContext } from "../context";
import { badRequest, parseBody } from "../lib/http";
import { getSettings, updateSettings, type AppSettings } from "../lib/settings";
import { getGoogleOAuthClient } from "../mail/googleOAuth";
import { normalizeKey, STANDARD_KEYS } from "../../shared/template";
import type { SettingsDto } from "../../shared/types";

export function settingsDto(ctx: AppContext): SettingsDto {
  const s = getSettings(ctx.db);
  return {
    companyName: s.companyName,
    companyAddress: s.companyAddress,
    companyLegal: s.companyLegal,
    privacyUrl: s.privacyUrl,
    timezone: s.timezone,
    optOutText: s.optOutText,
    globalVariables: s.globalVariables,
    legalNoticeAccepted: s.legalNoticeAccepted,
    ai: {
      keyConfigured: ctx.ai.keySource() !== null,
      keySource: ctx.ai.keySource(),
      model: ctx.config.claudeModel ?? s.claudeModel,
      modelSource: ctx.ai.modelSource(),
      prices: s.aiPrices,
    },
    publicBaseUrl: ctx.config.publicBaseUrl,
    googleOAuthConfigured: getGoogleOAuthClient(ctx.config, ctx.db, ctx.secrets) !== null,
  };
}

const priceSchema = z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000) });

const settingsSchema = z.object({
  companyName: z.string().max(200).optional(),
  companyAddress: z.string().max(500).optional(),
  companyLegal: z.string().max(1000).optional(),
  privacyUrl: z.string().max(500).optional(),
  timezone: z.string().optional(),
  optOutText: z.string().min(10, "Der Abmeldehinweis ist zu kurz.").max(500).optional(),
  globalVariables: z.record(z.string(), z.string().max(2000)).optional(),
  legalNoticeAccepted: z.boolean().optional(),
  anthropicApiKey: z.string().max(500).nullable().optional(),
  claudeModel: z.string().max(200).nullable().optional(),
  aiPrices: z
    .object({ opus: priceSchema, sonnet: priceSchema, haiku: priceSchema, fable: priceSchema, mythos: priceSchema })
    .partial()
    .optional(),
  googleClientId: z.string().max(300).nullable().optional(),
  googleClientSecret: z.string().max(300).nullable().optional(),
});

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/settings", async () => settingsDto(ctx));

  app.put("/api/settings", async (request) => {
    const body = parseBody(settingsSchema, request);
    const patch: Partial<AppSettings> = {};
    if (body.companyName !== undefined) patch.companyName = body.companyName.trim();
    if (body.companyAddress !== undefined) patch.companyAddress = body.companyAddress.trim();
    if (body.companyLegal !== undefined) patch.companyLegal = body.companyLegal.trim();
    if (body.privacyUrl !== undefined) patch.privacyUrl = body.privacyUrl.trim();
    if (body.optOutText !== undefined) patch.optOutText = body.optOutText.trim();
    if (body.legalNoticeAccepted !== undefined) patch.legalNoticeAccepted = body.legalNoticeAccepted;
    if (body.timezone !== undefined) {
      if (!IANAZone.isValidZone(body.timezone)) throw badRequest("Unbekannte Zeitzone.");
      patch.timezone = body.timezone;
    }
    if (body.globalVariables !== undefined) {
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.globalVariables)) {
        const key = normalizeKey(k);
        if (!key) continue;
        if (STANDARD_KEYS.has(key)) throw badRequest(`„${key}“ ist ein Standard-Platzhalter und kann nicht überschrieben werden.`);
        vars[key] = v;
      }
      patch.globalVariables = vars;
    }
    if (body.anthropicApiKey !== undefined) {
      const key = body.anthropicApiKey?.trim();
      patch.anthropicKeyEnc = key ? ctx.secrets.encrypt(key) : null;
    }
    if (body.claudeModel !== undefined) patch.claudeModel = body.claudeModel?.trim() || null;
    if (body.aiPrices !== undefined) patch.aiPrices = { ...getSettings(ctx.db).aiPrices, ...body.aiPrices };
    if (body.googleClientId !== undefined) patch.googleClientId = body.googleClientId?.trim() || null;
    if (body.googleClientSecret !== undefined) {
      const secret = body.googleClientSecret?.trim();
      patch.googleClientSecretEnc = secret ? ctx.secrets.encrypt(secret) : null;
    }
    updateSettings(ctx.db, patch);
    if (body.anthropicApiKey !== undefined || body.claudeModel !== undefined) ctx.ai.invalidate();
    return settingsDto(ctx);
  });
}
