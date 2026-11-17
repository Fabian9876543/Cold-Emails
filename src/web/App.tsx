import { useEffect, useState } from "react";
import { Navigate, NavLink as RouterNavLink, Route, Routes, useLocation } from "react-router";
import { AppShell, Badge, Burger, Center, Group, Loader, NavLink, ScrollArea, Text, Tooltip, ActionIcon, useMantineColorScheme } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconHome,
  IconSend,
  IconUsers,
  IconInbox,
  IconMail,
  IconShieldCheck,
  IconSettings,
  IconLogout,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";
import { api, useApi } from "./api";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { CampaignsPage } from "./pages/Campaigns";
import { CampaignEditorPage } from "./pages/CampaignEditor";
import { CampaignDetailPage } from "./pages/CampaignDetail";
import { LeadsPage } from "./pages/Leads";
import { InboxPage } from "./pages/Inbox";
import { MailboxesPage } from "./pages/Mailboxes";
import { DeliverabilityPage } from "./pages/Deliverability";
import { SettingsPage } from "./pages/Settings";
import { LegalNoticeModal } from "./components/LegalNotice";
import type { DashboardDto } from "../shared/types";

const NAV = [
  { to: "/", label: "Start", icon: IconHome },
  { to: "/kampagnen", label: "Kampagnen", icon: IconSend },
  { to: "/kontakte", label: "Kontakte", icon: IconUsers },
  { to: "/antworten", label: "Antworten", icon: IconInbox, badge: true },
  { to: "/postfaecher", label: "Postfächer", icon: IconMail },
  { to: "/zustellbarkeit", label: "Zustellbarkeit", icon: IconShieldCheck },
  { to: "/einstellungen", label: "Einstellungen", icon: IconSettings },
];

export function App() {
  const me = useApi<{ authenticated: boolean }>("/api/me", { staleTime: 60_000 });
  const queryClient = useQueryClient();

  useEffect(() => {
    const onUnauthorized = () => queryClient.setQueryData(["/api/me"], { authenticated: false });
    window.addEventListener("ce:unauthorized", onUnauthorized);
    return () => window.removeEventListener("ce:unauthorized", onUnauthorized);
  }, [queryClient]);

  if (me.isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (!me.data?.authenticated) {
    return <LoginPage onLoggedIn={() => queryClient.invalidateQueries()} />;
  }
  return <Shell />;
}

function Shell() {
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const dashboard = useApi<DashboardDto>("/api/dashboard", { refetchInterval: 60_000 });
  const unhandled = dashboard.data?.unhandledReplies ?? 0;
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => close(), [location.pathname, close]);

  const logout = async () => {
    setLoggingOut(true);
    await api.post("/api/logout").catch(() => undefined);
    queryClient.setQueryData(["/api/me"], { authenticated: false });
    setLoggingOut(false);
  };

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 230, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menü öffnen" />
            <IconMail size={22} stroke={1.8} color="var(--mantine-color-blue-6)" />
            <Text fw={700}>Cold-Emails</Text>
          </Group>
          <Group gap={4}>
            <Tooltip label={colorScheme === "dark" ? "Helles Design" : "Dunkles Design"}>
              <ActionIcon variant="subtle" color="gray" onClick={() => setColorScheme(colorScheme === "dark" ? "light" : "dark")} aria-label="Farbschema wechseln">
                {colorScheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Abmelden">
              <ActionIcon variant="subtle" color="gray" onClick={logout} loading={loggingOut} aria-label="Abmelden">
                <IconLogout size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              component={RouterNavLink}
              to={item.to}
              end={item.to === "/"}
              label={item.label}
              leftSection={<item.icon size={18} stroke={1.7} />}
              rightSection={item.badge && unhandled > 0 ? <Badge size="sm" circle>{unhandled}</Badge> : null}
              style={{ borderRadius: 8 }}
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>
        <LegalNoticeModal />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/kampagnen" element={<CampaignsPage />} />
          <Route path="/kampagnen/neu" element={<CampaignEditorPage />} />
          <Route path="/kampagnen/:id" element={<CampaignDetailPage />} />
          <Route path="/kampagnen/:id/bearbeiten" element={<CampaignEditorPage />} />
          <Route path="/kontakte" element={<LeadsPage />} />
          <Route path="/antworten" element={<InboxPage />} />
          <Route path="/postfaecher" element={<MailboxesPage />} />
          <Route path="/zustellbarkeit" element={<DeliverabilityPage />} />
          <Route path="/einstellungen" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
