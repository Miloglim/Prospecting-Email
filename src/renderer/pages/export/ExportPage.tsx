import { useState } from "react";
import { Button, Card, Input, message, Space } from "antd";
import { DownloadOutlined, FileExcelOutlined, FileTextOutlined } from "@ant-design/icons";

function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportPage() {
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportingNotes, setExportingNotes] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await window.api.invoke("export:contactsToExcel", { search });
      const r = result as { success: boolean; data?: string; error?: string };
      if (!r?.success) { message.error(r?.error || "导出失败"); return; }
      downloadCsv(r.data || "", `contacts_${new Date().toISOString().slice(0, 10)}.csv`);
      message.success("导出完成");
    } catch { message.error("导出失败"); }
    finally { setExporting(false); }
  };

  const handleExportNotes = async () => {
    setExportingNotes(true);
    try {
      const result = await window.api.invoke("export:notesToCsv");
      const r = result as { success: boolean; data?: string; error?: string };
      if (!r?.success) { message.error(r?.error || "导出失败"); return; }
      downloadCsv(r.data || "", `跟进记录_${new Date().toISOString().slice(0, 10)}.csv`);
      message.success("导出完成");
    } catch { message.error("导出失败"); }
    finally { setExportingNotes(false); }
  };

  return (
    <div className="max-w-lg mx-auto space-y-6 pt-12">
      <Card className="bg-white border-gray-200">
        <div className="text-center space-y-4">
          <FileExcelOutlined className="text-4xl text-green-500" />
          <h3 className="text-lg text-gray-900">导出联系人</h3>
          <p className="text-sm text-gray-500">
            将联系人数据导出为 CSV 文件，可直接用 Excel 打开
          </p>

          <Input
            placeholder="搜索关键词（可选，留空导出全部）"
            value={search} onChange={e => setSearch(e.target.value)}
            allowClear
          />

          <Button type="primary" icon={<DownloadOutlined />}
            loading={exporting} onClick={handleExport} block>
            导出联系人 CSV
          </Button>
        </div>
      </Card>

      <Card className="bg-white border-gray-200">
        <div className="text-center space-y-4">
          <FileTextOutlined className="text-4xl text-blue-500" />
          <h3 className="text-lg text-gray-900">导出跟进记录</h3>
          <p className="text-sm text-gray-500">
            导出全部联系人跟进记录（interactions 中的 note），按时间倒序
          </p>

          <Button icon={<DownloadOutlined />}
            loading={exportingNotes} onClick={handleExportNotes} block>
            导出跟进记录 CSV
          </Button>
        </div>
      </Card>
    </div>
  );
}
