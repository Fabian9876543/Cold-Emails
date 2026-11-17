import { DateTime } from "luxon";
import type { AppContext } from "../context";
import { getSettings } from "../lib/settings";
import { callStructured } from "./call";
import { REPLY_RULES, ReplySchema, replyUserMessage, type ReplyOutput } from "./prompts";

export async function classifyReply(ctx: AppContext, inbound: { subject: string; snippet: string; lead_id: number | null }): Promise<ReplyOutput> {
  const ours = inbound.lead_id
    ? (ctx.db.prepare("SELECT body FROM messages WHERE lead_id = ? AND status = 'sent' AND is_test = 0 ORDER BY sent_at DESC LIMIT 1").get(inbound.lead_id) as { body: string } | undefined)
    : undefined;
  const today = DateTime.fromMillis(ctx.clock.now(), { zone: getSettings(ctx.db).timezone }).toISODate() ?? "";
  const { data } = await callStructured(ctx, {
    feature: "reply",
    schema: ReplySchema,
    system: [REPLY_RULES],
    user: replyUserMessage({ subject: inbound.subject, text: inbound.snippet, ourEmail: ours?.body ?? null, today }),
    effort: "low",
    maxTokens: 3000,
  });
  const date = data.rueckkehr_datum && /^\d{4}-\d{2}-\d{2}$/.test(data.rueckkehr_datum) ? data.rueckkehr_datum : null;
  return { ...data, zusammenfassung: data.zusammenfassung.trim().slice(0, 300), rueckkehr_datum: data.kategorie === "abwesend" ? date : null };
}
