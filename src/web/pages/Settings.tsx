import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Card,
  Code,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { IconPlus, IconTrash, IconInfoCircle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { ErrorAlert, Loading, PageHeader } from "../components/common";
import { AiSettingsCard } from "../components/AiSettingsCard";
import { GoogleOAuthCard } from "../components/GoogleOAuthCard";
import type { SettingsDto } from "../../shared/types";

const COMMON_ZONES = ["Europe/Berlin", "Europe/Vienna", "Europe/Zurich", "Europe/London", "Europe/Paris", "UTC", "America/New_York"];

function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const zones = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  return Array.from(new Set([...COMMON_ZONES, ...zones]));
}

export function SettingsPage() {
  const settings = useApi<SettingsDto>("/api/settings");
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ companyName: "", companyAddress: "", companyLegal: "", privacyUrl: "", timezone: "Europe/Berlin", optOutText: "" });
  const [vars, setVars] = useState<{ key: string; value: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const zones = useMemo(allZones, []);

  useEffect(() => {
    if (!settings.data) return;
    const s = settings.data;
    setForm({ companyName: s.companyName, companyAddress: s.companyAddress, companyLegal: s.companyLegal, privacyUrl: s.privacyUrl, timezone: s.timezone, optOutText: s.optOutText });
    setVars(Object.entries(s.globalVariables).map(([key, value]) => ({ key, value })));
  }, [settings.data]);

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorAlert error={settings.error} />;

  const save = async () => {
    setSaving(true);
    try {
      const globalVariables: Record<string, string> = {};
      for (const v of vars) if (v.key.trim()) globalVariables[v.key.trim()] = v.value;
      const data = await api.put<SettingsDto>("/api/settings", { ...form, globalVariables });
      queryClient.setQueryData(["/api/settings"], data);
      notifySuccess("Einstellungen gespeichert.");
    } catch (err) {
      notifyError(err);
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }));

  return (
    <Stack maw={980}>
      <PageHeader title="Einstellungen" description="Firmendaten für die Signatur, Versand-Grundlagen, eigene Platzhalter und KI." />

      <Card>
        <Title order={4} mb={4}>
          Firma & Impressum
        </Title>
        <Text size="sm" c="dimmed" mb="md">
          Geschäftliche E-Mails brauchen Pflichtangaben (z. B. Rechtsform, Sitz, Registergericht, Geschäftsführung). Diese Angaben werden in die Signaturvorlage der Postfächer übernommen.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Firmenname" placeholder="Muster GmbH" value={form.companyName} onChange={set("companyName")} />
          <TextInput label="Link zur Datenschutzerklärung" placeholder="https://www.firma.de/datenschutz" value={form.privacyUrl} onChange={set("privacyUrl")} />
          <Textarea label="Anschrift" placeholder={"Musterstraße 1\n12345 Musterstadt"} autosize minRows={2} value={form.companyAddress} onChange={set("companyAddress")} />
          <Textarea label="Pflichtangaben" placeholder="Geschäftsführer: Max Mustermann · Amtsgericht Musterstadt HRB 12345" autosize minRows={2} value={form.companyLegal} onChange={set("companyLegal")} />
        </SimpleGrid>
      </Card>

      <Card>
        <Title order={4} mb="md">
          Versand
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label="Zeitzone der Plattform" description="Gilt für Tageslimits und Statistiken." data={zones} searchable value={form.timezone} onChange={(v) => v && setForm((f) => ({ ...f, timezone: v }))} />
          <Textarea
            label="Abmeldehinweis"
            description="Wird an jede Mail angehängt, wenn die Vorlage keinen eigenen Hinweis enthält."
            autosize
            minRows={2}
            value={form.optOutText}
            onChange={set("optOutText")}
          />
        </SimpleGrid>
        <Alert mt="md" variant="light" icon={<IconInfoCircle size={18} />}>
          Öffentliche Adresse für Abmelde-Links:{" "}
          {settings.data?.publicBaseUrl ? <Code>{settings.data.publicBaseUrl}</Code> : <Text span fw={600}>nicht gesetzt</Text>}. Ohne öffentliche Adresse
          melden sich Empfänger per Antwort oder über die Abmelde-Schaltfläche von Gmail ab (beides wird automatisch erkannt). Einstellbar über <Code>PUBLIC_BASE_URL</Code> in der Datei <Code>.env</Code>.
        </Alert>
      </Card>

      <Card>
        <Group justify="space-between" mb={4}>
          <Title order={4}>Eigene Platzhalter</Title>
          <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={() => setVars((v) => [...v, { key: "", value: "" }])}>
            Platzhalter hinzufügen
          </Button>
        </Group>
        <Text size="sm" c="dimmed" mb="md">
          Werte, die in allen Kampagnen gleich sind – z. B. <Code>{"{{kalender_link}}"}</Code> für Ihren Terminbuchungs-Link.
        </Text>
        <Stack gap="xs">
          {vars.length === 0 && (
            <Text size="sm" c="dimmed">
              Noch keine eigenen Platzhalter.
            </Text>
          )}
          {vars.map((v, i) => (
            <Group key={i} align="flex-end" wrap="nowrap">
              <TextInput
                label={i === 0 ? "Name" : undefined}
                placeholder="kalender_link"
                value={v.key}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setVars((all) => all.map((x, j) => (j === i ? { ...x, key: value } : x)));
                }}
                w={220}
              />
              <TextInput
                label={i === 0 ? "Wert" : undefined}
                placeholder="https://calendly.com/…"
                value={v.value}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setVars((all) => all.map((x, j) => (j === i ? { ...x, value } : x)));
                }}
                style={{ flex: 1 }}
              />
              <ActionIcon variant="subtle" color="red" size="lg" onClick={() => setVars((all) => all.filter((_, j) => j !== i))} aria-label="Platzhalter entfernen">
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
        </Stack>
      </Card>

      <Group justify="flex-end">
        <Button onClick={save} loading={saving}>
          Einstellungen speichern
        </Button>
      </Group>

      <AiSettingsCard />
      <GoogleOAuthCard />

      <Text size="xs" c="dimmed">
        Hinweise zur Einrichtung stehen in der{" "}
        <Anchor href="https://github.com/Fabian9876543/Cold-Emails#readme" target="_blank" rel="noreferrer">
          Anleitung (README)
        </Anchor>
        .
      </Text>
    </Stack>
  );
}
