const fs = require('fs');
let main = fs.readFileSync('electron/main.js', 'utf8');

const newProvider =
'  const searchProviders = {\n' +
'    \'basic\': {\n' +
'      name: \'基本信息\',\n' +
'      research: async (cname, company) => {\n' +
'        const rating = autoRate(\'\', company);\n' +
'        const stars = \"\\u2B50\".repeat(Math.min(5, Math.max(1, rating)));\n' +
'        const tags = [company.country, company.category].filter(Boolean).join(\" · \") || \"信息待补充\";\n' +
'        const fname = sanitizeFilename(cname).trim();\n' +
'        const dateStr = new Date().toISOString().slice(0, 10);\n' +
'\n' +
'        const lines = [\n' +
'          \"# \" + cname,\n' +
'          \"\",\n' +
'          \"> \" + tags + \" | 开发价值 \" + stars + \"（\" + rating + \"/5）\",\n' +
'          \"\",\n' +
'          \"---\",\n' +
'          \"\",\n' +
'          \"## 基本信息\",\n' +
'          \"\",\n' +
'          \"| 项目 | 内容 |\",\n' +
'          \"|------|------|\",\n' +
'          \"| **公司** | \" + cname + \" |\",\n' +
'        ];\n' +
'        if (company.country) lines.push(\"| **国家** | \" + company.country + \" |\");\n' +
'        if (company.category) lines.push(\"| **品类** | \" + company.category + \" |\");\n' +
'        if (company.email) lines.push(\"| **邮箱** | \" + company.email + \" |\");\n' +
'        if (company.contactName) lines.push(\"| **联系人** | \" + company.contactName + \" |\");\n' +
'        if (company.position) lines.push(\"| **职位** | \" + company.position + \" |\");\n' +
'        if (company.phone) lines.push(\"| **电话** | \" + company.phone + \" |\");\n' +
'        lines.push(\"\");\n' +
'        lines.push(\"---\");\n' +
'        lines.push(\"> 📅 \" + dateStr);\n' +
'\n' +
'        const report = lines.join(\"\\n\");\n' +
'        const reportPath = path.join(__dirname, \"..\", \"reports\", \"客户背调-\" + fname + \".md\");\n' +
'        const dir = path.dirname(reportPath);\n' +
'        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });\n' +
'        fs.writeFileSync(reportPath, report);\n' +
'\n' +
'        return { ok: true, status: \"done\", rating, message: \"信息卡已生成\" };\n' +
'      }\n' +
'    },\n' +
'  };';

const oldStart = '  const searchProviders = {';
const endMarker = '\n  // 报告全文翻译';
const startIdx = main.indexOf(oldStart);
const endIdx = main.indexOf(endMarker, startIdx);

if (startIdx > 0 && endIdx > startIdx) {
  main = main.slice(0, startIdx) + newProvider + '\n' + main.slice(endIdx);
  fs.writeFileSync('electron/main.js', main);
  console.log('OK');
} else {
  console.log('FAIL', startIdx, endIdx);
}
