import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppLayout } from "./components/layout/AppLayout";
import { Dashboard } from "./pages/dashboard/Dashboard";
import { ContactList } from "./pages/contacts/ContactList";
import { CompanyList } from "./pages/companies/CompanyList";
import { CrmPipeline } from "./pages/crm/CrmPipeline";
import { InboxList } from "./pages/inbox/InboxList";
import { CampaignList } from "./pages/campaigns/CampaignList";
import { TemplateList } from "./pages/templates/TemplateList";
import { ExportPage } from "./pages/export/ExportPage";
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

const companiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies",
  component: CompanyList,
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

const exportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/export",
  component: ExportPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  contactsRoute,
  companiesRoute,
  crmRoute,
  inboxRoute,
  campaignsRoute,
  templatesRoute,
  exportRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
