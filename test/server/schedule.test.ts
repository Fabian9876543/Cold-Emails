import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  computeGapMs,
  isValidWindow,
  isWithinWindow,
  nextWindowOpening,
  scheduleFollowUp,
  type SendWindow,
} from "../../src/server/worker/schedule";
import { classifySmtpError } from "../../src/server/mail/smtpErrors";

const w: SendWindow = { timezone: "Europe/Berlin", sendDays: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" };
const berlin = (iso: string) => DateTime.fromISO(iso, { zone: "Europe/Berlin" }).toMillis();
const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: "Europe/Berlin" }).toFormat("ccc yyyy-MM-dd HH:mm");

describe("Versandfenster", () => {
  it("erkennt Zeiten im Fenster", () => {
    expect(isWithinWindow(berlin("2025-03-04T09:30"), w)).toBe(true); // Dienstag
    expect(isWithinWindow(berlin("2025-03-04T07:59"), w)).toBe(false);
    expect(isWithinWindow(berlin("2025-03-04T17:00"), w)).toBe(false);
    expect(isWithinWindow(berlin("2025-03-08T10:00"), w)).toBe(false); // Samstag
  });

  it("berücksichtigt die Zeitzone und Sommerzeit", () => {
    // 30. März 2025: Umstellung auf Sommerzeit; Montag 31.3. 08:30 Berlin = 06:30 UTC
    expect(isWithinWindow(Date.UTC(2025, 2, 31, 6, 30), w)).toBe(true);
    expect(isWithinWindow(Date.UTC(2025, 2, 31, 5, 30), w)).toBe(false);
  });

  it("findet die nächste Öffnung (Freitagabend → Montag 8 Uhr)", () => {
    expect(fmt(nextWindowOpening(berlin("2025-03-07T18:00"), w))).toBe("Mon 2025-03-10 08:00");
  });

  it("prüft die Gültigkeit", () => {
    expect(isValidWindow(w)).toBe(true);
    expect(isValidWindow({ ...w, end: "08:15" })).toBe(false);
    expect(isValidWindow({ ...w, sendDays: [] })).toBe(false);
  });
});

describe("Follow-up-Termine", () => {
  it("plant nach Wartetagen innerhalb des Fensters", () => {
    const at = scheduleFollowUp(berlin("2025-03-04T10:00"), 3, w, () => 0.5);
    const dt = DateTime.fromMillis(at, { zone: "Europe/Berlin" });
    expect(dt.toISODate()).toBe("2025-03-07");
    expect(dt.hour).toBeGreaterThanOrEqual(8);
    expect(dt.hour).toBeLessThan(17);
  });

  it("überspringt das Wochenende", () => {
    const at = scheduleFollowUp(berlin("2025-03-06T10:00"), 2, w, () => 0); // Do + 2 = Sa → Mo
    expect(fmt(at)).toBe("Mon 2025-03-10 08:00");
  });
});

describe("Abstände", () => {
  it("verteilt die Quote über das restliche Fenster", () => {
    const now = berlin("2025-03-04T08:00");
    const end = berlin("2025-03-04T17:00");
    expect(computeGapMs(now, end, 18, () => 0.5)).toBe(30 * 60 * 1000); // 9 h / 18
  });
  it("hält mindestens 2 Minuten Abstand", () => {
    const now = berlin("2025-03-04T16:59");
    expect(computeGapMs(now, berlin("2025-03-04T17:00"), 50, () => 0)).toBe(2 * 60 * 1000);
  });
  it("variiert um ±30 %", () => {
    const now = berlin("2025-03-04T08:00");
    const end = berlin("2025-03-04T17:00");
    expect(computeGapMs(now, end, 18, () => 0)).toBe(Math.round(30 * 60 * 1000 * 0.7));
    expect(computeGapMs(now, end, 18, () => 0.999999)).toBeLessThanOrEqual(Math.round(30 * 60 * 1000 * 1.3));
  });
});

describe("SMTP-Fehler", () => {
  it("ordnet typische Gmail-Antworten zu", () => {
    expect(classifySmtpError({ code: "EAUTH", responseCode: 535, response: "535-5.7.8 Username and Password not accepted" }).kind).toBe("auth");
    expect(classifySmtpError({ responseCode: 550, response: "550 5.4.5 Daily user sending limit exceeded" }).kind).toBe("quota");
    expect(classifySmtpError({ responseCode: 421, response: "421 4.7.0 Try again later, closing connection" }).kind).toBe("rate");
    expect(classifySmtpError({ responseCode: 550, command: "RCPT TO", response: "550 5.1.1 The email account that you tried to reach does not exist" }).kind).toBe("recipient");
    expect(classifySmtpError({ responseCode: 550, command: "DATA", response: "550 5.7.26 Unauthenticated email from firma.de is not accepted due to domain's DMARC policy" }).kind).toBe("policy");
    expect(classifySmtpError({ responseCode: 451, response: "451 4.3.0 Mail server temporarily rejected message" }).kind).toBe("temporary");
    expect(classifySmtpError({ code: "ETIMEDOUT", message: "Connection timeout" }).kind).toBe("temporary");
    expect(classifySmtpError({ responseCode: 552, command: "DATA", response: "552 5.3.4 Message too big" }).kind).toBe("rejected");
  });
});
