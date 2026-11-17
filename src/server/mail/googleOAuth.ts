import type { AppConfig } from "../config";
import type { DB } from "../db/client";
import type { SecretBox } from "../lib/crypto";
import { getSettings } from "../lib/settings";

// Google OAuth 2.0 für Gmail per IMAP/SMTP (XOAUTH2). Nötig ist eine OAuth-App vom Typ
// "Intern" im eigenen Google-Workspace – dafür verlangt Google keine Prüfung.

export const GOOGLE_SCOPES = ["https://mail.google.com/", "openid", "email"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** OAuth-Zugangsdaten aus .env oder aus den Einstellungen. */
export function getGoogleOAuthClient(config: AppConfig, db: DB, secrets: SecretBox): GoogleOAuthClient | null {
  if (config.googleClientId && config.googleClientSecret) {
    return { clientId: config.googleClientId, clientSecret: config.googleClientSecret };
  }
  const s = getSettings(db);
  if (s.googleClientId && s.googleClientSecretEnc) {
    try {
      return { clientId: s.googleClientId, clientSecret: secrets.decrypt(s.googleClientSecretEnc) };
    } catch {
      return null;
    }
  }
  return null;
}

export function buildAuthUrl(client: GoogleOAuthClient, redirectUri: string, state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `${AUTH_URL}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const desc = (json.error_description as string) || (json.error as string) || `HTTP ${res.status}`;
    throw new Error(`Google-Anmeldung fehlgeschlagen: ${desc}`);
  }
  return json as unknown as TokenResponse;
}

export function exchangeCode(client: GoogleOAuthClient, code: string, redirectUri: string): Promise<TokenResponse> {
  return postToken({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
}

/** Liest die E-Mail-Adresse aus dem ID-Token (wurde direkt von Google über TLS geliefert). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
    return data.email && data.email_verified !== false ? data.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Access-Token für IMAP holen (mit Zwischenspeicher bis kurz vor Ablauf). */
export async function getAccessToken(client: GoogleOAuthClient, refreshToken: string): Promise<string> {
  const cached = accessTokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await postToken({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  accessTokenCache.set(refreshToken, { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 });
  return res.access_token;
}
