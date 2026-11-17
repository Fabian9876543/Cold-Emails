import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { checkDomain } from "../deliverability/dns";
import { badRequest, notFound, parseBody } from "../lib/http";
import { mailboxDomain } from "../mail/mailboxes";
import type { DomainCheckResult, DomainDto } from "../../shared/types";

interface DomainRow {
  domain: string;
  dkim_selector: string;
  check_json: string | null;
  checked_at: number | null;
}

export function ensureDomain(ctx: AppContext, domain: string): void {
  ctx.db.prepare("INSERT INTO domains (domain) VALUES (?) ON CONFLICT(domain) DO NOTHING").run(domain.toLowerCase());
}

export async function refreshDomainCheck(ctx: AppContext, domain: string): Promise<DomainCheckResult> {
  const row = ctx.db.prepare("SELECT * FROM domains WHERE domain = ?").get(domain) as DomainRow | undefined;
  const selector = row?.dkim_selector ?? "google";
  const result = await checkDomain(ctx.dns, domain, selector);
  ctx.db
    .prepare(
      "INSERT INTO domains (domain, dkim_selector, check_json, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(domain) DO UPDATE SET check_json = excluded.check_json, checked_at = excluded.checked_at",
    )
    .run(domain, selector, JSON.stringify(result), ctx.clock.now());
  return result;
}

/** Letztes Prüfergebnis einer Domain (ohne neue DNS-Abfrage). */
export function storedDomainResult(ctx: AppContext, domain: string): DomainCheckResult | null {
  const row = ctx.db.prepare("SELECT check_json FROM domains WHERE domain = ?").get(domain) as { check_json: string | null } | undefined;
  if (!row?.check_json) return null;
  try {
    return JSON.parse(row.check_json) as DomainCheckResult;
  } catch {
    return null;
  }
}

export function listDomains(ctx: AppContext): DomainDto[] {
  const mailboxes = ctx.db.prepare("SELECT email FROM mailboxes ORDER BY email").all() as { email: string }[];
  const byDomain = new Map<string, string[]>();
  for (const m of mailboxes) {
    const d = mailboxDomain(m.email);
    byDomain.set(d, [...(byDomain.get(d) ?? []), m.email]);
  }
  for (const d of byDomain.keys()) ensureDomain(ctx, d);
  const rows = ctx.db.prepare("SELECT * FROM domains ORDER BY domain").all() as DomainRow[];
  return rows
    .filter((r) => byDomain.has(r.domain.toLowerCase()))
    .map((r) => ({
      domain: r.domain,
      dkimSelector: r.dkim_selector,
      checkedAt: r.checked_at,
      result: r.check_json ? (JSON.parse(r.check_json) as DomainCheckResult) : null,
      mailboxes: byDomain.get(r.domain.toLowerCase()) ?? [],
    }));
}

export function registerDomainRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/domains", async () => listDomains(ctx));

  app.post("/api/domains/:domain/check", async (request): Promise<DomainDto> => {
    const domain = String((request.params as { domain: string }).domain).toLowerCase();
    const found = listDomains(ctx).find((d) => d.domain === domain);
    if (!found) throw notFound("Domain");
    await refreshDomainCheck(ctx, domain);
    return listDomains(ctx).find((d) => d.domain === domain)!;
  });

  app.patch("/api/domains/:domain", async (request): Promise<DomainDto> => {
    const domain = String((request.params as { domain: string }).domain).toLowerCase();
    const { dkimSelector } = parseBody(z.object({ dkimSelector: z.string().min(1).max(63) }), request);
    if (!/^[a-z0-9._-]+$/i.test(dkimSelector)) throw badRequest("Ungültiger DKIM-Selector.");
    const res = ctx.db.prepare("UPDATE domains SET dkim_selector = ? WHERE domain = ?").run(dkimSelector.trim(), domain);
    if (res.changes === 0) throw notFound("Domain");
    await refreshDomainCheck(ctx, domain);
    return listDomains(ctx).find((d) => d.domain === domain)!;
  });
}
