import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createTestEnv, fakeDns } from "../helpers";
import { parseCsv, parseUpload } from "../../src/server/leads/parse";
import { suggestMapping, splitFullName, normalizeSalutation } from "../../src/shared/fields";
import { checkEmailOffline } from "../../src/shared/emailCheck";
import type { ImportPreviewDto, ImportReportDto, LeadDto, Paged } from "../../src/shared/types";

function multipart(fileName: string, content: Buffer) {
  const boundary = "----testgrenze";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("CSV lesen", () => {
  it("erkennt Semikolon, BOM und deutsche Überschriften", () => {
    const csv = "﻿E-Mail;Vorname;Nachname;Firma\njulia@becker.de;Julia;Becker;Becker GmbH\n";
    const t = parseCsv(Buffer.from(csv, "utf8"));
    expect(t.headers).toEqual(["E-Mail", "Vorname", "Nachname", "Firma"]);
    expect(t.rows).toEqual([["julia@becker.de", "Julia", "Becker", "Becker GmbH"]]);
  });

  it("liest Windows-1252 (Excel-Export) mit Umlauten", () => {
    const latin1 = Buffer.from("Email;Firma\nx@y.de;Müller & Söhne\n", "latin1");
    const t = parseCsv(latin1);
    expect(t.rows[0]?.[1]).toBe("Müller & Söhne");
  });

  it("erkennt Kommas und Anführungszeichen", () => {
    const t = parseCsv(Buffer.from('email,company\n"a@b.de","Firma, Zweig Nord"\n'));
    expect(t.rows[0]).toEqual(["a@b.de", "Firma, Zweig Nord"]);
  });

  it("benennt doppelte Spalten eindeutig", () => {
    const t = parseCsv(Buffer.from("Email;Notiz;Notiz\na@b.de;1;2\n"));
    expect(t.headers).toEqual(["Email", "Notiz", "Notiz (2)"]);
  });
});

describe("Excel lesen", () => {
  it("liest .xlsx inklusive Hyperlink-Zellen", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Kontakte");
    ws.addRow(["E-Mail-Adresse", "Ansprechpartner", "Unternehmen"]);
    ws.addRow([{ text: "tom@werk.de", hyperlink: "mailto:tom@werk.de" }, "Dr. Tom Werner", "Werk AG"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const t = await parseUpload(buf, "liste.xlsx");
    expect(t.headers).toEqual(["E-Mail-Adresse", "Ansprechpartner", "Unternehmen"]);
    expect(t.rows[0]).toEqual(["tom@werk.de", "Dr. Tom Werner", "Werk AG"]);
  });
});

describe("Spaltenzuordnung", () => {
  it("ordnet typische Überschriften zu", () => {
    const m = suggestMapping(["E-Mail", "Vorname", "Nachname", "Firma", "Position", "Webseite", "Anrede", "Branche"]);
    expect(m).toMatchObject({
      "E-Mail": "email",
      Vorname: "first_name",
      Nachname: "last_name",
      Firma: "company",
      Position: "position",
      Webseite: "website",
      Anrede: "salutation",
      Branche: "custom:branche",
    });
  });
  it("teilt vollständige Namen auf und ignoriert Titel", () => {
    expect(splitFullName("Dr. Julia Maria Becker")).toEqual({ first: "Julia Maria", last: "Becker" });
    expect(splitFullName("Becker")).toEqual({ first: "Becker", last: "" });
  });
  it("vereinheitlicht Anreden", () => {
    expect(normalizeSalutation("Hr.")).toBe("Herr");
    expect(normalizeSalutation("w")).toBe("Frau");
  });
});

describe("Adressprüfung", () => {
  it("erkennt ungültige, Rollen-, Freemail- und Wegwerf-Adressen", () => {
    expect(checkEmailOffline("kein-at-zeichen").valid).toBe(false);
    expect(checkEmailOffline(" Info@Firma.de ")).toEqual({ email: "info@firma.de", valid: true, flags: ["role"] });
    expect(checkEmailOffline("max@gmx.de").flags).toContain("freemail");
    expect(checkEmailOffline("x@mailinator.com").valid).toBe(false);
    expect(checkEmailOffline("a..b@firma.de").valid).toBe(false);
  });
});

describe("Import über die API", () => {
  it("importiert, prüft, dedupliziert und berücksichtigt die Sperrliste", async () => {
    const env = await createTestEnv({ dns: fakeDns({ noMx: ["gibt-es-nicht.de"] }) });
    await env.api("POST", "/api/suppressions", { entries: "gesperrt@firma.de\nwettbewerber.de" });

    const csv = [
      "E-Mail;Vorname;Nachname;Firma;Branche",
      "julia@becker.de;Julia;Becker;Becker GmbH;Logistik",
      "JULIA@becker.de;Julia;Becker;Becker GmbH;Logistik",
      "info@firma.de;;;Firma;IT",
      "ungueltig;X;Y;Z;W",
      "tom@gibt-es-nicht.de;Tom;T;T GmbH;Bau",
      "gesperrt@firma.de;G;S;Firma;IT",
      "chef@wettbewerber.de;C;W;Wettbewerber;IT",
      ";;;;",
    ].join("\n");
    const mp = multipart("messe-2025.csv", Buffer.from(csv));
    const prev = await env.app.inject({ method: "POST", url: "/api/leads/import/preview", payload: mp.payload, headers: { ...mp.headers, cookie: env.cookie } });
    expect(prev.statusCode).toBe(200);
    const preview = JSON.parse(prev.body) as ImportPreviewDto;
    expect(preview.totalRows).toBe(7);
    expect(preview.mapping["E-Mail"]).toBe("email");

    const res = await env.api<ImportReportDto>("POST", "/api/leads/import/commit", { importId: preview.importId, mapping: preview.mapping, listName: "Messe 2025" });
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.imported).toBe(2); // julia + info@
    expect(r.duplicatesInFile).toBe(1);
    expect(r.suppressed).toBe(2);
    expect(r.warnings.role).toBe(1);
    expect(r.warnings.noMx).toBe(1);
    expect(r.invalid.map((i) => i.reason)).toEqual(["Ungültiges Format", "Domain kann keine E-Mails empfangen"]);

    const leads = await env.api<Paged<LeadDto>>("GET", `/api/leads?listId=${r.listId}`);
    expect(leads.body.total).toBe(2);
    const julia = leads.body.items.find((l) => l.email === "julia@becker.de")!;
    expect(julia.custom).toEqual({ branche: "Logistik" });

    // Erneuter Import ergänzt vorhandene Kontakte, ohne Werte zu leeren
    const mp2 = multipart("update.csv", Buffer.from("E-Mail;Position;Vorname\njulia@becker.de;Geschäftsführerin;\n"));
    const prev2 = JSON.parse((await env.app.inject({ method: "POST", url: "/api/leads/import/preview", payload: mp2.payload, headers: { ...mp2.headers, cookie: env.cookie } })).body) as ImportPreviewDto;
    const r2 = await env.api<ImportReportDto>("POST", "/api/leads/import/commit", { importId: prev2.importId, mapping: prev2.mapping });
    expect(r2.body.updated).toBe(1);
    const after = await env.api<Paged<LeadDto>>("GET", "/api/leads?q=julia");
    expect(after.body.items[0]).toMatchObject({ firstName: "Julia", position: "Geschäftsführerin" });
  });

  it("verlangt eine E-Mail-Spalte", async () => {
    const env = await createTestEnv();
    const mp = multipart("x.csv", Buffer.from("Name;Firma\nA;B\n"));
    const preview = JSON.parse((await env.app.inject({ method: "POST", url: "/api/leads/import/preview", payload: mp.payload, headers: { ...mp.headers, cookie: env.cookie } })).body) as ImportPreviewDto;
    const res = await env.api<{ error: string }>("POST", "/api/leads/import/commit", { importId: preview.importId, mapping: preview.mapping });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("E-Mail");
  });

  it("schützt den CSV-Export vor Formel-Injektion", async () => {
    const env = await createTestEnv();
    const mp = multipart("x.csv", Buffer.from("Email;Firma\na@b.de;=HYPERLINK(\"x\")\n"));
    const preview = JSON.parse((await env.app.inject({ method: "POST", url: "/api/leads/import/preview", payload: mp.payload, headers: { ...mp.headers, cookie: env.cookie } })).body) as ImportPreviewDto;
    await env.api("POST", "/api/leads/import/commit", { importId: preview.importId, mapping: preview.mapping, checkMx: false });
    const res = await env.app.inject({ method: "GET", url: "/api/leads/export.csv", headers: { cookie: env.cookie } });
    expect(res.body).toContain("'=HYPERLINK");
  });
});
