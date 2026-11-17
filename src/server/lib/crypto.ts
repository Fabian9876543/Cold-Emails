import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Verschlüsselt Geheimnisse (App-Passwörter, Refresh-Tokens, API-Schlüssel) mit AES-256-GCM
 * und signiert Tokens (Abmelde-Links, OAuth-State) per HMAC-SHA256.
 */
export class SecretBox {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(secret: string) {
    this.encKey = Buffer.from(crypto.hkdfSync("sha256", secret, "cold-emails", "encryption", 32));
    this.macKey = Buffer.from(crypto.hkdfSync("sha256", secret, "cold-emails", "signing", 32));
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encKey, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split(":");
    if (version !== "v1" || !ivB64 || !tagB64 || dataB64 === undefined) {
      throw new Error("Unbekanntes Format für verschlüsselte Daten");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encKey, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  }

  sign(value: string): string {
    return crypto.createHmac("sha256", this.macKey).update(value).digest("base64url").slice(0, 32);
  }

  /** Token der Form "<wert>.<signatur>"; der Wert darf keinen Punkt enthalten. */
  createToken(value: string): string {
    return `${value}.${this.sign(value)}`;
  }

  verifyToken(token: string): string | null {
    const idx = token.lastIndexOf(".");
    if (idx <= 0) return null;
    const value = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = this.sign(value);
    if (sig.length !== expected.length) return null;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? value : null;
  }
}

/** Verwendet APP_SECRET oder erzeugt beim ersten Start ein Geheimnis im Datenordner. */
export function loadOrCreateAppSecret(dataDir: string, explicit: string | null): string {
  if (explicit) return explicit;
  const file = path.join(dataDir, "app-secret.key");
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8").trim();
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomId(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
