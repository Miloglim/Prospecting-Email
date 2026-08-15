import React, { createContext, useContext, useState } from "react";

interface AppContextType {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <AppContext.Provider value={{
      sidebarCollapsed,
      toggleSidebar: () => setSidebarCollapsed(v => !v),
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
