import type { MailboxAuthType } from "../../shared/types";

/** Übersetzt typische Verbindungsfehler in verständliche Hinweise. */
export function explainConnectionError(err: unknown, protocol: "SMTP" | "IMAP", authType: MailboxAuthType): string {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string; authenticationFailed?: boolean; serverResponseCode?: string };
  const raw = `${e.response ?? ""} ${e.message ?? ""} ${e.serverResponseCode ?? ""}`.trim();
  const isAuth =
    e.code === "EAUTH" ||
    e.authenticationFailed === true ||
    e.responseCode === 535 ||
    /AUTHENTICATIONFAILED|authentication failed|invalid credentials|Username and Password not accepted|5\.7\.8|login failed/i.test(raw);

  if (isAuth) {
    if (authType === "google_app_password") {
      return `${protocol}: Google hat die Anmeldung abgelehnt. Bitte prüfen: 1) Die Bestätigung in zwei Schritten ist für das Konto aktiv. 2) Sie haben ein App-Passwort (16 Zeichen) eingegeben, nicht Ihr normales Passwort. 3) Die E-Mail-Adresse stimmt. 4) Ihr Workspace-Admin erlaubt App-Passwörter und IMAP-Zugriff.`;
    }
    if (authType === "google_oauth") {
      return `${protocol}: Die Google-Verbindung ist abgelaufen oder wurde widerrufen. Bitte das Postfach erneut mit Google verbinden.`;
    }
    return `${protocol}: Benutzername oder Passwort wurden abgelehnt.`;
  }
  if (/IMAP access is disabled|Web login required|Please log in via your web browser/i.test(raw)) {
    return `${protocol}: Der IMAP-Zugriff ist für dieses Konto deaktiviert. In der Google-Admin-Konsole unter Apps → Google Workspace → Gmail → Endnutzerzugriff den POP- und IMAP-Zugriff erlauben.`;
  }
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "ECONNECTION", "ESOCKET"].includes(e.code ?? "") || /timeout|getaddrinfo|ECONNREFUSED/i.test(raw)) {
    return `${protocol}: Der Server ist nicht erreichbar (${e.code ?? "Zeitüberschreitung"}). Bitte Servername, Port und Verschlüsselung prüfen.`;
  }
  if (/certificate|self[- ]signed|TLS|SSL/i.test(raw)) {
    return `${protocol}: Problem mit der verschlüsselten Verbindung (${raw.slice(0, 160)}). Bitte Port und Verschlüsselung prüfen.`;
  }
  return `${protocol}: ${raw.slice(0, 300) || "Unbekannter Fehler"}`;
}
