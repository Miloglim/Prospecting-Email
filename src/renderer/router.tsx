import { createRootRoute, createRoute, createRouter, createHashHistory, Outlet } from "@tanstack/react-router";
import { AppLayout } from "./components/layout/AppLayout";
import { Dashboard } from "./pages/dashboard/Dashboard";
import { ContactList } from "./pages/contacts/ContactList";
import { CrmPipeline } from "./pages/crm/CrmPipeline";
import { InboxList } from "./pages/inbox/InboxList";
import { CampaignList } from "./pages/campaigns/CampaignList";
import { TemplateList } from "./pages/templates/TemplateList";
import { HistoryPage } from "./pages/history/HistoryPage";
import { CompanyPage } from "./pages/companies/CompanyPage";
import { QueuePage } from "./pages/queue/QueuePage";
import { SettingsPage } from "./pages/settings/SettingsPage";

const rootRoute = createRootRoute({
  component: () => <AppLayout />,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: ContactList,
});

const crmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/crm",
  component: CrmPipeline,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxList,
});

const campaignsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/campaigns",
  component: CampaignList,
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  component: TemplateList,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryPage,
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: QueuePage,
});

const companiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies",
  component: CompanyPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  contactsRoute,
  crmRoute,
  inboxRoute,
  campaignsRoute,
  templatesRoute,
  historyRoute,
  queueRoute,
  companiesRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
