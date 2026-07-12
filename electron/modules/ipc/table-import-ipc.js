// ── 客户表导入 IPC 路由 ──
// 从 main.js 抽离：Excel/CSV 文件导入 + 飞书多维表格导入

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { execSync } = require('child_process');
const { classifyClient, markSuspicious } = require('../classify-client');

function register(ipcMain) {
  ipcMain.handle("table:importFile", async (_e, filePath) => {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (![".csv", ".xlsx", ".xls"].includes(ext))
        return { error: "不支持的文件格式" };
      let wb;
      if (ext === ".csv") {
        let text = fs.readFileSync(filePath, "utf-8");
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        wb = XLSX.read(text, { type: "string", codepage: 65001 });
      } else wb = XLSX.readFile(filePath, { type: "file", codepage: 65001 });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      // ponytail: 合并单元格处理 — 将左上角值填充到合并区域内所有单元格
      if (sheet["!merges"]) {
        for (const merge of sheet["!merges"]) {
          const { s, e } = merge;
          const srcAddr = XLSX.utils.encode_cell({ c: s.c, r: s.r });
          const srcVal = sheet[srcAddr];
          if (srcVal === undefined) continue;
          for (let R = s.r; R <= e.r; R++) {
            for (let C = s.c; C <= e.c; C++) {
              if (R === s.r && C === s.c) continue;
              const addr = XLSX.utils.encode_cell({ c: C, r: R });
              if (sheet[addr] === undefined) sheet[addr] = srcVal;
            }
          }
        }
      }
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const norm = (s) => String(s || "").trim().replace(/\s+/g, "").toLowerCase();
      const FIELD_KEYS = {
        company: ["公司", "公司名称", "公司全称", "公司名", "客户名称", "客户", "company"],
        email: ["邮箱", "邮箱地址", "邮件", "收件人", "email", "e-mail", "to"],
        country: ["国家", "country"],
        category: ["品类", "行业", "分类", "category", "industry"],
        website: ["网站", "网址", "官网", "website", "url"],
        linkedin: ["linkedin", "领英"],
        firstName: ["名", "firstname", "first_name"],
        lastName: ["姓", "lastname", "last_name"],
        contactName: ["姓名", "联系人", "姓名职位", "contact"],
        position: ["职位", "职务", "title", "position"],
        phone: ["电话", "手机", "phone", "tel", "mobile"],
        assignee: ["跟进人", "负责人", "assignee", "owner"],
        contactPerson: ["对接人", "contact_person"],
        stage: ["阶段", "stage"],
      };
      const keyToField = {};
      const allKnownKeys = new Set();
      for (const [field, keys] of Object.entries(FIELD_KEYS)) {
        for (const k of keys) {
          keyToField[norm(k)] = field;
          allKnownKeys.add(norm(k));
        }
      }
      const getStr = (obj, field) => {
        for (const rawKey of Object.keys(obj)) {
          if (keyToField[norm(rawKey)] === field) {
            const v = obj[rawKey];
            if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
          }
        }
        return "";
      };
      const EMAIL_RE = /^[^\s@,"<>\[\]\\]+@[^\s@,"<>\[\]\\]+\.[^\s@,"<>\[\]\\]{2,}$/;
      const clients = [];
      const invalidEmails = [];
      const unrecognizedCols = new Set();
      if (rows.length) {
        for (const rawKey of Object.keys(rows[0])) {
          if (!allKnownKeys.has(norm(rawKey))) unrecognizedCols.add(rawKey);
        }
      }
      rows.forEach((r) => {
        const company = getStr(r, "company");
        if (!company) return;
        const rawEmail = getStr(r, "email");
        if (rawEmail && !EMAIL_RE.test(rawEmail)) {
          invalidEmails.push({ company, email: rawEmail });
        }
        clients.push({
          company,
          country: getStr(r, "country"),
          category: getStr(r, "category"),
          email: rawEmail,
          website: getStr(r, "website"),
          linkedin: getStr(r, "linkedin"),
          firstName: getStr(r, "firstName"),
          lastName: getStr(r, "lastName"),
          contactName: getStr(r, "contactName"),
          position: getStr(r, "position"),
          phone: getStr(r, "phone"),
          assignee: getStr(r, "assignee"),
          contactPerson: getStr(r, "contactPerson"),
          stage: getStr(r, "stage"),
          clientType: classifyClient(company, getStr(r, "category")),
        });
      });
      return { clients, total: clients.length, invalidEmails, unrecognizedCols: [...unrecognizedCols] };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle("table:importFeishu", async (_e, baseToken, tableId) => {
    try {
      const fieldOut = execSync(
        `lark-cli base +field-list --base-token "${baseToken}" --table-id "${tableId}" --limit 200`,
        { timeout: 15000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      );
      const fd = JSON.parse(fieldOut);
      const fields = fd.data?.fields || fd.fields || [];
      const allFieldNames = fields.map((f) => f.name);
      const TARGETS = [
        { keys: ["公司名称", "公司名", "公司", "Company", "company", "empresa", "客户名称"], field: "company" },
        { keys: ["国家", "Country", "country"], field: "country" },
        { keys: ["公司类型", "品类", "行业", "Category", "category", "rubro"], field: "category" },
        { keys: ["邮箱", "联系方式", "邮箱地址", "Email", "email", "收件人"], field: "email" },
        { keys: ["网站", "Website", "website", "官网", "LinkedIn"], field: "website" },
        { keys: ["名", "FirstName", "first_name", "firstname"], field: "firstName" },
        { keys: ["姓", "LastName", "last_name", "lastname"], field: "lastName" },
        { keys: ["姓名", "联系人", "Contact", "contact"], field: "contactName" },
        { keys: ["职位", "Position", "position"], field: "position" },
        { keys: ["电话", "Phone", "phone", "Tel", "tel"], field: "phone" },
      ];
      const selectedNames = [];
      for (const t of TARGETS) {
        const name = allFieldNames.find((n) => t.keys.some((k) => n === k || (n && n.includes(k))));
        selectedNames.push(name || "");
      }
      if (!selectedNames.some(Boolean)) {
        selectedNames.splice(0, selectedNames.length, ...allFieldNames.slice(0, 3));
        while (selectedNames.length < TARGETS.length) selectedNames.push("");
      }
      const validNames = selectedNames.filter(Boolean);
      const allRecords = [];
      const seenRecordIds = new Set();
      const pageSize = 200;
      let offset = 0;
      const idArgs = validNames.map((n) => ` --field-id "${n}"`).join("");
      while (true) {
        const output = execSync(
          `lark-cli base +record-list --base-token "${baseToken}" --table-id "${tableId}" --offset ${offset} --limit ${pageSize} --format json${idArgs}`,
          { timeout: 30000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
        );
        const resp = JSON.parse(output);
        const rows = resp.data?.data || resp.data || [];
        if (!rows.length) break;
        const ids = resp.data?.record_id_list || [];
        for (let i = 0; i < rows.length; i++) {
          const rid = ids[i] || String(i + offset);
          if (seenRecordIds.has(rid)) continue;
          seenRecordIds.add(rid);
          const row = rows[i];
          const colMap = {};
          (resp.data?.fields || []).forEach((name, ci) => { colMap[name] = ci; });
          const obj = {};
          for (let ti = 0; ti < TARGETS.length; ti++) {
            const an = selectedNames[ti];
            if (!an) continue;
            const ci = colMap[an];
            const val = ci !== undefined && ci < row.length ? row[ci] : "";
            let clean = "";
            if (Array.isArray(val))
              clean = String(val[0]?.link || val[0]?.text || val[0]?.url || val[0] || "");
            else if (val && typeof val === "object")
              clean = val.link || val.text || val.url || "";
            else clean = String(val ?? "");
            clean = clean.trim();
            const md = clean.match(/^\[(.+?)\]\((.+?)\)$/);
            if (md) {
              const u = md[2];
              clean = u.startsWith("mailto:") ? u.slice(7)
                : u.startsWith("tel:") ? u.slice(4)
                : u.includes("@") ? u.replace(/^https?:\/\//, "")
                : u;
            }
            if (clean.startsWith("mailto:")) clean = clean.slice(7);
            else if (clean.startsWith("tel:")) clean = clean.slice(4);
            obj[TARGETS[ti].field] = clean.trim();
          }
          allRecords.push(obj);
        }
        if (!resp.data?.has_more || rows.length < pageSize) break;
        offset += pageSize;
      }
      if (!allRecords.length) return { error: "未读取到任何记录" };
      let suspiciousCount = 0;
      for (const r of allRecords) {
        const m = markSuspicious(r.company);
        r.company = m.company;
        r._suspicious = m._suspicious;
        if (m._suspicious) suspiciousCount++;
        r.clientType = classifyClient(r.company, r.category);
      }
      return { clients: allRecords, total: allRecords.length, suspiciousCount };
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("not found")) return { error: "lark-cli 未安装" };
      if (msg.includes("auth")) return { error: "飞书未授权" };
      if (msg.includes("ETIMEDOUT")) return { error: "飞书请求超时" };
      return { error: "飞书读取失败: " + msg };
    }
  });
}

module.exports = { register };
