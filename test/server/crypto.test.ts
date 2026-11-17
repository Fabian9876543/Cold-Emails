import { describe, expect, it } from "vitest";
import { SecretBox, safeEqual } from "../../src/server/lib/crypto";

describe("SecretBox", () => {
  const box = new SecretBox("ein-langes-test-geheimnis-1234567890");

  it("verschlüsselt und entschlüsselt", () => {
    const enc = box.encrypt("abcd efgh ijkl mnop");
    expect(enc).not.toContain("abcd");
    expect(box.decrypt(enc)).toBe("abcd efgh ijkl mnop");
  });

  it("erzeugt bei jedem Aufruf einen anderen Geheimtext", () => {
    expect(box.encrypt("x")).not.toBe(box.encrypt("x"));
  });

  it("erkennt manipulierte Daten", () => {
    const enc = box.encrypt("geheim");
    const parts = enc.split(":");
    parts[3] = Buffer.from("manipuliert").toString("base64url");
    expect(() => box.decrypt(parts.join(":"))).toThrow();
  });

  it("prüft signierte Tokens", () => {
    const token = box.createToken("c42");
    expect(box.verifyToken(token)).toBe("c42");
    expect(box.verifyToken(token.replace("c42", "c43"))).toBeNull();
    expect(box.verifyToken("c42.falsch")).toBeNull();
    expect(new SecretBox("anderes-geheimnis-0987654321").verifyToken(token)).toBeNull();
  });

  it("vergleicht Passwörter zeitkonstant", () => {
    expect(safeEqual("passwort", "passwort")).toBe(true);
    expect(safeEqual("passwort", "Passwort")).toBe(false);
  });
});
