import { createRootRoute, createRoute, createRouter, createHashHistory, Outlet } from "@tanstack/react-router";
import { AppLayout } from "./components/layout/AppLayout";
import { Dashboard } from "./pages/dashboard/Dashboard";
import { AssistantPage } from "./pages/assistant/AssistantPage";
import { CustomersPage } from "./pages/customers/CustomersPage";
import { InboxList } from "./pages/inbox/InboxList";
import { RateBoard } from "./pages/rates/RateBoard";
import { SendCenter } from "./pages/campaigns/SendCenter";
import { TemplateList } from "./pages/templates/TemplateList";
import { SettingsPage } from "./pages/settings/SettingsPage";

const rootRoute = createRootRoute({
  component: () => <AppLayout />,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

const assistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/assistant",
  component: AssistantPage,
});

const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers",
  component: CustomersPage,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxList,
});

const ratesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rates",
  component: RateBoard,
});

const campaignsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/campaigns",
  component: SendCenter,
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  component: TemplateList,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  assistantRoute,
  customersRoute,
  inboxRoute,
  ratesRoute,
  campaignsRoute,
  templatesRoute,
  settingsRoute,
]);

/** 冷启动默认页 = 新对话：地址里没有路由（无 hash 或裸 "#/"）时，先把地址定到 /assistant 再建 router。
 *  只改首屏落地——深链（#/inbox?… 等）照旧直达，点 Logo 主动回仪表盘（navigate to:"/"）也不受影响。
 *  用 replaceState 而非改 location：不新增历史记录、不触发 hashchange（此刻 router 还没挂）。 */
const bootHash = window.location.hash;
if (bootHash === "" || bootHash === "#" || bootHash === "#/") {
  window.history.replaceState(null, "", "#/assistant");
}

export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
