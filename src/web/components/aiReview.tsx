import { Text } from "@mantine/core";
import type { CampaignDto } from "../../shared/types";

/** Prüfung und Freigabe der KI-Einstiege – folgt in Meilenstein 6. */
export function AiReviewPanel(_props: { campaign: CampaignDto }) {
  return <Text c="dimmed">Die Freigabe der KI-Einstiege folgt im nächsten Schritt.</Text>;
}
