import { Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text } from "@mantine/core";
import { IconPlus, IconSend } from "@tabler/icons-react";
import { useNavigate } from "react-router";
import { useApi } from "../api";
import { EmptyState, ErrorAlert, Loading, PageHeader, StatusBadge } from "../components/common";
import { CAMPAIGN_STATUS } from "../texte";
import { fmtDate, fmtPercent } from "../format";
import type { CampaignDto } from "../../shared/types";

export function CampaignsPage() {
  const campaigns = useApi<CampaignDto[]>("/api/campaigns", { refetchInterval: 30_000 });
  const navigate = useNavigate();

  return (
    <Stack>
      <PageHeader
        title="Kampagnen"
        description="Eine Kampagne ist eine Folge von E-Mails (Erstkontakt plus Nachfass-Mails), die automatisch an Ihre Kontakte geht – bis jemand antwortet."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => navigate("/kampagnen/neu")}>
            Neue Kampagne
          </Button>
        }
      />
      {campaigns.isLoading && <Loading />}
      {campaigns.error && <ErrorAlert error={campaigns.error} />}
      {campaigns.data?.length === 0 && (
        <EmptyState
          icon={<IconSend size={28} />}
          title="Noch keine Kampagne"
          text="Erstellen Sie Ihre erste Kampagne: Kontakte wählen, E-Mails schreiben (mit Vorlagen oder KI), Versandzeiten festlegen, prüfen und starten."
          action={
            <Button leftSection={<IconPlus size={16} />} onClick={() => navigate("/kampagnen/neu")}>
              Erste Kampagne erstellen
            </Button>
          }
        />
      )}
      <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
        {campaigns.data?.map((c) => {
          const done = c.stats.leads > 0 ? (c.stats.leads - c.stats.queued - c.stats.active) / c.stats.leads : 0;
          return (
            <Card key={c.id} style={{ cursor: "pointer" }} onClick={() => navigate(c.status === "draft" ? `/kampagnen/${c.id}/bearbeiten` : `/kampagnen/${c.id}`)}>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Text fw={600} lineClamp={2}>
                  {c.name}
                </Text>
                <StatusBadge map={CAMPAIGN_STATUS} value={c.status} />
              </Group>
              <Text size="xs" c="dimmed" mt={2}>
                {c.steps.length} E-Mail{c.steps.length === 1 ? "" : "s"} · erstellt {fmtDate(c.createdAt)}
                {c.aiEnabled ? " · KI-Einstiege" : ""}
              </Text>
              <SimpleGrid cols={3} mt="md" spacing="xs">
                <div>
                  <Text size="xs" c="dimmed">
                    Kontakte
                  </Text>
                  <Text fw={600}>{c.stats.leads.toLocaleString("de-DE")}</Text>
                </div>
                <div>
                  <Text size="xs" c="dimmed">
                    Gesendet
                  </Text>
                  <Text fw={600}>{c.stats.sent.toLocaleString("de-DE")}</Text>
                </div>
                <div>
                  <Text size="xs" c="dimmed">
                    Antworten
                  </Text>
                  <Text fw={600} c={c.stats.replied > 0 ? "teal" : undefined}>
                    {c.stats.replied} <Text span size="xs" c="dimmed">({fmtPercent(c.stats.replyRate)})</Text>
                  </Text>
                </div>
              </SimpleGrid>
              {c.status !== "draft" && <Progress mt="md" value={done * 100} size="sm" />}
              {c.pauseReason && c.status === "paused" && (
                <Badge mt="sm" color="yellow" variant="light" fullWidth styles={{ label: { whiteSpace: "normal", textTransform: "none" } }}>
                  {c.pauseReason}
                </Badge>
              )}
            </Card>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
