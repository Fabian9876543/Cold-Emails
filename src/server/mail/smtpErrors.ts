// Ordnet SMTP-Fehler einer Reaktion zu (siehe Versand-Engine).

export type SmtpErrorKind =
  | "recipient" // Empfänger existiert nicht → Bounce + Sperrliste
  | "auth" // Login abgelehnt → Postfach auf "Fehler"
  | "quota" // Google-Tageslimit erreicht → Postfach bis morgen pausieren
  | "rate" // zu viele Mails in kurzer Zeit → Postfach 1 Stunde pausieren
  | "policy" // Mail wegen Richtlinien/Authentifizierung abgelehnt → Postfach prüfen
  | "rejected" // sonstige dauerhafte Ablehnung dieser Mail → Kontakt auf "Fehler"
  | "temporary"; // Netzwerk/vorübergehend → später erneut versuchen

export interface ClassifiedSmtpError {
  kind: SmtpErrorKind;
  responseCode: number | null;
  message: string;
}

interface NodemailerLikeError {
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
  message?: string;
  rejected?: unknown[];
}

export function classifySmtpError(err: unknown): ClassifiedSmtpError {
  const e = (err ?? {}) as NodemailerLikeError;
  const code = e.code ?? "";
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : null;
  const text = `${e.response ?? ""} ${e.message ?? ""}`.trim();
  const message = text || String(err);
  const command = (e.command ?? "").toUpperCase();

  if (code === "EAUTH" || responseCode === 535 || responseCode === 534 || (responseCode === 530 && /5\.7\.0/.test(text))) {
    return { kind: "auth", responseCode, message };
  }
  if (/5\.4\.5|daily (user )?sending (quota|limit)|sending limit exceeded|daily limit/i.test(text)) {
    return { kind: "quota", responseCode, message };
  }
  if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
    if (/4\.7\.\d|try again later|rate limit|too many|temporarily (rate )?limited/i.test(text)) {
      return { kind: "rate", responseCode, message };
    }
    return { kind: "temporary", responseCode, message };
  }
  if (responseCode !== null && responseCode >= 500) {
    const recipientProblem =
      command.startsWith("RCPT") ||
      code === "EENVELOPE" ||
      /5\.1\.\d|5\.2\.1|user unknown|no such user|does not exist|unknown user|mailbox (is )?unavailable|recipient (address )?rejected|address not found|invalid recipient|nicht vorhanden|unbekannt/i.test(text);
    if (recipientProblem) return { kind: "recipient", responseCode, message };
    if (/5\.7\.\d/.test(text)) return { kind: "policy", responseCode, message };
    return { kind: "rejected", responseCode, message };
  }
  if (code === "EENVELOPE") return { kind: "recipient", responseCode, message };
  return { kind: "temporary", responseCode, message };
}

/** Verständliche deutsche Erklärung für die Oberfläche. */
export function explainSmtpError(c: ClassifiedSmtpError): string {
  switch (c.kind) {
    case "auth":
      return "Anmeldung am Mailserver fehlgeschlagen. Bitte App-Passwort bzw. Google-Verbindung prüfen.";
    case "quota":
      return "Das Tageslimit von Google ist erreicht. Das Postfach pausiert bis morgen.";
    case "rate":
      return "Google drosselt den Versand vorübergehend. Das Postfach pausiert eine Stunde.";
    case "policy":
      return "Die Mail wurde aus Richtlinien-Gründen abgelehnt (oft fehlende SPF/DKIM/DMARC-Einträge). Bitte Zustellbarkeit prüfen.";
    case "recipient":
      return "Die Empfängeradresse existiert nicht.";
    case "rejected":
      return "Die Mail wurde vom Server abgelehnt.";
    case "temporary":
      return "Vorübergehender Fehler beim Versand. Es wird später erneut versucht.";
  }
}
