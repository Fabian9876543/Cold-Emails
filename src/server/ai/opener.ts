import type { AppContext } from "../context";
import type { CampaignRow, StepRow } from "../campaigns/repo";
import { parseCustom, type LeadRow } from "../leads/repo";
import { AiError, callStructured } from "./call";
import { OPENER_RULES, OpenerSchema, openerCampaignContext, openerUserMessage, type OpenerOutput } from "./prompts";
import { fetchWebsiteText } from "./website";

/** Prüft einen generierten Einstieg auf harte Regeln. Gibt eine Fehlermeldung zurück oder null. */
export function validateOpener(text: string): string | null {
  const t = text.trim();
  if (!t) return "Der Einstieg ist leer.";
  if (t.length > 320 || t.split(/\s+/).length > 45) return "Der Einstieg ist zu lang.";
  if (/[{}]/.test(t)) return "Der Einstieg enthält Platzhalter.";
  if (/https?:\/\/|www\./i.test(t)) return "Der Einstieg enthält einen Link.";
  if (/\p{Extended_Pictographic}/u.test(t)) return "Der Einstieg enthält Emojis.";
  if (/^(hallo|guten tag|sehr geehrte|hi |liebe)/i.test(t)) return "Der Einstieg enthält eine Begrüßung.";
  return null;
}

export function openerSystem(campaign: Pick<CampaignRow, "formality" | "ai_context">, step1: Pick<StepRow, "subject" | "body"> | undefined): string[] {
  return [
    OPENER_RULES,
    openerCampaignContext({ formality: campaign.formality, aiContext: campaign.ai_context, step1Subject: step1?.subject ?? "", step1Body: step1?.body ?? "" }),
  ];
}

export async function openerUser(ctx: AppContext, campaign: Pick<CampaignRow, "ai_use_website">, lead: LeadRow): Promise<string> {
  let website: string | null = null;
  if (campaign.ai_use_website && lead.website) {
    try {
      website = await fetchWebsiteText(ctx, lead.website);
    } catch {
      website = null;
    }
  }
  return openerUserMessage(
    { firstName: lead.first_name, lastName: lead.last_name, salutation: lead.salutation, company: lead.company, position: lead.position, website: lead.website, custom: parseCustom(lead.custom_json) },
    website,
  );
}

export async function generateOpener(ctx: AppContext, campaign: CampaignRow, step1: StepRow | undefined, lead: LeadRow): Promise<OpenerOutput> {
  const { data } = await callStructured(ctx, {
    feature: "opener",
    schema: OpenerSchema,
    system: openerSystem(campaign, step1),
    user: await openerUser(ctx, campaign, lead),
    effort: "low",
    maxTokens: 4000,
  });
  const problem = validateOpener(data.einstieg);
  if (problem) throw new AiError(`${problem} Bitte neu erstellen oder von Hand anpassen.`, "invalid");
  return { ...data, einstieg: data.einstieg.trim() };
}
