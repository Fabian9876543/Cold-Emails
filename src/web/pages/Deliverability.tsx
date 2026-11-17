import { useState } from "react";
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy, IconAlertTriangle, IconX, IconRefresh, IconShieldCheck, IconMail } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, notifyError, useApi } from "../api";
import { EmptyState, ErrorAlert, Loading, PageHeader } from "../components/common";
import { fmtDateTime } from "../format";
import type { CheckItem, CheckStatus, DomainDto } from "../../shared/types";

const STATUS: Record<CheckStatus, { color: string; label: string; icon: React.ReactNode }> = {
  ok: { color: "teal", label: "In Ordnung", icon: <IconCheck size={16} /> },
  warn: { color: "yellow", label: "Verbesserungswürdig", icon: <IconAlertTriangle size={16} /> },
  error: { color: "red", label: "Fehlt / fehlerhaft", icon: <IconX size={16} /> },
};

export function DeliverabilityPage() {
  const domains = useApi<DomainDto[]>("/api/domains");
  const navigate = useNavigate();

  return (
    <Stack>
      <PageHeader
        title="Zustellbarkeit"
        description="Damit Ihre Mails im Posteingang statt im Spam landen, müssen SPF, DKIM und DMARC für jede Absender-Domain stimmen. Gmail und Yahoo lehnen Mails ohne diese Einträge inzwischen ab."
      />
      {domains.isLoading && <Loading />}
      {domains.error && <ErrorAlert error={domains.error} />}
      {domains.data?.length === 0 && (
        <EmptyState
          icon={<IconShieldCheck size={28} />}
          title="Noch keine Absender-Domain"
          text="Sobald ein Postfach verbunden ist, prüft die Plattform hier automatisch die DNS-Einträge der Domain."
          action={
            <Button leftSection={<IconMail size={16} />} onClick={() => navigate("/postfaecher")}>
              Postfach verbinden
            </Button>
          }
        />
      )}
      {domains.data?.map((d) => <DomainCard key={d.domain} domain={d} />)}
      <BestPractices />
    </Stack>
  );
}

