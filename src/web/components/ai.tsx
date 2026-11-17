import { Alert, Card, Stack, Switch, Text, Textarea, Title } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import type { CampaignDto, CampaignStepDto } from "../../shared/types";
import type { Draft } from "../pages/CampaignEditor";

/** KI-Schreibhilfe – vollständige Umsetzung folgt in Meilenstein 6. */
export function AiWriterButton(_props: { draft: Draft; onApply: (steps: CampaignStepDto[]) => void }) {
  return null;
}

/** Schritt "KI-Personalisierung" im Kampagnen-Assistenten. */
export function AiOpenersStep({ draft, update }: { draft: Draft; update: (p: Partial<Draft>) => void; campaign: CampaignDto | null; onSave: () => Promise<number | null> }) {
  return (
    <Card>
      <Stack>
        <Title order={5}>Persönlicher Einstieg per KI</Title>
        <Switch checked={draft.aiEnabled} onChange={(e) => update({ aiEnabled: e.currentTarget.checked })} label="KI-Einstiege für diese Kampagne verwenden" />
        <Textarea
          label="Worum geht es?"
          description="Ihr Angebot, die Zielgruppe und worauf der Einstieg eingehen soll."
          autosize
          minRows={4}
          value={draft.aiContext}
          onChange={(e) => update({ aiContext: e.currentTarget.value })}
          disabled={!draft.aiEnabled}
        />
        <Alert variant="light" icon={<IconInfoCircle size={18} />}>
          <Text size="sm">Die Erstellung und Freigabe der Einstiege wird im nächsten Schritt der Entwicklung ergänzt.</Text>
        </Alert>
      </Stack>
    </Card>
  );
}
