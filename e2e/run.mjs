// End-to-End-Test: klickt die Plattform wie ein Nutzer durch – mit echtem Hintergrund-Worker
// und einem lokalen Test-Mailserver. Voraussetzung: `npm run build` und Playwright (Chromium).
//
//   npm run build && npm run e2e
//
// Screenshots landen in docs/screenshots/.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { SMTPServer } from "smtp-server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright fehlt. Installation: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}
if (!fs.existsSync(path.join(root, "dist/server/index.js"))) {
  console.error("Bitte zuerst bauen: npm run build");
  process.exit(1);
}

const shots = path.join(root, "docs/screenshots");
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-emails-e2e-"));
const PORT = 3999;
const PASSWORD = "e2e-passwort-123";
const base = `http://localhost:${PORT}`;

// Test-Mailserver
const received = [];
const smtp = new SMTPServer({
  authOptional: true,
  allowInsecureAuth: true,
  disabledCommands: ["STARTTLS"],
  logger: false,
  onAuth: (auth, _s, cb) => cb(null, { user: auth.username }),
  onData(stream, session, cb) {
    let raw = "";
    stream.on("data", (c) => (raw += c));
    stream.on("end", () => {
      received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
      cb();
    });
  },
});
await new Promise((r) => smtp.listen(2526, "127.0.0.1", r));

const server = spawn(process.execPath, ["dist/server/index.js"], {
  cwd: root,
  env: { ...process.env, ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir, PORT: String(PORT), NODE_ENV: "production", WORKER: "on", PUBLIC_BASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    // startet noch
  }
  await new Promise((r) => setTimeout(r, 200));
}

// Zeitzone wählen, in der gerade Geschäftszeit ist (damit der Versand sofort startet)
const ZONES = ["Europe/Berlin", "America/New_York", "America/Los_Angeles", "Pacific/Honolulu", "Asia/Tokyo", "Asia/Kolkata", "Asia/Dubai", "Pacific/Auckland", "America/Sao_Paulo", "Europe/London"];
const zone = ZONES.find((z) => {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: z }).format(new Date()));
  return h >= 9 && h <= 15;
}) ?? "Europe/Berlin";

const failures = [];
const check = (cond, message) => {
  console.log(`${cond ? "✔" : "✖"} ${message}`);
  if (!cond) failures.push(message);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, locale: "de-DE" });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

