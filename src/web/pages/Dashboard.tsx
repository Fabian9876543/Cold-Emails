import { Alert, Anchor, Badge, Button, Card, Group, List, Progress, SimpleGrid, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { BarChart } from "@mantine/charts";
import { IconCheck, IconAlertTriangle, IconCircleDashed, IconArrowRight } from "@tabler/icons-react";
import { useNavigate } from "react-router";
import { useApi } from "../api";
import { ErrorAlert, Loading, PageHeader, StatCard, StatusBadge } from "../components/common";
import { CAMPAIGN_STATUS, MAILBOX_STATUS } from "../texte";
import { fmtPercent } from "../format";
import type { DashboardDto } from "../../shared/types";

const SETUP_STEPS: { key: keyof DashboardDto["setup"]; title: string; text: string; link: string; action: string }[] = [
  { key: "mailbox", title: "Postfach verbinden", text: "Google-Workspace-Postfach per App-Passwort verbinden – am besten auf einer Zweit-Domain.", link: "/postfaecher", action: "Postfach verbinden" },
  { key: "domain", title: "Zustellbarkeit prüfen", text: "SPF, DKIM und DMARC der Absender-Domain einrichten, damit Mails im Posteingang landen.", link: "/zustellbarkeit", action: "DNS prüfen" },
  { key: "leads", title: "Kontakte importieren", text: "CSV- oder Excel-Liste hochladen – Adressen werden automatisch geprüft.", link: "/kontakte", action: "Kontakte importieren" },
  { key: "campaign", title: "Erste Kampagne starten", text: "E-Mails mit Vorlage oder KI schreiben, prüfen und starten.", link: "/kampagnen/neu", action: "Kampagne erstellen" },
];

export function DashboardPage() {
  const dash = useApi<DashboardDto>("/api/dashboard", { refetchInterval: 30_000 });
  const navigate = useNavigate();
  if (dash.isLoading) return <Loading />;
  if (dash.error || !dash.data) return <ErrorAlert error={dash.error ?? "Keine Daten"} />;
  const d = dash.data;
  const setupDone = Object.values(d.setup).every(Boolean);
  const nextStep = SETUP_STEPS.find((s) => !d.setup[s.key]);

  return (
    <Stack>
      <PageHeader title="Start" description="Überblick über Versand, Antworten und den Zustand Ihrer Postfächer." />

      {!setupDone && (
        <Card>
          <Title order={4} mb="sm">
            In vier Schritten startklar
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
            {SETUP_STEPS.map((s, i) => {
              const done = d.setup[s.key];
              const isNext = nextStep?.key === s.key;
              return (
                <Card key={s.key} withBorder padding="md" style={{ borderColor: isNext ? "var(--mantine-color-blue-5)" : undefined }}>
                  <Group gap="xs" mb={6}>
                    <ThemeIcon radius="xl" size="sm" color={done ? "teal" : isNext ? "blue" : "gray"} variant={done ? "filled" : "light"}>
                      {done ? <IconCheck size={12} /> : <IconCircleDashed size={12} />}
                    </ThemeIcon>
                    <Text fw={600} size="sm">
                      {i + 1}. {s.title}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed" mb="sm">
                    {s.text}
                  </Text>
                  {!done && (
                    <Button size="xs" variant={isNext ? "filled" : "light"} rightSection={<IconArrowRight size={14} />} onClick={() => navigate(s.link)}>
                      {s.action}
                    </Button>
                  )}
                </Card>
              );
            })}
          </SimpleGrid>
        </Card>
      )}

      {d.warnings.length > 0 && (
        <Alert color={d.warnings.some((w) => w.level === "error") ? "red" : "yellow"} icon={<IconAlertTriangle size={18} />} title="Bitte prüfen">
          <List size="sm" spacing={4}>
            {d.warnings.map((w) => (
              <List.Item key={w.message}>
                {w.message}{" "}
                {w.link && (
                  <Anchor size="sm" onClick={() => navigate(w.link!)}>
                    Öffnen
                  </Anchor>
                )}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <StatCard label="Heute gesendet" value={`${d.today.sent} / ${d.today.capacity}`} hint="Kapazität aller aktiven Postfächer" />
        <StatCard
          label="Offene Antworten"
          value={
            <Anchor component="button" fw={700} size="xl" onClick={() => navigate("/antworten")} c={d.unhandledReplies ? "teal" : undefined}>
              {d.unhandledReplies}
            </Anchor>
          }
          hint={`${d.today.replies} heute eingegangen`}
        />
        <StatCard label="Antwortrate (30 Tage)" value={fmtPercent(d.last30.replyRate)} hint={`${d.last30.replies} Antworten`} color="teal" />
        <StatCard label="Bounce-Rate (30 Tage)" value={fmtPercent(d.last30.bounceRate)} hint="Ziel: unter 3 %" color={d.last30.bounceRate > 0.03 ? "red" : undefined} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card>
          <Title order={5} mb="md">
            Versand und Antworten (14 Tage)
          </Title>
          <BarChart
            h={220}
            data={d.daily}
            dataKey="date"
            series={[
              { name: "sent", label: "Gesendet", color: "blue.6" },
              { name: "replies", label: "Antworten", color: "teal.6" },
            ]}
            tickLine="y"
            withLegend
          />
        </Card>
        <Card>
          <Group justify="space-between" mb="md">
            <Title order={5}>Postfächer heute</Title>
            <Anchor size="sm" onClick={() => navigate("/postfaecher")}>
              Alle Postfächer
            </Anchor>
          </Group>
          {d.mailboxes.length === 0 && (
            <Text size="sm" c="dimmed">
              Noch kein Postfach verbunden.
            </Text>
          )}
          <Stack gap="sm">
            {d.mailboxes.map((m) => (
              <div key={m.id}>
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <Text size="sm" truncate>
                    {m.email}
                  </Text>
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" c="dimmed">
                      {m.sentToday} / {m.effectiveLimit}
                    </Text>
                    {m.status !== "active" && <StatusBadge map={MAILBOX_STATUS} value={m.status} />}
                  </Group>
                </Group>
                <Progress value={m.effectiveLimit ? Math.min(100, (m.sentToday / m.effectiveLimit) * 100) : 0} size="sm" mt={4} color={m.problem ? "orange" : "blue"} />
              </div>
            ))}
          </Stack>
        </Card>
      </SimpleGrid>

      <Card>
        <Group justify="space-between" mb="sm">
          <Title order={5}>Laufende Kampagnen</Title>
          <Anchor size="sm" onClick={() => navigate("/kampagnen")}>
            Alle Kampagnen
          </Anchor>
        </Group>
        {d.activeCampaigns.length === 0 ? (
          <Text size="sm" c="dimmed">
            Keine laufenden Kampagnen.
          </Text>
        ) : (
          <Stack gap="xs">
            {d.activeCampaigns.map((c) => (
              <Group key={c.id} justify="space-between" wrap="nowrap" style={{ cursor: "pointer" }} onClick={() => navigate(`/kampagnen/${c.id}`)}>
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  <StatusBadge map={CAMPAIGN_STATUS} value={c.status} />
                  <Text size="sm" truncate>
                    {c.name}
                  </Text>
                </Group>
                <Group gap="md" wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    {c.leads} Kontakte
                  </Text>
                  <Text size="xs" c="dimmed">
                    {c.sent} gesendet
                  </Text>
                  <Badge variant="light" color="teal">
                    {c.replied} Antworten
                  </Badge>
                </Group>
              </Group>
            ))}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
