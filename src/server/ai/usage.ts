import { DateTime } from "luxon";
import type { AppContext } from "../context";
import { getSettings } from "../lib/settings";
import type { AiUsageDto, ModelLine } from "../../shared/types";

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Geschätzte Kosten in US-Dollar (Preise je Modellfamilie aus den Einstellungen). */
export function estimateCostUsd(ctx: AppContext, line: ModelLine | null, usage: UsageLike, batch: boolean): number {
  const prices = getSettings(ctx.db).aiPrices;
  const p = prices[line ?? "opus"] ?? prices.opus;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cost = (input * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + output * p.output) / 1_000_000;
  return batch ? cost * 0.5 : cost;
}

export async function recordUsage(ctx: AppContext, feature: string, model: string, usage: UsageLike | null | undefined, batch = false): Promise<void> {
  if (!usage) return;
  const line = await ctx.ai.lineOf(model);
  ctx.db
    .prepare(
      "INSERT INTO ai_usage (created_at, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, batch, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      ctx.clock.now(),
      feature,
      model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      batch ? 1 : 0,
      estimateCostUsd(ctx, line, usage, batch),
    );
}

export function usageForMonth(ctx: AppContext, monthStart: DateTime): AiUsageDto {
  const from = monthStart.toMillis();
  const to = monthStart.plus({ months: 1 }).toMillis();
  const r = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COUNT(*) AS n FROM ai_usage WHERE created_at >= ? AND created_at < ?",
    )
    .get(from, to) as { cost: number; input: number; output: number; n: number };
  return { month: monthStart.setLocale("de").toFormat("LLLL yyyy"), costUsd: r.cost, inputTokens: r.input, outputTokens: r.output, requests: r.n };
}
