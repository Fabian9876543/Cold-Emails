import { useState } from "react";
import { Alert, Badge, Button, Group, List, Modal, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, ThemeIcon } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconFileSpreadsheet, IconUpload, IconX, IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, notifyError } from "../api";
import { StatCard } from "./common";
import { STANDARD_FIELD_LABELS, customKeyFromHeader, type StandardField } from "../../shared/fields";
import type { ImportPreviewDto, ImportReportDto } from "../../shared/types";

const ACCEPT = {
  "text/csv": [".csv"],
  "text/plain": [".txt", ".tsv"],
  "application/vnd.ms-excel": [".csv"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
};

function optionsFor(header: string) {
  const std = (Object.keys(STANDARD_FIELD_LABELS) as StandardField[]).map((f) => ({ value: f, label: STANDARD_FIELD_LABELS[f] }));
  return [
    ...std,
    { value: `custom:${customKeyFromHeader(header)}`, label: `Eigene Spalte → {{${customKeyFromHeader(header)}}}` },
    { value: "ignore", label: "Nicht importieren" },
  ];
}

export function ImportWizard({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [step, setStep] = useState<"upload" | "mapping" | "report">("upload");
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [listName, setListName] = useState("");
  const [updateExisting, setUpdateExisting] = useState(true);
  const [checkMx, setCheckMx] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReportDto | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const reset = () => {
    setStep("upload");
    setPreview(null);
    setReport(null);
    setMapping({});
    setListName("");
  };
  const close = () => {
    reset();
    onClose();
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const p = await api.upload<ImportPreviewDto>("/api/leads/import/preview", form);
      setPreview(p);
      setMapping(p.mapping);
      setListName(file.name.replace(/\.[^.]+$/, ""));
      setStep("mapping");
    } catch (err) {
      notifyError(err, "Datei konnte nicht gelesen werden");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await api.post<ImportReportDto>("/api/leads/import/commit", { importId: preview.importId, mapping, listName, updateExisting, checkMx });
      setReport(r);
      setStep("report");
      await queryClient.invalidateQueries({ queryKey: ["/api/lead-lists"] });
      await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/leads") });
      await queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
    } catch (err) {
      notifyError(err, "Import fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  };

  const emailMapped = Object.values(mapping).includes("email");

  return (
    <Modal opened={opened} onClose={close} title="Kontakte importieren" size="xl">
      {step === "upload" && (
        <Stack>
          <Dropzone onDrop={(files) => files[0] && upload(files[0])} accept={ACCEPT} maxSize={25 * 1024 * 1024} multiple={false} loading={busy}>
            <Group justify="center" gap="xl" mih={180} style={{ pointerEvents: "none" }}>
              <Dropzone.Accept>
                <IconUpload size={48} stroke={1.5} />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX size={48} stroke={1.5} />
              </Dropzone.Reject>
              <Dropzone.Idle>
                <IconFileSpreadsheet size={48} stroke={1.5} />
              </Dropzone.Idle>
              <div>
                <Text size="lg" inline>
                  CSV- oder Excel-Datei hierher ziehen oder klicken
                </Text>
                <Text size="sm" c="dimmed" mt={7}>
                  Erste Zeile = Spaltenüberschriften. Benötigt wird mindestens eine Spalte mit E-Mail-Adressen.
                </Text>
              </div>
            </Group>
          </Dropzone>
          <Alert variant="light">
            Tipp: Je mehr Informationen (Vorname, Firma, Position, Website), desto persönlicher werden die Mails. Zusätzliche Spalten (z. B. „Branche“) werden automatisch zu Platzhaltern wie {"{{branche}}"}.
          </Alert>
        </Stack>
      )}

      {step === "mapping" && preview && (
        <Stack>
          <Text size="sm">
            <b>{preview.fileName}</b>: {preview.totalRows.toLocaleString("de-DE")} Zeilen gefunden. Bitte prüfen Sie die Zuordnung der Spalten.
          </Text>
          <div className="table-scroll">
            <Table striped withTableBorder verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Spalte in der Datei</Table.Th>
                  <Table.Th>Beispiele</Table.Th>
                  <Table.Th w={290}>Wird zu</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.headers.map((h, i) => (
                  <Table.Tr key={h}>
                    <Table.Td fw={500}>{h}</Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {preview.sample
                          .map((r) => r[i])
                          .filter(Boolean)
                          .slice(0, 3)
                          .join(" · ") || "–"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Select size="xs" data={optionsFor(h)} value={mapping[h] ?? "ignore"} onChange={(v) => v && setMapping((m) => ({ ...m, [h]: v }))} allowDeselect={false} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
          {!emailMapped && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              Bitte eine Spalte als „E-Mail“ zuordnen.
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Name der Liste" value={listName} onChange={(e) => setListName(e.currentTarget.value)} description="Unter diesem Namen wählen Sie die Kontakte später für Kampagnen aus." />
            <Stack gap="xs" mt={4}>
              <Switch checked={updateExisting} onChange={(e) => setUpdateExisting(e.currentTarget.checked)} label="Vorhandene Kontakte mit neuen Angaben ergänzen" />
              <Switch checked={checkMx} onChange={(e) => setCheckMx(e.currentTarget.checked)} label="Domains prüfen (können sie E-Mails empfangen?)" description="Verhindert Bounces. Dauert bei großen Listen etwas." />
            </Stack>
          </SimpleGrid>
          <Group justify="space-between">
            <Button variant="default" onClick={reset}>
              Andere Datei
            </Button>
            <Button onClick={commit} loading={busy} disabled={!emailMapped}>
              {preview.totalRows.toLocaleString("de-DE")} Zeilen importieren
            </Button>
          </Group>
        </Stack>
      )}

      {step === "report" && report && (
        <Stack>
          <Group gap="xs">
            <ThemeIcon color="teal" radius="xl">
              <IconCheck size={16} />
            </ThemeIcon>
            <Text fw={600}>Import abgeschlossen – Liste „{report.listName}“</Text>
          </Group>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <StatCard label="Neu" value={report.imported} color="teal" />
            <StatCard label="Bereits vorhanden" value={report.updated} />
            <StatCard label="Ungültig" value={report.invalid.length} color={report.invalid.length ? "red" : undefined} />
            <StatCard label="Auf Sperrliste" value={report.suppressed} />
          </SimpleGrid>
          {(report.warnings.role > 0 || report.warnings.freemail > 0 || report.duplicatesInFile > 0) && (
            <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} title="Bitte beachten">
              <List size="sm" spacing={2}>
                {report.duplicatesInFile > 0 && <List.Item>{report.duplicatesInFile} doppelte Adressen in der Datei wurden zusammengeführt.</List.Item>}
                {report.warnings.role > 0 && <List.Item>{report.warnings.role} Rollenadressen (info@, kontakt@ …) – diese antworten seltener und werden öfter als Spam markiert.</List.Item>}
                {report.warnings.freemail > 0 && (
                  <List.Item>{report.warnings.freemail} private Freemail-Adressen (gmx.de, web.de …) – an Privatpersonen ist Werbung per E-Mail ohne Einwilligung unzulässig.</List.Item>
                )}
              </List>
            </Alert>
          )}
          {report.invalid.length > 0 && (
            <div>
              <Text size="sm" fw={600} mb={4}>
                Nicht importiert:
              </Text>
              <Table withTableBorder fz="xs">
                <Table.Tbody>
                  {report.invalid.slice(0, 15).map((i) => (
                    <Table.Tr key={`${i.row}-${i.email}`}>
                      <Table.Td w={80}>Zeile {i.row}</Table.Td>
                      <Table.Td>{i.email || <Text span c="dimmed">(leer)</Text>}</Table.Td>
                      <Table.Td>
                        <Badge size="xs" color="gray" variant="light">
                          {i.reason}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {report.invalid.length > 15 && (
                <Text size="xs" c="dimmed" mt={4}>
                  … und {report.invalid.length - 15} weitere.
                </Text>
              )}
            </div>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Schließen
            </Button>
            <Button
              onClick={() => {
                close();
                navigate(`/kampagnen/neu?listId=${report.listId}`);
              }}
            >
              Kampagne mit dieser Liste erstellen
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
