import { useState } from "react";
import { ActionIcon, Badge, Button, Card, Group, Pagination, SegmentedControl, Stack, Table, Text, Textarea, Tooltip } from "@mantine/core";
import { IconCheck, IconEdit, IconRefresh, IconX, IconChecks } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { StatusBadge } from "./common";
import { AI_STATUS } from "../texte";
import type { CampaignDto, CampaignLeadDto, Paged } from "../../shared/types";

const FILTERS = [
  { value: "done", label: "Zur Prüfung" },
  { value: "approved", label: "Freigegeben" },
  { value: "error", label: "Fehler" },
  { value: "pending,generating", label: "In Arbeit" },
  { value: "", label: "Alle" },
];

const QUALITY: Record<string, { label: string; color: string }> = {
  hoch: { label: "konkret", color: "teal" },
  mittel: { label: "solide", color: "blue" },
  niedrig: { label: "wenig Infos", color: "orange" },
  manuell: { label: "von Hand", color: "grape" },
};

/** Prüfen, bearbeiten und freigeben der KI-Einstiege einer Kampagne. */
export function AiReviewPanel({ campaign }: { campaign: CampaignDto }) {
  const [filter, setFilter] = useState("done");
  const [page, setPage] = useState(1);
  const busyAi = campaign.stats.aiPending > 0;
  const url = `/api/campaigns/${campaign.id}/leads?pageSize=25&page=${page}${filter ? `&ai=${filter}` : ""}`;
  const leads = useApi<Paged<CampaignLeadDto>>(url, { refetchInterval: busyAi ? 4000 : 30_000, placeholderData: (p) => p });
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(`/api/campaigns/${campaign.id}`) || q.queryKey[0] === "/api/campaigns" });

  const approveAll = async () => {
    try {
      const r = await api.post<{ approved: number }>(`/api/campaigns/${campaign.id}/ai/approve`, {});
      notifySuccess(`${r.approved} Einstiege freigegeben.`);
      await refresh();
    } catch (err) {
      notifyError(err);
    }
  };
  const regenerateErrors = async () => {
    try {
      const r = await api.post<{ queued: number }>(`/api/campaigns/${campaign.id}/ai/generate`, { scope: "errors" });
      notifySuccess(`${r.queued} Einstiege werden neu erstellt.`);
      await refresh();
    } catch (err) {
      notifyError(err);
    }
  };

  const s = campaign.stats;
  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <Badge variant="light" color="yellow">
            {s.aiDone} zur Prüfung
          </Badge>
          <Badge variant="light" color="teal">
            {s.aiApproved} freigegeben
          </Badge>
          {s.aiPending > 0 && (
            <Badge variant="light" color="blue">
              {s.aiPending} in Arbeit
            </Badge>
          )}
          {s.aiError > 0 && (
            <Badge variant="light" color="red">
              {s.aiError} Fehler
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          {s.aiError > 0 && (
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={regenerateErrors}>
              Fehler neu erstellen
            </Button>
          )}
          <Button size="xs" leftSection={<IconChecks size={14} />} disabled={s.aiDone === 0} onClick={approveAll}>
            Alle {s.aiDone} freigeben
          </Button>
        </Group>
      </Group>
      <SegmentedControl
        size="xs"
        value={filter}
        onChange={(v) => {
          setFilter(v);
          setPage(1);
        }}
        data={FILTERS}
        w="fit-content"
      />
      <Card padding={0}>
        <div className="table-scroll">
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={220}>Kontakt</Table.Th>
                <Table.Th>Persönlicher Einstieg</Table.Th>
                <Table.Th w={150}>Status</Table.Th>
                <Table.Th w={110} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {leads.data?.items.map((l) => <OpenerRow key={l.id} lead={l} onChanged={refresh} />)}
              {leads.data?.items.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text c="dimmed" ta="center" py="md">
                      Keine Einträge in dieser Ansicht.
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

function OpenerRow({ lead: l, onChanged }: { lead: CampaignLeadDto; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(l.aiOpener ?? "");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      await api.patch(`/api/campaign-leads/${l.id}/opener`, { text, approve: true });
      setEditing(false);
    });
  const approve = () => run(() => api.patch(`/api/campaign-leads/${l.id}/opener`, { text: l.aiOpener ?? "", approve: true }));
  const regenerate = () => run(() => api.post(`/api/campaign-leads/${l.id}/opener/regenerate`));
  const q = l.aiQuality ? QUALITY[l.aiQuality] : null;
  const sent = l.lastSentAt !== null;

  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" fw={500}>
          {l.name || l.email}
        </Text>
        <Text size="xs" c="dimmed">
          {l.company || l.email}
        </Text>
        {l.website && (
          <Text size="xs" c="dimmed">
            {l.website}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {editing ? (
          <Stack gap={6}>
            <Textarea autosize minRows={2} value={text} onChange={(e) => setText(e.currentTarget.value)} maxLength={320} />
            <Group gap={6}>
              <Button size="compact-xs" onClick={save} loading={busy}>
                Speichern & freigeben
              </Button>
              <Button size="compact-xs" variant="subtle" onClick={() => setEditing(false)}>
                Abbrechen
              </Button>
            </Group>
          </Stack>
        ) : (
          <>
            {l.aiOpener ? (
              <Text size="sm">{l.aiOpener}</Text>
            ) : (
              <Text size="sm" c="dimmed">
                {l.aiStatus === "error" ? l.aiError : "–"}
              </Text>
            )}
            {l.aiReason && (
              <Group gap={6} mt={4}>
                {q && (
                  <Badge size="xs" color={q.color} variant="light">
                    {q.label}
                  </Badge>
                )}
                <Text size="xs" c="dimmed">
                  {l.aiReason}
                </Text>
              </Group>
            )}
          </>
        )}
      </Table.Td>
      <Table.Td>
        <StatusBadge map={AI_STATUS} value={l.aiStatus} />
        {sent && (
          <Text size="xs" c="dimmed" mt={4}>
            bereits gesendet
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {!sent && !editing && (
          <Group gap={4} wrap="nowrap" justify="flex-end">
            {l.aiStatus === "done" && (
              <Tooltip label="Freigeben">
                <ActionIcon variant="light" color="teal" onClick={approve} loading={busy} aria-label="Freigeben">
                  <IconCheck size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            {l.aiStatus === "approved" && (
              <Tooltip label="Freigabe zurücknehmen">
                <ActionIcon variant="subtle" color="gray" onClick={() => run(() => api.patch(`/api/campaign-leads/${l.id}/opener`, { text: l.aiOpener ?? "", approve: false }))} aria-label="Freigabe zurücknehmen">
                  <IconX size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="Bearbeiten">
              <ActionIcon
                variant="subtle"
                onClick={() => {
                  setText(l.aiOpener ?? "");
                  setEditing(true);
                }}
                aria-label="Bearbeiten"
              >
                <IconEdit size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Neu erstellen">
              <ActionIcon variant="subtle" color="gray" onClick={regenerate} loading={busy} disabled={l.aiStatus === "generating" || l.aiStatus === "pending"} aria-label="Neu erstellen">
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Table.Td>
    </Table.Tr>
  );
}
