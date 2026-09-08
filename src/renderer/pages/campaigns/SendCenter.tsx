import { useState } from "react";
import { Tabs } from "antd";
import { CampaignList } from "./CampaignList";
import { CampaignTasks } from "./CampaignTasks";
import { QueuePage } from "../queue/QueuePage";
import { HistoryPage } from "../history/HistoryPage";

/**
 * 发送中心 — 原 邮件发送 / 发送队列 / 发送总览 三个路由合并为单页三 tab。
 * 创建 → 执行 → 复盘 本是一条流水线，拆成三个路由导致来回跳转。
 * 不设 destroyOnHidden：切 tab 即卸载重挂是选人页/队列页每次切换都卡的主因，
 * 还会弄丢向导状态（已选的人、步骤）。已访问的 tab 保持挂载 —— 隐藏时的轮询
 * 成本可忽略（send:status 2s 轮询负载极小），离开整个路由时随 SendCenter 卸载。
 */
export function SendCenter() {
  // 初始 tab 支持 hash 参数（首页「自动开发信」跳转：#/campaigns?tab=new）
  const [tab, setTab] = useState<string>(() => {
    const h = window.location.hash;
    const qs = h.includes("?") ? h.split("?")[1] : "";
    return new URLSearchParams(qs).get("tab") || "tasks";
  });

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      size="small"
      items={[
        { key: "tasks", label: "发信任务", children: <CampaignTasks /> },
        { key: "new", label: "新建任务", children: <CampaignList goToQueue={() => setTab("queue")} /> },
        { key: "queue", label: "发送队列", children: <QueuePage /> },
        { key: "history", label: "发送历史", children: <HistoryPage /> },
      ]}
    />
  );
}
