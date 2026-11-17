import { useState } from "react";
import { ActionIcon, Anchor, Badge, Button, Card, Code, CopyButton, Group, List, PasswordInput, Stack, Text, TextInput, Title, Tooltip, Alert } from "@mantine/core";
import { IconBrandGoogle, IconCheck, IconCopy, IconInfoCircle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, notifyError, notifySuccess, useApi } from "../api";
import type { SettingsDto } from "../../shared/types";

/** Einrichtung von "Mit Google verbinden" (OAuth-App vom Typ "Intern" im eigenen Workspace). */
export function GoogleOAuthCard() {
  const settings = useApi<SettingsDto>("/api/settings");
  const redirect = useApi<{ redirectUri: string }>("/api/oauth/google/redirect-uri");
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  if (!settings.data) return null;
  const configured = settings.data.googleOAuthConfigured;
  const uri = redirect.data?.redirectUri ?? `${window.location.origin}/api/oauth/google/callback`;
  const insecure = uri.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(uri);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const data = await api.put<SettingsDto>("/api/settings", patch);
      queryClient.setQueryData(["/api/settings"], data);
      notifySuccess(patch.googleClientId === null ? "Google-Zugang entfernt." : "Google-Zugang gespeichert.");
      setClientId("");
      setClientSecret("");
    } catch (err) {
      notifyError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Group gap="xs" mb={4}>
        <IconBrandGoogle size={20} />
        <Title order={4}>„Mit Google verbinden“ (optional)</Title>
        {configured ? <Badge color="teal" variant="light">eingerichtet</Badge> : <Badge color="gray" variant="light">nicht eingerichtet</Badge>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Statt App-Passwörtern können Postfächer mit einem Klick über die Google-Anmeldung verbunden werden. Dafür legen Sie einmalig eine OAuth-App vom Typ „Intern“ in Ihrem Google Workspace an – für
        interne Apps verlangt Google keine Prüfung.
      </Text>
      <List size="sm" type="ordered" spacing={6} mb="md">
        <List.Item>
          In der{" "}
          <Anchor href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
            Google Cloud Console
          </Anchor>{" "}
          mit einem Workspace-Admin ein Projekt anlegen (z. B. „Cold-Emails“) und unter „APIs & Dienste → Bibliothek“ die <b>Gmail API</b> aktivieren.
        </List.Item>
        <List.Item>
          Unter{" "}
          <Anchor href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">
            Google Auth Platform
          </Anchor>{" "}
          den Zustimmungsbildschirm einrichten: Nutzertyp <b>Intern</b>, App-Name und Support-E-Mail eintragen.
        </List.Item>
        <List.Item>
          Unter „Clients“ einen neuen Client vom Typ <b>Webanwendung</b> erstellen und als autorisierte Weiterleitungs-URI eintragen:
          <Group gap={4} mt={4} wrap="nowrap">
            <Code className="mono-block">{uri}</Code>
            <CopyButton value={uri}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "Kopiert" : "Kopieren"}>
                  <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} onClick={copy} aria-label="URI kopieren">
                    {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
        </List.Item>
        <List.Item>Client-ID und Clientschlüssel unten eintragen. In der Google-Admin-Konsole muss der IMAP-Zugriff erlaubt sein (Gmail → Endnutzerzugriff).</List.Item>
      </List>
      {insecure && (
        <Alert color="yellow" variant="light" icon={<IconInfoCircle size={18} />} mb="md">
          Google erlaubt Weiterleitungen nur über HTTPS (Ausnahme: localhost). Auf einem Server bitte HTTPS einrichten und PUBLIC_BASE_URL setzen.
        </Alert>
      )}
      <Stack>
        <Group align="flex-end" wrap="wrap">
          <TextInput label="Client-ID" placeholder={configured ? "(hinterlegt – zum Ändern neu eingeben)" : "123456-abc.apps.googleusercontent.com"} value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} w={380} />
          <PasswordInput label="Clientschlüssel" placeholder="GOCSPX-…" value={clientSecret} onChange={(e) => setClientSecret(e.currentTarget.value)} w={260} />
          <Button onClick={() => save({ googleClientId: clientId, googleClientSecret: clientSecret })} disabled={!clientId.trim() || !clientSecret.trim()} loading={saving}>
            Speichern
          </Button>
          {configured && (
            <Button variant="subtle" color="red" onClick={() => save({ googleClientId: null, googleClientSecret: null })}>
              Entfernen
            </Button>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          Alternativ über GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET in der .env. Der Clientschlüssel und die Zugangs-Tokens der Postfächer werden verschlüsselt gespeichert.
        </Text>
      </Stack>
    </Card>
  );
}
