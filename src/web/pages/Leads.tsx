import { useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Modal,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconUpload, IconSearch, IconDots, IconEdit, IconTrash, IconUsers, IconDownload, IconBan, IconList, IconPlus } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, notifyError, notifySuccess, useApi } from "../api";
import { EmptyState, ErrorAlert, Loading, PageHeader, StatusBadge } from "../components/common";
import { ImportWizard } from "../components/ImportWizard";
import { LEAD_STATUS } from "../texte";
import { fmtDate } from "../format";
import { FLAG_LABELS, type EmailFlag } from "../../shared/emailCheck";
import type { LeadDto, LeadListDto, Paged, SuppressionDto } from "../../shared/types";

export function LeadsPage() {
  const [tab, setTab] = useState<string | null>("kontakte");
  const [importOpen, setImportOpen] = useState(false);
  return (
    <Stack>
      <PageHeader
        title="Kontakte"
        description="Importieren Sie Ihre Kontaktlisten (CSV oder Excel). Adressen werden beim Import geprüft, Abmeldungen und Bounces landen automatisch auf der Sperrliste."
        actions={
          <Button leftSection={<IconUpload size={16} />} onClick={() => setImportOpen(true)}>
            Kontakte importieren
          </Button>
        }
      />
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="kontakte" leftSection={<IconUsers size={16} />}>
            Alle Kontakte
          </Tabs.Tab>
          <Tabs.Tab value="listen" leftSection={<IconList size={16} />}>
            Listen
          </Tabs.Tab>
          <Tabs.Tab value="sperrliste" leftSection={<IconBan size={16} />}>
            Sperrliste
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="kontakte" pt="md">
          <LeadTable onImport={() => setImportOpen(true)} />
        </Tabs.Panel>
        <Tabs.Panel value="listen" pt="md">
          <ListsPanel onImport={() => setImportOpen(true)} />
        </Tabs.Panel>
        <Tabs.Panel value="sperrliste" pt="md">
          <SuppressionPanel />
        </Tabs.Panel>
      </Tabs>
      <ImportWizard opened={importOpen} onClose={() => setImportOpen(false)} />
    </Stack>
  );
}

