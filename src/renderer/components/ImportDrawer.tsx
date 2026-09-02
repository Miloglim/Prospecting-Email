import { useState, useRef } from "react";
import { Drawer, Tabs, Upload, Input, Button, Table, Select, message, Tag, Space } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnsType } from "antd/es/table";

const { TextArea } = Input;
const { Dragger } = Upload;

// 字段别名指南 — 匹配旧 PE 的 guide-alias-grid（自 ImportPage 移植，两处合一）
const FIELD_ALIASES: { field: string; icon: string; codes: string[] }[] = [
  { field: "邮箱", icon: "✉️", codes: ["邮箱", "邮箱地址", "邮件", "收件人", "email", "e-mail", "to"] },
  { field: "公司名", icon: "🏢", codes: ["公司", "公司名称", "公司全称", "公司名", "客户名称", "客户", "company"] },
  { field: "联系人", icon: "👤", codes: ["姓名", "姓名 | 职位", "姓名职位", "联系人", "contact"] },
  { field: "名", icon: "👤", codes: ["名", "firstname", "first_name"] },
  { field: "姓", icon: "👤", codes: ["姓", "lastname", "last_name"] },
  { field: "职位", icon: "💼", codes: ["职位", "职务", "title", "position"] },
  { field: "电话", icon: "📞", codes: ["电话", "手机", "phone", "tel", "mobile"] },
  { field: "国家", icon: "🌐", codes: ["国家", "country"] },
  { field: "品类", icon: "🏷️", codes: ["品类", "行业", "分类", "category", "industry"] },
  { field: "网站", icon: "🔗", codes: ["网站", "网址", "官网", "website", "url"] },
  { field: "LinkedIn", icon: "🔗", codes: ["linkedin", "领英"] },
  { field: "跟进人", icon: "✅", codes: ["跟进人", "负责人", "assignee", "owner"] },
  { field: "对接人", icon: "👥", codes: ["对接人", "contact_person"] },
  { field: "阶段", icon: "🚩", codes: ["阶段", "stage"] },
  { field: "客户类型", icon: "🚩", codes: ["客户类型", "类型", "type", "client_type", "clienttype"] },
];

const FIELD_OPTIONS = [
  { value: "", label: "— 忽略 —" },
  { value: "email", label: "邮箱" },
  { value: "companyName", label: "公司" },
  { value: "firstName", label: "名" },
  { value: "lastName", label: "姓" },
  { value: "title", label: "职位" },
  { value: "phone", label: "电话" },
  { value: "country", label: "国家/语言" },
  { value: "stage", label: "发送阶段" },
  { value: "clientType", label: "客户类型" },
  { value: "assignee", label: "负责人" },
];

interface PreviewData {
  headers: string[];
  previewRows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  duplicateEmails: string[];
}

type Step = "input" | "preview";

