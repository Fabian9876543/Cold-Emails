import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  List,
  Menu,
  Modal,
  NumberInput,
  PasswordInput,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  ActionIcon,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  IconMail,
  IconPlus,
  IconDots,
  IconPlugConnected,
  IconSend,
  IconEdit,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
  IconAlertTriangle,
  IconBrandGoogle,
  IconRefresh,
  IconInfoCircle,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { EmptyState, ErrorAlert, Loading, PageHeader, StatusBadge } from "../components/common";
import { MAILBOX_STATUS } from "../texte";
import { fmtDateTime, fmtRelative } from "../format";
import type { MailboxDto, SettingsDto, Security } from "../../shared/types";

type Mode = "google_app_password" | "google_oauth" | "smtp";

interface FormState {
  mode: Mode;
  email: string;
  fromName: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: Security;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  username: string;
  dailyLimit: number;
  warmupEnabled: boolean;
  warmupStart: number;
  warmupStep: number;
  signature: string;
  imapEnabled: boolean;
}

const EMPTY: FormState = {
  mode: "google_app_password",
  email: "",
  fromName: "",
  password: "",
  smtpHost: "",
  smtpPort: 465,
  smtpSecurity: "ssl",
  imapHost: "",
  imapPort: 993,
  imapSecurity: "ssl",
  username: "",
  dailyLimit: 30,
  warmupEnabled: true,
  warmupStart: 5,
  warmupStep: 2,
  signature: "",
  imapEnabled: true,
};

const SECURITY_OPTIONS = [
  { value: "ssl", label: "SSL/TLS" },
  { value: "starttls", label: "STARTTLS" },
  { value: "none", label: "Keine (nur lokal/Test)" },
];

export function buildSignature(fromName: string, s: SettingsDto | undefined): string {
  if (!s) return fromName;
  const lines = [fromName, s.companyName, s.companyAddress.split("\n").map((l) => l.trim()).filter(Boolean).join(" · "), s.companyLegal];
  if (s.privacyUrl) lines.push(`Datenschutz: ${s.privacyUrl}`);
  return lines.filter((l) => l && l.trim()).join("\n");
}

export function MailboxesPage() {
  const mailboxes = useApi<MailboxDto[]>("/api/mailboxes", { refetchInterval: 30_000 });
  const settings = useApi<SettingsDto>("/api/settings");
  const [editing, setEditing] = useState<MailboxDto | "new" | null>(null);

  return (
    <Stack>
      <PageHeader
        title="Postfächer"
        description="Die Plattform verschickt über Ihre eigenen Google-Workspace-Postfächer. Antworten landen wie gewohnt in Gmail."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing("new")}>
            Postfach verbinden
          </Button>
        }
      />
      {mailboxes.isLoading && <Loading />}
      {mailboxes.error && <ErrorAlert error={mailboxes.error} />}
      {mailboxes.data && mailboxes.data.length === 0 && (
        <EmptyState
          icon={<IconMail size={28} />}
          title="Noch kein Postfach verbunden"
          text="Verbinden Sie ein oder mehrere Google-Workspace-Postfächer. Tipp: Nutzen Sie für Cold-Emails eine eigene Zweit-Domain (z. B. ihre-firma-mail.de), damit Ihre Hauptdomain geschützt bleibt."
          action={
            <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing("new")}>
              Erstes Postfach verbinden
            </Button>
          }
        />
      )}
      {mailboxes.data && mailboxes.data.length > 0 && (
        <>
          <Alert variant="light" icon={<IconInfoCircle size={18} />}>
            Faustregel: 20–40 Cold-Emails pro Postfach und Tag. Für mehr Volumen weitere Postfächer verbinden – die Plattform verteilt die Mails automatisch.
          </Alert>
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {mailboxes.data.map((m) => (
              <MailboxCard key={m.id} mailbox={m} onEdit={() => setEditing(m)} />
            ))}
          </SimpleGrid>
        </>
      )}
      <MailboxModal editing={editing} settings={settings.data} onClose={() => setEditing(null)} />
    </Stack>
  );
}

