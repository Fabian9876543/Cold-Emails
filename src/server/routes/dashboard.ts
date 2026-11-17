import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import type { AppContext } from "../context";
import { getSettings } from "../lib/settings";
import { effectiveDailyLimit, listMailboxRows, sentToday, startOfDayMs } from "../mail/mailboxes";
import { listDomains } from "./domains";
import type { DashboardDto } from "../../shared/types";

export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/dashboard", async (): Promise<DashboardDto> => {
    const db = ctx.db;
    const now = ctx.clock.now();
    const tz = getSettings(db).timezone;
    const todayStart = startOfDayMs(now, tz);
    const since30 = now - 30 * 86_400_000;
    const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

    const mailboxes = listMailboxRows(db);
    const domains = listDomains(ctx);
    const warnings: DashboardDto["warnings"] = [];

    const mailboxDtos = mailboxes.map((m) => {
      const problem = m.status === "error" ? m.last_error : m.imap_error;
      if (m.status === "error") warnings.push({ level: "error", message: `Postfach ${m.email}: ${m.last_error ?? "Fehler"}`, link: "/postfaecher" });
      else if (m.imap_error) warnings.push({ level: "warn", message: `Posteingang ${m.email} nicht erreichbar – Antworten werden nicht erkannt.`, link: "/postfaecher" });
      return { id: m.id, email: m.email, sentToday: sentToday(db, m.id, now, tz), effectiveLimit: effectiveDailyLimit(m, now, tz), status: m.status, problem };
    });
    for (const d of domains) {
      if (d.result?.overall === "error") warnings.push({ level: "error", message: `Domain ${d.domain}: SPF/DKIM unvollständig – Mails landen im Spam.`, link: "/zustellbarkeit" });
    }
    const paused = db.prepare("SELECT id, name, pause_reason FROM campaigns WHERE status = 'paused' AND pause_reason LIKE 'Automatisch%'").all() as { id: number; name: string; pause_reason: string }[];
    for (const p of paused) warnings.push({ level: "warn", message: `Kampagne „${p.name}“: ${p.pause_reason}`, link: `/kampagnen/${p.id}` });
    const aiCampaigns = count("SELECT COUNT(*) AS n FROM campaigns WHERE ai_enabled = 1 AND status IN ('active','paused')");
    if (aiCampaigns > 0 && ctx.ai.keySource() === null) warnings.push({ level: "warn", message: "KI-Einstiege sind aktiviert, aber kein Claude-API-Schlüssel hinterlegt.", link: "/einstellungen" });
    const waitingAi = count("SELECT COUNT(*) AS n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.status = 'active' AND cl.ai_status = 'done' AND c.ai_auto_approve = 0 AND cl.status = 'queued'");
    if (waitingAi > 0) warnings.push({ level: "warn", message: `${waitingAi} KI-Einstiege warten auf Ihre Freigabe – diese Kontakte werden erst danach angeschrieben.`, link: "/kampagnen" });

    const contacted30 = count("SELECT COUNT(DISTINCT lead_id) AS n FROM messages WHERE status = 'sent' AND is_test = 0 AND sent_at >= ?", since30);
    const replies30 = count("SELECT COUNT(*) AS n FROM inbound WHERE kind = 'reply' AND received_at >= ?", since30);
    const bounces30 = count("SELECT COUNT(*) AS n FROM inbound WHERE kind = 'bounce' AND received_at >= ?", since30) + count("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed' AND error LIKE '%5.1.%' AND created_at >= ?", since30);

    const daily: DashboardDto["daily"] = [];
    for (let i = 13; i >= 0; i--) {
      const day = DateTime.fromMillis(now, { zone: tz }).startOf("day").minus({ days: i });
      const from = day.toMillis();
      const to = day.plus({ days: 1 }).toMillis();
      daily.push({
        date: day.toFormat("dd.MM."),
        sent: count("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent' AND is_test = 0 AND sent_at >= ? AND sent_at < ?", from, to),
        replies: count("SELECT COUNT(*) AS n FROM inbound WHERE kind = 'reply' AND received_at >= ? AND received_at < ?", from, to),
      });
    }

    const campaigns = db
      .prepare(
        `SELECT c.id, c.name, c.status,
           (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.status = 'sent' AND m.is_test = 0) AS sent,
           (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.status = 'replied') AS replied,
           (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) AS leads
         FROM campaigns c WHERE c.status IN ('active','paused') ORDER BY c.updated_at DESC LIMIT 6`,
      )
      .all() as DashboardDto["activeCampaigns"];

    return {
      setup: {
        mailbox: mailboxes.length > 0,
        domain: domains.some((d) => d.result && d.result.overall !== "error"),
        leads: count("SELECT COUNT(*) AS n FROM leads") > 0,
        campaign: count("SELECT COUNT(*) AS n FROM campaigns WHERE status != 'draft'") > 0,
      },
      today: {
        sent: count("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent' AND is_test = 0 AND sent_at >= ?", todayStart),
        capacity: mailboxDtos.filter((m) => m.status === "active").reduce((s, m) => s + m.effectiveLimit, 0),
        replies: count("SELECT COUNT(*) AS n FROM inbound WHERE kind = 'reply' AND received_at >= ?", todayStart),
        bounces: count("SELECT COUNT(*) AS n FROM inbound WHERE kind = 'bounce' AND received_at >= ?", todayStart),
      },
      last30: {
        sent: count("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent' AND is_test = 0 AND sent_at >= ?", since30),
        replies: replies30,
        bounces: bounces30,
        replyRate: contacted30 ? replies30 / contacted30 : 0,
        bounceRate: contacted30 ? bounces30 / contacted30 : 0,
      },
      daily,
      mailboxes: mailboxDtos,
      activeCampaigns: campaigns,
      unhandledReplies: count("SELECT COUNT(*) AS n FROM inbound WHERE kind = 'reply' AND handled = 0"),
      warnings,
    };
  });
}
