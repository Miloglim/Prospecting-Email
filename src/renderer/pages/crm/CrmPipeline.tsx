import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, Select, Button, Tag, message, Collapse } from "antd";
import { SwapOutlined } from "@ant-design/icons";

const STAGE_COLORS: Record<string, string> = {
  new: "default", contacted: "blue", replied: "cyan",
  interested: "purple", negotiating: "orange", won: "green", lost: "red",
};

const STAGE_LABELS: Record<string, string> = {
  new: "新线索", contacted: "已联系", replied: "已回复",
  interested: "有意向", negotiating: "谈判中", won: "已成交", lost: "已丢失",
};

interface PipelineContact {
  id: number; email: string; firstName: string | null;
  lastName: string | null; companyName: string | null;
  notes: string | null; reminderAt: string | null;
}

interface StageData {
  stage: string; contacts: PipelineContact[];
}

export function CrmPipeline() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["crm"],
    queryFn: () => window.api.invoke("crm:listPipeline") as Promise<{
      success: boolean; data?: StageData[]; error?: string;
    }>,
  });

  const setStageMut = useMutation({
    mutationFn: (params: { contactId: number; stage: string }) =>
      window.api.invoke("crm:setStage", params),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["crm"] }); },
  });

  const stages = data?.success ? data.data || [] : [];

  const moveToStage = async (contactId: number, currentStage: string) => {
    const stageIdx = stages.findIndex(s => s.stage === currentStage);
    const nextStage = stages[stageIdx + 1]?.stage;
    if (!nextStage) { message.warning("已是最后一个阶段"); return; }
    const result = await setStageMut.mutateAsync({ contactId, stage: nextStage });
    result?.success ? message.success(`→ ${STAGE_LABELS[nextStage]}`)
      : message.error(result?.error || "操作失败");
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: "calc(100vh - 120px)" }}>
      {isLoading ? <Card loading className="w-full" /> :
        stages.map(s => (
          <div key={s.stage} className="flex-shrink-0" style={{ width: 280 }}>
            {/* 阶段标题 */}
            <div className="flex items-center justify-between mb-3 px-2">
              <div className="flex items-center gap-2">
                <Tag color={STAGE_COLORS[s.stage]}>{STAGE_LABELS[s.stage]}</Tag>
                <span className="text-xs text-zinc-500">{s.contacts.length}</span>
              </div>
            </div>

            {/* 联系人卡片 */}
            <div className="space-y-2">
              {s.contacts.map(c => (
                <Card key={c.id} size="small" className="bg-zinc-900 border-zinc-800"
                  actions={[
                    <Button key="move" type="text" size="small" icon={<SwapOutlined />}
                      onClick={() => moveToStage(c.id, s.stage)}
                    />,
                  ]}
                >
                  <div className="text-sm font-mono text-violet-400 truncate">{c.email}</div>
                  <div className="text-xs text-zinc-400">
                    {[c.firstName, c.lastName].filter(Boolean).join(" ") || "未命名"}
                  </div>
                  {c.companyName && (
                    <div className="text-xs text-zinc-500 mt-1">{c.companyName}</div>
                  )}
                  {c.reminderAt && (
                    <div className="text-xs text-amber-500 mt-1">
                      提醒: {new Date(c.reminderAt).toLocaleDateString("zh-CN")}
                    </div>
                  )}
                </Card>
              ))}
              {s.contacts.length === 0 && (
                <div className="text-center text-zinc-600 text-sm py-8">空</div>
              )}
            </div>
          </div>
        ))
      }
    </div>
  );
}
