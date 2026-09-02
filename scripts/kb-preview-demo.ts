// 一次性演示脚本：离线预览 KB http-dispatch 将发出的真实请求（不落网络）
// 用法: npx tsx scripts/kb-preview-demo.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-demo-"));
  process.env.QW_ENV_PATH = path.join(tmp, ".env");
  fs.writeFileSync(process.env.QW_ENV_PATH, "", "utf-8");

  const Kb = await import("../src/main/services/kb.service");
  Kb.setKbConfig({ baseUrl: "https://kb.iyunquna.com", token: "kbtt_DEMO_TOKEN_1234567890" });

  const examples: Array<[string, Parameters<typeof Kb.kbPreview>[0]]> = [
    [
      "示例A：GET 查询订单（内网接口还要自己的 X-API-Key —— 两层鉴权）",
      {
        method: "GET",
        url: "https://inner-api.example/orders/search",
        query: { order_no: "SO123" },
        innerHeaders: { "X-API-Key": "INNER_SECRET_KEY" },
      },
    ],
    [
      "示例B：EMC 保函 PDF 上传（写操作，file_bytes 略）",
      {
        method: "POST",
        url: "http://39022-service.example/xbase/ossfile/upload_process",
        innerHeaders: { "Content-Type": "application/json" },
        body: { header: { xSourceAppId: "62011", lang: "zh", timezone: "Asia/Shanghai" }, model: { file_type_id: 34, original_file_name: "bg.pdf", file_bytes: "<Base64…>" } },
        writeOperation: true,
      },
    ],
    [
      "示例C：application_id 生产模式（不裸写内网 url）",
      { method: "GET", applicationId: "app-39022", path: "orders/search", query: { order_no: "SO123" } },
    ],
  ];

  for (const [title, input] of examples) {
    const r = Kb.kbPreview(input);
    console.log("\n=== " + title + " ===");
    if (!r.success) { console.log("预览失败:", r.error); continue; }
    console.log("POST " + r.data.endpoint);
    console.log("外层 Header（只给 KB，不转发内网）:");
    console.log(JSON.stringify(r.data.outerHeaders, null, 2));
    console.log("中转 Body（KB 依此代访内网）:");
    console.log(JSON.stringify(r.data.payload, null, 2));
  }

  console.log("\n=== 实际 kbDispatch（无有效令牌/网络不可达 → 验证不崩溃 + 错误分层） ===");
  const live = await Kb.kbDispatch({ method: "GET", url: "https://demo.invalid/x", query: { a: 1 } });
  console.log(JSON.stringify(live.success ? live.data : { error: live.error }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
