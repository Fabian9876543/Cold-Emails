import { useState } from "react";
import { Anchor, Badge, Button, Card, Group, Menu, Pagination, SegmentedControl, Select, Stack, Text, Tooltip } from "@mantine/core";
import { IconInbox, IconRefresh, IconCheck, IconExternalLink, IconTag, IconBan, IconDownload, IconArrowBackUp } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { EmptyState, ErrorAlert, Loading, PageHeader, StatusBadge } from "../components/common";
import { INBOUND_KIND, REPLY_CATEGORY } from "../texte";
import { fmtDateTime, fmtRelative } from "../format";
import type { InboundDto, Paged, ReplyCategory } from "../../shared/types";

const VIEWS = [
  { value: "open", label: "Offen", query: "kind=reply&handled=0" },
  { value: "replies", label: "Alle Antworten", query: "kind=reply" },
  { value: "unsubscribe", label: "Abmeldungen", query: "kind=unsubscribe" },
  { value: "bounce", label: "Unzustellbar", query: "kind=bounce" },
  { value: "auto", label: "Abwesend", query: "kind=auto_reply" },
];

export function InboxPage() {
  const [view, setView] = useState("open");
  const [category, setCategory] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [polling, setPolling] = useState(false);
  const queryClient = useQueryClient();
  const base = VIEWS.find((v) => v.value === view)!.query;
  const url = `/api/inbox?${base}${category ? `&category=${category}` : ""}&page=${page}`;
  const inbox = useApi<Paged<InboundDto>>(url, { refetchInterval: 60_000, placeholderData: (p) => p });

  const refresh = () => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/inbox") || q.queryKey[0] === "/api/dashboard" });

  const poll = async () => {
    setPolling(true);
    try {
      const r = await api.post<{ processed: number }>("/api/inbox/poll");
      notifySuccess(r.processed ? `${r.processed} neue Nachrichten zugeordnet.` : "Keine neuen Antworten.");
      await refresh();
    } catch (err) {
      notifyError(err);
    } finally {
      setPolling(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="Antworten"
        description="Alle Reaktionen auf Ihre Kampagnen aus allen Postfächern. Antworten stoppen die Sequenz automatisch – beantworten Sie sie wie gewohnt in Gmail."
        actions={
          <>
            <Button variant="default" component="a" href={`/api/inbox/export.csv?${base}`} leftSection={<IconDownload size={16} />}>
              Export
            </Button>
            <Button variant="light" leftSection={<IconRefresh size={16} />} loading={polling} onClick={poll}>
              Jetzt prüfen
            </Button>
          </>
        }
      />
      <Group justify="space-between" wrap="wrap">
        <SegmentedControl
          value={view}
          onChange={(v) => {
            setView(v);
            setPage(1);
          }}
          data={VIEWS.map((v) => ({ value: v.value, label: v.label }))}
        />
        {(view === "open" || view === "replies") && (
          <Select
            placeholder="Alle Kategorien"
            clearable
            data={Object.entries(REPLY_CATEGORY).map(([value, c]) => ({ value, label: c.label }))}
            value={category}
            onChange={(v) => {
              setCategory(v);
              setPage(1);
            }}
            w={220}
          />
        )}
      </Group>
      {inbox.isLoading && <Loading />}
      {inbox.error && <ErrorAlert error={inbox.error} />}
      {inbox.data?.items.length === 0 && (
        <EmptyState
          icon={<IconInbox size={28} />}
          title={view === "open" ? "Alles erledigt" : "Nichts gefunden"}
          text={view === "open" ? "Keine offenen Antworten. Neue Antworten werden alle drei Minuten aus Ihren Postfächern abgerufen." : "In dieser Ansicht gibt es noch keine Einträge."}
        />
      )}
      <Stack gap="sm">
        {inbox.data?.items.map((item) => <InboundCard key={item.id} item={item} onChanged={refresh} />)}
      </Stack>
      {inbox.data && inbox.data.total > inbox.data.pageSize && <Pagination value={page} onChange={setPage} total={Math.ceil(inbox.data.total / inbox.data.pageSize)} />}
    </Stack>
  );
}

function InboundCard({ item, onChanged }: { item: InboundDto; onChanged: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const patch = async (body: { handled?: boolean; category?: ReplyCategory | null }) => {
    setBusy(true);
    try {
      await api.patch(`/api/inbox/${item.id}`, body);
      onChanged();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const unsubscribe = async () => {
    setBusy(true);
    try {
      await api.post(`/api/inbox/${item.id}/unsubscribe`);
      notifySuccess(`${item.fromEmail} wurde abgemeldet und gesperrt.`);
      onChanged();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const cat = item.category ? REPLY_CATEGORY[item.category] : null;

  return (
    <Card padding="md" style={{ opacity: item.handled && item.kind === "reply" ? 0.75 : 1 }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap={8} wrap="wrap">
            <Text fw={600}>{item.leadName ?? item.fromEmail}</Text>
            {item.company && (
              <Text size="sm" c="dimmed">
                {item.company}
              </Text>
            )}
            {item.kind !== "reply" && <StatusBadge map={INBOUND_KIND} value={item.kind} />}
            {cat && item.kind === "reply" && (
              <Badge color={cat.color} variant="light">
                {cat.label}
              </Badge>
            )}
            {item.handled && item.kind === "reply" && (
              <Badge color="gray" variant="outline" leftSection={<IconCheck size={10} />}>
                Erledigt
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {item.fromEmail}
            {item.campaignName && (
              <>
                {" · "}
                <Anchor size="xs" onClick={() => navigate(`/kampagnen/${item.campaignId}`)}>
                  {item.campaignName}
                </Anchor>
              </>
            )}
            {" · "}
            <Tooltip label={fmtDateTime(item.receivedAt)}>
              <span>{fmtRelative(item.receivedAt)}</span>
            </Tooltip>
            {item.returnDate ? ` · zurück ab ${new Date(item.returnDate).toLocaleDateString("de-DE")}` : ""}
          </Text>
        </div>
        <Group gap={6} wrap="nowrap">
          {item.gmailLink && (
            <Button size="xs" variant="light" component="a" href={item.gmailLink} target="_blank" rel="noreferrer" leftSection={<IconExternalLink size={14} />}>
              In Gmail öffnen
            </Button>
          )}
          {item.kind === "reply" && (
            <Button size="xs" variant={item.handled ? "default" : "filled"} loading={busy} onClick={() => patch({ handled: !item.handled })} leftSection={item.handled ? <IconArrowBackUp size={14} /> : <IconCheck size={14} />}>
              {item.handled ? "Wieder öffnen" : "Erledigt"}
            </Button>
          )}
          {item.kind === "reply" && (
            <Menu position="bottom-end">
              <Menu.Target>
                <Button size="xs" variant="default" px={8} aria-label="Weitere Aktionen">
                  <IconTag size={14} />
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Kategorie</Menu.Label>
                {Object.entries(REPLY_CATEGORY).map(([value, c]) => (
                  <Menu.Item key={value} onClick={() => patch({ category: value as ReplyCategory })}>
                    {c.label}
                  </Menu.Item>
                ))}
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconBan size={14} />} onClick={unsubscribe}>
                  Abmelden & sperren
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      </Group>
      {item.summary && (
        <Text size="sm" mt="sm" fw={500}>
          {item.summary}
        </Text>
      )}
      {item.subject && item.kind === "reply" && (
        <Text size="xs" c="dimmed" mt="xs">
          Betreff: {item.subject}
        </Text>
      )}
      <Text size="sm" mt={6} className="mail-preview" lineClamp={8}>
        {item.snippet}
      </Text>
    </Card>
  );
}
