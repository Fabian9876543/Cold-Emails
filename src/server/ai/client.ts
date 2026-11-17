import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config";
import type { DB } from "../db/client";
import type { SecretBox } from "../lib/crypto";
import { getSettings } from "../lib/settings";
import type { AiModelDto, ModelLine } from "../../shared/types";

/**
 * Zugang zu Claude. Der API-Schlüssel kommt aus ANTHROPIC_API_KEY oder (verschlüsselt) aus den Einstellungen.
 * Das Modell wird nicht fest im Code hinterlegt: ohne Vorgabe wird automatisch das neueste
 * aktive Opus-Modell aus der Models API verwendet – neue Modelle stehen so ohne Update bereit.
 */
export interface AiGateway {
  client(): Anthropic | null;
  keySource(): "env" | "settings" | null;
  /** Gewähltes Modell (Einstellung, CLAUDE_MODEL oder automatisch) – wirft, wenn keins ermittelt werden kann. */
  resolveModel(): Promise<string>;
  modelSource(): "env" | "settings" | "auto" | null;
  listModels(): Promise<AiModelDto[]>;
  /** Modellfamilie (opus/sonnet/haiku …) für Preise und Fähigkeiten. */
  lineOf(modelId: string): Promise<ModelLine | null>;
  /** Nach Änderung von Schlüssel oder Modell aufrufen. */
  invalidate(): void;
}

const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

export function createAiGateway(deps: { config: AppConfig; db: DB; secrets: SecretBox }): AiGateway {
  let cachedClient: { key: string; client: Anthropic } | null = null;
  let modelCache: { at: number; models: AiModelDto[] } | null = null;

  const currentKey = (): { key: string; source: "env" | "settings" } | null => {
    if (deps.config.anthropicApiKey) return { key: deps.config.anthropicApiKey, source: "env" };
    const enc = getSettings(deps.db).anthropicKeyEnc;
    if (!enc) return null;
    try {
      return { key: deps.secrets.decrypt(enc), source: "settings" };
    } catch {
      return null;
    }
  };

  const gateway: AiGateway = {
    client() {
      const k = currentKey();
      if (!k) return null;
      if (!cachedClient || cachedClient.key !== k.key) {
        cachedClient = { key: k.key, client: new Anthropic({ apiKey: k.key, maxRetries: 3, timeout: 120_000 }) };
      }
      return cachedClient.client;
    },
    keySource() {
      return currentKey()?.source ?? null;
    },
    modelSource() {
      if (deps.config.claudeModel) return "env";
      if (getSettings(deps.db).claudeModel) return "settings";
      return currentKey() ? "auto" : null;
    },
    async listModels() {
      const client = gateway.client();
      if (!client) return [];
      if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
      const models: AiModelDto[] = [];
      for await (const m of client.models.list({ limit: 100 })) {
        if (m.lifecycle && m.lifecycle !== "active") continue;
        if (m.capabilities?.structured_outputs && !m.capabilities.structured_outputs.supported) continue;
        if (m.capabilities?.effort && !m.capabilities.effort.supported) continue;
        models.push({ id: m.id, displayName: m.display_name, line: (m.line as ModelLine | null) ?? null, createdAt: m.created_at });
      }
      models.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      modelCache = { at: Date.now(), models };
      return models;
    },
    async resolveModel() {
      if (deps.config.claudeModel) return deps.config.claudeModel;
      const chosen = getSettings(deps.db).claudeModel;
      if (chosen) return chosen;
      const models = await gateway.listModels();
      const opus = models.find((m) => m.line === "opus");
      const pick = opus ?? models[0];
      if (!pick) throw new Error("Es konnte kein Claude-Modell ermittelt werden. Bitte in den Einstellungen ein Modell wählen.");
      return pick.id;
    },
    async lineOf(modelId) {
      const known = (modelCache?.models ?? []).find((m) => m.id === modelId);
      if (known?.line) return known.line;
      const lines: ModelLine[] = ["opus", "sonnet", "haiku", "fable", "mythos"];
      return lines.find((l) => modelId.toLowerCase().includes(l)) ?? null;
    },
    invalidate() {
      cachedClient = null;
      modelCache = null;
    },
  };
  return gateway;
}
