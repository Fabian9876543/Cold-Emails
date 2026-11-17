import nodemailer from "nodemailer";
import type { MailboxRow } from "./mailboxes";
import type { GoogleOAuthClient } from "./googleOAuth";

export interface OutgoingMail {
  from: { name: string; address: string };
  to: { name?: string; address: string };
  subject: string;
  text: string;
  /** Vollständige Message-ID inklusive spitzer Klammern, z. B. "<uuid@firma.de>". */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
  date?: Date;
}

export interface SendResult {
  response: string;
  accepted: string[];
  rejected: string[];
}

export interface MailTransport {
  send(mailbox: MailboxRow, mail: OutgoingMail): Promise<SendResult>;
  verify(mailbox: MailboxRow): Promise<void>;
}

export interface CredentialSource {
  /** Entschlüsseltes App-Passwort, SMTP-Passwort oder OAuth-Refresh-Token. */
  secretFor(mailbox: MailboxRow): string;
  oauthClient(): GoogleOAuthClient | null;
}

function createTransporter(mailbox: MailboxRow, creds: CredentialSource) {
  const secret = creds.secretFor(mailbox);
  let auth: Record<string, unknown> | undefined;
  if (mailbox.auth_type === "google_oauth") {
    const client = creds.oauthClient();
    if (!client) throw new Error("Google-OAuth ist nicht eingerichtet (Client-ID/Secret fehlen).");
    auth = { type: "OAuth2", user: mailbox.username, clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: secret };
  } else if (mailbox.username) {
    auth = { user: mailbox.username, pass: secret };
  }
  return nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_security === "ssl",
    requireTLS: mailbox.smtp_security === "starttls",
    ignoreTLS: mailbox.smtp_security === "none",
    auth: auth as never,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    tls: mailbox.smtp_security === "none" ? undefined : { minVersion: "TLSv1.2" },
  });
}

/** Versand über die echten Postfächer (Google SMTP oder beliebiger SMTP-Server). */
export function createSmtpTransport(creds: CredentialSource): MailTransport {
  return {
    async send(mailbox, mail) {
      const transporter = createTransporter(mailbox, creds);
      try {
        const info = await transporter.sendMail({
          from: { name: mail.from.name, address: mail.from.address },
          to: mail.to.name ? { name: mail.to.name, address: mail.to.address } : mail.to.address,
          subject: mail.subject,
          text: mail.text,
          messageId: mail.messageId,
          inReplyTo: mail.inReplyTo,
          references: mail.references,
          headers: mail.headers,
          date: mail.date,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        return {
          response: String(info.response ?? ""),
          accepted: (info.accepted ?? []).map(String),
          rejected: (info.rejected ?? []).map(String),
        };
      } finally {
        transporter.close();
      }
    },
    async verify(mailbox) {
      const transporter = createTransporter(mailbox, creds);
      try {
        await transporter.verify();
      } finally {
        transporter.close();
      }
    },
  };
}