function DomainCard({ domain: d }: { domain: DomainDto }) {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [selector, setSelector] = useState(d.dkimSelector);

  const recheck = async (newSelector?: string) => {
    setChecking(true);
    try {
      const updated = newSelector
        ? await api.patch<DomainDto>(`/api/domains/${encodeURIComponent(d.domain)}`, { dkimSelector: newSelector })
        : await api.post<DomainDto>(`/api/domains/${encodeURIComponent(d.domain)}/check`);
      queryClient.setQueryData<DomainDto[]>(["/api/domains"], (old) => old?.map((x) => (x.domain === updated.domain ? updated : x)));
      await queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
    } catch (err) {
      notifyError(err);
    } finally {
      setChecking(false);
    }
  };

  const overall = d.result?.overall;
  return (
    <Card>
      <Group justify="space-between" mb="md" wrap="wrap">
        <div>
          <Group gap="xs">
            <Title order={4}>{d.domain}</Title>
            {overall ? (
              <Badge color={STATUS[overall].color} variant="light">
                {overall === "ok" ? "Alles eingerichtet" : overall === "warn" ? "Fast fertig" : "Handlungsbedarf"}
              </Badge>
            ) : (
              <Badge color="gray" variant="light">
                Noch nicht geprüft
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            Postfächer: {d.mailboxes.join(", ")} · Zuletzt geprüft: {fmtDateTime(d.checkedAt)}
          </Text>
        </div>
        <Button variant="light" leftSection={<IconRefresh size={16} />} loading={checking} onClick={() => recheck()}>
          Jetzt prüfen
        </Button>
      </Group>
      {!d.result && (
        <Text size="sm" c="dimmed">
          Klicken Sie auf „Jetzt prüfen“. DNS-Änderungen können bis zu einige Stunden brauchen, bis sie sichtbar sind.
        </Text>
      )}
      {d.result && (
        <Stack gap="sm">
          {[d.result.spf, d.result.dkim, d.result.dmarc, d.result.mx].map((item) => (
            <CheckRow key={item.title} item={item} domain={d.domain} />
          ))}
          <Group align="flex-end" gap="xs">
            <TextInput size="xs" label="DKIM-Selector" description="Bei Google Workspace: google" value={selector} onChange={(e) => setSelector(e.currentTarget.value)} w={200} />
            <Button size="xs" variant="default" disabled={selector === d.dkimSelector || !selector} onClick={() => recheck(selector)}>
              Übernehmen
            </Button>
          </Group>
        </Stack>
      )}
    </Card>
  );
}

function CheckRow({ item, domain }: { item: CheckItem; domain: string }) {
  const s = STATUS[item.status];
  return (
    <Paper withBorder p="sm">
      <Group align="flex-start" wrap="nowrap" gap="sm">
        <ThemeIcon color={s.color} variant="light" radius="xl">
          {s.icon}
        </ThemeIcon>
        <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs">
            <Text fw={600}>{item.title}</Text>
            <Badge size="xs" color={s.color} variant="light">
              {s.label}
            </Badge>
          </Group>
          <Text size="sm">{item.detail}</Text>
          {item.found && item.found.length > 0 && (
            <Stack gap={2}>
              {item.found.map((f) => (
                <Code key={f} className="mono-block" block>
                  {f}
                </Code>
              ))}
            </Stack>
          )}
          {item.fix && item.status !== "ok" && (
            <Stack gap={6}>
              {item.fix.value && (
                <div className="table-scroll">
                  <Table withTableBorder withColumnBorders fz="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Typ</Table.Th>
                        <Table.Th>Name / Host</Table.Th>
                        <Table.Th>Wert</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      <Table.Tr>
                        <Table.Td>{item.fix.type}</Table.Td>
                        <Table.Td>
                          <Code>{item.fix.host === "@" ? `@ (${domain})` : item.fix.host}</Code>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4} wrap="nowrap">
                            <Code className="mono-block">{item.fix.value}</Code>
                            <CopyButton value={item.fix.value}>
                              {({ copied, copy }) => (
                                <Tooltip label={copied ? "Kopiert" : "Kopieren"}>
                                  <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} onClick={copy} aria-label="Wert kopieren">
                                    {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                                  </ActionIcon>
                                </Tooltip>
                              )}
                            </CopyButton>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    </Table.Tbody>
                  </Table>
                </div>
              )}
              {item.fix.steps && (
                <List size="sm" type="ordered" spacing={2}>
                  {item.fix.steps.map((step) => (
                    <List.Item key={step}>{step}</List.Item>
                  ))}
                </List>
              )}
            </Stack>
          )}
        </Stack>
      </Group>
    </Paper>
  );
}

function BestPractices() {
  const tips = [
    ["Eigene Zweit-Domain", "Verschicken Sie Cold-Emails von einer separaten Domain (z. B. ihre-firma-mail.de). So bleibt der Ruf Ihrer Hauptdomain geschützt."],
    ["Kleine Mengen, mehr Postfächer", "20–40 Mails pro Postfach und Tag. Für mehr Volumen weitere Postfächer verbinden statt das Limit zu erhöhen."],
    ["Langsam hochfahren", "Neue Postfächer starten mit wenigen Mails pro Tag. Die Plattform steigert die Menge automatisch."],
    ["Reiner Text, wenige Links", "Persönlich formulierte Text-Mails ohne Bilder, Tracking und Link-Kürzer landen am zuverlässigsten im Posteingang."],
    ["Echte Personalisierung", "Jede Mail sollte erkennbar für genau diesen Empfänger geschrieben sein – die KI-Einstiege helfen dabei."],
    ["Saubere Listen", "Ungültige Adressen erzeugen Bounces und schaden dem Ruf. Die Plattform prüft Adressen beim Import und stoppt bei vielen Bounces."],
    ["Abmeldung respektieren", "Jede Mail enthält einen Abmeldehinweis; Abmeldungen landen sofort auf der Sperrliste."],
  ];
  return (
    <Card>
      <Title order={4} mb="sm">
        So bleiben Ihre Mails aus dem Spam-Ordner
      </Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        {tips.map(([title, text]) => (
          <Paper key={title} withBorder p="sm">
            <Text fw={600} size="sm">
              {title}
            </Text>
            <Text size="sm" c="dimmed">
              {text}
            </Text>
          </Paper>
        ))}
      </SimpleGrid>
      <Text size="sm" mt="md">
        Ruf Ihrer Domain bei Gmail beobachten:{" "}
        <Anchor href="https://postmaster.google.com" target="_blank" rel="noreferrer">
          Google Postmaster Tools
        </Anchor>
        . Spam-Score einer Testmail prüfen:{" "}
        <Anchor href="https://www.mail-tester.com" target="_blank" rel="noreferrer">
          mail-tester.com
        </Anchor>
        .
      </Text>
    </Card>
  );
}