function LeadTable({ onImport }: { onImport: () => void }) {
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const [status, setStatus] = useState<string | null>(null);
  const [listId, setListId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<LeadDto | null>(null);
  const lists = useApi<LeadListDto[]>("/api/lead-lists");
  const params = new URLSearchParams({ page: String(page), pageSize: "50" });
  if (debounced) params.set("q", debounced);
  if (status) params.set("status", status);
  if (listId) params.set("listId", listId);
  const leads = useApi<Paged<LeadDto>>(`/api/leads?${params.toString()}`, { placeholderData: (prev) => prev });
  const queryClient = useQueryClient();

  useEffect(() => setPage(1), [debounced, status, listId]);

  const remove = (lead: LeadDto) =>
    modals.openConfirmModal({
      title: "Kontakt löschen?",
      children: (
        <Text size="sm">
          {lead.email} wird gelöscht. Soll die Adresse zusätzlich auf die Sperrliste, damit sie nicht versehentlich erneut importiert und angeschrieben wird?
        </Text>
      ),
      labels: { confirm: "Löschen und sperren", cancel: "Abbrechen" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await api.del(`/api/leads/${lead.id}?suppress=1`);
          await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/leads") || String(q.queryKey[0]).startsWith("/api/suppressions") });
        } catch (err) {
          notifyError(err);
        }
      },
    });

  const exportUrl = `/api/leads/export.csv?${params.toString()}`;

  if (leads.data && leads.data.total === 0 && !debounced && !status && !listId) {
    return (
      <EmptyState
        icon={<IconUsers size={28} />}
        title="Noch keine Kontakte"
        text="Importieren Sie eine CSV- oder Excel-Datei mit mindestens einer Spalte für E-Mail-Adressen. Vorname, Firma, Position und Website machen die Personalisierung besser."
        action={
          <Button leftSection={<IconUpload size={16} />} onClick={onImport}>
            Kontakte importieren
          </Button>
        }
      />
    );
  }

  return (
    <Stack>
      <Group gap="sm" wrap="wrap">
        <TextInput placeholder="Suchen (E-Mail, Name, Firma)" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} style={{ flex: 1, minWidth: 220 }} />
        <Select
          placeholder="Alle Listen"
          clearable
          data={(lists.data ?? []).map((l) => ({ value: String(l.id), label: `${l.name} (${l.leadCount})` }))}
          value={listId}
          onChange={setListId}
          w={240}
        />
        <Select
          placeholder="Alle Status"
          clearable
          data={Object.entries(LEAD_STATUS).map(([value, s]) => ({ value, label: s.label }))}
          value={status}
          onChange={setStatus}
          w={170}
        />
        <Button variant="default" component="a" href={exportUrl} leftSection={<IconDownload size={16} />}>
          Export
        </Button>
      </Group>
      {leads.error && <ErrorAlert error={leads.error} />}
      {leads.isLoading && <Loading />}
      {leads.data && (
        <Card padding={0}>
          <div className="table-scroll">
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>E-Mail</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Firma</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Hinzugefügt</Table.Th>
                  <Table.Th w={50} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {leads.data.items.map((l) => (
                  <Table.Tr key={l.id}>
                    <Table.Td>
                      <Text size="sm">{l.email}</Text>
                      {l.checkFlags.length > 0 && (
                        <Group gap={4} mt={2}>
                          {l.checkFlags.map((f) => (
                            <Tooltip key={f} label={FLAG_LABELS[f as EmailFlag] ?? f}>
                              <Badge size="xs" variant="outline" color="yellow">
                                {f === "role" ? "Rolle" : f === "freemail" ? "Freemail" : f}
                              </Badge>
                            </Tooltip>
                          ))}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{[l.salutation, l.firstName, l.lastName].filter(Boolean).join(" ") || "–"}</Text>
                      {l.position && (
                        <Text size="xs" c="dimmed">
                          {l.position}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{l.company || "–"}</Text>
                      {l.website && (
                        <Text size="xs" c="dimmed">
                          {l.website}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge map={LEAD_STATUS} value={l.status} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" className="nowrap">
                        {fmtDate(l.createdAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Menu position="bottom-end">
                        <Menu.Target>
                          <ActionIcon variant="subtle" color="gray" aria-label="Aktionen">
                            <IconDots size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item leftSection={<IconEdit size={16} />} onClick={() => setEditing(l)}>
                            Bearbeiten
                          </Menu.Item>
                          <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => remove(l)}>
                            Löschen
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {leads.data.items.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={6}>
                      <Text c="dimmed" ta="center" py="md">
                        Keine Kontakte gefunden.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </div>
        </Card>
      )}
      {leads.data && leads.data.total > leads.data.pageSize && (
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {leads.data.total.toLocaleString("de-DE")} Kontakte
          </Text>
          <Pagination value={page} onChange={setPage} total={Math.ceil(leads.data.total / leads.data.pageSize)} />
        </Group>
      )}
      <LeadEditModal lead={editing} onClose={() => setEditing(null)} />
    </Stack>
  );
}

function LeadEditModal({ lead, onClose }: { lead: LeadDto | null; onClose: () => void }) {
  const [form, setForm] = useState({ salutation: "", firstName: "", lastName: "", company: "", position: "", website: "" });
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!lead) return;
    setForm({ salutation: lead.salutation, firstName: lead.firstName, lastName: lead.lastName, company: lead.company, position: lead.position, website: lead.website });
    setCustom(
      Object.entries(lead.custom)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
    );
  }, [lead]);

  const save = async () => {
    if (!lead) return;
    setSaving(true);
    try {
      const customObj: Record<string, string> = {};
      for (const line of custom.split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) customObj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      await api.patch(`/api/leads/${lead.id}`, { ...form, custom: customObj });
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/leads") });
      notifySuccess("Kontakt gespeichert.");
      onClose();
    } catch (err) {
      notifyError(err);
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }));

  return (
    <Modal opened={!!lead} onClose={onClose} title={lead ? `Kontakt bearbeiten: ${lead.email}` : ""} size="lg">
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select label="Anrede" data={["", "Herr", "Frau"].map((v) => ({ value: v, label: v || "–" }))} value={form.salutation} onChange={(v) => setForm((f) => ({ ...f, salutation: v ?? "" }))} />
          <TextInput label="Vorname" value={form.firstName} onChange={set("firstName")} />
          <TextInput label="Nachname" value={form.lastName} onChange={set("lastName")} />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="Firma" value={form.company} onChange={set("company")} />
          <TextInput label="Position" value={form.position} onChange={set("position")} />
          <TextInput label="Website" value={form.website} onChange={set("website")} />
        </SimpleGrid>
        <Textarea label="Eigene Felder" description="Ein Feld pro Zeile im Format „name: wert“ – nutzbar als {{name}}." autosize minRows={2} value={custom} onChange={(e) => setCustom(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={save} loading={saving}>
            Speichern
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ListsPanel({ onImport }: { onImport: () => void }) {
  const lists = useApi<LeadListDto[]>("/api/lead-lists");
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const remove = (l: LeadListDto) =>
    modals.openConfirmModal({
      title: `Liste „${l.name}“ löschen?`,
      children: <Text size="sm">Die Liste wird entfernt. Kontakte, die in keiner anderen Liste stehen, werden ebenfalls gelöscht.</Text>,
      labels: { confirm: "Liste und Kontakte löschen", cancel: "Abbrechen" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          const r = await api.del<{ deletedLeads: number }>(`/api/lead-lists/${l.id}?deleteLeads=1`);
          notifySuccess(`Liste gelöscht (${r.deletedLeads} Kontakte entfernt).`);
          await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/lead") });
        } catch (err) {
          notifyError(err);
        }
      },
    });

  if (lists.isLoading) return <Loading />;
  if (lists.error) return <ErrorAlert error={lists.error} />;
  if (!lists.data?.length) {
    return (
      <EmptyState
        icon={<IconList size={28} />}
        title="Noch keine Listen"
        text="Jeder Import legt eine Liste an. Listen wählen Sie später als Empfänger einer Kampagne aus."
        action={
          <Button leftSection={<IconUpload size={16} />} onClick={onImport}>
            Kontakte importieren
          </Button>
        }
      />
    );
  }
  return (
    <Card padding={0}>
      <Table verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Liste</Table.Th>
            <Table.Th>Kontakte</Table.Th>
            <Table.Th>Erstellt</Table.Th>
            <Table.Th w={260} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {lists.data.map((l) => (
            <Table.Tr key={l.id}>
              <Table.Td fw={500}>{l.name}</Table.Td>
              <Table.Td>{l.leadCount.toLocaleString("de-DE")}</Table.Td>
              <Table.Td>{fmtDate(l.createdAt)}</Table.Td>
              <Table.Td>
                <Group gap="xs" justify="flex-end">
                  <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => navigate(`/kampagnen/neu?listId=${l.id}`)}>
                    Kampagne
                  </Button>
                  <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => remove(l)}>
                    Löschen
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

const REASONS: Record<SuppressionDto["reason"], string> = {
  unsubscribe: "Abmeldung",
  bounce: "Unzustellbar",
  manual: "Manuell",
  complaint: "Beschwerde",
};

function SuppressionPanel() {
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState("");
  const [adding, setAdding] = useState(false);
  const params = new URLSearchParams({ page: String(page), pageSize: "50" });
  if (debounced) params.set("q", debounced);
  const list = useApi<Paged<SuppressionDto>>(`/api/suppressions?${params.toString()}`, { placeholderData: (p) => p });
  const queryClient = useQueryClient();

  const add = async () => {
    setAdding(true);
    try {
      const r = await api.post<{ added: number; invalid: string[] }>("/api/suppressions", { entries });
      notifySuccess(`${r.added} Einträge hinzugefügt.${r.invalid.length ? ` Ungültig: ${r.invalid.slice(0, 5).join(", ")}` : ""}`);
      setEntries("");
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/suppressions") });
    } catch (err) {
      notifyError(err);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (s: SuppressionDto) => {
    try {
      await api.del(`/api/suppressions/${s.id}`);
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/suppressions") });
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Stack>
      <Card>
        <Text fw={600} mb={4}>
          Adressen oder Domains sperren
        </Text>
        <Text size="sm" c="dimmed" mb="sm">
          Gesperrte Adressen werden nie angeschrieben – auch nicht nach einem erneuten Import. Ganze Firmen sperren Sie über die Domain (z. B. <b>wettbewerber.de</b>).
        </Text>
        <Textarea placeholder={"max@beispiel.de\nwettbewerber.de"} autosize minRows={3} value={entries} onChange={(e) => setEntries(e.currentTarget.value)} />
        <Group justify="flex-end" mt="sm">
          <Button onClick={add} loading={adding} disabled={!entries.trim()} leftSection={<IconBan size={16} />}>
            Sperren
          </Button>
        </Group>
      </Card>
      <Group>
        <TextInput placeholder="Sperrliste durchsuchen" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} style={{ flex: 1 }} />
        <Button variant="default" component="a" href="/api/suppressions/export.csv" leftSection={<IconDownload size={16} />}>
          Export
        </Button>
      </Group>
      {list.error && <ErrorAlert error={list.error} />}
      {list.data && (
        <Card padding={0}>
          <Table verticalSpacing="xs" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Eintrag</Table.Th>
                <Table.Th>Grund</Table.Th>
                <Table.Th>Seit</Table.Th>
                <Table.Th w={50} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.items.map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td>
                    <Text size="sm">{s.type === "domain" ? `Domain: ${s.value}` : s.value}</Text>
                    {s.note && (
                      <Text size="xs" c="dimmed">
                        {s.note}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={s.reason === "bounce" ? "red" : s.reason === "unsubscribe" ? "orange" : "gray"}>
                      {REASONS[s.reason]}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{fmtDate(s.createdAt)}</Table.Td>
                  <Table.Td>
                    <Tooltip label="Von der Sperrliste entfernen">
                      <ActionIcon variant="subtle" color="gray" onClick={() => remove(s)} aria-label="Entfernen">
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
              {list.data.items.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text c="dimmed" ta="center" py="md">
                      Die Sperrliste ist leer.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Card>
      )}
      {list.data && list.data.total > list.data.pageSize && <Pagination value={page} onChange={setPage} total={Math.ceil(list.data.total / list.data.pageSize)} />}
    </Stack>
  );
}
