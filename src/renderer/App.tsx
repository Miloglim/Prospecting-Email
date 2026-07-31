import { RouterProvider } from "@tanstack/react-router";
import { ConfigProvider, App as AntApp } from "antd";
import { AppProvider } from "./AppContext";
import { router } from "./router";

export function App() {
  return (
    <AppProvider>
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: "#1a1a1a",
            colorBgContainer: "#ffffff",
            colorBgElevated: "#ffffff",
            colorBgLayout: "#f5f5f5",
            colorBorder: "#e0e0e0",
            colorText: "#1a1a1a",
            colorTextSecondary: "#6b6b6b",
            borderRadius: 8,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          },
        }}
      >
        <AntApp>
          <RouterProvider router={router} />
        </AntApp>
      </ConfigProvider>
    </AppProvider>
  );
}
