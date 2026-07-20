// ── 客户表导入 IPC 路由 ──
// 从 main.js 抽离：Excel/CSV 文件导入

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { classifyClient, normalizeClientType } = require('../classify-client');

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
        title: ["职位", "职务", "title", "position"],
        phone: ["电话", "手机", "phone", "tel", "mobile"],
        assignee: ["跟进人", "负责人", "assignee", "owner"],
        contactPerson: ["对接人", "contact_person"],
        stage: ["阶段", "stage"],
        clientType: ["客户类型", "类型", "type", "client_type", "clienttype"],
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
      // 多邮箱分隔符：/ // , ; 换行
      const EMAIL_SPLIT_RE = /\s*(?:\/\/+|\/|,|;|\n)\s*/;
      const splitEmails = (raw) => {
        const parts = raw.split(EMAIL_SPLIT_RE).map(s => s.trim()).filter(Boolean);
        const seen = new Set();
        return parts.filter(p => {
          if (!EMAIL_RE.test(p) || seen.has(p.toLowerCase())) return false;
          seen.add(p.toLowerCase());
          return true;
        });
      };
      const makeClient = (row, rawEmail, extra) => {
        const company = getStr(row, "company");
        const rawCType = getStr(row, "clientType");
        const cl = {
          company,
          country: getStr(row, "country"),
          category: getStr(row, "category"),
          email: rawEmail,
          website: getStr(row, "website"),
          linkedin: getStr(row, "linkedin"),
          firstName: getStr(row, "firstName"),
          lastName: getStr(row, "lastName"),
          contactName: getStr(row, "contactName"),
          title: getStr(row, "title"),
          phone: getStr(row, "phone"),
          assignee: getStr(row, "assignee"),
          contactPerson: getStr(row, "contactPerson"),
          stage: getStr(row, "stage"),
          clientType: normalizeClientType(rawCType) || classifyClient(company, getStr(row, "category")),
        };
        if (extra && Object.keys(extra).length) cl._extra = extra;
        return cl;
      };

      const clients = [];
      const invalidEmails = [];
      const unrecognizedCols = new Set();
      let noEmailCount = 0;
      let splitCount = 0;
      let noCompanyCount = 0; // 无公司名跳过
      let totalEmailsInSheet = 0; // 原表有邮箱的单元格数
      if (rows.length) {
        for (const rawKey of Object.keys(rows[0])) {
          if (!allKnownKeys.has(norm(rawKey))) unrecognizedCols.add(rawKey);
        }
      }
      const extraColsArr = [...unrecognizedCols];
      rows.forEach((r) => {
        const rawEmail = getStr(r, "email");
        if (rawEmail) totalEmailsInSheet++; // 原表统计，不计公司名为空

        let company = getStr(r, "company");
        const noCompany = !company;
        if (noCompany) { noCompanyCount++; company = '(未命名公司)'; }

        // 构建额外列数据
        const extra = {};
        for (const col of extraColsArr) {
          const v = r[col];
          if (v !== undefined && v !== null && String(v).trim()) extra[col] = String(v).trim();
        }

        if (!rawEmail) {
          const cl = makeClient(r, "", extra);
          cl.company = company;
          cl._emailStatus = "no_email";
          if (noCompany) cl._noCompany = true;
          clients.push(cl);
          noEmailCount++;
          return;
        }

        if (EMAIL_RE.test(rawEmail)) {
          const cl = makeClient(r, rawEmail, extra);
          cl.company = company;
          if (noCompany) cl._noCompany = true;
          clients.push(cl);
          return;
        }

        // 尝试拆分多邮箱
        const parts = splitEmails(rawEmail);
        if (parts.length >= 1) {
          for (const email of parts) {
            const cl = makeClient(r, email, extra);
            cl.company = company;
            if (noCompany) cl._noCompany = true;
            clients.push(cl);
          }
          if (parts.length > 1) splitCount += parts.length - 1;
          return;
        }

        // 确实格式异常
        invalidEmails.push({ company, email: rawEmail });
        const cl = makeClient(r, rawEmail, extra);
        cl.company = company;
        cl._emailStatus = "invalid_email";
        if (noCompany) cl._noCompany = true;
        clients.push(cl);
      });
      return { clients, total: clients.length, invalidEmails, unrecognizedCols: [...unrecognizedCols], noEmailCount, noCompanyCount, splitCount, totalEmailsInSheet };
    } catch (e) {
      return { error: e.message };
    }
  });

}

module.exports = { register };
