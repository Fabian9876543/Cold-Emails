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

import { greeting } from "../../src/shared/template";
import { checkSpam } from "../../src/shared/spamcheck";

describe("Begrüßung", () => {
  it("passt sich Ansprache und vorhandenen Angaben an", () => {
    expect(greeting("sie", "Frau", "Julia", "Becker")).toBe("Guten Tag Frau Becker");
    expect(greeting("sie", "", "Julia", "Becker")).toBe("Guten Tag Julia Becker");
    expect(greeting("sie", "", "", "")).toBe("Guten Tag");
    expect(greeting("du", "Frau", "Julia", "Becker")).toBe("Hallo Julia");
    expect(greeting("du", "", "", "Becker")).toBe("Hallo");
  });
});

describe("Spam-Check", () => {
  it("bewertet sachliche, personalisierte Mails als unkritisch", () => {
    const r = checkSpam({ subject: "Frage zu {{firma}}", body: "{{begruessung}},\n\nkurze Frage zu Ihrer Logistik: Wer ist bei Ihnen für den Fuhrpark zuständig?\n\nViele Grüße", isFirstStep: true });
    expect(r.level).toBe("niedrig");
  });
  it("erkennt typische Spam-Auslöser", () => {
    const r = checkSpam({ subject: "Re: KOSTENLOS testen!!!", body: "Jetzt kaufen!!! 100% garantiert, hier klicken: https://bit.ly/abc", isFirstStep: true });
    expect(r.level).toBe("hoch");
    expect(r.findings.some((f) => f.message.includes("Link-Kürzer"))).toBe(true);
    expect(r.findings.some((f) => f.message.includes("Re:"))).toBe(true);
  });
  it("vermisst Personalisierung im Erstkontakt", () => {
    const r = checkSpam({ subject: "Hallo", body: "Wir bieten Software für Logistik an. Interesse an einem Gespräch?", isFirstStep: true });
    expect(r.findings.some((f) => f.message.includes("Personalisierung"))).toBe(true);
  });
});
