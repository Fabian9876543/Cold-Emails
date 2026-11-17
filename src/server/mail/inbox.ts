import { ImapFlow } from "imapflow";
import type { MailboxRow } from "./mailboxes";
import type { CredentialSource } from "./transport";
import { getAccessToken } from "./googleOAuth";

export interface FetchedMessage {
  uid: number;
  source: Buffer;
}

export interface InboxCursor {
  uidValidity: string | null;
  lastUid: number;
}

export interface InboxFetchResult {
  uidValidity: string;
  lastUid: number;
  messages: FetchedMessage[];
}

export interface InboxReader {
  /**
   * Holt neue Mails seit dem Cursor. Beim ersten Abruf (oder wenn sich UIDVALIDITY ändert)
   * wird nur der Cursor gesetzt – alte Mails im Posteingang werden nie verarbeitet.
   */
  fetchNew(mailbox: MailboxRow, cursor: InboxCursor): Promise<InboxFetchResult>;
  verify(mailbox: MailboxRow): Promise<void>;
}

const MAX_PER_POLL = 200;
const MAX_SOURCE_BYTES = 512 * 1024;

async function connect(mailbox: MailboxRow, creds: CredentialSource): Promise<ImapFlow> {
  const secret = creds.secretFor(mailbox);
  let auth: { user: string; pass?: string; accessToken?: string };
  if (mailbox.auth_type === "google_oauth") {
    const client = creds.oauthClient();
    if (!client) throw new Error("Google-OAuth ist nicht eingerichtet (Client-ID/Secret fehlen).");
    auth = { user: mailbox.username, accessToken: await getAccessToken(client, secret) };
  } else {
    auth = { user: mailbox.username, pass: secret };
  }
  const client = new ImapFlow({
    host: mailbox.imap_host,
    port: mailbox.imap_port,
    secure: mailbox.imap_security === "ssl",
    doSTARTTLS: mailbox.imap_security === "starttls" ? true : mailbox.imap_security === "none" ? false : undefined,
    auth,
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  await client.connect();
  return client;
}

/** Liest den Posteingang per IMAP – nur mit BODY.PEEK, Mails bleiben ungelesen. */
export function createImapReader(creds: CredentialSource): InboxReader {
  return {
    async fetchNew(mailbox, cursor) {
      const client = await connect(mailbox, creds);
      try {
        const lock = await client.getMailboxLock("INBOX", { readOnly: true });
        try {
          const status = client.mailbox;
          if (!status || typeof status === "boolean") throw new Error("Posteingang konnte nicht geöffnet werden.");
          const uidValidity = String(status.uidValidity);
          const highest = Math.max(0, Number(status.uidNext ?? 1) - 1);
          if (cursor.uidValidity !== uidValidity) {
            return { uidValidity, lastUid: highest, messages: [] };
          }
          if (highest <= cursor.lastUid) {
            return { uidValidity, lastUid: cursor.lastUid, messages: [] };
          }
          const to = Math.min(highest, cursor.lastUid + MAX_PER_POLL);
          const messages: FetchedMessage[] = [];
          let lastUid = cursor.lastUid;
          for await (const msg of client.fetch(
            `${cursor.lastUid + 1}:${to}`,
            { uid: true, source: { start: 0, maxLength: MAX_SOURCE_BYTES } },
            { uid: true },
          )) {
            if (msg.uid <= cursor.lastUid) continue;
            if (msg.source) messages.push({ uid: msg.uid, source: msg.source });
            lastUid = Math.max(lastUid, msg.uid);
          }
          return { uidValidity, lastUid: Math.max(lastUid, to), messages };
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
    async verify(mailbox) {
      const client = await connect(mailbox, creds);
      try {
        const lock = await client.getMailboxLock("INBOX", { readOnly: true });
        lock.release();
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  };
}
