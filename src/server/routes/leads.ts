import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { logEvent } from "../lib/events";
import { badRequest, idParam, notFound, parseBody, parseQuery, sendCsv } from "../lib/http";
import { commitImport, defaultListName, dropPendingImport, getPendingImport, storePendingImport } from "../leads/import";
import { ParseError, parseUpload } from "../leads/parse";
import { addSuppression, getLeadRow, parseCustom, toLeadDto, toSuppressionDto, type LeadRow } from "../leads/repo";
import { isValidEmailSyntax, normalizeEmail } from "../../shared/emailCheck";
import { suggestMapping, type FieldMapping } from "../../shared/fields";
import { normalizeKey } from "../../shared/template";
import type { ImportPreviewDto, ImportReportDto, LeadDto, LeadListDto, Paged, SuppressionDto } from "../../shared/types";

const listQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["active", "unsubscribed", "bounced", "invalid"]).optional(),
  listId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

function leadFilter(q: z.infer<typeof listQuery>): { where: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.q?.trim()) {
    const like = `%${q.q.trim()}%`;
    where.push("(l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ? OR l.company LIKE ?)");
    params.push(like, like, like, like);
  }
  if (q.status) {
    where.push("l.status = ?");
    params.push(q.status);
  }
  if (q.listId) {
    where.push("l.id IN (SELECT lead_id FROM lead_list_members WHERE list_id = ?)");
    params.push(q.listId);
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

const mappingValue = z.union([
  z.enum(["email", "salutation", "first_name", "last_name", "full_name", "company", "position", "website", "ignore"]),
  z.string().regex(/^custom:.+/),
]);

export function registerLeadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/leads", async (request): Promise<Paged<LeadDto>> => {
    const q = parseQuery(listQuery, request);
    const { where, params } = leadFilter(q);
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM leads l ${where}`).get(...params) as { n: number }).n;
    const rows = ctx.db
      .prepare(`SELECT l.* FROM leads l ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`)
      .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as LeadRow[];
    return { items: rows.map(toLeadDto), total, page: q.page, pageSize: q.pageSize };
  });

  app.get("/api/leads/fields", async () => {
    // Alle eigenen Spalten, die in Kontakten vorkommen (für Platzhalter-Vorschläge)
    const rows = ctx.db.prepare("SELECT DISTINCT custom_json FROM leads WHERE custom_json != '{}' LIMIT 2000").all() as { custom_json: string }[];
    const keys = new Set<string>();
    for (const r of rows) for (const k of Object.keys(parseCustom(r.custom_json))) keys.add(k);
    return [...keys].sort();
  });

  app.get("/api/leads/export.csv", async (request, reply) => {
    const q = parseQuery(listQuery, request);
    const { where, params } = leadFilter(q);
    const rows = ctx.db.prepare(`SELECT l.* FROM leads l ${where} ORDER BY l.id`).all(...params) as LeadRow[];
    const customKeys = [...new Set(rows.flatMap((r) => Object.keys(parseCustom(r.custom_json))))].sort();
    const header = ["E-Mail", "Anrede", "Vorname", "Nachname", "Firma", "Position", "Website", "Status", ...customKeys];
    const data = rows.map((r) => {
      const c = parseCustom(r.custom_json);
      return [r.email, r.salutation, r.first_name, r.last_name, r.company, r.position, r.website, r.status, ...customKeys.map((k) => c[k] ?? "")];
    });
    return sendCsv(reply, "kontakte.csv", [header, ...data]);
  });

  app.patch("/api/leads/:id", async (request): Promise<LeadDto> => {
    const id = idParam(request);
    const row = getLeadRow(ctx.db, id);
    if (!row) throw notFound("Kontakt");
    const body = parseBody(
      z
        .object({
          salutation: z.string().max(40),
          firstName: z.string().max(120),
          lastName: z.string().max(120),
          company: z.string().max(200),
          position: z.string().max(200),
          website: z.string().max(300),
          custom: z.record(z.string(), z.string().max(2000)),
          status: z.enum(["active"]),
        })
        .partial(),
      request,
    );
    const custom = body.custom
      ? Object.fromEntries(Object.entries(body.custom).map(([k, v]) => [normalizeKey(k), v]).filter(([k]) => k))
      : undefined;
    ctx.db
      .prepare(
        `UPDATE leads SET salutation = COALESCE(?, salutation), first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
           company = COALESCE(?, company), position = COALESCE(?, position), website = COALESCE(?, website),
           custom_json = COALESCE(?, custom_json), status = COALESCE(?, status), updated_at = ? WHERE id = ?`,
      )
      .run(
        body.salutation ?? null, body.firstName ?? null, body.lastName ?? null, body.company ?? null, body.position ?? null,
        body.website ?? null, custom ? JSON.stringify(custom) : null, body.status ?? null, ctx.clock.now(), id,
      );
    // Kontakte mit Fehler (z. B. fehlender Vorname) dürfen nach Korrektur erneut versucht werden
    ctx.db.prepare("UPDATE campaign_leads SET status = 'queued', status_reason = NULL WHERE lead_id = ? AND status = 'error' AND last_sent_at IS NULL").run(id);
    return toLeadDto(getLeadRow(ctx.db, id)!);
  });

  app.delete("/api/leads/:id", async (request) => {
    const id = idParam(request);
    const row = getLeadRow(ctx.db, id);
    if (!row) throw notFound("Kontakt");
    const { suppress } = parseQuery(z.object({ suppress: z.enum(["0", "1"]).optional() }), request);
    ctx.db.transaction(() => {
      if (suppress === "1") addSuppression(ctx.db, ctx.clock.now(), row.email, "manual", "Kontakt gelöscht");
      ctx.db.prepare("DELETE FROM leads WHERE id = ?").run(id);
    })();
    return { ok: true };
  });

  app.post("/api/leads/bulk-delete", async (request) => {
    const { ids } = parseBody(z.object({ ids: z.array(z.number().int()).min(1).max(10_000) }), request);
    const del = ctx.db.prepare("DELETE FROM leads WHERE id = ?");
    let n = 0;
    ctx.db.transaction(() => {
      for (const id of ids) n += del.run(id).changes;
    })();
    return { deleted: n };
  });

  // --- Listen ---
  app.get("/api/lead-lists", async (): Promise<LeadListDto[]> => {
    const rows = ctx.db
      .prepare(
        `SELECT ll.id, ll.name, ll.created_at, COUNT(m.lead_id) AS lead_count
         FROM lead_lists ll LEFT JOIN lead_list_members m ON m.list_id = ll.id
         GROUP BY ll.id ORDER BY ll.created_at DESC`,
      )
      .all() as { id: number; name: string; created_at: number; lead_count: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, leadCount: r.lead_count }));
  });

  app.patch("/api/lead-lists/:id", async (request) => {
    const id = idParam(request);
    const { name } = parseBody(z.object({ name: z.string().min(1).max(200) }), request);
    const res = ctx.db.prepare("UPDATE lead_lists SET name = ? WHERE id = ?").run(name.trim(), id);
    if (res.changes === 0) throw notFound("Liste");
    return { ok: true };
  });

  app.delete("/api/lead-lists/:id", async (request) => {
    const id = idParam(request);
    const { deleteLeads } = parseQuery(z.object({ deleteLeads: z.enum(["0", "1"]).optional() }), request);
    let deletedLeads = 0;
    ctx.db.transaction(() => {
      if (deleteLeads === "1") {
        // nur Kontakte löschen, die in keiner anderen Liste stehen
        deletedLeads = ctx.db
          .prepare(
            `DELETE FROM leads WHERE id IN (SELECT lead_id FROM lead_list_members WHERE list_id = ?)
             AND id NOT IN (SELECT lead_id FROM lead_list_members WHERE list_id != ?)`,
          )
          .run(id, id).changes;
      }
      ctx.db.prepare("DELETE FROM lead_lists WHERE id = ?").run(id);
    })();
    return { ok: true, deletedLeads };
  });

  // --- Import ---
  app.post("/api/leads/import/preview", async (request): Promise<ImportPreviewDto> => {
    const file = await request.file();
    if (!file) throw badRequest("Bitte eine Datei auswählen.");
    const buf = await file.toBuffer();
    let table;
    try {
      table = await parseUpload(buf, file.filename);
    } catch (err) {
      if (err instanceof ParseError) throw badRequest(err.message);
      throw badRequest("Die Datei konnte nicht gelesen werden. Unterstützt werden CSV und Excel (.xlsx).");
    }
    const importId = storePendingImport(file.filename, table);
    return {
      importId,
      fileName: file.filename,
      headers: table.headers,
      sample: table.rows.slice(0, 5),
      totalRows: table.rows.length,
      mapping: suggestMapping(table.headers),
    };
  });

  app.post("/api/leads/import/commit", async (request): Promise<ImportReportDto> => {
    const body = parseBody(
      z.object({
        importId: z.string(),
        mapping: z.record(z.string(), mappingValue),
        listName: z.string().max(200).optional(),
        updateExisting: z.boolean().default(true),
        checkMx: z.boolean().default(true),
      }),
      request,
    );
    const pending = getPendingImport(body.importId);
    if (!pending) throw badRequest("Der Import ist abgelaufen. Bitte die Datei erneut hochladen.");
    let report: ImportReportDto;
    try {
      report = await commitImport(ctx, pending.fileName, pending.table, {
        mapping: body.mapping as Record<string, FieldMapping>,
        listName: body.listName?.trim() || defaultListName(pending.fileName, ctx.clock.now()),
        updateExisting: body.updateExisting,
        checkMx: body.checkMx,
      });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    dropPendingImport(body.importId);
    logEvent(ctx.db, ctx.clock.now(), "info", "leads.imported", `${report.imported} neue und ${report.updated} vorhandene Kontakte in „${report.listName}“ importiert.`);
    return report;
  });

  // --- Sperrliste ---
  app.get("/api/suppressions", async (request): Promise<Paged<SuppressionDto>> => {
    const q = parseQuery(z.object({ q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50) }), request);
    const where = q.q?.trim() ? "WHERE value LIKE ?" : "";
    const params = q.q?.trim() ? [`%${q.q.trim()}%`] : [];
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM suppressions ${where}`).get(...params) as { n: number }).n;
    const rows = ctx.db.prepare(`SELECT * FROM suppressions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
    return { items: rows.map(toSuppressionDto), total, page: q.page, pageSize: q.pageSize };
  });

  app.post("/api/suppressions", async (request) => {
    const { entries, note } = parseBody(z.object({ entries: z.string().max(1_000_000), note: z.string().max(300).optional() }), request);
    const now = ctx.clock.now();
    const values = entries
      .split(/[\n,;]+/)
      .map((v) => v.trim().toLowerCase().replace(/^mailto:/, ""))
      .filter(Boolean);
    let added = 0;
    const invalid: string[] = [];
    ctx.db.transaction(() => {
      for (const raw of values) {
        const v = raw.replace(/^@/, "");
        const ok = v.includes("@") ? isValidEmailSyntax(normalizeEmail(v)) : /^([a-z0-9-]+\.)+[a-z]{2,63}$/.test(v);
        if (!ok) {
          invalid.push(raw);
          continue;
        }
        const before = ctx.db.prepare("SELECT 1 FROM suppressions WHERE value = ?").get(v);
        addSuppression(ctx.db, now, v, "manual", note ?? null);
        if (!before) added++;
      }
    })();
    return { added, invalid };
  });

  app.delete("/api/suppressions/:id", async (request) => {
    const id = idParam(request);
    const res = ctx.db.prepare("DELETE FROM suppressions WHERE id = ?").run(id);
    if (res.changes === 0) throw notFound("Eintrag");
    return { ok: true };
  });

  app.get("/api/suppressions/export.csv", async (_request, reply) => {
    const rows = ctx.db.prepare("SELECT * FROM suppressions ORDER BY created_at").all() as Record<string, unknown>[];
    const reasons: Record<string, string> = { unsubscribe: "Abmeldung", bounce: "Unzustellbar", manual: "Manuell", complaint: "Beschwerde" };
    return sendCsv(reply, "sperrliste.csv", [
      ["Eintrag", "Typ", "Grund", "Notiz", "Datum"],
      ...rows.map((r) => [r.value as string, r.type === "domain" ? "Domain" : "E-Mail", reasons[r.reason as string] ?? (r.reason as string), (r.note as string) ?? "", new Date(r.created_at as number).toISOString()]),
    ]);
  });
}
