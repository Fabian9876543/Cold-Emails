import type { AppContext } from "../context";
import { pruneEvents } from "../lib/events";
import { checkCampaignHealth, completeFinishedCampaigns } from "../campaigns/health";
import { recoverInterruptedSends, runSendTick } from "./sender";
import { runInboxPoll } from "./inboxPoller";
import { runAiJobs } from "../ai/jobs";

export interface WorkerHandle {
  stop(): Promise<void>;
}

interface Loop {
  stop(): Promise<void>;
}

function startLoop(ctx: AppContext, name: string, intervalMs: number, initialDelayMs: number, fn: () => Promise<unknown>): Loop {
  let stopped = false;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    if (stopped) return;
    running = (async () => {
      try {
        await fn();
      } catch (err) {
        ctx.log.error({ err }, `Hintergrundaufgabe „${name}“ fehlgeschlagen`);
      }
    })().finally(() => {
      running = null;
      if (!stopped) timer = setTimeout(run, intervalMs);
    });
  };
  timer = setTimeout(run, initialDelayMs);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
  };
}

export function housekeeping(ctx: AppContext): void {
  const now = ctx.clock.now();
  ctx.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  pruneEvents(ctx.db, now);
  ctx.db.prepare("DELETE FROM website_cache WHERE fetched_at < ?").run(now - 30 * 86_400_000);
  const active = ctx.db.prepare("SELECT id FROM campaigns WHERE status = 'active'").all() as { id: number }[];
  active.forEach((c) => checkCampaignHealth(ctx, c.id));
  completeFinishedCampaigns(ctx);
}

/** Startet die Hintergrundprozesse: Versand, Posteingang, KI und Aufräumen. */
export function startWorker(ctx: AppContext): WorkerHandle {
  const recovered = recoverInterruptedSends(ctx);
  if (recovered > 0) ctx.log.warn(`${recovered} unterbrochene Sendungen gefunden – zur Sicherheit nicht erneut gesendet.`);
  const loops = [
    startLoop(ctx, "Versand", 20_000, 3_000, () => runSendTick(ctx)),
    startLoop(ctx, "Posteingang", 60_000, 10_000, () => runInboxPoll(ctx)),
    startLoop(ctx, "KI", 5_000, 5_000, () => runAiJobs(ctx)),
    startLoop(ctx, "Aufräumen", 15 * 60_000, 60_000, async () => housekeeping(ctx)),
  ];
  ctx.log.info("Hintergrund-Worker gestartet (Versand, Posteingang, KI)");
  return {
    async stop() {
      await Promise.all(loops.map((l) => l.stop()));
    },
  };
}