try {
  // Anmeldung
  await page.goto(base);
  await page.getByLabel("Passwort").fill(PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await page.getByText("Wichtig: Rechtliche Lage bei Cold-Emails").waitFor();
  await page.getByLabel("Ich habe den Hinweis gelesen").check();
  await page.getByRole("button", { name: "Verstanden" }).click();
  await page.getByText("In vier Schritten startklar").waitFor();
  check(true, "Anmeldung und Einrichtungs-Checkliste");
  await shot("01-start");

  // Firmendaten
  await page.getByRole("link", { name: "Einstellungen" }).click();
  await page.getByLabel("Firmenname").fill("Muster GmbH");
  await page.getByLabel("Anschrift").fill("Musterstraße 1\n34117 Kassel");
  await page.getByRole("button", { name: "Einstellungen speichern" }).click();
  await page.getByText("Einstellungen gespeichert.").waitFor();
  check(true, "Firmendaten gespeichert");

  // Postfach verbinden (lokaler Test-Mailserver)
  await page.getByRole("link", { name: "Postfächer" }).click();
  await page.getByRole("button", { name: "Postfach verbinden" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Anderer Anbieter").click();
  await dialog.getByLabel("Absendername").fill("Max Mustermann");
  await dialog.getByLabel("E-Mail-Adresse").fill("max@absender.test");
  await dialog.getByLabel(/^Passwort/).fill("test");
  await dialog.getByLabel("SMTP-Server").fill("127.0.0.1");
  await dialog.getByLabel("SMTP-Port").fill("2526");
  await dialog.getByLabel("Verschlüsselung").first().click();
  await page.getByRole("option", { name: "Keine (nur lokal/Test)" }).click();
  await dialog.getByLabel("IMAP-Server").fill("127.0.0.1");
  await dialog.getByLabel("Posteingang auf Antworten und Bounces prüfen (IMAP)").uncheck();
  await dialog.getByLabel("Langsam hochfahren (empfohlen für neue Postfächer)").uncheck();
  await dialog.getByRole("button", { name: "Aus Firmendaten erzeugen" }).click();
  await dialog.getByRole("button", { name: "Verbinden & prüfen" }).click();
  await page.getByText("max@absender.test ist verbunden.").waitFor();
  check(true, "Postfach verbunden und geprüft");
  await page.waitForTimeout(400);
  await shot("02-postfaecher");

  // Kontakte importieren
  const csv = path.join(dataDir, "messe-kontakte.csv");
  fs.writeFileSync(
    csv,
    "﻿E-Mail;Anrede;Vorname;Nachname;Firma;Position;Branche\njulia.becker@becker-logistik.test;Frau;Julia;Becker;Becker Logistik GmbH;Geschäftsführerin;Logistik\ntom.werner@werk-ag.test;Herr;Tom;Werner;Werk AG;Einkauf;Maschinenbau\ninfo@nord-kg.test;;;;Nord KG;;Handel\nkaputt-ohne-at;;;;;;\n",
  );
  await page.getByRole("link", { name: "Kontakte" }).click();
  await page.getByRole("button", { name: "Kontakte importieren" }).first().click();
  await page.locator('input[type="file"]').setInputFiles(csv);
  await page.getByText("4 Zeilen gefunden").waitFor();
  await page.getByRole("switch", { name: /Domains prüfen/ }).uncheck();
  await shot("03-import-zuordnung");
  await page.getByRole("button", { name: "4 Zeilen importieren" }).click();
  await page.getByText(/Import abgeschlossen/).waitFor();
  check((await page.getByText("Ungültiges Format").count()) === 1, "Import mit Prüfbericht (1 ungültige Adresse)");
  await shot("04-import-bericht");
  await page.getByRole("button", { name: "Kampagne mit dieser Liste erstellen" }).click();

  // Kampagnen-Assistent
  await page.getByLabel("Name der Kampagne").fill("Logistik Nordhessen");
  await page.getByRole("button", { name: /Weiter: E-Mails/ }).click();
  await page.getByLabel("Betreff").waitFor();
  await page.getByLabel("Betreff").fill("Frage zu {{firma}}");
  const body = page.locator("textarea").first();
  await body.fill(
    "{{begruessung}},\n\nbei meiner Recherche bin ich auf {{firma|Ihr Unternehmen}} gestoßen. Wir helfen Unternehmen aus der Branche {{branche|Ihrer Branche}}, Leerfahrten zu reduzieren.\n\nWäre ein kurzes Gespräch von 15 Minuten in den nächsten Tagen interessant?\n\nViele Grüße",
  );
  await page.getByText("Guten Tag Frau Becker,").waitFor();
  await page.locator(".mail-preview", { hasText: "Leerfahrten zu reduzieren" }).waitFor();
  check(true, "Live-Vorschau mit echtem Kontakt und Begrüßung");
  await shot("05-editor");
  await page.getByRole("tab", { name: /Nachfass 1/ }).click();
  await page.locator("textarea").first().fill("{{begruessung}},\n\nich hole meine Nachricht noch einmal kurz nach oben – passt das Thema gerade?\n\nViele Grüße");
  await page.getByRole("tab", { name: /Nachfass 2/ }).click();
  await page.locator("textarea").first().fill("{{begruessung}},\n\nich melde mich ein letztes Mal. Falls das Thema später interessant wird, antworten Sie einfach.\n\nViele Grüße");
  await page.getByRole("button", { name: /Weiter: KI-Personalisierung/ }).click();
  await page.getByRole("button", { name: /Weiter: Versand/ }).click();
  for (const day of ["Sa", "So"]) await page.getByText(day, { exact: true }).click();
  await page.getByRole("textbox", { name: "Von", exact: true }).click();
  await page.getByRole("option", { name: "06:00" }).click();
  await page.getByRole("textbox", { name: "Bis", exact: true }).click();
  await page.getByRole("option", { name: "21:00" }).click();
  await page.getByRole("textbox", { name: "Zeitzone der Empfänger" }).fill(zone);
  await page.getByRole("option", { name: zone, exact: true }).click();
  await page.getByRole("button", { name: /Weiter: Prüfen & Starten/ }).click();
  await page.getByText("Bitte vor dem Start beheben").waitFor();
  check((await page.getByText(/SPF und DKIM fehlt/).count()) > 0, "Startprüfung erkennt fehlendes SPF/DKIM der Testdomain");
  await page.getByLabel(/trotzdem starten/).check();
  await page.waitForTimeout(800);
  await shot("06-pruefen-starten");
  await page.getByRole("button", { name: "Kampagne starten" }).click();
  await page.getByText("Kampagne gestartet").waitFor();
  check(true, "Kampagne gestartet");

  // Auf den Versand durch den Hintergrund-Worker warten
  for (let i = 0; i < 60 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 1000));
  check(received.length >= 1, `Hintergrund-Worker hat versendet (${received.length} Mail(s))`);
  const first = received[0]?.raw ?? "";
  check(/List-Unsubscribe: <mailto:max@absender\.test\?subject=Abmelden>/.test(first), "Abmelde-Kopfzeile vorhanden");
  check(/Kein Interesse\? Eine kurze Antwort gen=C3=BCgt|Kein Interesse\? Eine kurze Antwort genügt/.test(first), "Abmeldehinweis im Text");

  await page.reload();
  await page.getByText("Gesendet").first().waitFor();
  await page.waitForTimeout(500);
  await shot("07-kampagne");
  await page.getByRole("link", { name: "Start" }).click();
  await page.getByText("Versand und Antworten (14 Tage)").waitFor();
  await page.waitForTimeout(800);
  await shot("08-dashboard");
  await page.getByRole("link", { name: "Zustellbarkeit" }).click();
  await page.getByText("absender.test").first().waitFor();
  await page.waitForTimeout(500);
  await shot("09-zustellbarkeit");
} catch (err) {
  failures.push(String(err));
  console.error(err);
  await page.screenshot({ path: path.join(shots, "fehler.png"), fullPage: true }).catch(() => undefined);
} finally {
  check(consoleErrors.length === 0, `Keine Fehler in der Browser-Konsole${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(" | ")}` : ""}`);
  await browser.close();
  server.kill();
  smtp.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} Prüfung(en) fehlgeschlagen.\n--- Server-Protokoll ---\n${serverLog.slice(-3000)}`);
  process.exit(1);
}
console.log(`\nAlle Prüfungen bestanden. Screenshots: ${path.relative(root, shots)}/`);
