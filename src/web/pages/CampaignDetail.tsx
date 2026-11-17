import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  List,
  Menu,
  Modal,
  MultiSelect,
  Pagination,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Timeline,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
  IconPlayerPause,
  IconPlayerPlay,
  IconEdit,
  IconCopy,
  IconTrash,
  IconDots,
  IconUsersPlus,
  IconAlertTriangle,
  IconRefresh,
  IconSearch,
  IconSparkles,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { ErrorAlert, Loading, PageHeader, StatCard, StatusBadge } from "../components/common";
import { AiReviewPanel } from "../components/aiReview";
import { CAMPAIGN_LEAD_STATUS, CAMPAIGN_STATUS } from "../texte";
import { fmtDateTime, fmtPercent, fmtRelative } from "../format";
import type { CampaignDto, CampaignLeadDto, EventDto, LeadListDto, Paged, PreflightDto } from "../../shared/types";

const FILTERS = [
  { value: "", label: "Alle" },
  { value: "queued,active", label: "Offen" },
  { value: "replied", label: "Geantwortet" },
  { value: "finished", label: "Beendet" },
  { value: "bounced,unsubscribed", label: "Bounce/Abgemeldet" },
  { value: "error,skipped", label: "Probleme" },
];

export function CampaignDetailPage() {
  const id = Number(useParams().id);
  const campaign = useApi<CampaignDto>(`/api/campaigns/${id}`, { refetchInterval: 20_000 });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [tab, setTab] = useState<string | null>("kontakte");

  if (campaign.isLoading) return <Loading />;
  if (campaign.error || !campaign.data) return <ErrorAlert error={campaign.error ?? "Nicht gefunden"} />;
  const c = campaign.data;
  const s = c.stats;
  const refresh = () => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(`/api/campaigns`) });

  const pause = async () => {
    setBusy(true);
    try {
      await api.post(`/api/campaigns/${id}/pause`);
      await refresh();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; preflight: PreflightDto }>(`/api/campaigns/${id}/resume`, {});
      if (!r.ok) {
        modals.open({
          title: "Fortsetzen nicht möglich",
          children: (
            <List size="sm" spacing={4}>
              {r.preflight.blocking.map((b) => (
                <List.Item key={b.message}>{b.message}</List.Item>
              ))}
            </List>
          ),
        });
      }
      await refresh();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const duplicate = async () => {
    try {
      const copy = await api.post<CampaignDto>(`/api/campaigns/${id}/duplicate`);
      navigate(`/kampagnen/${copy.id}/bearbeiten`);
    } catch (err) {
      notifyError(err);
    }
  };
  const remove = () =>
    modals.openConfirmModal({
      title: "Kampagne löschen?",
      children: <Text size="sm">Die Kampagne und ihre Planung werden gelöscht. Bereits gesendete Mails bleiben in Ihrem Gmail-Postfach.</Text>,
      labels: { confirm: "Löschen", cancel: "Abbrechen" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await api.del(`/api/campaigns/${id}`);
          await queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
          navigate("/kampagnen");
        } catch (err) {
          notifyError(err);
        }
      },
    });

  return (
    <Stack>
      <PageHeader
        title={c.name}
        description={
          <Group gap="xs" component="span">
            <StatusBadge map={CAMPAIGN_STATUS} value={c.status} />
            <Text span size="sm" c="dimmed">
              {c.startedAt ? `gestartet ${fmtDateTime(c.startedAt)}` : "noch nicht gestartet"} · {c.steps.length} E-Mails · versendet {c.windowStart}–{c.windowEnd} Uhr
            </Text>
          </Group>
        }
        actions={
          <>
            {c.status === "active" && (
              <Button variant="default" leftSection={<IconPlayerPause size={16} />} onClick={pause} loading={busy}>
                Pausieren
              </Button>
            )}
            {c.status === "paused" && (
              <Button leftSection={<IconPlayerPlay size={16} />} onClick={resume} loading={busy}>
                Fortsetzen
              </Button>
            )}
            {c.status === "draft" && (
              <Button leftSection={<IconPlayerPlay size={16} />} onClick={() => navigate(`/kampagnen/${id}/bearbeiten?schritt=4`)}>
                Prüfen & starten
              </Button>
            )}
            <Button variant="default" leftSection={<IconEdit size={16} />} onClick={() => navigate(`/kampagnen/${id}/bearbeiten?schritt=1`)}>
              Bearbeiten
            </Button>
            <Menu position="bottom-end">
              <Menu.Target>
                <Button variant="default" px="xs" aria-label="Weitere Aktionen">
                  <IconDots size={16} />
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconUsersPlus size={16} />} onClick={() => setAddOpen(true)}>
                  Kontakte hinzufügen
                </Menu.Item>
                <Menu.Item leftSection={<IconCopy size={16} />} onClick={duplicate}>
                  Duplizieren
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={remove}>
                  Löschen
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />

      {c.status === "paused" && c.pauseReason && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />}>
          {c.pauseReason}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
        <StatCard label="Kontakte" value={s.leads.toLocaleString("de-DE")} hint={`${(s.queued + s.active).toLocaleString("de-DE")} noch offen`} />
        <StatCard label="Gesendet" value={s.sent.toLocaleString("de-DE")} />
        <StatCard label="Antworten" value={s.replied} hint={fmtPercent(s.replyRate)} color="teal" />
        <StatCard label="Unzustellbar" value={s.bounced} hint={fmtPercent(s.bounceRate)} color={s.bounceRate > 0.03 ? "red" : undefined} />
        <StatCard label="Abgemeldet" value={s.unsubscribed} />
        <StatCard label="Übersprungen / Fehler" value={s.skipped + s.error} color={s.error > 0 ? "orange" : undefined} />
      </SimpleGrid>

      <Card padding={0}>
        <Table verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>E-Mail</Table.Th>
              <Table.Th>Betreff</Table.Th>
              <Table.Th>Gesendet</Table.Th>
              <Table.Th>Antworten danach</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {c.steps.map((st) => {
              const ps = s.perStep.find((p) => p.position === st.position);
              return (
                <Table.Tr key={st.position}>
                  <Table.Td>{st.position === 1 ? "Erste E-Mail" : `Nachfass ${st.position - 1} (+${st.waitDays} Tage)`}</Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1}>
                      {st.subject || <Text span c="dimmed">Re: (selber Verlauf)</Text>}
                    </Text>
                  </Table.Td>
                  <Table.Td>{ps?.sent ?? 0}</Table.Td>
                  <Table.Td>{ps?.replies ?? 0}</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Card>

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="kontakte">Kontakte</Tabs.Tab>
          {c.aiEnabled && (
            <Tabs.Tab value="ki" leftSection={<IconSparkles size={14} />} rightSection={s.aiDone > 0 ? <Badge size="xs">{s.aiDone}</Badge> : null}>
              KI-Einstiege
            </Tabs.Tab>
          )}
          <Tabs.Tab value="aktivitaet">Aktivität</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="kontakte" pt="md">
          <CampaignLeads campaignId={id} />
        </Tabs.Panel>
        {c.aiEnabled && (
          <Tabs.Panel value="ki" pt="md">
            <AiReviewPanel campaign={c} />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="aktivitaet" pt="md">
          <ActivityLog campaignId={id} />
        </Tabs.Panel>
      </Tabs>
      <AddLeadsModal campaignId={id} opened={addOpen} onClose={() => setAddOpen(false)} />
    </Stack>
  );
}

function CampaignLeads({ campaignId }: { campaignId: number }) {
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), pageSize: "50" });
  if (filter) params.set("status", filter);
  if (debounced) params.set("q", debounced);
  const leads = useApi<Paged<CampaignLeadDto>>(`/api/campaigns/${campaignId}/leads?${params.toString()}`, { placeholderData: (p) => p, refetchInterval: 30_000 });
  const queryClient = useQueryClient();
  const problems = (leads.data?.items ?? []).filter((l) => l.status === "error" || l.status === "skipped");

  const requeue = async (ids: number[]) => {
    try {
      const r = await api.post<{ requeued: number }>(`/api/campaigns/${campaignId}/leads/requeue`, { ids });
      notifySuccess(`${r.requeued} Kontakte erneut eingereiht.`);
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(`/api/campaigns/${campaignId}`) });
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
          data={FILTERS}
        />
        <Group gap="xs">
          <TextInput size="xs" placeholder="Suchen" leftSection={<IconSearch size={14} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
          {problems.length > 0 && (
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => requeue(problems.map((p) => p.id))}>
              Probleme erneut einreihen ({problems.length})
            </Button>
          )}
        </Group>
      </Group>
      <Card padding={0}>
        <div className="table-scroll">
          <Table verticalSpacing="xs" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Kontakt</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Nächster Schritt</Table.Th>
                <Table.Th>Postfach</Table.Th>
                <Table.Th>Zuletzt gesendet</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {leads.data?.items.map((l) => (
                <Table.Tr key={l.id}>
                  <Table.Td>
                    <Text size="sm">{l.name || l.email}</Text>
                    <Text size="xs" c="dimmed">
                      {l.name ? l.email : ""} {l.company ? `· ${l.company}` : ""}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={l.statusReason ?? ""} disabled={!l.statusReason} multiline w={320}>
                      <span>
                        <StatusBadge map={CAMPAIGN_LEAD_STATUS} value={l.status} />
                      </span>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    {l.status === "queued" || l.status === "active" ? (
                      <Text size="sm">
                        E-Mail {l.nextStep}
                        <Text span size="xs" c="dimmed">
                          {" "}
                          · {l.nextSendAt ? fmtRelative(l.nextSendAt) : "sobald frei"}
                        </Text>
                      </Text>
                    ) : (
                      <Text size="sm" c="dimmed">
                        –
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{l.mailboxEmail ?? "–"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{fmtDateTime(l.lastSentAt)}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
              {leads.data?.items.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text c="dimmed" ta="center" py="md">
                      Keine Kontakte in dieser Ansicht.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </div>
      </Card>
      {leads.data && leads.data.total > leads.data.pageSize && <Pagination value={page} onChange={setPage} total={Math.ceil(leads.data.total / leads.data.pageSize)} />}
    </Stack>
  );
}

function ActivityLog({ campaignId }: { campaignId: number }) {
  const events = useApi<EventDto[]>(`/api/campaigns/${campaignId}/events`, { refetchInterval: 30_000 });
  if (events.isLoading) return <Loading />;
  if (!events.data?.length) return <Text c="dimmed">Noch keine Ereignisse.</Text>;
  return (
    <Card>
      <Timeline bulletSize={14} lineWidth={2}>
        {events.data.map((e) => (
          <Timeline.Item key={e.id} color={e.level === "error" ? "red" : e.level === "warn" ? "yellow" : "blue"} title={<Text size="sm">{e.message}</Text>}>
            <Text size="xs" c="dimmed">
              {fmtDateTime(e.createdAt)}
            </Text>
          </Timeline.Item>
        ))}
      </Timeline>
    </Card>
  );
}

function AddLeadsModal({ campaignId, opened, onClose }: { campaignId: number; opened: boolean; onClose: () => void }) {
  const lists = useApi<LeadListDto[]>("/api/lead-lists", { enabled: opened });
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ added: number; skipped: number }>(`/api/campaigns/${campaignId}/leads`, { listIds: selected.map(Number) });
      notifySuccess(`${r.added} Kontakte hinzugefügt${r.skipped ? `, ${r.skipped} übersprungen` : ""}.`);
      setSelected([]);
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(`/api/campaigns`) });
      onClose();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Kontakte hinzufügen">
      <Stack>
        <MultiSelect
          label="Listen"
          data={(lists.data ?? []).map((l) => ({ value: String(l.id), label: `${l.name} (${l.leadCount})` }))}
          value={selected}
          onChange={setSelected}
          searchable
        />
        <Text size="xs" c="dimmed">
          Kontakte, die schon in der Kampagne sind, gesperrt oder unzustellbar sind, werden ausgelassen.
        </Text>
        <Group justify="flex-end">
          <Button onClick={add} loading={busy} disabled={!selected.length}>
            Hinzufügen
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
