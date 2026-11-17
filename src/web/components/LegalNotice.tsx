import { Button, Checkbox, Group, List, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, notifyError, useApi } from "../api";
import { LEGAL_NOTICE } from "../texte";
import type { SettingsDto } from "../../shared/types";

/** Wird einmalig angezeigt, bis der Hinweis bestätigt wurde. */
export function LegalNoticeModal() {
  const settings = useApi<SettingsDto>("/api/settings");
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const open = settings.data !== undefined && !settings.data.legalNoticeAccepted;

  const accept = async () => {
    setSaving(true);
    try {
      const data = await api.put<SettingsDto>("/api/settings", { legalNoticeAccepted: true });
      queryClient.setQueryData(["/api/settings"], data);
    } catch (err) {
      notifyError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={open} onClose={() => undefined} withCloseButton={false} title={LEGAL_NOTICE.title} size="lg" centered>
      <Stack>
        <List spacing="sm" size="sm">
          {LEGAL_NOTICE.paragraphs.map((p) => (
            <List.Item key={p}>{p}</List.Item>
          ))}
        </List>
        <Text size="xs" c="dimmed">
          Dieser Hinweis ist keine Rechtsberatung.
        </Text>
        <Checkbox checked={checked} onChange={(e) => setChecked(e.currentTarget.checked)} label="Ich habe den Hinweis gelesen und kümmere mich um die rechtliche Prüfung." />
        <Group justify="flex-end">
          <Button disabled={!checked} loading={saving} onClick={accept}>
            Verstanden
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
