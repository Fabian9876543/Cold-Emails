import fs from "node:fs";
import path from "node:path";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { AppContext } from "./context";
import { formatZodError, HttpError } from "./lib/http";
import { isAuthenticated, registerAuthRoutes } from "./routes/auth";
import { registerSettingsRoutes } from "./routes/settings";
import { registerMailboxRoutes } from "./routes/mailboxes";
import { registerDomainRoutes } from "./routes/domains";
import { registerLeadRoutes } from "./routes/leads";
import { registerCampaignRoutes } from "./routes/campaigns";
import { registerInboxRoutes } from "./routes/inbox";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerAiRoutes } from "./routes/ai";
import { registerOAuthRoutes } from "./routes/oauth";
import { registerUnsubscribeRoutes } from "./routes/unsubscribe";

/** API-Pfade, die ohne Anmeldung erreichbar sind. */
const PUBLIC_API = new Set(["/api/login", "/api/me", "/api/health"]);

export async function buildApp(ctx: AppContext, opts: { webDir?: string | null } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    strictTransportSecurity: false,
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error: FastifyError | ZodError | HttpError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: `Bitte Eingaben prüfen – ${formatZodError(error)}` });
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    const status = (error as FastifyError).statusCode ?? 500;
    if (status === 429) return reply.status(429).send({ error: "Zu viele Versuche. Bitte in einer Minute erneut probieren." });
    if (status === 413) return reply.status(413).send({ error: "Die Datei ist zu groß (maximal 25 MB)." });
    if (status < 500) return reply.status(status).send({ error: error.message });
    request.log.error({ err: error }, "Unerwarteter Fehler");
    return reply.status(500).send({ error: "Interner Fehler. Details stehen im Server-Protokoll." });
  });

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/") || PUBLIC_API.has(url)) return;
    if (!isAuthenticated(ctx, request)) {
      return reply.status(401).send({ error: "Bitte zuerst anmelden." });
    }
  });

  registerAuthRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerMailboxRoutes(app, ctx);
  registerDomainRoutes(app, ctx);
  registerLeadRoutes(app, ctx);
  registerCampaignRoutes(app, ctx);
  registerInboxRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerOAuthRoutes(app, ctx);
  registerUnsubscribeRoutes(app, ctx);

  const webDir = opts.webDir;
  if (webDir && fs.existsSync(path.join(webDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: "/",
      wildcard: false,
      setHeaders(reply, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          reply.header("Cache-Control", "no-cache");
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split("?")[0] ?? "";
      if (request.method === "GET" && !url.startsWith("/api/")) {
        return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      }
      return reply.status(404).send({ error: "Nicht gefunden." });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: "Nicht gefunden." }));
  }

  return app;
}
