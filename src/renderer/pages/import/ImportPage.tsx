import { useState, useRef, useCallback } from "react";
import { Button, Select, Table, message, Tag, Space } from "antd";
import { InboxOutlined, UploadOutlined, FileExcelOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnsType } from "antd/es/table";

// 字段别名指南 — 匹配旧 PE 的 guide-alias-grid
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

export function ImportPage() {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState(false);

  // 自定义拖拽区，避免 Ant Design Dragger 的虚线样式
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, []);

  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };
  const rawDataRef = useRef<{ type: "csv" | "xlsx" | "tsv"; data?: string; filePath?: string } | null>(null);

  const reset = () => {
    setPreview(null);
    setMapping({});
    setPasteText("");
    rawDataRef.current = null;
  };

  const processData = async (type: "csv" | "xlsx" | "tsv", data: string, filePath?: string) => {
    setLoading(true);
    try {
      rawDataRef.current = { type, data, filePath };
      const r = await window.api.invoke("contacts:import", { mode: "preview", type, data, filePath });
      if (r && r.success && r.data) {
        setPreview(r.data);
        setMapping(r.data.suggestedMapping || {});
      } else {
        message.error(r?.error || "解析失败");
      }
    } catch (err) {
      message.error("解析失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  // ponytail: Electron File 有 path 属性，直接传路径给主进程读文件，避免 IPC 传几十 MB base64
  // ponytail: Electron File 有 path 属性，直接传路径给主进程读文件，避免 IPC 传几十 MB base64
  const processFile = async (file: File) => {
    try {
      const p = (file as unknown as { path?: string }).path;
      const ext = file.name.split(".").pop()?.toLowerCase();
      const type: "csv" | "xlsx" = (ext === "csv") ? "csv" : "xlsx";
      if (p) {
        await processData(type, "", p);
      } else {
        // fallback: 无 path（极少数安全策略下）
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += CHUNK)
          parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
        await processData(type, btoa(parts.join("")));
      }
    } catch (err) {
      message.error("文件读取失败: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const processPaste = async () => {
    if (!pasteText.trim()) return;
    setShowPaste(false);
    await processData("tsv", pasteText);
  };

  const executeImport = async () => {
    if (!rawDataRef.current) return;
    setImporting(true);
    try {
      const { type, data, filePath } = rawDataRef.current;
      const r = await window.api.invoke("contacts:import", {
        mode: "execute", type, data, filePath, mapping,
      }) as { success: boolean; data?: { imported: number; skipped: number }; error?: string };
      if (r.success && r.data) {
        message.success(`导入 ${r.data.imported} 条，跳过 ${r.data.skipped} 条（重复）`);
        qc.invalidateQueries({ queryKey: ["contacts"] });
        qc.invalidateQueries({ queryKey: ["crm"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        reset();
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
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
        <FileExcelOutlined /> 导入客户
      </h2>

      {/* 拖拽上传区 — 匹配旧 PE drop-zone */}
      {!preview && (
        <>
          {/* 自定义拖拽区，匹配旧 PE drop-zone 样式 */}
          <div
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => document.getElementById("import-file-input")?.click()}
            className="flex flex-col items-center justify-center py-10 cursor-pointer rounded-lg border-2 border-gray-300 bg-white transition-colors"
            style={{
              borderColor: dragOver ? "#00bfa5" : undefined,
              background: dragOver ? "#f0fdf9" : undefined,
            }}
          >
            <p className="text-3xl text-gray-300 mb-3"><InboxOutlined /></p>
            <p className="text-sm text-gray-500">拖入 Excel/CSV 文件，或点击选择</p>
          </div>
          <input
            id="import-file-input"
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={handleFileInput}
          />

          {/* 粘贴入口 */}
          <div className="text-center">
            {!showPaste ? (
              <button
                className="text-xs text-gray-400 hover:text-gray-600 underline"
                onClick={() => setShowPaste(true)}
              >
                或从 Excel 复制粘贴数据
              </button>
            ) : (
              <div className="space-y-3">
                <textarea
                  rows={8}
                  className="w-full max-w-xl border border-gray-200 rounded-lg p-3 text-xs font-mono resize-y"
                  placeholder={"邮箱\t公司\t名\t姓\njohn@acme.com\tACME\tJohn\tSmith"}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                />
                <div className="flex justify-center gap-2">
                  <Button size="small" loading={loading} disabled={!pasteText.trim()}
                    onClick={processPaste}>解析预览</Button>
                  <Button size="small" onClick={() => { setShowPaste(false); setPasteText(""); }}>取消</Button>
                </div>
              </div>
            )}
          </div>

          {/* 字段识别指南 — 匹配旧 PE guide-alias-grid */}
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
        </>
      )}

      {/* 预览 + 导入 */}
      {preview && (
        <div className="space-y-4">
          {/* 工具栏 — 匹配旧 PE clients-toolbar */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <Space size="small">
              <Tag color="blue">共 {preview.totalRows} 行</Tag>
              <Tag color="green">新增 {newCount} 条</Tag>
              {dupCount > 0 && <Tag color="orange">重复 {dupCount} 条（将跳过）</Tag>}
              {!emailMapped && <Tag color="red">未映射邮箱列</Tag>}
            </Space>
            <Space>
              <Button size="small" onClick={reset}>清除</Button>
              <Button type="primary" size="small" icon={<UploadOutlined />}
                loading={importing} disabled={!emailMapped}
                onClick={executeImport}>
                保存到联系人
              </Button>
            </Space>
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
            loading={loading || importing}
            scroll={{ x: preview.headers.length * 130 }}
            pagination={false}
            className="[&_.ant-table-thead>tr>th]:!text-[10px] [&_.ant-table-thead>tr>th]:!p-1"
          />
        </div>
      )}
    </div>
  );
}
