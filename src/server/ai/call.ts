import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import type { AppContext } from "../context";
import { recordUsage } from "./usage";

export type AiErrorKind = "not_configured" | "auth" | "rate" | "refusal" | "invalid" | "api";

export class AiError extends Error {
  constructor(
    message: string,
    public readonly kind: AiErrorKind,
  ) {
    super(message);
  }
}

export interface StructuredCall<T> {
  feature: string;
  schema: ZodType<T>;
  /** Stabile System-Teile; der letzte Block wird zwischengespeichert (Prompt-Caching). */
  system: string[];
  user: string;
  effort: "low" | "medium" | "high";
  maxTokens: number;
}

export function toAiError(err: unknown, model: string): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiError("Der Claude-API-Schlüssel ist ungültig oder hat keine Berechtigung. Bitte in den Einstellungen prüfen.", "auth");
  }
  if (err instanceof Anthropic.RateLimitError) return new AiError("Das Anfragelimit der Claude-API ist erreicht. Es wird gleich automatisch erneut versucht.", "rate");
  if (err instanceof Anthropic.NotFoundError) return new AiError(`Das Modell „${model}“ ist nicht verfügbar. Bitte in den Einstellungen ein anderes Modell wählen.`, "api");
  if (err instanceof Anthropic.BadRequestError) return new AiError(`Die Claude-API hat die Anfrage abgelehnt: ${err.message}`, "api");
  if (err instanceof Anthropic.InternalServerError) return new AiError("Die Claude-API ist gerade überlastet. Es wird später erneut versucht.", "rate");
  if (err instanceof Anthropic.APIConnectionError) return new AiError("Keine Verbindung zur Claude-API. Es wird später erneut versucht.", "rate");
  if (err instanceof Anthropic.APIError) return new AiError(`Fehler der Claude-API (${err.status ?? "?"}): ${err.message}`, "api");
  return new AiError(`Unerwarteter Fehler bei der KI-Anfrage: ${(err as Error)?.message ?? String(err)}`, "api");
}

export function systemBlocks(parts: string[]): Anthropic.Beta.Messages.BetaTextBlockParam[] {
  return parts.map((text, i) => (i === parts.length - 1 ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text }));
}

/** Strukturierte Anfrage an Claude (messages.parse + Zod-Schema), mit Refusal-Fallback und Kostenerfassung. */
export async function callStructured<T>(ctx: AppContext, call: StructuredCall<T>): Promise<{ data: T; model: string }> {
  const client = ctx.ai.client();
  if (!client) throw new AiError("Es ist kein Claude-API-Schlüssel hinterlegt (Einstellungen → KI).", "not_configured");
  let model = "";
  try {
    model = await ctx.ai.resolveModel();
    const line = await ctx.ai.lineOf(model);
    // Server-seitiger Fallback bei Ablehnungen – nicht für die Haiku-Familie verfügbar
    const fallback = line !== "haiku" && line !== null ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
    const res = await client.beta.messages.parse({
      model,
      max_tokens: call.maxTokens,
      system: systemBlocks(call.system),
      messages: [{ role: "user", content: call.user }],
      output_config: { effort: call.effort, format: zodOutputFormat(call.schema as never) },
      ...fallback,
    });
    await recordUsage(ctx, call.feature, res.model ?? model, res.usage);
    if (res.stop_reason === "refusal") throw new AiError("Die KI hat diese Anfrage abgelehnt.", "refusal");
    if (res.stop_reason === "max_tokens") throw new AiError("Die Antwort der KI war zu lang und wurde abgeschnitten.", "invalid");
    const data = (res as { parsed_output?: unknown }).parsed_output;
    if (data === null || data === undefined) throw new AiError("Die Antwort der KI hatte ein unerwartetes Format.", "invalid");
    return { data: data as T, model: res.model ?? model };
  } catch (err) {
    throw toAiError(err, model);
  }
}

/** JSON-Schema für Batch-Anfragen (dort ohne parse-Helfer). */
export function jsonFormat<T>(schema: ZodType<T>) {
  const fmt = zodOutputFormat(schema as never);
  return { format: { type: "json_schema" as const, schema: fmt.schema }, parse: (text: string) => fmt.parse(text) as T };
}
