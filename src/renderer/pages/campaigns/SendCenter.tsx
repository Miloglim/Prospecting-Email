import { useState } from "react";
import { Tabs } from "antd";
import { CampaignTasks } from "./CampaignTasks";
import { CampaignWizard } from "./CampaignWizard";
import { HistoryPage } from "../history/HistoryPage";

/**
 * 发送中心 — 开发任务为唯一操作入口。
 * 创建/编辑任务在子窗口（Modal 向导）内完成，配置好的任务组以卡片形式展示在开发任务页；
 * 发送引擎（队列的启动/暂停/止损横幅）以紧凑状态条内嵌在开发任务页顶部，不再单独设页。
 * 首页「自动开发信」跳转：#/campaigns?create=1 → 直接打开创建子窗口。
 */
export function SendCenter() {
  const [tab, setTab] = useState<string>(() => {
    const h = window.location.hash;
    const qs = h.includes("?") ? h.split("?")[1] : "";
    return new URLSearchParams(qs).get("tab") || "tasks";
  });
  const [wizardOpen, setWizardOpen] = useState(() => {
    const h = window.location.hash;
    const qs = h.includes("?") ? h.split("?")[1] : "";
    return new URLSearchParams(qs).get("create") === "1";
  });
  const [editingDraft, setEditingDraft] = useState<string | null>(null);

  return (
    <>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        size="small"
        items={[
          {
            key: "tasks", label: "开发任务",
            children: (
              <CampaignTasks
                onCreate={() => { setEditingDraft(null); setWizardOpen(true); }}
                onEdit={(id) => { setEditingDraft(id); setWizardOpen(true); }}
              />
            ),
          },
          { key: "history", label: "发送历史", children: <HistoryPage /> },
        ]}
      />
      <CampaignWizard
        key={`${editingDraft ?? "new"}-${wizardOpen}`}
        open={wizardOpen}
        draftId={editingDraft}
        onClose={() => setWizardOpen(false)}
        onDone={() => setWizardOpen(false)}
      />
    </>
  );
}
