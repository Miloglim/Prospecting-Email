import React, { createContext, useContext, useState } from "react";

interface AppContextType {
  theme: "dark" | "light";
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  selectedAccountId: number | null;
  setSelectedAccountId: (id: number | null) => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  return (
    <AppContext.Provider value={{
      theme: "dark",
      sidebarCollapsed,
      toggleSidebar: () => setSidebarCollapsed(v => !v),
      selectedAccountId,
      setSelectedAccountId,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext 必须在 AppProvider 内使用");
  return ctx;
}
