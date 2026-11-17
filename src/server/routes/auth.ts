import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { randomId, safeEqual } from "../lib/crypto";
import { HttpError, parseBody } from "../lib/http";

export const SESSION_COOKIE = "ce_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function isAuthenticated(ctx: AppContext, request: FastifyRequest): boolean {
  const id = request.cookies?.[SESSION_COOKIE];
  if (!id) return false;
  const row = ctx.db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(id) as { expires_at: number } | undefined;
  return !!row && row.expires_at > ctx.clock.now();
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { password } = parseBody(z.object({ password: z.string().max(500) }), request);
      if (!safeEqual(password, ctx.config.adminPassword)) {
        await new Promise((r) => setTimeout(r, 400));
        throw new HttpError(401, "Das Passwort ist falsch.");
      }
      const now = ctx.clock.now();
      const id = randomId(32);
      ctx.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
      ctx.db.prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)").run(id, now, now + SESSION_MS);
      reply.setCookie(SESSION_COOKIE, id, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: request.protocol === "https",
        maxAge: SESSION_MS / 1000,
      });
      return { ok: true };
    },
  );

  app.post("/api/logout", async (request, reply) => {
    const id = request.cookies?.[SESSION_COOKIE];
    if (id) ctx.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (request) => ({ authenticated: isAuthenticated(ctx, request) }));

  app.get("/api/health", async () => ({ ok: true }));
}
