import { ConfigProvider, theme, App as AntApp } from "antd";
import { AppLayout } from "./components/layout/AppLayout";

export function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#a78bfa",
          colorBgContainer: "#18181b",
          colorBgElevated: "#27272a",
          colorBgLayout: "#09090b",
          colorBorder: "#27272a",
          borderRadius: 6,
        },
      }}
    >
      <AntApp>
        <AppLayout />
      </AntApp>
    </ConfigProvider>
  );
}
