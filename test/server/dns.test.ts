import { describe, expect, it } from "vitest";
import { analyzeDkim, analyzeDmarc, analyzeMx, analyzeSpf, checkDomain, domainAcceptsMail, type DnsResolver } from "../../src/server/deliverability/dns";

describe("SPF", () => {
  it("fehlt → Fehler mit Vorschlag", () => {
    const r = analyzeSpf([]);
    expect(r.status).toBe("error");
    expect(r.fix?.value).toBe("v=spf1 include:_spf.google.com ~all");
  });
  it("korrekter Google-Eintrag → ok", () => {
    expect(analyzeSpf(["v=spf1 include:_spf.google.com ~all"]).status).toBe("ok");
  });
  it("ohne Google → Warnung mit ergänztem Eintrag", () => {
    const r = analyzeSpf(["v=spf1 include:spf.protection.outlook.com -all"]);
    expect(r.status).toBe("warn");
    expect(r.fix?.value).toBe("v=spf1 include:spf.protection.outlook.com include:_spf.google.com -all");
  });
  it("mehrere SPF-Einträge → Fehler", () => {
    expect(analyzeSpf(["v=spf1 include:_spf.google.com ~all", "v=spf1 mx ~all"]).status).toBe("error");
  });
  it("+all → Fehler", () => {
    expect(analyzeSpf(["v=spf1 include:_spf.google.com +all"]).status).toBe("error");
  });
  it("ignoriert andere TXT-Einträge", () => {
    expect(analyzeSpf(["google-site-verification=abc", "v=spf1 include:_spf.google.com ~all"]).status).toBe("ok");
  });
});

describe("DKIM", () => {
  it("fehlt → Fehler mit Anleitung", () => {
    const r = analyzeDkim([], "google");
    expect(r.status).toBe("error");
    expect(r.fix?.steps?.length).toBeGreaterThan(2);
  });
  it("vorhanden → ok", () => {
    expect(analyzeDkim(["v=DKIM1; k=rsa; p=MIIBIjANBgkq"], "google").status).toBe("ok");
  });
  it("leerer Schlüssel → Fehler", () => {
    expect(analyzeDkim(["v=DKIM1; p="], "google").status).toBe("error");
  });
});

describe("DMARC", () => {
  it("fehlt → Warnung mit Vorschlag", () => {
    const r = analyzeDmarc([], "firma.de");
    expect(r.status).toBe("warn");
    expect(r.fix?.value).toContain("v=DMARC1; p=none");
  });
  it("p=none → ok", () => {
    expect(analyzeDmarc(["v=DMARC1; p=none; rua=mailto:x@firma.de"], "firma.de").status).toBe("ok");
  });
  it("ohne Richtlinie → Fehler", () => {
    expect(analyzeDmarc(["v=DMARC1; rua=mailto:x@firma.de"], "firma.de").status).toBe("error");
  });
});

describe("MX", () => {
  it("Google-MX → ok", () => {
    expect(analyzeMx([{ exchange: "smtp.google.com", priority: 1 }]).status).toBe("ok");
    expect(analyzeMx([{ exchange: "aspmx.l.google.com", priority: 1 }]).status).toBe("ok");
  });
  it("anderer Anbieter → Warnung", () => {
    expect(analyzeMx([{ exchange: "mx00.ionos.de", priority: 10 }]).status).toBe("warn");
  });
  it("kein MX → Fehler", () => {
    expect(analyzeMx([]).status).toBe("error");
  });
});

function fakeDns(records: Record<string, string[]>, mx: Record<string, string[]> = {}): DnsResolver {
  const notFound = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return {
    async resolveTxt(name) {
      if (!records[name]) throw notFound();
      return records[name].map((r) => [r]);
    },
    async resolveMx(domain) {
      if (!mx[domain]) throw notFound();
      return mx[domain].map((exchange, i) => ({ exchange, priority: i }));
    },
    async resolve4() {
      throw notFound();
    },
  };
}

describe("checkDomain", () => {
  it("kombiniert alle Prüfungen", async () => {
    const dns = fakeDns(
      {
        "firma.de": ["v=spf1 include:_spf.google.com ~all"],
        "google._domainkey.firma.de": ["v=DKIM1; k=rsa; p=ABC"],
        "_dmarc.firma.de": ["v=DMARC1; p=none"],
      },
      { "firma.de": ["smtp.google.com"] },
    );
    const r = await checkDomain(dns, "firma.de", "google");
    expect(r.overall).toBe("ok");
  });

  it("meldet fehlende Einträge", async () => {
    const r = await checkDomain(fakeDns({}, { "firma.de": ["smtp.google.com"] }), "firma.de", "google");
    expect(r.spf.status).toBe("error");
    expect(r.dkim.status).toBe("error");
    expect(r.overall).toBe("error");
  });

  it("erkennt Domains ohne Mailempfang", async () => {
    expect(await domainAcceptsMail(fakeDns({}, {}), "gibtsnicht.example")).toBe(false);
    expect(await domainAcceptsMail(fakeDns({}, { "firma.de": ["mx.firma.de"] }), "firma.de")).toBe(true);
  });
});