function MailboxCard({ mailbox: m, onEdit }: { mailbox: MailboxDto; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/mailboxes"] });
  const usage = m.effectiveLimit > 0 ? Math.min(100, (m.sentToday / m.effectiveLimit) * 100) : 0;
  const warming = m.warmupEnabled && m.effectiveLimit < m.dailyLimit;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };

  const test = () =>
    run("test", async () => {
      const r = await api.post<{ smtp: { ok: boolean; error?: string }; imap: { ok: boolean; error?: string; skipped?: boolean } }>(`/api/mailboxes/${m.id}/test`);
      if (r.smtp.ok && r.imap.ok) notifySuccess(r.imap.skipped ? "Versand (SMTP) funktioniert." : "Versand (SMTP) und Posteingang (IMAP) funktionieren.", "Verbindung in Ordnung");
      else notifyError(new Error([r.smtp.error, r.imap.error].filter(Boolean).join(" ")), "Verbindung fehlgeschlagen");
      await refresh();
    });

  const testMail = () =>
    run("mail", async () => {
      const r = await api.post<{ to: string }>(`/api/mailboxes/${m.id}/test-email`, {});
      notifySuccess(`Testmail an ${r.to} verschickt. Bitte im Posteingang prüfen.`);
    });

  const toggle = () =>
    run("toggle", async () => {
      await api.patch(`/api/mailboxes/${m.id}`, { status: m.status === "paused" ? "active" : "paused" });
      await refresh();
    });

  const remove = () =>
    modals.openConfirmModal({
      title: "Postfach entfernen?",
      children: <Text size="sm">Das Postfach {m.email} wird aus allen Kampagnen entfernt. Bereits verschickte Mails bleiben in der Statistik.</Text>,
      labels: { confirm: "Entfernen", cancel: "Abbrechen" },
      confirmProps: { color: "red" },
      onConfirm: () =>
        run("delete", async () => {
          await api.del(`/api/mailboxes/${m.id}`);
          await refresh();
          await queryClient.invalidateQueries({ queryKey: ["/api/domains"] });
        }),
    });

  return (
    <Card>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon variant="light" size="lg" radius="xl">
            {m.authType === "smtp" ? <IconMail size={18} /> : <IconBrandGoogle size={18} />}
          </ThemeIcon>
          <div style={{ minWidth: 0 }}>
            <Text fw={600} truncate>
              {m.email}
            </Text>
            <Text size="sm" c="dimmed" truncate>
              {m.fromName} · {m.authType === "google_oauth" ? "Google (verbunden)" : m.authType === "google_app_password" ? "Google (App-Passwort)" : `${m.smtpHost}`}
            </Text>
          </div>
        </Group>
        <Group gap={6} wrap="nowrap">
          <StatusBadge map={MAILBOX_STATUS} value={m.status} />
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label="Aktionen">
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconPlugConnected size={16} />} onClick={test}>
                Verbindung testen
              </Menu.Item>
              <Menu.Item leftSection={<IconSend size={16} />} onClick={testMail}>
                Testmail an mich
              </Menu.Item>
              <Menu.Item leftSection={<IconEdit size={16} />} onClick={onEdit}>
                Bearbeiten
              </Menu.Item>
              <Menu.Item leftSection={m.status === "paused" ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />} onClick={toggle}>
                {m.status === "paused" ? "Fortsetzen" : "Pausieren"}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={remove}>
                Entfernen
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      <Stack gap={4} mt="md">
        <Group justify="space-between">
          <Text size="sm">Heute verschickt</Text>
          <Text size="sm" fw={600}>
            {m.sentToday} / {m.effectiveLimit}
          </Text>
        </Group>
        <Progress value={usage} color={usage >= 100 ? "gray" : "blue"} />
        <Text size="xs" c="dimmed">
          {warming
            ? `Hochfahren aktiv: heute bis zu ${m.effectiveLimit} Mails, täglich +${m.warmupStep} bis zum Ziel von ${m.dailyLimit}.`
            : `Tageslimit: ${m.dailyLimit} Mails.`}
          {m.pausedUntil && m.pausedUntil > Date.now() ? ` Pausiert bis ${fmtDateTime(m.pausedUntil)}.` : ""}
        </Text>
      </Stack>

      {m.lastError && m.status === "error" && (
        <Alert mt="md" color="red" icon={<IconAlertTriangle size={18} />} title="Versand gestoppt">
          <Text size="sm">{m.lastError}</Text>
          <Group mt="xs" gap="xs">
            <Button size="xs" variant="light" color="red" onClick={test} loading={busy === "test"}>
              Erneut prüfen
            </Button>
            <Button size="xs" variant="subtle" color="red" onClick={onEdit}>
              Zugangsdaten ändern
            </Button>
          </Group>
        </Alert>
      )}
      {m.imapError && (
        <Alert mt="md" color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Posteingang nicht erreichbar">
          <Text size="sm">{m.imapError} Antworten und Bounces werden erst wieder erkannt, wenn das behoben ist.</Text>
        </Alert>
      )}

      <Divider my="sm" />
      <Group justify="space-between" gap="xs">
        <Text size="xs" c="dimmed">
          {m.imapEnabled ? `Posteingang geprüft: ${fmtRelative(m.imapLastPollAt)}` : "Posteingang wird nicht geprüft"}
        </Text>
        <Group gap={6}>
          <Button size="compact-xs" variant="subtle" leftSection={<IconPlugConnected size={14} />} onClick={test} loading={busy === "test"}>
            Testen
          </Button>
          <Button size="compact-xs" variant="subtle" leftSection={<IconSend size={14} />} onClick={testMail} loading={busy === "mail"}>
            Testmail
          </Button>
          {busy === "toggle" || busy === "delete" ? <Badge variant="light">…</Badge> : null}
        </Group>
      </Group>
    </Card>
  );
}

