import { useState } from "react";
import { Button, Center, Paper, PasswordInput, Stack, Text, ThemeIcon, Title, Alert } from "@mantine/core";
import { IconMail, IconAlertCircle } from "@tabler/icons-react";
import { api } from "../api";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/api/login", { password });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Center mih="100vh" p="md" bg="var(--mantine-color-body)">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={380}>
        <form onSubmit={submit}>
          <Stack>
            <Stack gap={6} align="center">
              <ThemeIcon size={48} radius="xl" variant="light">
                <IconMail size={26} />
              </ThemeIcon>
              <Title order={2}>Cold-Emails</Title>
              <Text c="dimmed" size="sm" ta="center">
                Personalisierte Cold-Emails, die ankommen.
              </Text>
            </Stack>
            {error && (
              <Alert color="red" icon={<IconAlertCircle size={18} />}>
                {error}
              </Alert>
            )}
            <PasswordInput
              label="Passwort"
              description="Das ADMIN_PASSWORD aus der Datei .env"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoFocus
              required
            />
            <Button type="submit" loading={loading} fullWidth>
              Anmelden
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
