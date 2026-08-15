import { useEffect, useState } from "react";
import { Button, Table, Tag, message, Alert, Popconfirm, Select, Space } from "antd";
import { FolderOpenOutlined, DatabaseOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";

interface LegacyDirCandidate { dir: string; hasConfig: boolean; }

interface MigrationPreview {
  legacyDir: string;
  configFound: boolean;
  accounts: number;
  accountsExisting: number;
  fromName: boolean;
  signature: boolean;
  schedule: boolean;
  apiKeysDetected: string[];
  configFields: Array<{ legacy: string; target: string; value?: string }>;
}

interface MigrationReport {
  importedAccounts: number;
  skippedAccounts: number;
  importedConfig: string[];
  backupPath: string | null;
}

/** 取路径最后一段 */
function pathBasename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function MigrationSection() {
  const qc = useQueryClient();
  const [dir, setDir] = useState("");
  const [candidates, setCandidates] = useState<LegacyDirCandidate[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [loading, setLoading] = useState<"idle" | "preview" | "run">("idle");

  // 挂载时自动探测旧 PE 目录并自动填入 + 预览
  useEffect(() => {
    (async () => {
      setDetecting(true);
      try {
        const r = await window.api.invoke("migrate:detect") as { success: boolean; data?: LegacyDirCandidate[] };
        if (r?.success && r.data && r.data.length > 0) {
          setCandidates(r.data);
          const first = r.data[0]!.dir;
          setDir(first);
          const pr = await window.api.invoke("migrate:preview", first) as { success: boolean; data?: MigrationPreview; error?: string };
          if (pr?.success && pr.data) setPreview(pr.data);
        }
      } catch { /* 探测失败留给手动 */ }
      finally { setDetecting(false); }
    })();
  }, []);

  const pickDir = async () => {
    const r = await window.api.invoke("system:selectDirectory") as { success: boolean; data?: string; error?: string };
    if (r?.success && r.data) { setDir(r.data); setPreview(null); setReport(null); }
  };

  const doPreview = async () => {
    if (!dir.trim()) { message.warning("请先选择旧 PE 目录"); return; }
    setLoading("preview");
    setReport(null);
    try {
      const r = await window.api.invoke("migrate:preview", dir) as { success: boolean; data?: MigrationPreview; error?: string };
      if (r?.success && r.data) setPreview(r.data);
      else message.error(r?.error || "预览失败");
    } catch { message.error("预览失败"); }
    finally { setLoading("idle"); }
  };

  const doRun = async () => {
    setLoading("run");
    try {
      const r = await window.api.invoke("migrate:run", dir) as { success: boolean; data?: MigrationReport; error?: string };
      if (r?.success && r.data) {
        setReport(r.data);
        message.success("配置迁移完成");
        qc.invalidateQueries({ queryKey: ["accounts"] });
        qc.invalidateQueries({ queryKey: ["settings"] });
      } else {
        message.error(r?.error || "迁移失败");
      }
    } catch { message.error("迁移失败"); }
    finally { setLoading("idle"); }
  };

  return (
    <div className="space-y-3">
      <Alert type="info" showIcon className="text-[11px]"
        message={
          <div className="text-[11px]">
            从旧版 Prospecting Email 迁移<b>用户设置</b>到 4.0：发信账号（密码 AES 加密导入）、
            发件人名称、正文署名、发送规则。迁移前自动备份。客户数据不迁移（在外部工具管理）；API 密钥不迁移，请手动配置 .env。
          </div>
        }
      />

      {/* 目录选择 */}
      <div className="space-y-2">
        {detecting ? (
          <div className="text-xs text-gray-400">正在自动探测旧 PE 目录...</div>
        ) : candidates.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 flex-shrink-0">旧版目录</span>
            <Select
              size="small" style={{ width: "100%" }} value={dir}
              onChange={v => { setDir(v); setPreview(null); setReport(null); }}
              options={candidates.map(c => ({ value: c.dir, label: `${pathBasename(c.dir)}${c.hasConfig ? " ✓" : ""}` }))}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={pickDir}>其他...</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="small" icon={<FolderOpenOutlined />} onClick={pickDir}>选择旧 PE 目录</Button>
            <span className="text-[11px] text-gray-400">未自动探测到旧版，请手动选择</span>
          </div>
        )}

        <Space>
          <Button size="small" icon={<DatabaseOutlined />} loading={loading === "preview"} onClick={doPreview} disabled={!dir.trim()}>
            预览配置
          </Button>
          <Popconfirm
            title="开始迁移？"
            description="将导入旧版账号与设置，当前账号库会先备份。"
            onConfirm={doRun}
          >
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} loading={loading === "run"} disabled={!dir.trim()}>
              开始迁移
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {/* 配置对齐预览 */}
      {preview && (
        <div className="space-y-3 border border-gray-200 rounded p-3 bg-gray-50/50">
          <div className="text-[11px] font-semibold text-gray-700">
            配置对齐 — {preview.legacyDir}
          </div>
          <Table
            dataSource={preview.configFields}
            size="small" pagination={false}
            columns={[
              { title: "旧字段", dataIndex: "legacy", key: "legacy", render: (v: string) => <code className="text-[10px]">{v}</code> },
              { title: "4.0 设置", dataIndex: "target", key: "target", width: 130 },
              { title: "检测", dataIndex: "value", key: "value", width: 130 },
            ]}
          />
          {preview.accountsExisting > 0 && (
            <div className="text-[10px] text-gray-400">
              4.0 已有 {preview.accountsExisting} 个账号，同邮箱账号将跳过。
            </div>
          )}
          {preview.apiKeysDetected.length > 0 && (
            <Alert type="warning" showIcon className="text-[11px]"
              message={
                <div className="text-[11px]">
                  检测到旧配置含 API 密钥（{preview.apiKeysDetected.join("、")}），不自动迁移，请手动写入 <code>.env</code>。
                </div>
              }
            />
          )}
        </div>
      )}

      {/* 迁移报告 */}
      {report && (
        <Alert type="success" showIcon
          message={
            <div className="text-[11px] space-y-1">
              <b>迁移完成</b>
              <div>导入账号 {report.importedAccounts} 个（跳过 {report.skippedAccounts}）</div>
              {report.importedConfig.length > 0 && <div>已导入配置：{report.importedConfig.join("、")}</div>}
              {report.backupPath && <div className="text-gray-500">备份：<code>{report.backupPath}</code></div>}
            </div>
          }
        />
      )}
    </div>
  );
}
