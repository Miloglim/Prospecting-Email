// ── Agnes 开发信质量验证 ────────────────────────────────────────────────────
const https = require('https');
const { APP_ROOT, loadSearchConfig } = require('./config');
const { API } = require('./core/contract');

function getAgnesKey() {
  try {
    const cfg = loadSearchConfig();
    const raw = cfg?.verify?.agnesKey || '';
    // ponytail: 清理非法字符（换行/空格/不可见字符），防止 HTTP header 报错
    return raw.replace(/[\r\n\t]/g, '').trim();
  } catch { /* Agnes Key 读取失败 → 下方会提示用户配置 */ }
  return '';
}

async function verifyEmailWithAgnes(emailBody) {
  const apiKey = getAgnesKey();
  if (!apiKey) return { ok: false, error: '未配置 Agnes API Key' };
  // ponytail: API key 格式校验，跳过明显无效的值
  if (apiKey.length < 20 || /[-￿]/.test(apiKey) || apiKey.includes(' ')) {
    return { ok: false, error: 'Agnes API Key 格式无效，请检查设置' };
  }

  const checklist = [
    '对象类型正确（代理不提本地仓库/本地团队；直客可提墨西哥本地化；未标签用通用语言）',
    '无广告垃圾词（最高级/紧迫词/夸大承诺/价格诱饵/排名宣称/全大写/感叹号）',
    '无空洞形容词（competitivo/eficiente），líder不超过1次且有事实支撑',
    '无 digital/AI/平台/technology 等技术词汇',
    '全文第二人称，不教客户做事',
    '首段无"Somos/We are"开头',
    'CTA是给不是要',
    '无占位符残留[XXX]',
    'Saludos 后无任何文字',
    '同一封不同时出现船东名+具体运价',
    '使用了公司资料中的真实数字',
    '列出了2-3个权威背书',
  ];

  const prompt = `你是一个开发信质检员。对照以下清单逐条检查这封开发信。\n\n【检查清单】\n${checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n【开发信正文】\n${emailBody}\n\n逐条回复，格式：\n1. ✅/❌ 简述（10字以内）\n2. ✅/❌ 简述\n...\n\n最后一行写总结：通过 X/12 项。`;

  try {
    const body = JSON.stringify({
      model: 'agnes-2.0-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 512,
    });

    const result = await new Promise((resolve) => {
      const opts = {
        ...API.AGNES, port: 443, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        timeout: 30000, rejectUnauthorized: false,
      };
      const req = https.request(opts, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d, _status: res.statusCode }); } });
      });
      req.on('error', (e) => resolve({ _error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ _error: 'timeout' }); });
      req.end(body);
    });

    if (result._error) return { ok: false, error: '网络: ' + result._error };
    if (result._raw) return { ok: false, error: 'HTTP ' + result._status + ': ' + (result._raw || '').slice(0, 200) };
    if (result.error) return { ok: false, error: 'API错误: ' + JSON.stringify(result.error).slice(0, 200) };
    if (!result?.choices?.[0]?.message?.content) return { ok: false, error: 'Agnes 返回空: ' + JSON.stringify(result).slice(0, 200) };

    const content = result.choices[0].message.content;
    const scoreMatch = content.match(/(\d+)\/12/);
    const passed = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    return { ok: true, passed, total: 12, details: content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { verifyEmailWithAgnes };
