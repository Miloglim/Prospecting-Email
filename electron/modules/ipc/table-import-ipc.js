// ── 客户表导入 IPC 路由 ──
// 从 main.js 抽离：Excel/CSV 文件导入

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { classifyClient } = require('../classify-client');

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
        email: ["邮箱", "邮箱地址", "邮件", "收件人", "联系方式", "email", "e-mail", "to"],
        country: ["国家", "country"],
        category: ["品类", "行业", "分类", "category", "industry"],
        website: ["网站", "网址", "官网", "website", "url"],
        linkedin: ["linkedin", "领英"],
        firstName: ["名", "firstname", "first_name"],
        lastName: ["姓", "lastname", "last_name"],
        contactName: ["姓名", "姓名 | 职位", "联系人", "姓名职位", "contact"],
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
      const extraColsArr = [...unrecognizedCols];
      rows.forEach((r) => {
        const company = getStr(r, "company");
        if (!company) return;
        const rawEmail = getStr(r, "email");
        if (rawEmail && !EMAIL_RE.test(rawEmail)) {
          invalidEmails.push({ company, email: rawEmail });
        }
        const extra = {};
        for (const col of extraColsArr) {
          const v = r[col];
          if (v !== undefined && v !== null && String(v).trim()) extra[col] = String(v).trim();
        }
        const client = {
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
        };
        if (Object.keys(extra).length) client._extra = extra;
        clients.push(client);
      });
      return { clients, total: clients.length, invalidEmails, unrecognizedCols: [...unrecognizedCols] };
    } catch (e) {
      return { error: e.message };
    }
  });

}

module.exports = { register };
