import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  List,
  Loader,
  Menu,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconBraces, IconChevronLeft, IconChevronRight, IconAlertTriangle, IconCircleCheck, IconInfoCircle } from "@tabler/icons-react";
import { api, useApi } from "../api";
import { checkSpam } from "../../shared/spamcheck";
import { STANDARD_VARIABLES } from "../../shared/template";
import type { CampaignLeadDto, CampaignStepDto, Formality, OptOutMode, Paged, PreviewDto, SettingsDto, SpamCheckResult } from "../../shared/types";

/** Menü zum Einfügen von Platzhaltern an der Cursor-Position. */
export function VariableMenu({ onInsert, aiEnabled }: { onInsert: (text: string) => void; aiEnabled: boolean }) {
  const fields = useApi<string[]>("/api/leads/fields");
  const settings = useApi<SettingsDto>("/api/settings");
  const groups: { label: string; items: { key: string; label: string }[] }[] = [
    { label: "Kontakt", items: STANDARD_VARIABLES.filter((v) => v.group === "kontakt").map((v) => ({ key: v.key, label: v.label })) },
    { label: "Absender", items: STANDARD_VARIABLES.filter((v) => v.group === "absender").map((v) => ({ key: v.key, label: v.label })) },
    {
      label: "Sonstiges",
      items: STANDARD_VARIABLES.filter((v) => v.group === "system" && (v.key !== "ki_einstieg" || aiEnabled)).map((v) => ({ key: v.key, label: v.label })),
    },
  ];
  if (fields.data?.length) groups.push({ label: "Eigene Spalten", items: fields.data.map((k) => ({ key: k, label: k })) });
  const globals = Object.keys(settings.data?.globalVariables ?? {});
  if (globals.length) groups.push({ label: "Eigene Platzhalter", items: globals.map((k) => ({ key: k, label: k })) });

  return (
    <Menu position="bottom-start" withinPortal shadow="md" width={320}>
      <Menu.Target>
        <Button size="xs" variant="light" leftSection={<IconBraces size={14} />}>
          Platzhalter einfügen
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <ScrollArea.Autosize mah={360}>
          {groups.map((g) => (
            <div key={g.label}>
              <Menu.Label>{g.label}</Menu.Label>
              {g.items.map((v) => (
                <Menu.Item key={v.key} onClick={() => onInsert(`{{${v.key}}}`)}>
                  <Text size="sm">{v.label}</Text>
                  <Text size="xs" c="dimmed" ff="monospace">{`{{${v.key}}}`}</Text>
                </Menu.Item>
              ))}
            </div>
          ))}
        </ScrollArea.Autosize>
      </Menu.Dropdown>
    </Menu>
  );
}

/** Fügt Text an der Cursorposition eines Textfelds ein. */
export function useInsertAtCursor(value: string, onChange: (v: string) => void) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const insert = (text: string) => {
    const el = ref.current;
    if (!el) {
      onChange(value + text);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };
  return { ref, insert };
}

const LEVEL_COLOR: Record<SpamCheckResult["level"], string> = { niedrig: "teal", mittel: "yellow", hoch: "red" };

export function SpamCheckPanel({ subject, body, isFirstStep }: { subject: string; body: string; isFirstStep: boolean }) {
  const result = checkSpam({ subject, body, isFirstStep });
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" mb={6}>
        <Text size="sm" fw={600}>
          Spam-Check
        </Text>
        <Badge color={LEVEL_COLOR[result.level]} variant="light">
          Risiko {result.level}
        </Badge>
      </Group>
      <List size="xs" spacing={4} center>
        {result.findings.map((f) => (
          <List.Item
            key={f.message}
            icon={
              <ThemeIcon size={16} radius="xl" variant="light" color={f.severity === "high" ? "red" : f.severity === "warn" ? "yellow" : "gray"}>
                {f.severity === "info" ? <IconInfoCircle size={11} /> : <IconAlertTriangle size={11} />}
              </ThemeIcon>
            }
          >
            {f.message}
          </List.Item>
        ))}
      </List>
    </Paper>
  );
}

/** Live-Vorschau eines Schritts mit echtem Kontakt (über die Server-Vorschau). */
export function EmailPreview(props: {
  campaignId: number | null;
  steps: CampaignStepDto[];
  position: number;
  optOutMode: OptOutMode;
  formality: Formality;
}) {
  const [leadIndex, setLeadIndex] = useState(0);
  const leads = useApi<Paged<CampaignLeadDto>>(props.campaignId ? `/api/campaigns/${props.campaignId}/leads?pageSize=50` : null);
  const leadList = leads.data?.items ?? [];
  const leadId = leadList.length ? leadList[Math.min(leadIndex, leadList.length - 1)]?.leadId ?? null : null;
  const payload = JSON.stringify({ campaignId: props.campaignId, steps: props.steps, position: props.position, optOutMode: props.optOutMode, formality: props.formality, leadId });
  const [debounced] = useDebouncedValue(payload, 400);
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .post<PreviewDto>("/api/campaigns/preview", JSON.parse(debounced))
      .then((p) => {
        if (!cancelled) {
          setPreview(p);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap={6}>
          <Text size="sm" fw={600}>
            Vorschau
          </Text>
          {loading && <Loader size="xs" />}
        </Group>
        <Group gap={4} wrap="nowrap">
          <Tooltip label="Vorheriger Kontakt">
            <ActionIcon variant="subtle" size="sm" disabled={leadList.length < 2} onClick={() => setLeadIndex((i) => (i - 1 + leadList.length) % leadList.length)} aria-label="Vorheriger Kontakt">
              <IconChevronLeft size={16} />
            </ActionIcon>
          </Tooltip>
          <Text size="xs" c="dimmed" maw={190} truncate>
            {preview?.leadLabel ?? "…"}
          </Text>
          <Tooltip label="Nächster Kontakt">
            <ActionIcon variant="subtle" size="sm" disabled={leadList.length < 2} onClick={() => setLeadIndex((i) => (i + 1) % leadList.length)} aria-label="Nächster Kontakt">
              <IconChevronRight size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      {preview && (
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            Von: {preview.from}
            <br />
            An: {preview.to}
          </Text>
          <Text size="sm" fw={600}>
            {preview.subject || <Text span c="red">(kein Betreff)</Text>}
          </Text>
          <div className="mail-preview">{preview.body}</div>
          {preview.missing.length > 0 ? (
            <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
              <Text size="xs">
                Für diesen Kontakt fehlt: {preview.missing.map((m) => `{{${m}}}`).join(", ")} – er würde übersprungen. Tipp: Ersatztext angeben, z. B. {`{{${preview.missing[0]}|…}}`}.
              </Text>
            </Alert>
          ) : (
            <Group gap={4}>
              <IconCircleCheck size={14} color="var(--mantine-color-teal-6)" />
              <Text size="xs" c="dimmed">
                Alle Platzhalter für diesen Kontakt gefüllt.
              </Text>
            </Group>
          )}
        </Stack>
      )}
    </Paper>
  );
}
