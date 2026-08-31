import { useState } from "react";
import { Tabs } from "antd";
import { CampaignList } from "./CampaignList";
import { QueuePage } from "../queue/QueuePage";
import { HistoryPage } from "../history/HistoryPage";

/**
 * 发送中心 — 原 邮件发送 / 发送队列 / 发送总览 三个路由合并为单页三 tab。
 * 创建 → 执行 → 复盘 本是一条流水线，拆成三个路由导致来回跳转。
 * destroyInactiveTabPane：切走时卸载队列页，避免隐藏状态下仍每 2s 轮询 send:status。
 */
export function SendCenter() {
  const [tab, setTab] = useState<string>("new");

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      size="small"
      destroyInactiveTabPane
      items={[
        { key: "new", label: "新建任务", children: <CampaignList goToQueue={() => setTab("queue")} /> },
        { key: "queue", label: "发送队列", children: <QueuePage /> },
        { key: "history", label: "发送历史", children: <HistoryPage /> },
      ]}
    />
  );
}
