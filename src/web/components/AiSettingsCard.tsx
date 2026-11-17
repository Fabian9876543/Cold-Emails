import { useState } from "react";
import { Alert, Anchor, Badge, Button, Card, Group, NumberInput, PasswordInput, Select, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconSparkles, IconPlugConnected, IconInfoCircle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { fmtNumber, fmtUsd } from "../format";
import type { AiModelDto, AiUsageDto, ModelLine, SettingsDto } from "../../shared/types";

const LINE_LABEL: Record<ModelLine, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable", mythos: "Mythos" };

export function AiSettingsCard() {
  const settings = useApi<SettingsDto>("/api/settings");
  const configured = settings.data?.ai.keyConfigured ?? false;
  const models = useApi<AiModelDto[]>(configured ? "/api/ai/models" : null, { staleTime: 10 * 60_000, retry: false });
  const usage = useApi<{ current: AiUsageDto; previous: AiUsageDto }>("/api/ai/usage");
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  if (!settings.data) return null;
  const ai = settings.data.ai;

  const save = async (patch: Record<string, unknown>, message: string) => {
    setBusy("save");
    try {
      const data = await api.put<SettingsDto>("/api/settings", patch);
      queryClient.setQueryData(["/api/settings"], data);
      await queryClient.invalidateQueries({ queryKey: ["/api/ai/models"] });
      notifySuccess(message);
      setKey("");
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await api.post<{ ok: boolean; model: string }>("/api/ai/test");
      notifySuccess(`Verbindung in Ordnung (Modell: ${r.model}).`, "Claude erreichbar");
    } catch (err) {
      notifyError(err, "Verbindung fehlgeschlagen");
    } finally {
      setBusy(null);
    }
  };

  const modelOptions = [
    { value: "", label: "Automatisch – neuestes Opus-Modell (empfohlen)" },
    ...(models.data ?? []).map((m) => ({ value: m.id, label: `${m.displayName}${m.line ? ` (${LINE_LABEL[m.line]})` : ""}` })),
  ];
  if (ai.model && !modelOptions.some((o) => o.value === ai.model)) modelOptions.push({ value: ai.model, label: ai.model });

  return (
    <Card>
      <Group gap="xs" mb={4}>
        <IconSparkles size={20} color="var(--mantine-color-violet-6)" />
        <Title order={4}>KI mit Claude</Title>
        {configured ? <Badge color="teal" variant="light">eingerichtet</Badge> : <Badge color="gray" variant="light">nicht eingerichtet</Badge>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Für persönliche Einstiege je Kontakt, die Schreibhilfe und das automatische Einordnen von Antworten. Benötigt einen API-Schlüssel von{" "}
        <Anchor href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          console.anthropic.com
        </Anchor>
        . Abgerechnet wird direkt bei Anthropic nach Nutzung.
      </Text>
      <Stack>
        {ai.keySource === "env" ? (
          <Alert variant="light" icon={<IconInfoCircle size={18} />}>
            Der Schlüssel kommt aus der Datei .env (ANTHROPIC_API_KEY).
          </Alert>
        ) : (
          <Group align="flex-end">
            <PasswordInput
              label="API-Schlüssel"
              placeholder={configured ? "•••••••• (hinterlegt – zum Ändern neu eingeben)" : "sk-ant-…"}
              value={key}
              onChange={(e) => setKey(e.currentTarget.value)}
              style={{ flex: 1 }}
              maw={480}
            />
            <Button onClick={() => save({ anthropicApiKey: key }, "API-Schlüssel gespeichert (verschlüsselt).")} disabled={!key.trim()} loading={busy === "save"}>
              Speichern
            </Button>
            {configured && (
              <Button variant="subtle" color="red" onClick={() => save({ anthropicApiKey: null }, "API-Schlüssel entfernt.")}>
                Entfernen
              </Button>
            )}
          </Group>
        )}
        {configured && (
          <Group align="flex-end">
            <Select
              label="Modell"
              description={ai.modelSource === "env" ? "Festgelegt über CLAUDE_MODEL in der .env." : "Größere Modelle schreiben besser, kleinere sind günstiger."}
              data={modelOptions}
              value={ai.modelSource === "settings" ? ai.model ?? "" : ""}
              onChange={(v) => save({ claudeModel: v || null }, "Modell gespeichert.")}
              disabled={ai.modelSource === "env"}
              w={420}
              error={models.error ? (models.error as Error).message : undefined}
            />
            <Button variant="light" leftSection={<IconPlugConnected size={16} />} onClick={test} loading={busy === "test"}>
              Verbindung testen
            </Button>
          </Group>
        )}
        <div>
          <Text size="sm" fw={500} mb={4}>
            Preise für die Kostenschätzung (US-Dollar je 1 Mio. Tokens: Eingabe / Ausgabe)
          </Text>
          <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
            {(["opus", "sonnet", "haiku"] as ModelLine[]).map((line) => (
              <Group key={line} gap={4} wrap="nowrap" align="flex-end">
                <NumberInput
                  label={LINE_LABEL[line]}
                  size="xs"
                  decimalScale={2}
                  min={0}
                  value={ai.prices[line].input}
                  onBlur={(e) => {
                    const v = Number(e.currentTarget.value.replace(",", "."));
                    if (!Number.isNaN(v) && v !== ai.prices[line].input) void save({ aiPrices: { [line]: { ...ai.prices[line], input: v } } }, "Preis gespeichert.");
                  }}
                  w={90}
                />
                <NumberInput
                  size="xs"
                  decimalScale={2}
                  min={0}
                  value={ai.prices[line].output}
                  onBlur={(e) => {
                    const v = Number(e.currentTarget.value.replace(",", "."));
                    if (!Number.isNaN(v) && v !== ai.prices[line].output) void save({ aiPrices: { [line]: { ...ai.prices[line], output: v } } }, "Preis gespeichert.");
                  }}
                  w={90}
                />
              </Group>
            ))}
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt={4}>
            Voreinstellung laut Anthropic-Preisliste; maßgeblich ist Ihre Abrechnung in der Anthropic-Konsole.
          </Text>
        </div>
        {usage.data && (
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {[usage.data.current, usage.data.previous].map((u) => (
              <Card key={u.month} withBorder padding="sm">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  {u.month}
                </Text>
                <Text fw={700}>ca. {fmtUsd(u.costUsd)}</Text>
                <Text size="xs" c="dimmed">
                  {fmtNumber(u.requests)} Anfragen · {fmtNumber(u.inputTokens)} / {fmtNumber(u.outputTokens)} Tokens
                </Text>
              </Card>
            ))}
          </SimpleGrid>
        )}
      </Stack>
    </Card>
  );
}
