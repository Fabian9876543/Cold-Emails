import type { ReactNode } from "react";
import { Badge, Center, Group, Loader, Paper, Stack, Text, ThemeIcon, Title, Alert } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="lg" wrap="wrap" gap="sm">
      <Stack gap={4} style={{ flex: 1, minWidth: 240 }}>
        <Title order={2}>{title}</Title>
        {description && (
          <Text c="dimmed" size="sm">
            {description}
          </Text>
        )}
      </Stack>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: ReactNode; action?: ReactNode }) {
  return (
    <Paper withBorder p="xl">
      <Stack align="center" gap="sm" py="lg">
        <ThemeIcon size={56} radius="xl" variant="light">
          {icon}
        </ThemeIcon>
        <Title order={4}>{title}</Title>
        <Text c="dimmed" ta="center" maw={520} size="sm">
          {text}
        </Text>
        {action}
      </Stack>
    </Paper>
  );
}

export function Loading() {
  return (
    <Center py="xl">
      <Loader />
    </Center>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  return (
    <Alert color="red" icon={<IconAlertCircle size={18} />} title="Fehler beim Laden">
      {error instanceof Error ? error.message : String(error)}
    </Alert>
  );
}

export function StatusBadge({ map, value }: { map: Record<string, { label: string; color: string }>; value: string }) {
  const s = map[value] ?? { label: value, color: "gray" };
  return (
    <Badge color={s.color} variant="light" className="nowrap">
      {s.label}
    </Badge>
  );
}

export function StatCard({ label, value, hint, color }: { label: string; value: ReactNode; hint?: ReactNode; color?: string }) {
  return (
    <Paper withBorder p="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="xl" fw={700} c={color}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Paper>
  );
}
