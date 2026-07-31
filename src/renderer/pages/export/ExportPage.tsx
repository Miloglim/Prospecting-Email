import { useState } from "react";
import { Button, Card, Input, message, Space } from "antd";
import { DownloadOutlined, FileExcelOutlined } from "@ant-design/icons";

export function ExportPage() {
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await window.api.invoke("export:contactsToExcel", { search });
      if (!result || typeof result !== "object" || !("success" in result)) {
        message.error("导出失败");
        return;
      }
      const r = result as { success: boolean; data?: string; error?: string };
      if (!r.success) {
        message.error(r.error || "导出失败");
        return;
      }

      // 下载 CSV 文件
      const blob = new Blob([r.data || ""], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      message.success("导出完成");
    } catch {
      message.error("导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto space-y-6 pt-12">
      <Card className="bg-zinc-900 border-zinc-800">
        <div className="text-center space-y-4">
          <FileExcelOutlined className="text-4xl text-green-500" />
          <h3 className="text-lg text-zinc-100">导出联系人</h3>
          <p className="text-sm text-zinc-500">
            将联系人数据导出为 CSV 文件，可直接用 Excel 打开
          </p>

          <Input
            placeholder="搜索关键词（可选，留空导出全部）"
            value={search} onChange={e => setSearch(e.target.value)}
            allowClear
          />

          <Button type="primary" icon={<DownloadOutlined />}
            loading={exporting} onClick={handleExport} block>
            导出 CSV
          </Button>
        </div>
      </Card>
    </div>
  );
}
