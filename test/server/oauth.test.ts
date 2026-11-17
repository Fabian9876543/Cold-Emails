import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, type TestEnv } from "../helpers";
import type { MailboxDto } from "../../src/shared/types";

function idToken(email: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ email, email_verified: true })}.signatur`;
}

async function startFlow(env: TestEnv, query = "fromName=Max%20Mustermann&dailyLimit=25") {
  const res = await env.app.inject({ method: "GET", url: `/api/oauth/google/start?${query}`, headers: { cookie: env.cookie, host: "localhost:3000" } });
  const location = new URL(res.headers.location as string);
  const setCookie = String(res.headers["set-cookie"]);
  const oauthCookie = /ce_oauth=([^;]+)/.exec(setCookie)?.[1] ?? "";
  return { res, location, oauthCookie };
}

function mockGoogle(tokens: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(tokens), { status: 200, headers: { "content-type": "application/json" } }));
}

afterEach(() => vi.restoreAllMocks());

const message = (location: unknown) => new URL(String(location), "http://x").searchParams.get("message") ?? "";

describe("Mit Google verbinden", () => {
  it("leitet ohne Einrichtung mit Hinweis zurück", async () => {
    const env = await createTestEnv({ publicBaseUrl: null });
    const res = await env.app.inject({ method: "GET", url: "/api/oauth/google/start", headers: { cookie: env.cookie } });
    expect(res.statusCode).toBe(302);
    expect(message(res.headers.location)).toContain("nicht eingerichtet");
  });

  it("verbindet ein Postfach über den kompletten Ablauf", async () => {
    const env = await createTestEnv({ publicBaseUrl: null });
    await env.api("PUT", "/api/settings", { googleClientId: "client-123.apps.googleusercontent.com", googleClientSecret: "GOCSPX-geheim" });
    const { location, oauthCookie } = await startFlow(env);
    expect(location.host).toBe("accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("client-123.apps.googleusercontent.com");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/google/callback");
    expect(location.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(location.searchParams.get("access_type")).toBe("offline");
    const state = location.searchParams.get("state")!;

    const fetchMock = mockGoogle({ access_token: "ya29.x", expires_in: 3600, refresh_token: "1//refresh", id_token: idToken("max@absender.de"), scope: "openid email https://mail.google.com/" });
    const cb = await env.app.inject({
      method: "GET",
      url: `/api/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: { cookie: `${env.cookie}; ce_oauth=${oauthCookie}`, host: "localhost:3000" },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain("oauth=ok");
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("client_secret=GOCSPX-geheim");

    const list = (await env.api<MailboxDto[]>("GET", "/api/mailboxes")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: "max@absender.de", authType: "google_oauth", fromName: "Max Mustermann", dailyLimit: 25, smtpHost: "smtp.gmail.com" });
    const row = env.ctx.db.prepare("SELECT secret_enc FROM mailboxes").get() as { secret_enc: string };
    expect(row.secret_enc).not.toContain("refresh");
    expect(env.ctx.secrets.decrypt(row.secret_enc)).toBe("1//refresh");
  });

  it("lehnt einen Rückruf ohne passendes Cookie ab (CSRF-Schutz)", async () => {
    const env = await createTestEnv({ publicBaseUrl: null });
    await env.api("PUT", "/api/settings", { googleClientId: "c", googleClientSecret: "s" });
    const { location } = await startFlow(env);
    const state = location.searchParams.get("state")!;
    const fetchMock = mockGoogle({});
    const cb = await env.app.inject({ method: "GET", url: `/api/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, headers: { cookie: env.cookie } });
    expect(message(cb.headers.location)).toContain("abgelaufen oder ungültig");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("erklärt fehlende Refresh-Tokens", async () => {
    const env = await createTestEnv({ publicBaseUrl: null });
    await env.api("PUT", "/api/settings", { googleClientId: "c", googleClientSecret: "s" });
    const { location, oauthCookie } = await startFlow(env);
    mockGoogle({ access_token: "x", expires_in: 3600, id_token: idToken("max@absender.de"), scope: "https://mail.google.com/" });
    const cb = await env.app.inject({
      method: "GET",
      url: `/api/oauth/google/callback?code=abc&state=${encodeURIComponent(location.searchParams.get("state")!)}`,
      headers: { cookie: `${env.cookie}; ce_oauth=${oauthCookie}` },
    });
    expect(message(cb.headers.location)).toContain("dauerhaften Zugang");
  });

  it("meldet abgelehnten Zugriff", async () => {
    const env = await createTestEnv({ publicBaseUrl: null });
    const cb = await env.app.inject({ method: "GET", url: "/api/oauth/google/callback?error=access_denied", headers: { cookie: env.cookie } });
    expect(message(cb.headers.location)).toContain("abgelehnt");
  });
});
