import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  List,
  Loader,
  Menu,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { IconSparkles, IconInfoCircle, IconWand, IconAlertTriangle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { AiReviewPanel } from "./aiReview";
import { fmtUsd } from "../format";
import { usesPlaceholder } from "../../shared/template";
import type { CampaignDto, CampaignStepDto, SettingsDto } from "../../shared/types";
import type { Draft } from "../pages/CampaignEditor";

function useAiReady() {
  const settings = useApi<SettingsDto>("/api/settings");
  return settings.data?.ai.keyConfigured ?? false;
}

/** Schreibhilfe: erstellt eine komplette Sequenz aus wenigen Angaben. */
export function AiWriterButton({ draft, onApply }: { draft: Draft; onApply: (steps: CampaignStepDto[]) => void }) {
  const ready = useAiReady();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ offer: "", audience: "", goal: "ein kurzes Gespräch von 15 Minuten", proof: "", tone: "", emails: 3 });
  const [result, setResult] = useState<{ steps: CampaignStepDto[]; hints: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const generate = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post<{ steps: CampaignStepDto[]; hints: string[] }>("/api/ai/write-sequence", { ...form, formality: draft.formality, useAi: draft.aiEnabled });
      setResult(r);
    } catch (err) {
      notifyError(err, "Entwurf fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }));

  return (
    <>
      <Button size="xs" variant="light" color="violet" leftSection={<IconSparkles size={14} />} onClick={() => setOpen(true)}>
        Mit KI schreiben
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title="E-Mails mit KI schreiben" size="xl">
        {!ready ? (
          <Alert icon={<IconInfoCircle size={18} />}>
            Dafür wird ein Claude-API-Schlüssel benötigt.{" "}
            <Anchor onClick={() => navigate("/einstellungen")}>Zu den Einstellungen</Anchor>
          </Alert>
        ) : (
          <Stack>
            <Textarea label="Was bieten Sie an?" placeholder="z. B. Software für die Tourenplanung von Kühltransporten, spart im Schnitt 20 % Fahrten" autosize minRows={2} value={form.offer} onChange={set("offer")} required />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="Wen schreiben Sie an?" placeholder="Geschäftsführer kleiner Logistikunternehmen" value={form.audience} onChange={set("audience")} />
              <TextInput label="Was ist das Ziel?" value={form.goal} onChange={set("goal")} />
              <TextInput label="Belege / Referenzen (optional)" placeholder="z. B. 40 Kunden in Hessen, Referenz: Muster Spedition" value={form.proof} onChange={set("proof")} />
              <TextInput label="Tonalität (optional)" placeholder="locker, direkt, auf Augenhöhe" value={form.tone} onChange={set("tone")} />
            </SimpleGrid>
            <Group align="flex-end">
              <NumberInput label="Anzahl E-Mails" min={1} max={5} value={form.emails} onChange={(v) => setForm((f) => ({ ...f, emails: Number(v) || 1 }))} w={160} />
              <Text size="xs" c="dimmed" maw={420}>
                Ansprache: {draft.formality === "du" ? "Du" : "Sie"} · KI-Einstieg: {draft.aiEnabled ? "ja" : "nein"} (änderbar in den Kampagnen-Schritten)
              </Text>
            </Group>
            <Group justify="flex-end">
              <Button onClick={generate} loading={busy} disabled={!form.offer.trim()} leftSection={<IconSparkles size={16} />}>
                Entwurf erstellen
              </Button>
            </Group>
            {busy && (
              <Group gap="xs">
                <Loader size="xs" />
                <Text size="sm" c="dimmed">
                  Claude schreibt … das dauert meist 10–40 Sekunden.
                </Text>
              </Group>
            )}
            {result && (
              <Stack>
                {result.hints.length > 0 && (
                  <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} title="Bitte noch ergänzen">
                    <List size="sm">
                      {result.hints.map((h) => (
                        <List.Item key={h}>{h}</List.Item>
                      ))}
                    </List>
                  </Alert>
                )}
                {result.steps.map((s) => (
                  <Paper key={s.position} withBorder p="sm">
                    <Text size="xs" c="dimmed">
                      {s.position === 1 ? "Erste E-Mail" : `Nachfass ${s.position - 1} – nach ${s.waitDays} Tagen`}
                    </Text>
                    {s.subject && (
                      <Text size="sm" fw={600}>
                        {s.subject}
                      </Text>
                    )}
                    <div className="mail-preview">{s.body}</div>
                  </Paper>
                ))}
                <Group justify="flex-end">
                  <Button variant="default" onClick={generate} loading={busy}>
                    Neuer Entwurf
                  </Button>
                  <Button
                    onClick={() => {
                      onApply(result.steps);
                      setOpen(false);
                      notifySuccess("Entwurf übernommen – Sie können ihn jetzt anpassen.");
                    }}
                  >
                    Übernehmen (ersetzt die bisherigen E-Mails)
                  </Button>
                </Group>
              </Stack>
            )}
          </Stack>
        )}
      </Modal>
    </>
  );
}

