import type { AppContext } from "../context";
import { callStructured } from "./call";
import { ImproveSchema, SequenceSchema, WRITER_RULES, improveUserMessage, writerUserMessage } from "./prompts";
import type { CampaignStepDto, Formality } from "../../shared/types";

export interface WriteSequenceInput {
  offer: string;
  audience: string;
  goal: string;
  proof: string;
  tone: string;
  formality: Formality;
  emails: number;
  useAi: boolean;
  customFields: string[];
}

export async function writeSequence(ctx: AppContext, input: WriteSequenceInput): Promise<{ steps: CampaignStepDto[]; hints: string[] }> {
  const { data } = await callStructured(ctx, {
    feature: "writer",
    schema: SequenceSchema,
    system: [WRITER_RULES],
    user: writerUserMessage(input),
    effort: "medium",
    maxTokens: 16000,
  });
  const steps = data.schritte.slice(0, 5).map((s, i) => ({
    position: i + 1,
    waitDays: i === 0 ? 0 : Math.min(60, Math.max(1, Math.round(s.wartetage || 3))),
    // Nachfass-Mails gehen als Antwort im selben Verlauf raus
    subject: i === 0 ? s.betreff.trim() : "",
    body: s.text.replace(/\r\n/g, "\n").trim(),
  }));
  return { steps, hints: data.hinweise.slice(0, 6) };
}

export async function improveText(
  ctx: AppContext,
  input: { subject: string; body: string; instruction: string; formality: Formality; isFollowUp: boolean },
): Promise<{ subject: string; body: string; changes: string[] }> {
  const { data } = await callStructured(ctx, {
    feature: "improve",
    schema: ImproveSchema,
    system: [WRITER_RULES],
    user: improveUserMessage(input),
    effort: "medium",
    maxTokens: 12000,
  });
  return { subject: input.isFollowUp && !input.subject ? "" : data.betreff.trim(), body: data.text.replace(/\r\n/g, "\n").trim(), changes: data.aenderungen.slice(0, 5) };
}