export function ImportDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("input");
  const [inputTab, setInputTab] = useState<string>("file");
  const [pasteText, setPasteText] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // 缓存原始数据，execute 时重新送后端解析全部行
  const rawDataRef = useRef<{ type: "csv" | "xlsx" | "tsv"; data: string } | null>(null);

  const reset = () => {
    setStep("input");
    setPasteText("");
    setPreview(null);
    setMapping({});
    setLoading(false);
    setImporting(false);
    rawDataRef.current = null;
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // 读取文件内容 → 送后端预览（P0-4: 不再把本地路径传给主进程，内容经 File API 读取）
  const processFile = async (file: File) => {
    setLoading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      const type: "csv" | "xlsx" = (ext === "csv") ? "csv" : "xlsx";

      let data = "";
      if (type === "xlsx") {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += CHUNK)
          parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
        data = btoa(parts.join(""));
      } else {
        data = await file.text();
      }

      rawDataRef.current = { type, data };

      const r = await window.api.invoke("contacts:import", { mode: "preview", type, data }) as {
        success: boolean; data?: PreviewData; error?: string;
      };
      if (r.success && r.data) {
        setPreview(r.data);
        setMapping(r.data.suggestedMapping);
        setStep("preview");
      } else {
        message.error(r.error || "解析失败");
      }
    } catch (err) {
      message.error("文件读取失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  // 粘贴文本 → 送后端预览
  const processPaste = async () => {
    if (!pasteText.trim()) return;
    setLoading(true);
    try {
      rawDataRef.current = { type: "tsv", data: pasteText };

      const r = await window.api.invoke("contacts:import", {
        mode: "preview", type: "tsv", data: pasteText,
      }) as { success: boolean; data?: PreviewData; error?: string };
      if (r.success && r.data) {
        setPreview(r.data);
        setMapping(r.data.suggestedMapping);
        setStep("preview");
      } else {
        message.error(r.error || "解析失败");
      }
    } catch (err) {
      message.error("解析失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  // 确认导入 — 重新送原始数据 + 最终 mapping
  const executeImport = async () => {
    if (!rawDataRef.current) return;
    setImporting(true);
    try {
      const { type, data } = rawDataRef.current;
      const r = await window.api.invoke("contacts:import", {
        mode: "execute", type, data, mapping,
      }) as { success: boolean; data?: { imported: number; skipped: number }; error?: string };

      if (r.success && r.data) {
        message.success(`导入 ${r.data.imported} 条，跳过 ${r.data.skipped} 条（重复）`);
        qc.invalidateQueries({ queryKey: ["contacts"] });
        qc.invalidateQueries({ queryKey: ["crm"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        handleClose();
      } else {
        message.error(r.error || "导入失败");
      }
    } catch (err) {
      message.error("导入失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setImporting(false);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns: ColumnsType<any> = preview
    ? preview.headers.map((h) => ({
        title: (
          <Select
            size="small"
            value={mapping[h] || ""}
            onChange={(v) => setMapping(prev => ({ ...prev, [h]: v }))}
            options={FIELD_OPTIONS}
            className="w-24"
            popupMatchSelectWidth={false}
          />
        ),
        key: h,
        dataIndex: h,
        width: 130,
        render: (v: string) => (
          <span className={`text-xs ${!v ? "text-gray-300" : "text-gray-700"}`}>
            {v || "—"}
          </span>
        ),
      }))
    : [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataSource: any[] = preview
    ? preview.previewRows.map((row, idx) => {
        const obj: Record<string, string | number> = { __idx: idx };
        preview.headers.forEach((h, i) => { obj[h] = row[i] || ""; });
        return obj;
      })
    : [];

  const dupCount = preview?.duplicateEmails.length || 0;
  const newCount = preview ? preview.totalRows - dupCount : 0;
  const emailMapped = preview?.headers.some(h => mapping[h] === "email");

  return (
    <Drawer title="导入联系人" open={open} onClose={handleClose}
      width={step === "input" ? 560 : Math.max(800, (preview?.headers.length || 5) * 130 + 48)}
    >
      {step === "input" && (
        <div className="space-y-4">
          <Tabs activeKey={inputTab} onChange={setInputTab} size="small"
          items={[
            {
              key: "file",
              label: "上传文件",
              children: (
                <div className="space-y-4 pt-4">
                  <Dragger
                    accept=".csv,.xlsx,.xls"
                    maxCount={1}
                    beforeUpload={(file) => { processFile(file); return false; }}
                    showUploadList={false}
                  >
                    <p className="text-3xl text-gray-300 mb-2"><InboxOutlined /></p>
                    <p className="text-xs text-gray-500">点击或拖拽 CSV / XLSX 文件到此处</p>
                  </Dragger>
                </div>
              ),
            },
            {
              key: "paste",
              label: "粘贴数据",
              children: (
                <div className="space-y-4 pt-4">
                  <TextArea
                    rows={14}
                    placeholder={`从 Excel 复制后粘贴到这里（Tab 分隔，第一行为表头）\n\n示例：\n邮箱\t公司\t名\t姓\njohn@acme.com\tACME\tJohn\tSmith`}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                  />
                  <Button type="primary" size="small" block
                    loading={loading}
                    disabled={!pasteText.trim()}
                    onClick={processPaste}>
                    解析预览
                  </Button>
                </div>
              ),
            },
          ]}
        />

        {/* 字段识别指南（自 ImportPage 移植） */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-xs font-semibold text-gray-500 mb-3">字段识别说明</p>
          <p className="text-[11px] text-gray-400 mb-4">
            程序读取 Excel/CSV 的<strong>第一行作为表头</strong>，通过匹配列名自动识别字段。中英文列名均可，忽略大小写与空格。
            未匹配的列保留在「额外信息」中。
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            {FIELD_ALIASES.map((fa) => (
              <div key={fa.field} className="flex items-start gap-2 text-[11px]">
                <span className="text-gray-500 whitespace-nowrap min-w-[56px]">{fa.icon} {fa.field}</span>
                <span className="text-gray-400">
                  {fa.codes.map(c => <code key={c} className="text-[10px] bg-gray-100 px-1 py-0.5 rounded mr-1">{c}</code>)}
                </span>
              </div>
            ))}
          </div>
        </div>
        </div>
      )}

      {step === "preview" && preview && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-xs flex-wrap">
            <Tag color="blue">共 {preview.totalRows} 行</Tag>
            <Tag color="green">新增 {newCount} 条</Tag>
            {dupCount > 0 && <Tag color="orange">重复 {dupCount} 条（跳过）</Tag>}
            {!emailMapped && <Tag color="red">未映射邮箱列</Tag>}
          </div>

          {preview.previewRows.length < preview.totalRows && (
            <div className="text-[11px] text-gray-400">
              预览前 {preview.previewRows.length} 行（共 {preview.totalRows} 行），每列下拉可调整字段映射
            </div>
          )}

          <Table
            columns={columns}
            dataSource={dataSource}
            rowKey="__idx"
            size="small"
            scroll={{ x: preview.headers.length * 130 }}
            pagination={false}
            className="[&_.ant-table-thead>tr>th]:!text-[10px] [&_.ant-table-thead>tr>th]:!p-1"
          />

          <Space className="w-full justify-end">
            <Button size="small" onClick={() => setStep("input")}>返回</Button>
            <Button type="primary" size="small"
              loading={importing}
              disabled={!emailMapped}
              onClick={executeImport}>
              确认导入 {newCount} 条
            </Button>
          </Space>
        </div>
      )}
    </Drawer>
  );
}