const IMPROVE_ACTIONS = [
  "Kürzer und knackiger, höchstens 90 Wörter",
  "Persönlicher und weniger werblich",
  "Klarere, leicht zu beantwortende Frage am Ende",
  "Lockerer im Ton",
  "Förmlicher im Ton",
  "Rechtschreibung und Stil prüfen, sonst nichts ändern",
];

/** Text einer E-Mail mit KI überarbeiten. */
export function AiImproveMenu(props: { subject: string; body: string; position: number; formality: Draft["formality"]; onApply: (subject: string, body: string) => void }) {
  const ready = useAiReady();
  const [proposal, setProposal] = useState<{ subject: string; body: string; changes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  if (!ready) return null;

  const improve = async (instruction: string) => {
    setBusy(true);
    try {
      const r = await api.post<{ subject: string; body: string; changes: string[] }>("/api/ai/improve", { subject: props.subject, body: props.body, instruction, formality: props.formality, position: props.position });
      setProposal(r);
    } catch (err) {
      notifyError(err, "Überarbeitung fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Menu position="bottom-end" width={320}>
        <Menu.Target>
          <Button size="xs" variant="light" color="violet" leftSection={busy ? <Loader size={12} /> : <IconWand size={14} />} disabled={busy || !props.body.trim()}>
            Verbessern
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {IMPROVE_ACTIONS.map((a) => (
            <Menu.Item key={a} onClick={() => improve(a)}>
              {a}
            </Menu.Item>
          ))}
          <Menu.Divider />
          <div style={{ padding: 8 }}>
            <TextInput
              size="xs"
              placeholder="Eigene Anweisung, Enter zum Senden"
              value={custom}
              onChange={(e) => setCustom(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && custom.trim()) {
                  void improve(custom.trim());
                  setCustom("");
                }
              }}
            />
          </div>
        </Menu.Dropdown>
      </Menu>
      <Modal opened={!!proposal} onClose={() => setProposal(null)} title="Vorschlag der KI" size="lg">
        {proposal && (
          <Stack>
            {proposal.changes.length > 0 && (
              <List size="sm">
                {proposal.changes.map((c) => (
                  <List.Item key={c}>{c}</List.Item>
                ))}
              </List>
            )}
            <Paper withBorder p="sm">
              {proposal.subject && (
                <Text size="sm" fw={600} mb={4}>
                  {proposal.subject}
                </Text>
              )}
              <div className="mail-preview">{proposal.body}</div>
            </Paper>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setProposal(null)}>
                Verwerfen
              </Button>
              <Button
                onClick={() => {
                  props.onApply(proposal.subject, proposal.body);
                  setProposal(null);
                }}
              >
                Übernehmen
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

/** Schritt "KI-Personalisierung" im Kampagnen-Assistenten. */
export function AiOpenersStep({ draft, update, campaign, onSave }: { draft: Draft; update: (p: Partial<Draft>) => void; campaign: CampaignDto | null; onSave: () => Promise<number | null> }) {
  const ready = useAiReady();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const usesOpener = draft.steps.some((s) => usesPlaceholder(s.body, "ki_einstieg"));
  const [mode, setMode] = useState<"now" | "batch">("now");
  const [busy, setBusy] = useState(false);
  const estimate = useApi<{ count: number; usd: number; batchUsd: number; model: string | null }>(campaign && ready && draft.aiEnabled ? `/api/campaigns/${campaign.id}/ai/estimate` : null);
  const live = useApi<CampaignDto>(campaign ? `/api/campaigns/${campaign.id}` : null, { refetchInterval: (q) => ((q.state.data?.stats.aiPending ?? 0) > 0 ? 4000 : false) });
  const stats = live.data?.stats ?? campaign?.stats;

  useEffect(() => {
    if (estimate.data && estimate.data.count > 150) setMode("batch");
  }, [estimate.data]);

  const generate = async () => {
    setBusy(true);
    try {
      const id = await onSave();
      if (!id) return;
      const r = await api.post<{ queued: number }>(`/api/campaigns/${id}/ai/generate`, { scope: "missing", batch: mode === "batch" });
      notifySuccess(mode === "batch" ? `${r.queued} Einstiege als Batch beauftragt – meist innerhalb einer Stunde fertig.` : `${r.queued} Einstiege werden erstellt.`);
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(`/api/campaigns/${id}`) });
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Card>
        <Stack>
          <Group gap="xs">
            <IconSparkles size={20} color="var(--mantine-color-violet-6)" />
            <Title order={5}>Persönlicher Einstieg per KI</Title>
          </Group>
          <Text size="sm" c="dimmed">
            Claude schreibt für jeden Kontakt einen individuellen ersten Satz – auf Basis von Firma, Position, eigenen Spalten und (optional) der Website. Sie prüfen und geben die Sätze frei, bevor
            etwas verschickt wird. In der Vorlage steht dafür der Platzhalter {"{{ki_einstieg}}"}.
          </Text>
          {!ready && (
            <Alert icon={<IconInfoCircle size={18} />} variant="light">
              Für KI-Einstiege wird ein Claude-API-Schlüssel benötigt. <Anchor onClick={() => navigate("/einstellungen")}>Jetzt in den Einstellungen hinterlegen</Anchor>. Ohne KI nutzt die Vorlage den
              Ersatztext.
            </Alert>
          )}
          <Switch checked={draft.aiEnabled} onChange={(e) => update({ aiEnabled: e.currentTarget.checked })} label="KI-Einstiege für diese Kampagne verwenden" disabled={!ready} />
          {draft.aiEnabled && !usesOpener && (
            <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
              Die E-Mails enthalten noch keinen Platzhalter {"{{ki_einstieg}}"}. Fügen Sie ihn im Schritt „E-Mails“ direkt nach der Begrüßung ein.
            </Alert>
          )}
          <Textarea
            label="Worum geht es? (Kontext für die KI)"
            description="Ihr Angebot, die Zielgruppe und worauf der Einstieg eingehen soll – z. B. „Bezug auf Spezialisierung oder Region nehmen“."
            placeholder="Wir bieten Tourenplanungs-Software für Kühltransporte. Zielgruppe: kleine Speditionen. Der Einstieg soll auf ihre Spezialisierung oder Region eingehen."
            autosize
            minRows={3}
            value={draft.aiContext}
            onChange={(e) => update({ aiContext: e.currentTarget.value })}
            disabled={!draft.aiEnabled}
          />
          <Group>
            <Switch checked={draft.aiUseWebsite} onChange={(e) => update({ aiUseWebsite: e.currentTarget.checked })} label="Website des Kontakts lesen (bessere Einstiege)" disabled={!draft.aiEnabled} />
            <Switch checked={draft.aiAutoApprove} onChange={(e) => update({ aiAutoApprove: e.currentTarget.checked })} label="Ohne Prüfung automatisch freigeben" disabled={!draft.aiEnabled} />
          </Group>
        </Stack>
      </Card>

      {draft.aiEnabled && ready && campaign && (
        <Card>
          <Group justify="space-between" align="flex-end" wrap="wrap">
            <Stack gap={4}>
              <Text fw={600}>Einstiege erstellen</Text>
              {estimate.data && (
                <Text size="sm" c="dimmed">
                  {estimate.data.count} Kontakte ohne Einstieg · geschätzte Kosten ca. {fmtUsd(mode === "batch" ? estimate.data.batchUsd : estimate.data.usd)}
                  {estimate.data.model ? ` mit ${estimate.data.model}` : ""}
                </Text>
              )}
            </Stack>
            <Group>
              <SegmentedControl
                value={mode}
                onChange={(v) => setMode(v as "now" | "batch")}
                data={[
                  { value: "now", label: "Sofort" },
                  { value: "batch", label: "Batch (−50 %, bis ~1 Std.)" },
                ]}
              />
              <Button leftSection={<IconSparkles size={16} />} onClick={generate} loading={busy} disabled={!estimate.data?.count}>
                Einstiege erstellen
              </Button>
            </Group>
          </Group>
        </Card>
      )}
      {draft.aiEnabled && campaign && live.data && stats && stats.aiPending + stats.aiDone + stats.aiApproved + stats.aiError > 0 && <AiReviewPanel campaign={live.data} />}
      {draft.aiEnabled && !campaign && (
        <Text size="sm" c="dimmed">
          Die Einstiege können erstellt werden, sobald die Kampagne gespeichert ist (Schritt „Weiter“).
        </Text>
      )}
    </Stack>
  );
}
