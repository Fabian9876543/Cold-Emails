import type { AppContext } from "../context";
import { logEvent } from "../lib/events";
import { getCampaignRow } from "./repo";

export const BOUNCE_PAUSE_MIN_SENT = 20;
export const BOUNCE_PAUSE_RATE = 0.05;

/** Pausiert eine Kampagne automatisch bei zu vielen Bounces (schützt den Ruf der Domain). */
export function checkCampaignHealth(ctx: AppContext, campaignId: number): void {
  const c = getCampaignRow(ctx.db, campaignId);
  if (!c || c.status !== "active") return;
  const contacted = (ctx.db.prepare("SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND last_sent_at IS NOT NULL").get(campaignId) as { n: number }).n;
  if (contacted < BOUNCE_PAUSE_MIN_SENT) return;
  const bounced = (ctx.db.prepare("SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND status = 'bounced'").get(campaignId) as { n: number }).n;
  const rate = bounced / contacted;
  if (rate > BOUNCE_PAUSE_RATE) {
    const pct = (rate * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 });
    const reason = `Automatisch pausiert: ${pct} % der Mails waren unzustellbar (Grenze: 5 %). Bitte die Kontaktliste prüfen, bevor die Kampagne fortgesetzt wird.`;
    ctx.db.prepare("UPDATE campaigns SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?").run(reason, ctx.clock.now(), campaignId);
    logEvent(ctx.db, ctx.clock.now(), "error", "campaign.autopause", `Kampagne „${c.name}“: ${reason}`, { campaignId });
  }
}

/** Setzt Kampagnen ohne offene Kontakte auf "abgeschlossen". */
export function completeFinishedCampaigns(ctx: AppContext): void {
  const now = ctx.clock.now();
  const done = ctx.db
    .prepare(
      `SELECT c.id, c.name FROM campaigns c WHERE c.status = 'active'
       AND EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.campaign_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.status IN ('queued','active'))`,
    )
    .all() as { id: number; name: string }[];
  for (const c of done) {
    ctx.db.prepare("UPDATE campaigns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, c.id);
    logEvent(ctx.db, now, "info", "campaign.completed", `Kampagne „${c.name}“ ist abgeschlossen – alle Sequenzen sind beendet.`, { campaignId: c.id });
  }
}
