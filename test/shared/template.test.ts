import { describe, expect, it } from "vitest";
import { extractPlaceholders, normalizeKey, render } from "../../src/shared/template";

describe("render", () => {
  it("ersetzt Platzhalter und ignoriert Groß-/Kleinschreibung", () => {
    const r = render("Hallo {{Vorname}}, wie läuft es bei {{ firma }}?", { vorname: "Julia", firma: "Becker GmbH" });
    expect(r.text).toBe("Hallo Julia, wie läuft es bei Becker GmbH?");
    expect(r.missing).toEqual([]);
  });

  it("nutzt den Ersatztext, wenn der Wert fehlt", () => {
    const r = render("Hallo {{vorname|zusammen}},", { vorname: "" });
    expect(r.text).toBe("Hallo zusammen,");
    expect(r.missing).toEqual([]);
  });

  it("meldet fehlende Pflicht-Platzhalter statt sie leer zu lassen", () => {
    const r = render("Hallo {{vorname}}, {{firma}}", { firma: "X" });
    expect(r.missing).toEqual(["vorname"]);
  });

  it("entfernt doppelte Leerzeichen bei leerem Ersatztext", () => {
    const r = render("Guten Tag {{anrede|}} {{nachname}},", { nachname: "Becker" });
    expect(r.text).toBe("Guten Tag Becker,");
  });

  it("behält Zeilenumbrüche", () => {
    const r = render("Zeile 1\n\n{{signatur}}", { signatur: "Max\nFirma" });
    expect(r.text).toBe("Zeile 1\n\nMax\nFirma");
  });

  it("normalisiert Umlaute in Schlüsseln", () => {
    expect(normalizeKey("Straße Nr.")).toBe("strasse_nr");
    expect(normalizeKey("Größe")).toBe("groesse");
    const r = render("{{Größe}}", { groesse: "XL" });
    expect(r.text).toBe("XL");
  });

  it("findet verwendete Platzhalter", () => {
    expect(extractPlaceholders("{{vorname|du}} {{KI_Einstieg}} {{vorname}}")).toEqual([
      { key: "vorname", hasFallback: true },
      { key: "ki_einstieg", hasFallback: false },
    ]);
  });
});
