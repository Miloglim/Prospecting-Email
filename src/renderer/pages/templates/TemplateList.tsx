import { useState, useEffect, useCallback } from "react";
import { Table, Button, Input, Modal, Form, Select, message, Tag, Tabs, Card, Radio } from "antd";
import { PlusOutlined, DeleteOutlined, ImportOutlined, ThunderboltOutlined, EditOutlined, CopyOutlined, EyeOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RichTextEditor, HtmlText } from "../../components/RichTextEditor";

const LANGUAGES = ["EN", "ES", "PT"];
const CATEGORIES = ["direct", "peer", "general"];

const STAGE_LABELS: Record<string, string> = {
  initial: "初次接触", followup1: "首次跟进", followup2: "二次跟进",
  closing: "促单", reactivate: "重新激活",
};
const CATEGORY_LABELS: Record<string, string> = {
  direct: "直客", peer: "同行", general: "通用",
};

interface Template {
  id: number; name: string; language: string; subject: string; body: string;
  category: string | null; stage: string | null; version: number;
}

interface PresetTemplate {
  name: string; category: string; stage: string; variant: string; language: string;
  subject: string; body: string;
}

export function TemplateList() {
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [previewModal, setPreviewModal] = useState<{ subject: string; body: string } | null>(null);
  // ── 模板预览（仿旧 PE layout）──
  const [pvType, setPvType] = useState<string>("direct");
  const [pvLang, setPvLang] = useState<string>("EN");
  const [pvStage, setPvStage] = useState<string>("initial");
  const [pvSource, setPvSource] = useState<string>("preset");
  const [pvSeed, setPvSeed] = useState(0);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [form] = Form.useForm();
  const [aiForm] = Form.useForm();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: () => window.api.invoke("templates:list") as Promise<{
      success: boolean; data?: Template[]; error?: string;
    }>,
  });

  const { data: aiStatus } = useQuery({
    queryKey: ["ai", "status"],
    queryFn: () => window.api.invoke("ai:status") as Promise<{ success: boolean; data?: boolean }>,
  });
  const aiConfigured = aiStatus?.success ? !!aiStatus.data : false;

  const upsertMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("templates:upsert", input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["templates"] }); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => window.api.invoke("templates:delete", id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["templates"] }); },
  });

  const templates = data?.success ? data.data || [] : [];

  // ── 句库预览：调后端组装 ──
  const [pvFetching, setPvFetching] = useState(false);
  const [pvRendered, setPvRendered] = useState<{ subject: string; body: string } | null>(null);
  const [pvError, setPvError] = useState<string | null>(null);
  const fetchPreview = useCallback(async () => {
    setPvFetching(true);
    setPvError(null);
    try {
      if (pvSource === "user") {
        const matched = templates.filter(t =>
          (t.category === pvType || t.category === "general") &&
          (t.language === pvLang) &&
          (t.stage === pvStage || !t.stage)
        );
        if (matched.length === 0) { setPvRendered(null); return; }
        const tpl = matched[Math.abs(pvSeed * 2654435761) % matched.length]!;
        const r = await window.api.invoke("send:preview", { subject: tpl.subject, body: tpl.body }) as {
          success: boolean; data?: { subject: string; body: string };
        };
        setPvRendered(r?.success ? r.data! : null);
        if (!r?.success) setPvError((r as { error?: string }).error || "渲染失败");
      } else {
        const r = await window.api.invoke("send:preview", {
          lang: pvLang, clientType: pvType, stage: pvStage,
        }) as { success: boolean; data?: { subject: string; body: string }; error?: string };
        setPvRendered(r?.success ? r.data! : null);
        if (!r?.success) setPvError(r.error || "组装失败");
      }
    } catch (e) {
      setPvError(e instanceof Error ? e.message : String(e));
      setPvRendered(null);
    } finally {
      setPvFetching(false);
    }
  }, [pvType, pvLang, pvStage, pvSource, pvSeed, templates]);
  useEffect(() => { fetchPreview(); }, [fetchPreview]);
  const rendered = pvRendered;

  const columns = [
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "语言", dataIndex: "language", key: "language", width: 60,
      render: (v: string) => <Tag>{v}</Tag> },
    { title: "阶段", dataIndex: "stage", key: "stage", width: 80,
      render: (v: string | null) => v ? <Tag>{STAGE_LABELS[v] || v}</Tag> : "-" },
    { title: "主题", dataIndex: "subject", key: "subject" },
    { title: "分类", dataIndex: "category", key: "category", width: 100,
      render: (v: string | null) => v ? <Tag color="purple">{CATEGORY_LABELS[v] || v}</Tag> : "-" },
    { title: "版本", dataIndex: "version", key: "version", width: 60 },
    {
      title: "操作", key: "actions", width: 140,
      render: (_: unknown, r: Template) => (
        <div className="flex gap-1">
          <Button size="small" type="text" icon={<EditOutlined />}
            onClick={() => {
              form.setFieldsValue({ name: r.name, language: r.language, category: r.category, stage: r.stage, subject: r.subject, body: r.body });
              setEditingId(r.id);
              setAddOpen(true);
            }}
          />
          <Button size="small" type="text" icon={<CopyOutlined />}
            onClick={() => {
              form.setFieldsValue({ name: r.name + " (副本)", language: r.language, category: r.category, stage: r.stage, subject: r.subject, body: r.body });
              setEditingId(null);
              setAddOpen(true);
            }}
          />
          <Button danger size="small" type="text" icon={<DeleteOutlined />}
            onClick={async () => {
              const result = await deleteMut.mutateAsync(r.id);
              result?.success ? message.success("已删除") : message.error(result?.error || "失败");
            }}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Tabs
        size="small"
        items={[
          {
            key: "mine", label: `我的模板 (${templates.length})`,
            children: (
              <div className="space-y-4">
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600">{templates.length} 个模板</span>
                  <div className="flex gap-2">
                    <Button icon={<ThunderboltOutlined />}
                      onClick={() => { aiForm.resetFields(); setAiOpen(true); }}
                      disabled={!aiConfigured}
                    >AI 生成</Button>
                    <Button type="primary" icon={<PlusOutlined />}
                      onClick={() => { form.resetFields(); setEditingId(null); setAddOpen(true); }}>新增模板</Button>
                  </div>
                </div>
                <Table dataSource={templates} columns={columns} rowKey="id"
                  loading={isLoading} size="middle" />
              </div>
            ),
          },
          {
            key: "preview", label: "模板预览",
            children: (
              <div className="space-y-4">
                {/* 筛选条 */}
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-1 bg-gray-100 rounded p-0.5">
                    {[
                      { k: "direct", l: "直客" }, { k: "peer", l: "同行" }, { k: "general", l: "通用" },
                    ].map(t => (
                      <Button key={t.k} size="small" type={pvType === t.k ? "primary" : "text"}
                        className="text-xs !px-2 !py-0"
                        onClick={() => { setPvType(t.k); setPvSeed(0); }}
                      >{t.l}</Button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 bg-gray-100 rounded p-0.5">
                    {["EN", "ES", "PT"].map(l => (
                      <Button key={l} size="small" type={pvLang === l ? "primary" : "text"}
                        className="text-xs !px-2 !py-0"
                        onClick={() => { setPvLang(l); setPvSeed(0); }}
                      >{l}</Button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 bg-gray-100 rounded p-0.5">
                    {[
                      { k: "initial", l: "初次" }, { k: "followup1", l: "跟进1" },
                      { k: "followup2", l: "跟进2" }, { k: "closing", l: "促单" }, { k: "reactivate", l: "激活" },
                    ].map(s => (
                      <Button key={s.k} size="small" type={pvStage === s.k ? "primary" : "text"}
                        className="text-xs !px-2 !py-0"
                        onClick={() => { setPvStage(s.k); setPvSeed(0); }}
                      >{s.l}</Button>
                    ))}
                  </div>
                  <Select size="small" value={pvSource} onChange={v => { setPvSource(v); setPvSeed(0); }}
                    style={{ width: 110 }}
                    options={[
                      { value: "preset", label: "预设模板" },
                      { value: "user", label: "我的模板" },
                    ]}
                  />
                  <Button size="small" icon={<ReloadOutlined />}
                    onClick={() => setPvSeed(s => s + 1)}>换一组</Button>
                </div>

                {/* 结果 — 有旧内容时保留（刷新期间不清空，只替换预览框内容） */}
                {rendered ? (
                  <div className="space-y-3">
                    <div className="text-[10px] text-gray-400 flex items-center gap-2">
                      <Tag className="text-[9px]">{pvSource === "preset" ? "句库" : "我的模板"}</Tag>
                      <span>{CATEGORY_LABELS[pvType] || pvType} · {STAGE_LABELS[pvStage] || pvStage} · {pvLang}</span>
                    </div>
                    <div className="border rounded bg-white">
                      <div className="p-4 pb-2">
                        <div className="text-[10px] text-gray-400 mb-1">主题</div>
                        <div className="text-sm font-semibold text-gray-800 mb-4 pb-3 border-b">
                          {rendered.subject}
                        </div>
                      </div>
                      <div className="px-4 pb-4">
                        <HtmlText html={rendered.body} className="text-[13px] text-gray-700 leading-relaxed" />
                      </div>
                    </div>
                  </div>
                ) : pvFetching ? (
                  <div className="text-xs text-gray-400 py-16 text-center">加载中...</div>
                ) : pvError ? (
                  <div className="text-xs text-red-500 py-16 text-center">
                    预览出错：{pvError}
                  </div>
                ) : (
                  <div className="text-xs text-gray-400 py-16 text-center space-y-1">
                    <p>{pvSource === "user" && templates.length === 0
                      ? "尚无模板，请先在「我的模板」中创建"
                      : "该筛选条件下无匹配模板"}</p>
                    {pvSource === "user" && templates.length > 0 && (
                      <p className="text-[10px]">尝试调整上方的客户类型、语言或阶段筛选</p>
                    )}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />

      <Modal title={editingId ? "编辑模板" : "新增模板"} open={addOpen} width={640}
        confirmLoading={upsertMut.isPending}
        onCancel={() => { setAddOpen(false); form.resetFields(); setEditingId(null); }}
        onOk={async () => {
          try {
            const values = await form.validateFields();
            const payload = editingId ? { ...values, id: editingId } : values;
            const result = await upsertMut.mutateAsync(payload);
            if (result?.success) {
              setAddOpen(false); form.resetFields(); setEditingId(null);
              message.success("已保存");
            } else {
              message.error(result?.error || "保存失败");
            }
          } catch (err) {
            message.error("保存失败: " + (err instanceof Error ? err.message : String(err)));
          }
        }}
      >
        <Form form={form} layout="vertical" size="small">
          <div className="grid grid-cols-4 gap-3">
            <Form.Item name="name" label="名称" rules={[{ required: true }]}>
              <Input placeholder="模板名称" />
            </Form.Item>
            <Form.Item name="language" label="语言" rules={[{ required: true }]}>
              <Select options={LANGUAGES.map(l => ({ value: l, label: l }))} />
            </Form.Item>
            <Form.Item name="category" label="受众">
              <Select options={CATEGORIES.map(c => ({ value: c, label: CATEGORY_LABELS[c] || c }))} />
            </Form.Item>
            <Form.Item name="stage" label="阶段">
              <Select allowClear options={Object.entries(STAGE_LABELS).map(([k, v]) => ({ value: k, label: v }))} />
            </Form.Item>
          </div>
          <Form.Item name="subject" label="主题" rules={[{ required: true }]}>
            <Input placeholder="{{firstName}} — 关于您的货运需求" />
          </Form.Item>
          <Form.Item name="body" label="正文" rules={[{ required: true }]}>
            <RichTextEditor
              placeholder={"Hi {{firstName}},\n\nI noticed that your company..."}
              style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #d9d9d9", borderRadius: 6, padding: 8 }}
            />
          </Form.Item>
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-gray-400">
              变量：{"{{firstName}}"} {"{{lastName}}"} {"{{company}}"} {"{{title}}"} {"{{email}}"} &nbsp;|&nbsp;
              随机：{"{Hello|Hi|Hey}"}
            </div>
            <Button size="small" icon={<EyeOutlined />}
              onClick={async () => {
                const v = form.getFieldsValue();
                if (!v.subject || !v.body) { message.warning("请先填写主题和正文"); return; }
                const r = await window.api.invoke("send:preview", { subject: v.subject, body: v.body }) as {
                  success: boolean; data?: { subject: string; body: string }; error?: string;
                };
                if (r?.success && r.data) setPreviewModal(r.data);
                else message.error(r?.error || "预览失败");
              }}
            >预览渲染</Button>
          </div>
        </Form>
      </Modal>

      {/* 预览弹窗 */}
      <Modal title="渲染预览" open={!!previewModal} onCancel={() => setPreviewModal(null)}
        footer={null} width={520}
      >
        {previewModal && (
          <div className="text-sm space-y-3">
            <div className="font-semibold text-gray-800">{previewModal.subject}</div>
            <HtmlText html={previewModal.body} className="border-t pt-3 text-[13px] text-gray-700 leading-relaxed" />
          </div>
        )}
      </Modal>

      {/* AI 生成模板 */}
      <Modal title="AI 生成开发信" open={aiOpen} width={440}
        onCancel={() => setAiOpen(false)}
        okText="生成" confirmLoading={aiLoading}
        onOk={async () => {
          const v = await aiForm.validateFields();
          setAiLoading(true);
          try {
            const r = await window.api.invoke("ai:generateDraft", {
              companyName: v.companyName, contactName: v.contactName, language: v.language,
            }) as { success: boolean; data?: string; error?: string };
            if (!r?.success) { message.error(r?.error || "生成失败"); return; }
            // 解析 "SUBJECT: xxx\n\n正文" 格式
            const text = r.data || "";
            const m = text.match(/^SUBJECT:\s*([^\n]+)\s*\n+([\s\S]*)$/i);
            const subject = m ? m[1]!.trim() : "关于您的货运需求";
            const body = m ? m[2]!.trim() : text;
            // 填入新增模板表单
            form.setFieldsValue({
              name: `AI ${v.companyName}`, language: v.language,
              subject, body,
            });
            setAiOpen(false);
            setAddOpen(true);
            message.success("已生成，请确认内容后保存");
          } catch {
            message.error("生成失败");
          } finally { setAiLoading(false); }
        }}
      >
        {!aiConfigured && (
          <div className="text-xs text-amber-600 bg-amber-50 rounded p-2 mb-3">
            DeepSeek API Key 未配置。请在项目 .env 中设置 DEEPSEEK_API_KEY 后重启。
          </div>
        )}
        <Form form={aiForm} layout="vertical" size="small">
          <Form.Item name="companyName" label="公司名" rules={[{ required: true }]}>
            <Input placeholder="目标客户公司名（有背调会自动带上）" />
          </Form.Item>
          <Form.Item name="contactName" label="联系人名" rules={[{ required: true }]}>
            <Input placeholder="如 Juan" />
          </Form.Item>
          <Form.Item name="language" label="语言" rules={[{ required: true }]} initialValue="EN">
            <Radio.Group>
              <Radio.Button value="EN">English</Radio.Button>
              <Radio.Button value="ES">Español</Radio.Button>
              <Radio.Button value="PT">Português</Radio.Button>
            </Radio.Group>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
