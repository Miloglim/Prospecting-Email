import { useEffect, useState } from "react";
import { Segmented } from "antd";
import { UnorderedListOutlined, PartitionOutlined, BankOutlined } from "@ant-design/icons";
import { ContactList } from "../contacts/ContactList";
import { CrmPipeline } from "../crm/CrmPipeline";
import { CompanyPage } from "../companies/CompanyPage";

type View = "table" | "board" | "company";

/** 从 hash 读取 view 参数（#/customers?view=board&detail=5） */
function parseView(): View {
  const rawHash = window.location.hash;
  const qs = rawHash.includes("?") ? rawHash.split("?")[1] : "";
  const v = new URLSearchParams(qs).get("view");
  return v === "board" || v === "company" ? v : "table";
}

/**
 * 客户 — 原 联系人 / 客户跟进 / 公司 三个路由合并为单页三视图。
 * 三者是同一批数据的三个投影：表格=全量档案，看板=跟进管线，公司=聚合维度。
 *
 * 深链约定（其余 query 参数由各子组件自行解析，均为路由无关的 query 级解析）：
 *   #/customers?view=table&detail=123        打开联系人详情
 *   #/customers?view=table&add=1&email=..    新增联系人预填
 *   #/customers?view=board&detail=123        打开 CRM 详情
 */
export function CustomersPage() {
  const [view, setView] = useState<View>(() => parseView());

  // 外部页面通过 window.location.hash 写深链时同步视图。
  // 只在 hash 明确携带 view 参数时才切换 —— 子组件解析完参数会把 hash
  // 清回裸的 #/customers（无 view），若不区分会把视图误重置为默认表格。
  useEffect(() => {
    const onHashChange = () => {
      const v = parseView();
      const rawHash = window.location.hash;
      const qs = rawHash.includes("?") ? rawHash.split("?")[1] : "";
      if (new URLSearchParams(qs).get("view")) setView(v);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Segmented<View>
          value={view}
          onChange={(v) => setView(v)}
          options={[
            { value: "table", label: "联系人", icon: <UnorderedListOutlined /> },
            { value: "board", label: "跟进看板", icon: <PartitionOutlined /> },
            { value: "company", label: "公司", icon: <BankOutlined /> },
          ]}
        />
      </div>

      {/* 切换视图时重挂载子组件：各自持有筛选/分页/抽屉状态，互不干扰 */}
      {view === "table" && <ContactList />}
      {view === "board" && <CrmPipeline />}
      {view === "company" && <CompanyPage />}
    </div>
  );
}
