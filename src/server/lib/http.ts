import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError, type ZodType } from "zod";

/** Fehler mit HTTP-Status und deutscher Meldung für die Oberfläche. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Eintrag") => new HttpError(404, `${what} nicht gefunden.`);
export const badRequest = (message: string) => new HttpError(400, message);

export function parseBody<T>(schema: ZodType<T>, request: FastifyRequest): T {
  return schema.parse(request.body ?? {});
}

export function parseQuery<T>(schema: ZodType<T>, request: FastifyRequest): T {
  return schema.parse(request.query ?? {});
}

export function idParam(request: FastifyRequest, name = "id"): number {
  const raw = (request.params as Record<string, string>)[name];
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Ungültige ID.");
  return id;
}

export function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => {
      const field = i.path.join(".");
      return field ? `${field}: ${i.message}` : i.message;
    })
    .join("; ");
}

export function sendCsv(reply: FastifyReply, fileName: string, rows: (string | number | null | undefined)[][]): FastifyReply {
  const escape = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Formel-Injektion in Excel verhindern
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csv = "﻿" + rows.map((r) => r.map(escape).join(";")).join("\r\n");
  return reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${fileName}"`)
    .send(csv);
}
