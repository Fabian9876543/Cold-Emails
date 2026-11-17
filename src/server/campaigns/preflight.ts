import type { AppContext } from "../context";
import { getSettings } from "../lib/settings";
import { parseCustom, type LeadRow } from "../leads/repo";
import { effectiveDailyLimit, getMailboxRow, mailboxDomain } from "../mail/mailboxes";
import { refreshDomainCheck, storedDomainResult } from "../routes/domains";
import { getCampaignMailboxIds, getSteps, windowOf, type CampaignLeadRow, type CampaignRow } from "./repo";
import { hasOptOut, renderStep } from "./compose";
import { isValidWindow } from "../worker/schedule";
import { checkSpam } from "../../shared/spamcheck";
import { extractPlaceholders, STANDARD_KEYS } from "../../shared/template";
import type { PreflightDto, PreflightItem } from "../../shared/types";

export async function runPreflight(ctx: AppContext, campaign: CampaignRow, opts: { ignoreDns?: boolean } = {}): Promise<PreflightDto> {
  const blocking: PreflightItem[] = [];
  const warnings: PreflightItem[] = [];
  const settings = getSettings(ctx.db);
  const now = ctx.clock.now();
  const steps = getSteps(ctx.db, campaign.id);
  const mailboxIds = getCampaignMailboxIds(ctx.db, campaign.id);
  const mailboxes = mailboxIds.map((id) => getMailboxRow(ctx.db, id)).filter((m) => m !== undefined);

  // Sequenz
  if (steps.length === 0 || !steps[0]?.body.trim()) blocking.push({ code: "steps", message: "Die erste E-Mail hat noch keinen Text." });
  if (steps[0] && !steps[0].subject.trim()) blocking.push({ code: "subject", message: "Die erste E-Mail braucht einen Betreff." });
  steps.forEach((s) => {
    if (!s.body.trim()) blocking.push({ code: `step${s.position}`, message: `E-Mail ${s.position} hat keinen Text.` });
    const spam = checkSpam({ subject: s.subject, body: s.body, isFirstStep: s.position === 1 });
    if (spam.level === "hoch") warnings.push({ code: `spam${s.position}`, message: `E-Mail ${s.position}: hohes Spam-Risiko – ${spam.findings.filter((f) => f.severity !== "info").map((f) => f.message).slice(0, 2).join(" ")}` });
  });
  const gaps = steps.filter((s) => /\[[^\]\n]{2,60}\]/.test(`${s.subject}\n${s.body}`)).map((s) => s.position);
  if (gaps.length) {
    blocking.push({ code: "gaps", message: `Bitte die Lückentexte in eckigen Klammern [ … ] ausfüllen (E-Mail ${gaps.join(", ")}).` });
  }
  if (!steps.every((s) => hasOptOut(s.body, campaign.opt_out_mode))) {
    warnings.push({ code: "optout", message: "Mindestens eine E-Mail enthält keinen Abmeldehinweis. Jede Werbe-Mail muss eine einfache Abmeldemöglichkeit bieten." });
  }
  if (!isValidWindow(windowOf(campaign))) blocking.push({ code: "window", message: "Das Versandfenster ist ungültig (mindestens 30 Minuten und ein Wochentag)." });

  // Postfächer
  if (mailboxes.length === 0) blocking.push({ code: "mailboxes", message: "Bitte mindestens ein Absender-Postfach auswählen." });
  else if (!mailboxes.some((m) => m.status === "active")) blocking.push({ code: "mailbox_inactive", message: "Keines der gewählten Postfächer ist aktiv. Bitte unter „Postfächer“ prüfen." });
  else {
    for (const m of mailboxes.filter((x) => x.status !== "active")) warnings.push({ code: "mailbox_inactive", message: `Postfach ${m.email} ist ${m.status === "error" ? "fehlerhaft" : "pausiert"} und versendet nicht.` });
  }

  // DNS je Domain
  const domains = [...new Set(mailboxes.map((m) => mailboxDomain(m.email)))];
  for (const d of domains) {
    let result = storedDomainResult(ctx, d);
    if (!result) {
      try {
        result = await refreshDomainCheck(ctx, d);
      } catch {
        result = null;
      }
    }
    if (!result) {
      warnings.push({ code: "dns", message: `Die DNS-Einträge von ${d} konnten nicht geprüft werden.` });
      continue;
    }
    const missing = [result.spf.status === "error" ? "SPF" : null, result.dkim.status === "error" ? "DKIM" : null].filter(Boolean);
    if (missing.length && !opts.ignoreDns) {
      blocking.push({ code: "dns", message: `${d}: ${missing.join(" und ")} fehlt. Ohne diese Einträge landen Mails im Spam oder werden abgelehnt (siehe „Zustellbarkeit“).` });
    } else if (missing.length) {
      warnings.push({ code: "dns", message: `${d}: ${missing.join(" und ")} fehlt – Start trotzdem gewünscht.` });
    }
    if (result.dmarc.status !== "ok") warnings.push({ code: "dmarc", message: `${d}: DMARC fehlt oder ist fehlerhaft. Empfohlen: „v=DMARC1; p=none“ eintragen.` });
  }

  // Kontakte
  const pending = ctx.db
    .prepare(
      `SELECT cl.*, l.email, l.salutation, l.first_name, l.last_name, l.company, l.position, l.website, l.custom_json, l.status AS lead_status, l.check_flags
       FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ? AND cl.status IN ('queued','active')`,
    )
    .all(campaign.id) as (CampaignLeadRow & LeadRow & { lead_status: string })[];
  if (pending.length === 0) blocking.push({ code: "leads", message: "Der Kampagne sind keine (offenen) Kontakte zugeordnet." });

  // Platzhalter
  const known = new Set([...STANDARD_KEYS, ...Object.keys(settings.globalVariables)]);
  const customKeys = new Set(pending.flatMap((p) => Object.keys(parseCustom(p.custom_json))));
  const unknown = new Set<string>();
  for (const s of steps) {
    for (const p of extractPlaceholders(`${s.subject}\n${s.body}`)) {
      if (!known.has(p.key) && !customKeys.has(p.key) && !p.hasFallback) unknown.add(p.key);
    }
  }
  if (unknown.size) blocking.push({ code: "placeholders", message: `Unbekannte Platzhalter ohne Ersatztext: ${[...unknown].map((k) => `{{${k}}}`).join(", ")}.` });

  const usesAi = steps.some((s) => extractPlaceholders(`${s.subject}\n${s.body}`).some((p) => p.key === "ki_einstieg"));
  if (usesAi && !campaign.ai_enabled) {
    const withoutFallback = steps.some((s) => extractPlaceholders(`${s.subject}\n${s.body}`).some((p) => p.key === "ki_einstieg" && !p.hasFallback));
    if (withoutFallback) blocking.push({ code: "ai", message: "Die Vorlage nutzt {{ki_einstieg}}, aber KI-Einstiege sind für diese Kampagne nicht aktiviert." });
  }
  if (campaign.ai_enabled && ctx.ai.keySource() === null) blocking.push({ code: "ai_key", message: "KI-Einstiege sind aktiviert, aber es ist kein Claude-API-Schlüssel hinterlegt (Einstellungen)." });
  if (campaign.ai_enabled && usesAi) {
    const waiting = pending.filter((p) => p.next_step === 1 && p.ai_status !== "approved" && !(campaign.ai_auto_approve && p.ai_status === "done")).length;
    if (waiting > 0) warnings.push({ code: "ai_pending", message: `${waiting} KI-Einstiege sind noch nicht freigegeben – diese Kontakte werden erst danach angeschrieben.` });
  }

  // Fehlende Angaben bei Kontakten (Simulation mit der echten Vorlage)
  const firstMailbox = mailboxes.find((m) => m.status === "active") ?? mailboxes[0];
  if (firstMailbox && steps.length && pending.length) {
    const missingCount = new Map<string, number>();
    let affected = 0;
    for (const p of pending) {
      const lead: LeadRow = { ...p, id: p.lead_id, status: "active" };
      let any = false;
      for (const s of steps.filter((x) => x.position >= p.next_step)) {
        const r = renderStep(s, {
          campaign,
          lead,
          mailbox: firstMailbox,
          campaignLead: { id: p.id, ai_opener: "x", ai_status: "approved", thread_subject: p.thread_subject },
          settings,
          publicBaseUrl: ctx.config.publicBaseUrl,
          secrets: ctx.secrets,
          firstStepSubject: steps[0]?.subject ?? "",
        });
        for (const m of r.missing) {
          if (unknown.has(m)) continue;
          missingCount.set(m, (missingCount.get(m) ?? 0) + 1);
          any = true;
        }
      }
      if (any) affected++;
    }
    if (affected > 0) {
      const detail = [...missingCount.entries()].map(([k, n]) => `{{${k}}} fehlt bei ${n}`).join(", ");
      warnings.push({ code: "missing", message: `${affected} Kontakte werden übersprungen, weil Angaben fehlen (${detail}). Tipp: Ersatztext verwenden, z. B. {{vorname|zusammen}}.` });
    }
    const freemail = pending.filter((p) => p.check_flags.includes("freemail")).length;
    if (freemail > 0) warnings.push({ code: "freemail", message: `${freemail} Kontakte haben private Freemail-Adressen. Werbung an Privatpersonen ist ohne Einwilligung unzulässig.` });
  }

  if (!ctx.config.publicBaseUrl) warnings.push({ code: "public_url", message: "Keine öffentliche Adresse gesetzt (PUBLIC_BASE_URL): Abmeldung erfolgt per Antwort-Mail bzw. Gmail-Abmeldeknopf statt per Ein-Klick-Link." });

  // Schätzung
  const perDay = mailboxes
    .filter((m) => m.status === "active")
    .reduce((sum, m) => sum + Math.max(1, Math.round((effectiveDailyLimit(m, now, settings.timezone) + m.daily_limit) / 2)), 0);
  const emailsTotal = pending.reduce((sum, p) => sum + Math.max(0, steps.length - p.next_step + 1), 0);
  const waitDays = steps.reduce((sum, s) => sum + (s.position > 1 ? s.wait_days : 0), 0);
  const sendDaysPerWeek = Math.max(1, windowOf(campaign).sendDays.length);
  const workDays = perDay > 0 ? Math.ceil(emailsTotal / perDay) : 0;
  const days = Math.ceil((workDays * 7) / sendDaysPerWeek) + waitDays;

  return { ok: blocking.length === 0, blocking, warnings, estimate: { leads: pending.length, emailsTotal, perDay, days } };
}
