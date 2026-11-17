import type { AppContext } from "../context";

export interface WorkerHandle {
  stop(): Promise<void>;
}

/** Startet die Hintergrundprozesse (Versand, Posteingang, KI). */
export function startWorker(ctx: AppContext): WorkerHandle {
  ctx.log.info("Hintergrund-Worker gestartet");
  return { async stop() {} };
}
