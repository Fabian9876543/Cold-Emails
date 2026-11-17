import type { DB } from "../db/client";
import type { AiPriceDto, ModelLine } from "../../shared/types";

export interface AppSettings {
  companyName: string;
  companyAddress: string;
  /** Pflichtangaben, z. B. "Geschäftsführer: … · Amtsgericht … HRB …" */
  companyLegal: string;
  privacyUrl: string;
  timezone: string;
  /** Satz, der angehängt wird, wenn eine Vorlage keinen Abmeldehinweis enthält (Modus "text"). */
  optOutText: string;
  /** Satz mit {{abmelden_link}} für den Modus "link". */
  optOutLinkText: string;
  globalVariables: Record<string, string>;
  legalNoticeAccepted: boolean;
  anthropicKeyEnc: string | null;
  claudeModel: string | null;
  aiPrices: Record<ModelLine, AiPriceDto>;
  googleClientId: string | null;
  googleClientSecretEnc: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  companyName: "",
  companyAddress: "",
  companyLegal: "",
  privacyUrl: "",
  timezone: "Europe/Berlin",
  optOutText: "Kein Interesse? Eine kurze Antwort genügt, dann melde ich mich nicht mehr.",
  optOutLinkText: "Keine weiteren E-Mails erhalten: {{abmelden_link}}",
  globalVariables: {},
  legalNoticeAccepted: false,
  anthropicKeyEnc: null,
  claudeModel: null,
  // US-Dollar pro 1 Mio. Tokens (Eingabe/Ausgabe), Stand der Anthropic-Preisliste; in den Einstellungen änderbar.
  aiPrices: {
    opus: { input: 4, output: 20 },
    sonnet: { input: 2, output: 10 },
    haiku: { input: 0.1, output: 0.5 },
    fable: { input: 8, output: 40 },
    mythos: { input: 8, output: 40 },
  },
  googleClientId: null,
  googleClientSecretEnc: null,
};

export function getSettings(db: DB): AppSettings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      // defekter Eintrag wird ignoriert
    }
  }
  const merged = { ...DEFAULT_SETTINGS, ...stored } as AppSettings;
  merged.aiPrices = { ...DEFAULT_SETTINGS.aiPrices, ...((stored.aiPrices as AppSettings["aiPrices"]) ?? {}) };
  return merged;
}

export function updateSettings(db: DB, patch: Partial<AppSettings>): AppSettings {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      stmt.run(k, JSON.stringify(v));
    }
  })();
  return getSettings(db);
}