function MailboxModal({ editing, settings, onClose }: { editing: MailboxDto | "new" | null; settings: SettingsDto | undefined; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isNew = editing === "new";
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oauthReady = settings?.googleOAuthConfigured ?? false;

  useEffect(() => {
    setError(null);
    if (editing === "new") setForm({ ...EMPTY });
    else if (editing) {
      setForm({
        mode: editing.authType,
        email: editing.email,
        fromName: editing.fromName,
        password: "",
        smtpHost: editing.smtpHost,
        smtpPort: editing.smtpPort,
        smtpSecurity: editing.smtpSecurity,
        imapHost: editing.imapHost,
        imapPort: editing.imapPort,
        imapSecurity: editing.imapSecurity,
        username: editing.username,
        dailyLimit: editing.dailyLimit,
        warmupEnabled: editing.warmupEnabled,
        warmupStart: editing.warmupStart,
        warmupStep: editing.warmupStep,
        signature: editing.signature,
        imapEnabled: editing.imapEnabled,
      });
    }
  }, [editing]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const limits = {
    dailyLimit: form.dailyLimit,
    warmupEnabled: form.warmupEnabled,
    warmupStart: form.warmupStart,
    warmupStep: form.warmupStep,
    signature: form.signature,
    imapEnabled: form.imapEnabled,
  };
  const server = {
    smtpHost: form.smtpHost,
    smtpPort: form.smtpPort,
    smtpSecurity: form.smtpSecurity,
    imapHost: form.imapHost,
    imapPort: form.imapPort,
    imapSecurity: form.imapSecurity,
    username: form.username || form.email,
  };

  const save = async (skipVerify = false) => {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        if (form.mode === "google_oauth") {
          window.location.href = `/api/oauth/google/start?${new URLSearchParams({ fromName: form.fromName, email: form.email, dailyLimit: String(form.dailyLimit), warmup: form.warmupEnabled ? "1" : "0", signature: form.signature }).toString()}`;
          return;
        }
        const body =
          form.mode === "google_app_password"
            ? { authType: form.mode, email: form.email, fromName: form.fromName, password: form.password, skipVerify, ...limits }
            : { authType: form.mode, email: form.email, fromName: form.fromName, password: form.password, skipVerify, ...server, ...limits };
        await api.post("/api/mailboxes", body);
        notifySuccess(`${form.email} ist verbunden.`, "Postfach verbunden");
      } else if (editing) {
        const body: Record<string, unknown> = { fromName: form.fromName, skipVerify, ...limits };
        if (form.password) body.password = form.password;
        if (editing.authType === "smtp") Object.assign(body, server);
        await api.patch(`/api/mailboxes/${editing.id}`, body);
        notifySuccess("Änderungen gespeichert.");
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/mailboxes"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/domains"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={editing !== null} onClose={onClose} title={isNew ? "Postfach verbinden" : `Postfach bearbeiten: ${typeof editing === "object" && editing ? editing.email : ""}`} size="lg">
      <Stack>
        {isNew && (
          <SegmentedControl
            fullWidth
            value={form.mode}
            onChange={(v) => set("mode", v as Mode)}
            data={[
              { value: "google_app_password", label: "Google (App-Passwort)" },
              { value: "google_oauth", label: "Mit Google verbinden", disabled: !oauthReady },
              { value: "smtp", label: "Anderer Anbieter" },
            ]}
          />
        )}
        {isNew && form.mode === "google_app_password" && (
          <Alert variant="light" icon={<IconBrandGoogle size={18} />} title="So erstellen Sie ein App-Passwort (ca. 2 Minuten)">
            <List size="sm" type="ordered" spacing={4}>
              <List.Item>
                Mit dem Postfach bei Google anmelden und die{" "}
                <Anchor href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer">
                  Bestätigung in zwei Schritten
                </Anchor>{" "}
                aktivieren.
              </List.Item>
              <List.Item>
                <Anchor href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
                  App-Passwort erstellen
                </Anchor>{" "}
                (Name z. B. „Cold-Emails“) und das 16-stellige Passwort kopieren.
              </List.Item>
              <List.Item>Unten einfügen – die Plattform prüft die Verbindung sofort.</List.Item>
            </List>
            <Text size="xs" c="dimmed" mt="xs">
              Workspace-Admins: App-Passwörter (Bestätigung in zwei Schritten) und IMAP-Zugriff müssen in der Admin-Konsole erlaubt sein.
            </Text>
          </Alert>
        )}
        {isNew && form.mode === "google_oauth" && (
          <Alert variant="light" icon={<IconBrandGoogle size={18} />}>
            Sie werden zu Google weitergeleitet und melden sich dort mit dem Postfach an. Danach ist es sofort verbunden – ganz ohne Passwort.
          </Alert>
        )}
        {isNew && !oauthReady && (
          <Text size="xs" c="dimmed">
            „Mit Google verbinden“ wird verfügbar, sobald in den Einstellungen eine Google-OAuth-App hinterlegt ist.
          </Text>
        )}

        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="Absendername"
            description="So erscheinen Sie beim Empfänger."
            placeholder="Max Mustermann"
            value={form.fromName}
            onChange={(e) => set("fromName", e.currentTarget.value)}
            required
          />
          <TextInput
            label="E-Mail-Adresse"
            placeholder="max@ihre-firma-mail.de"
            value={form.email}
            onChange={(e) => set("email", e.currentTarget.value)}
            disabled={!isNew}
            required={form.mode !== "google_oauth"}
            description={form.mode === "google_oauth" ? "Optional – wird von Google übernommen." : undefined}
          />
        </SimpleGrid>

        {form.mode !== "google_oauth" && (
          <PasswordInput
            label={form.mode === "google_app_password" ? "App-Passwort" : "Passwort"}
            placeholder={isNew ? (form.mode === "google_app_password" ? "abcd efgh ijkl mnop" : "") : "Leer lassen = unverändert"}
            value={form.password}
            onChange={(e) => set("password", e.currentTarget.value)}
            required={isNew}
          />
        )}

        {form.mode === "smtp" && (
          <Card withBorder padding="sm">
            <Text size="sm" fw={600} mb="xs">
              Server
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput label="SMTP-Server" placeholder="smtp.ionos.de" value={form.smtpHost} onChange={(e) => set("smtpHost", e.currentTarget.value)} />
              <NumberInput label="SMTP-Port" value={form.smtpPort} onChange={(v) => set("smtpPort", Number(v) || 465)} />
              <Select label="Verschlüsselung" data={SECURITY_OPTIONS} value={form.smtpSecurity} onChange={(v) => v && set("smtpSecurity", v as Security)} />
              <TextInput label="IMAP-Server" placeholder="imap.ionos.de" value={form.imapHost} onChange={(e) => set("imapHost", e.currentTarget.value)} />
              <NumberInput label="IMAP-Port" value={form.imapPort} onChange={(v) => set("imapPort", Number(v) || 993)} />
              <Select label="Verschlüsselung" data={SECURITY_OPTIONS} value={form.imapSecurity} onChange={(v) => v && set("imapSecurity", v as Security)} />
            </SimpleGrid>
            <TextInput mt="sm" label="Benutzername" description="Meist die E-Mail-Adresse." value={form.username} onChange={(e) => set("username", e.currentTarget.value)} />
          </Card>
        )}

        <Divider label="Versandmengen" labelPosition="left" />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput
            label="Tageslimit"
            description="Empfehlung: 20–40"
            min={1}
            max={500}
            value={form.dailyLimit}
            onChange={(v) => set("dailyLimit", Number(v) || 1)}
            error={form.dailyLimit > 50 ? "Über 50 pro Tag steigt das Spam-Risiko deutlich." : undefined}
          />
          <NumberInput label="Start beim Hochfahren" description="Mails am ersten Tag" min={1} value={form.warmupStart} onChange={(v) => set("warmupStart", Number(v) || 1)} disabled={!form.warmupEnabled} />
          <NumberInput label="Steigerung pro Tag" description="zusätzliche Mails je Tag" min={1} value={form.warmupStep} onChange={(v) => set("warmupStep", Number(v) || 1)} disabled={!form.warmupEnabled} />
        </SimpleGrid>
        <Switch
          checked={form.warmupEnabled}
          onChange={(e) => set("warmupEnabled", e.currentTarget.checked)}
          label="Langsam hochfahren (empfohlen für neue Postfächer)"
          description="Neue Postfächer haben noch keinen Ruf. Kleine, steigende Mengen schützen vor dem Spam-Ordner."
        />
        <Switch
          checked={form.imapEnabled}
          onChange={(e) => set("imapEnabled", e.currentTarget.checked)}
          label="Posteingang auf Antworten und Bounces prüfen (IMAP)"
          description="Nötig, damit Sequenzen bei einer Antwort automatisch stoppen."
        />

        <Divider label="Signatur" labelPosition="left" />
        <Textarea
          autosize
          minRows={3}
          value={form.signature}
          onChange={(e) => set("signature", e.currentTarget.value)}
          placeholder={"Max Mustermann\nMuster GmbH · Musterstraße 1 · 12345 Musterstadt"}
          description="Wird unter jede Mail gesetzt (Gmail-Signaturen gelten beim Versand über die Plattform nicht)."
        />
        <Group>
          <Button variant="light" size="xs" leftSection={<IconRefresh size={14} />} onClick={() => set("signature", buildSignature(form.fromName || "Ihr Name", settings))}>
            Aus Firmendaten erzeugen
          </Button>
        </Group>

        {error && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Verbindung fehlgeschlagen">
            <Text size="sm">{error}</Text>
            <Button mt="xs" size="xs" variant="subtle" color="red" onClick={() => save(true)}>
              Trotzdem speichern (ohne Prüfung)
            </Button>
          </Alert>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={() => save(false)} loading={saving} leftSection={form.mode === "google_oauth" && isNew ? <IconBrandGoogle size={16} /> : undefined}>
            {isNew ? (form.mode === "google_oauth" ? "Weiter zu Google" : "Verbinden & prüfen") : "Speichern"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
