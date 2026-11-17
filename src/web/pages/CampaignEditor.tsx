import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Grid,
  Group,
  List,
  Menu,
  MultiSelect,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Switch,
  Tabs,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  IconPlus,
  IconTrash,
  IconTemplate,
  IconAlertTriangle,
  IconCircleCheck,
  IconSend,
  IconRocket,
  IconInfoCircle,
  IconDeviceFloppy,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { ErrorAlert, Loading, PageHeader, StatCard } from "../components/common";
import { EmailPreview, SpamCheckPanel, VariableMenu, useInsertAtCursor } from "../components/editor";
import { AiImproveMenu, AiOpenersStep, AiWriterButton } from "../components/ai";
import { WEEKDAYS } from "../texte";
import { SEQUENCE_TEMPLATES } from "../../shared/sequences";
import { usesPlaceholder } from "../../shared/template";
import type { CampaignDto, CampaignStepDto, Formality, LeadListDto, MailboxDto, OptOutMode, PreflightDto, SettingsDto } from "../../shared/types";

export interface Draft {
  name: string;
  formality: Formality;
  steps: CampaignStepDto[];
  mailboxIds: number[];
  sendDays: number[];
  windowStart: string;
  windowEnd: string;
  timezone: string;
  stopOnReplyAll: boolean;
  skipRecentDays: number;
  optOutMode: OptOutMode;
  aiEnabled: boolean;
  aiContext: string;
  aiUseWebsite: boolean;
  aiAutoApprove: boolean;
}

