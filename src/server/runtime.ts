import type { Logger } from "pino";
import type { AppConfig } from "./config";
import { systemClock, type AppContext } from "./context";
import type { DB } from "./db/client";
import type { SecretBox } from "./lib/crypto";
import { createSmtpTransport, type CredentialSource } from "./mail/transport";
import { createImapReader } from "./mail/inbox";
import { getGoogleOAuthClient } from "./mail/googleOAuth";
import { createSystemResolver } from "./deliverability/dns";
import { createAiGateway } from "./ai/client";

/** Kontext mit den echten Adaptern (SMTP, IMAP, DNS, Claude). */
export function createRuntimeContext(deps: { config: AppConfig; db: DB; secrets: SecretBox; log: Logger }): AppContext {
  const creds: CredentialSource = {
    secretFor: (mailbox) => deps.secrets.decrypt(mailbox.secret_enc),
    oauthClient: () => getGoogleOAuthClient(deps.config, deps.db, deps.secrets),
  };
  return {
    ...deps,
    clock: systemClock,
    mail: createSmtpTransport(creds),
    inbox: createImapReader(creds),
    dns: createSystemResolver(),
    ai: createAiGateway(deps),
    random: Math.random,
  };
}
