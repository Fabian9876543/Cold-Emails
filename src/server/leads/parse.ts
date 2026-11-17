import Papa from "papaparse";
import ExcelJS from "exceljs";

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

export class ParseError extends Error {}

const MAX_ROWS = 100_000;

/** Erkennt UTF-8; sonst Windows-1252 (typischer Excel-Export unter Windows). */
export function decodeText(buf: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("windows-1252").decode(buf);
  }
  return text.replace(/^﻿/, "");
}

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Spalte ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function toTable(matrix: string[][]): ParsedTable {
  const nonEmpty = matrix.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) throw new ParseError("Die Datei enthält keine Daten.");
  const headers = uniqueHeaders(nonEmpty[0] ?? []);
  const rows = nonEmpty.slice(1, MAX_ROWS + 1).map((r) => headers.map((_, i) => (r[i] ?? "").trim()));
  if (nonEmpty.length - 1 > MAX_ROWS) throw new ParseError(`Zu viele Zeilen (maximal ${MAX_ROWS.toLocaleString("de-DE")} pro Import).`);
  return { headers, rows };
}

export function parseCsv(buf: Buffer): ParsedTable {
  const text = decodeText(buf);
  const result = Papa.parse<string[]>(text, {
    delimiter: "",
    delimitersToGuess: [";", ",", "\t", "|"],
    skipEmptyLines: "greedy",
  });
  if (result.data.length === 0) throw new ParseError("Die Datei enthält keine Daten.");
  return toTable(result.data.map((r) => r.map((c) => String(c ?? ""))));
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("richText" in v && Array.isArray(v.richText)) return (v.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("hyperlink" in v && typeof v.hyperlink === "string") return v.hyperlink.replace(/^mailto:/i, "");
    if ("result" in v) return cellToString(v.result as ExcelJS.CellValue);
    if ("error" in v) return "";
    return "";
  }
  return String(value);
}

export async function parseXlsx(buf: Buffer): Promise<ParsedTable> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new ParseError("Die Excel-Datei konnte nicht gelesen werden. Bitte als .xlsx oder .csv speichern.");
  }
  const ws = wb.worksheets.find((w) => w.rowCount > 0);
  if (!ws) throw new ParseError("Die Excel-Datei enthält keine Daten.");
  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as ExcelJS.CellValue[];
    // row.values ist 1-basiert
    matrix.push(values.slice(1).map(cellToString));
  });
  return toTable(matrix);
}

export async function parseUpload(buf: Buffer, fileName: string): Promise<ParsedTable> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return parseXlsx(buf);
  if (lower.endsWith(".xls")) throw new ParseError("Das alte Excel-Format (.xls) wird nicht unterstützt. Bitte als .xlsx oder .csv speichern.");
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".tsv")) return parseCsv(buf);
  // Inhalt prüfen: XLSX ist ein ZIP-Archiv
  if (buf.subarray(0, 2).toString("latin1") === "PK") return parseXlsx(buf);
  return parseCsv(buf);
}