const TIMES = Array.from({ length: 31 }, (_, i) => {
  const minutes = 6 * 60 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

function draftFromCampaign(c: CampaignDto): Draft {
  return {
    name: c.name,
    formality: c.formality,
    steps: c.steps,
    mailboxIds: c.mailboxIds,
    sendDays: c.sendDays,
    windowStart: c.windowStart,
    windowEnd: c.windowEnd,
    timezone: c.timezone,
    stopOnReplyAll: c.stopOnReplyAll,
    skipRecentDays: c.skipRecentDays,
    optOutMode: c.optOutMode,
    aiEnabled: c.aiEnabled,
    aiContext: c.aiContext,
    aiUseWebsite: c.aiUseWebsite,
    aiAutoApprove: c.aiAutoApprove,
  };
}

const STEP_LABELS = ["Grundlagen", "E-Mails", "KI-Personalisierung", "Versand", "Prüfen & Starten"];

export function CampaignEditorPage() {
  const { id } = useParams();
  const campaignId = id ? Number(id) : null;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = Math.min(4, Math.max(0, Number(params.get("schritt") ?? 0)));
  const setActive = (n: number) => setParams((p) => ({ ...Object.fromEntries(p), schritt: String(n) }), { replace: true });

  const campaign = useApi<CampaignDto>(campaignId ? `/api/campaigns/${campaignId}` : null);
  const lists = useApi<LeadListDto[]>("/api/lead-lists");
  const mailboxes = useApi<MailboxDto[]>("/api/mailboxes");
  const settings = useApi<SettingsDto>("/api/settings");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [listIds, setListIds] = useState<string[]>(() => (params.get("listId") ? [params.get("listId")!] : []));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (campaignId && campaign.data && (!draft || !dirty)) setDraft(draftFromCampaign(campaign.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.data, campaignId]);

  useEffect(() => {
    if (!campaignId && !draft && mailboxes.data && settings.data) {
      setDraft({
        name: "",
        formality: "sie",
        steps: SEQUENCE_TEMPLATES[0]!.steps.sie,
        mailboxIds: mailboxes.data.filter((m) => m.status === "active").map((m) => m.id),
        sendDays: [1, 2, 3, 4, 5],
        windowStart: "08:00",
        windowEnd: "17:00",
        timezone: settings.data.timezone,
        stopOnReplyAll: true,
        skipRecentDays: 90,
        optOutMode: "text",
        aiEnabled: settings.data.ai.keyConfigured,
        aiContext: "",
        aiUseWebsite: true,
        aiAutoApprove: false,
      });
    }
  }, [campaignId, draft, mailboxes.data, settings.data]);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  /** Speichert (bzw. legt beim ersten Mal an) und liefert die Kampagnen-ID. */
  const save = async (): Promise<number | null> => {
    if (!draft) return null;
    if (!draft.name.trim()) {
      notifyError(new Error("Bitte der Kampagne einen Namen geben."));
      setActive(0);
      return null;
    }
    setSaving(true);
    try {
      let saved: CampaignDto;
      if (!campaignId) {
        saved = await api.post<CampaignDto>("/api/campaigns", { ...draft, listIds: listIds.map(Number) });
      } else {
        saved = await api.put<CampaignDto>(`/api/campaigns/${campaignId}`, draft);
      }
      queryClient.setQueryData([`/api/campaigns/${saved.id}`], saved);
      await queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(`/api/campaigns/${saved.id}/`) });
      setDirty(false);
      return saved.id;
    } catch (err) {
      notifyError(err, "Speichern fehlgeschlagen");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const goTo = async (n: number) => {
    const savedId = await save();
    if (savedId === null) return;
    if (!campaignId) navigate(`/kampagnen/${savedId}/bearbeiten?schritt=${n}`, { replace: true });
    else setActive(n);
  };

  if (campaign.error) return <ErrorAlert error={campaign.error} />;
  if (!draft || (campaignId && campaign.isLoading)) return <Loading />;

  const isRunning = campaign.data?.status === "active" || campaign.data?.status === "paused";

  return (
    <Stack>
      <PageHeader
        title={campaignId ? `Kampagne: ${draft.name || "ohne Namen"}` : "Neue Kampagne"}
        description="In fünf Schritten zur Kampagne. Ihre Eingaben werden bei jedem Schritt gespeichert."
        actions={
          campaignId ? (
            <>
              <Button variant="default" onClick={() => navigate(`/kampagnen/${campaignId}`)}>
                Zur Übersicht
              </Button>
              <Button leftSection={<IconDeviceFloppy size={16} />} loading={saving} onClick={() => save().then((x) => x && notifySuccess("Gespeichert."))}>
                Speichern
              </Button>
            </>
          ) : null
        }
      />
      <Stepper active={active} onStepClick={(n) => (campaignId || n === 0 ? goTo(n) : undefined)} size="sm" allowNextStepsSelect={!!campaignId}>
        {STEP_LABELS.map((label, i) => (
          <Stepper.Step key={label} label={label} description={i === 0 ? "Name & Kontakte" : undefined} />
        ))}
      </Stepper>

      {active === 0 && (
        <BasicsStep draft={draft} update={update} lists={lists.data ?? []} listIds={listIds} setListIds={setListIds} campaign={campaign.data ?? null} />
      )}
      {active === 1 && <SequenceStep draft={draft} update={update} campaignId={campaignId} />}
      {active === 2 && <AiOpenersStep draft={draft} update={update} campaign={campaign.data ?? null} onSave={save} />}
      {active === 3 && <SendingStep draft={draft} update={update} mailboxes={mailboxes.data ?? []} />}
      {active === 4 && campaignId && <ReviewStep campaignId={campaignId} isRunning={isRunning} onSave={save} dirty={dirty} />}

      <Group justify="space-between">
        <Button variant="default" disabled={active === 0} onClick={() => goTo(active - 1)}>
          Zurück
        </Button>
        {active < 4 && (
          <Button onClick={() => goTo(active + 1)} loading={saving}>
            Weiter: {STEP_LABELS[active + 1]}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function BasicsStep(props: {
  draft: Draft;
  update: (p: Partial<Draft>) => void;
  lists: LeadListDto[];
  listIds: string[];
  setListIds: (v: string[]) => void;
  campaign: CampaignDto | null;
}) {
  const { draft, update, campaign } = props;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const listOptions = props.lists.map((l) => ({ value: String(l.id), label: `${l.name} (${l.leadCount.toLocaleString("de-DE")} Kontakte)` }));

  const addLists = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      const r = await api.post<{ added: number; skipped: number }>(`/api/campaigns/${campaign.id}/leads`, { listIds: adding.map(Number) });
      notifySuccess(`${r.added} Kontakte hinzugefügt${r.skipped ? `, ${r.skipped} übersprungen (bereits enthalten, gesperrt oder inaktiv)` : ""}.`);
      setAdding([]);
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(`/api/campaigns/${campaign.id}`) });
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Stack>
        <TextInput label="Name der Kampagne" description="Nur für Sie sichtbar." placeholder="z. B. Logistik Hessen – Frühjahr" value={draft.name} onChange={(e) => update({ name: e.currentTarget.value })} required maw={520} />
        <div>
          <Text size="sm" fw={500} mb={4}>
            Ansprache
          </Text>
          <SegmentedControl value={draft.formality} onChange={(v) => update({ formality: v as Formality })} data={[{ value: "sie", label: "Sie (förmlich)" }, { value: "du", label: "Du (locker)" }]} />
          <Text size="xs" c="dimmed" mt={4}>
            Bestimmt die Begrüßung {"{{begruessung}}"} und den Ton der KI-Texte.
          </Text>
        </div>
        {!campaign && (
          <>
            {props.lists.length === 0 ? (
              <Alert icon={<IconInfoCircle size={18} />} variant="light">
                Noch keine Kontakte vorhanden.{" "}
                <Text span c="blue" style={{ cursor: "pointer" }} onClick={() => navigate("/kontakte")}>
                  Jetzt Kontakte importieren
                </Text>{" "}
                – Sie können sie auch später hinzufügen.
              </Alert>
            ) : (
              <MultiSelect label="Kontakte" description="Welche Listen sollen angeschrieben werden?" data={listOptions} value={props.listIds} onChange={props.setListIds} searchable clearable maw={620} />
            )}
          </>
        )}
        {campaign && (
          <Paper withBorder p="md">
            <Text size="sm" fw={500}>
              Kontakte in dieser Kampagne: {campaign.stats.leads.toLocaleString("de-DE")}
            </Text>
            <Group align="flex-end" mt="xs">
              <MultiSelect placeholder="Weitere Listen hinzufügen" data={listOptions} value={adding} onChange={setAdding} searchable style={{ flex: 1 }} maw={520} />
              <Button variant="light" onClick={addLists} loading={busy} disabled={adding.length === 0}>
                Hinzufügen
              </Button>
            </Group>
            <Text size="xs" c="dimmed" mt={4}>
              Gesperrte, abgemeldete und unzustellbare Kontakte werden automatisch ausgelassen.
            </Text>
          </Paper>
        )}
      </Stack>
    </Card>
  );
}

function SequenceStep({ draft, update, campaignId }: { draft: Draft; update: (p: Partial<Draft>) => void; campaignId: number | null }) {
  const [tab, setTab] = useState<string | null>("1");
  const position = Number(tab ?? 1);
  const step = draft.steps.find((s) => s.position === position) ?? draft.steps[0]!;

  const setStep = (patch: Partial<CampaignStepDto>) => update({ steps: draft.steps.map((s) => (s.position === step.position ? { ...s, ...patch } : s)) });
  const addStep = () => {
    const next = draft.steps.length + 1;
    update({
      steps: [
        ...draft.steps,
        {
          position: next,
          waitDays: next === 2 ? 3 : 5,
          subject: "",
          body: draft.formality === "du" ? "{{begruessung}},\n\n\n\nViele Grüße" : "{{begruessung}},\n\n\n\nViele Grüße",
        },
      ],
    });
    setTab(String(next));
  };
  const removeStep = (pos: number) => {
    update({ steps: draft.steps.filter((s) => s.position !== pos).map((s, i) => ({ ...s, position: i + 1 })) });
    setTab("1");
  };
  const applyTemplate = (templateId: string) => {
    const t = SEQUENCE_TEMPLATES.find((x) => x.id === templateId);
    if (!t) return;
    modals.openConfirmModal({
      title: `Vorlage „${t.name}“ übernehmen?`,
      children: <Text size="sm">Die bisherigen E-Mails dieser Kampagne werden ersetzt.</Text>,
      labels: { confirm: "Übernehmen", cancel: "Abbrechen" },
      onConfirm: () => {
        update({ steps: t.steps[draft.formality] });
        setTab("1");
      },
    });
  };

  const subjectInsert = useInsertAtCursor(step.subject, (v) => setStep({ subject: v }));
  const bodyInsert = useInsertAtCursor(step.body, (v) => setStep({ body: v }));
  const usesAi = draft.steps.some((s) => usesPlaceholder(s.body, "ki_einstieg"));

  return (
    <Stack>
      <Group justify="space-between">
        <Tabs value={tab} onChange={setTab} variant="pills">
          <Tabs.List>
            {draft.steps.map((s) => (
              <Tabs.Tab key={s.position} value={String(s.position)}>
                {s.position === 1 ? "Erste E-Mail" : `Nachfass ${s.position - 1} (+${s.waitDays} T.)`}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
        <Group gap="xs">
          {draft.steps.length < 5 && (
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={addStep}>
              Nachfass-E-Mail
            </Button>
          )}
          <Menu position="bottom-end">
            <Menu.Target>
              <Button size="xs" variant="default" leftSection={<IconTemplate size={14} />}>
                Vorlage
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {SEQUENCE_TEMPLATES.map((t) => (
                <Menu.Item key={t.id} onClick={() => applyTemplate(t.id)}>
                  <Text size="sm" fw={500}>
                    {t.name}
                  </Text>
                  <Text size="xs" c="dimmed" maw={280}>
                    {t.description}
                  </Text>
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <AiWriterButton draft={draft} onApply={(steps) => update({ steps })} />
        </Group>
      </Group>

      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card>
            <Stack>
              {step.position > 1 && (
                <Group align="flex-end" justify="space-between">
                  <NumberInput label="Wartezeit nach der vorherigen E-Mail" suffix=" Tage" min={1} max={60} value={step.waitDays} onChange={(v) => setStep({ waitDays: Number(v) || 1 })} w={260} />
                  <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => removeStep(step.position)}>
                    Diese E-Mail entfernen
                  </Button>
                </Group>
              )}
              <TextInput
                ref={subjectInsert.ref as React.Ref<HTMLInputElement>}
                label="Betreff"
                description={step.position > 1 ? "Leer lassen = Antwort im selben E-Mail-Verlauf („Re: …“) – empfohlen." : "Kurz und neutral wirkt am persönlichsten."}
                placeholder={step.position > 1 ? "(Antwort im selben Verlauf)" : "Frage zu {{firma}}"}
                value={step.subject}
                onChange={(e) => setStep({ subject: e.currentTarget.value })}
              />
              <Group justify="space-between" align="flex-end">
                <Text size="sm" fw={500}>
                  Text
                </Text>
                <Group gap="xs">
                  <AiImproveMenu subject={step.subject} body={step.body} position={step.position} formality={draft.formality} onApply={(subject, body) => setStep({ subject, body })} />
                  <VariableMenu onInsert={bodyInsert.insert} aiEnabled={draft.aiEnabled} />
                </Group>
              </Group>
              <Textarea
                ref={bodyInsert.ref as React.Ref<HTMLTextAreaElement>}
                autosize
                minRows={10}
                value={step.body}
                onChange={(e) => setStep({ body: e.currentTarget.value })}
                styles={{ input: { fontSize: 14, lineHeight: 1.55 } }}
              />
              <Text size="xs" c="dimmed">
                Signatur und Abmeldehinweis werden automatisch angehängt. Platzhalter mit Ersatztext: {"{{vorname|zusammen}}"}. Lückentexte in [eckigen Klammern] bitte ersetzen.
              </Text>
              {usesAi && !draft.aiEnabled && (
                <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                  Die Vorlage nutzt {"{{ki_einstieg}}"}. Aktivieren Sie im nächsten Schritt die KI-Personalisierung – sonst wird der Ersatztext verwendet.
                </Alert>
              )}
            </Stack>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack>
            <EmailPreview campaignId={campaignId} steps={draft.steps} position={step.position} optOutMode={draft.optOutMode} formality={draft.formality} />
            <SpamCheckPanel subject={step.position > 1 && !step.subject ? draft.steps[0]?.subject ?? "" : step.subject} body={step.body} isFirstStep={step.position === 1} />
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function SendingStep({ draft, update, mailboxes }: { draft: Draft; update: (p: Partial<Draft>) => void; mailboxes: MailboxDto[] }) {
  const navigate = useNavigate();
  const zones = useMemo(() => {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    return Array.from(new Set([draft.timezone, "Europe/Berlin", "Europe/Vienna", "Europe/Zurich", ...(intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [])]));
  }, [draft.timezone]);
  const capacity = mailboxes.filter((m) => draft.mailboxIds.includes(m.id) && m.status === "active").reduce((s, m) => s + m.dailyLimit, 0);

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }}>
      <Card>
        <Title order={5} mb="xs">
          Absender-Postfächer
        </Title>
        <Text size="sm" c="dimmed" mb="sm">
          Die Mails werden gleichmäßig auf die gewählten Postfächer verteilt. Nachfass-Mails kommen immer vom selben Postfach wie die erste Mail.
        </Text>
        {mailboxes.length === 0 ? (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
            Noch kein Postfach verbunden.{" "}
            <Text span c="blue" style={{ cursor: "pointer" }} onClick={() => navigate("/postfaecher")}>
              Postfach verbinden
            </Text>
          </Alert>
        ) : (
          <Checkbox.Group value={draft.mailboxIds.map(String)} onChange={(v) => update({ mailboxIds: v.map(Number) })}>
            <Stack gap="xs">
              {mailboxes.map((m) => (
                <Checkbox
                  key={m.id}
                  value={String(m.id)}
                  label={m.email}
                  description={`${m.fromName} · bis zu ${m.dailyLimit} Mails/Tag${m.status !== "active" ? ` · ${m.status === "error" ? "Fehler" : "pausiert"}` : ""}`}
                />
              ))}
            </Stack>
          </Checkbox.Group>
        )}
        <Text size="sm" mt="sm">
          Kapazität: bis zu <b>{capacity}</b> Mails pro Versandtag.
        </Text>
      </Card>
      <Card>
        <Title order={5} mb="xs">
          Zeitplan
        </Title>
        <Stack>
          <div>
            <Text size="sm" fw={500} mb={6}>
              Versandtage
            </Text>
            <Chip.Group multiple value={draft.sendDays.map(String)} onChange={(v) => update({ sendDays: v.map(Number).sort() })}>
              <Group gap={6}>
                {WEEKDAYS.map((d) => (
                  <Chip key={d.value} value={d.value} size="sm">
                    {d.label}
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          </div>
          <Group grow>
            <Select label="Von" data={TIMES} value={draft.windowStart} onChange={(v) => v && update({ windowStart: v })} />
            <Select label="Bis" data={TIMES} value={draft.windowEnd} onChange={(v) => v && update({ windowEnd: v })} error={draft.windowEnd <= draft.windowStart ? "Ende vor Start" : undefined} />
          </Group>
          <Select label="Zeitzone der Empfänger" data={zones} searchable value={draft.timezone} onChange={(v) => v && update({ timezone: v })} />
          <Text size="xs" c="dimmed">
            Empfehlung: werktags während der Geschäftszeiten. Die Mails werden mit natürlichen, zufälligen Abständen über das Zeitfenster verteilt.
          </Text>
        </Stack>
      </Card>
      <Card>
        <Title order={5} mb="xs">
          Abmeldung
        </Title>
        <SegmentedControl
          fullWidth
          value={draft.optOutMode}
          onChange={(v) => update({ optOutMode: v as OptOutMode })}
          data={[
            { value: "text", label: "Satz anhängen" },
            { value: "link", label: "Abmelde-Link" },
            { value: "none", label: "Eigener Hinweis" },
          ]}
        />
        <Text size="xs" c="dimmed" mt="xs">
          {draft.optOutMode === "text" && "Unter jede Mail kommt ein kurzer Satz wie „Kein Interesse? Eine kurze Antwort genügt …“ – wirkt persönlich. Antworten werden automatisch erkannt."}
          {draft.optOutMode === "link" && "Unter jede Mail kommt ein Abmelde-Link (benötigt eine öffentliche Adresse der Plattform, sonst ein E-Mail-Link)."}
          {draft.optOutMode === "none" && "Sie formulieren den Abmeldehinweis selbst in der Vorlage (z. B. mit {{abmelden_link}}). Jede Mail muss einen enthalten."}
        </Text>
        <Text size="xs" c="dimmed" mt={4}>
          Zusätzlich enthält jede Mail einen unsichtbaren Abmelde-Kopf, damit Gmail & Co. einen „Abbestellen“-Knopf anzeigen.
        </Text>
      </Card>
      <Card>
        <Title order={5} mb="xs">
          Schutzregeln
        </Title>
        <Stack>
          <Switch
            checked={draft.stopOnReplyAll}
            onChange={(e) => update({ stopOnReplyAll: e.currentTarget.checked })}
            label="Bei einer Antwort alle Kampagnen für diesen Kontakt stoppen"
            description="Die Sequenz der beantworteten Kampagne stoppt immer."
          />
          <NumberInput
            label="Kontakte überspringen, die angeschrieben wurden in den letzten"
            suffix=" Tagen"
            min={0}
            max={365}
            value={draft.skipRecentDays}
            onChange={(v) => update({ skipRecentDays: Number(v) || 0 })}
            maw={360}
          />
        </Stack>
      </Card>
    </SimpleGrid>
  );
}

function ReviewStep({ campaignId, isRunning, onSave, dirty }: { campaignId: number; isRunning: boolean; onSave: () => Promise<number | null>; dirty: boolean }) {
  const [ignoreDns, setIgnoreDns] = useState(false);
  const preflight = useApi<PreflightDto>(`/api/campaigns/${campaignId}/preflight${ignoreDns ? "?ignoreDns=1" : ""}`);
  const campaign = useApi<CampaignDto>(`/api/campaigns/${campaignId}`);
  const [testStep, setTestStep] = useState<string | null>("1");
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onlyDnsBlocking = !!preflight.data && preflight.data.blocking.length > 0 && preflight.data.blocking.every((b) => b.code === "dns");

  useEffect(() => {
    if (dirty) void onSave().then(() => preflight.refetch());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendTest = async () => {
    setBusy("test");
    try {
      const r = await api.post<{ to: string; missing: string[] }>(`/api/campaigns/${campaignId}/test-email`, { position: Number(testStep ?? 1) });
      notifySuccess(`Testmail an ${r.to} verschickt.${r.missing.length ? ` Hinweis: Für den Beispielkontakt fehlt ${r.missing.join(", ")}.` : ""}`);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setBusy("start");
    try {
      const r = await api.post<{ ok: boolean; preflight: PreflightDto }>(`/api/campaigns/${campaignId}/${campaign.data?.status === "paused" ? "resume" : "start"}`, { ignoreDns });
      if (!r.ok) {
        queryClient.setQueryData([`/api/campaigns/${campaignId}/preflight${ignoreDns ? "?ignoreDns=1" : ""}`], r.preflight);
        notifyError(new Error("Bitte zuerst die rot markierten Punkte beheben."));
        return;
      }
      notifySuccess("Die Kampagne läuft. Die ersten Mails gehen im nächsten Versandfenster raus.", "Kampagne gestartet");
      await queryClient.invalidateQueries();
      navigate(`/kampagnen/${campaignId}`);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };

  if (preflight.isLoading || !preflight.data) return <Loading />;
  const p = preflight.data;
  return (
    <Stack>
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <StatCard label="Kontakte" value={p.estimate.leads.toLocaleString("de-DE")} />
        <StatCard label="E-Mails insgesamt" value={p.estimate.emailsTotal.toLocaleString("de-DE")} />
        <StatCard label="Pro Versandtag" value={`bis ${p.estimate.perDay}`} hint="über alle Postfächer" />
        <StatCard label="Dauer" value={`ca. ${p.estimate.days} Tage`} hint="inkl. Wartezeiten" />
      </SimpleGrid>

      {p.blocking.length > 0 && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Bitte vor dem Start beheben">
          <List size="sm" spacing={4}>
            {p.blocking.map((b) => (
              <List.Item key={b.code + b.message}>{b.message}</List.Item>
            ))}
          </List>
          {onlyDnsBlocking && (
            <Checkbox mt="sm" checked={ignoreDns} onChange={(e) => setIgnoreDns(e.currentTarget.checked)} label="Ich kenne das Risiko und möchte trotzdem starten (nicht empfohlen)" />
          )}
        </Alert>
      )}
      {p.warnings.length > 0 && (
        <Alert color="yellow" icon={<IconInfoCircle size={18} />} title="Hinweise">
          <List size="sm" spacing={4}>
            {p.warnings.map((w) => (
              <List.Item key={w.code + w.message}>{w.message}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {p.blocking.length === 0 && (
        <Alert color="teal" icon={<IconCircleCheck size={18} />}>
          Alles bereit. Tipp: Schicken Sie sich vorher eine Testmail und prüfen Sie sie in Gmail.
        </Alert>
      )}

      <Card>
        <Group justify="space-between" wrap="wrap">
          <Group align="flex-end">
            <Select
              label="Testmail an mich"
              data={(campaign.data?.steps ?? []).map((s) => ({ value: String(s.position), label: s.position === 1 ? "Erste E-Mail" : `Nachfass ${s.position - 1}` }))}
              value={testStep}
              onChange={setTestStep}
              w={200}
            />
            <Button variant="default" leftSection={<IconSend size={16} />} loading={busy === "test"} onClick={sendTest}>
              Testmail senden
            </Button>
          </Group>
          {isRunning && campaign.data?.status === "active" ? (
            <Badge color="teal" size="lg" variant="light">
              Kampagne läuft – Änderungen gelten für alle folgenden Mails
            </Badge>
          ) : (
            <Tooltip label={p.ok || (onlyDnsBlocking && ignoreDns) ? "" : "Erst die rot markierten Punkte beheben"} disabled={p.ok || (onlyDnsBlocking && ignoreDns)}>
              <Button size="md" leftSection={<IconRocket size={18} />} loading={busy === "start"} disabled={!(p.ok || (onlyDnsBlocking && ignoreDns))} onClick={start}>
                {campaign.data?.status === "paused" ? "Kampagne fortsetzen" : "Kampagne starten"}
              </Button>
            </Tooltip>
          )}
        </Group>
      </Card>
      <Group gap={6}>
        <ThemeIcon size="sm" variant="light" radius="xl">
          <IconInfoCircle size={12} />
        </ThemeIcon>
        <Text size="xs" c="dimmed">
          Laufende Kampagnen können Sie jederzeit pausieren. Antworten stoppen die Sequenz des jeweiligen Kontakts automatisch.
        </Text>
        <ActionIcon variant="transparent" size="xs" aria-hidden />
      </Group>
    </Stack>
  );
}
