// ── 发布后同步 OSS ──────────────────────────────────────────────────────────
// 用法: node scripts/sync-oss.js
// 将 dist-release 的 exe + latest.yml 上传到阿里云 OSS，替换 latest.yml 中的 URL

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ═══ 配置（改成你自己的） ═══
const OSS = {
  region: 'oss-cn-shanghai',
  bucket: 'milogin-updates',
  accessKeyId: process.env.OSS_KEY || '',
  accessSecret: process.env.OSS_SECRET || '',
};
const DIST = path.join(__dirname, '..', '..', 'dist-release');

function hmac(key, data) {
  return crypto.createHmac('sha1', key).update(data).digest('base64');
}

function ossRequest(method, objectName, body, contentType) {
  const date = new Date().toUTCString();
  const host = `${OSS.bucket}.${OSS.region}.aliyuncs.com`;
  const res = `/${OSS.bucket}/${objectName}`;
  const headers = { 'Content-Type': contentType || 'application/octet-stream', 'Date': date, 'Host': host };
  const signStr = `${method}\n\n${headers['Content-Type']}\n${date}\n${res}`;
  const sig = hmac(OSS.accessSecret, signStr);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, port: 443, method, path: `/${objectName}`,
      headers: { ...headers, Authorization: `OSS ${OSS.accessKeyId}:${sig}` },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  if (!OSS.accessKeyId) { console.error('请设置 OSS_KEY 和 OSS_SECRET 环境变量'); process.exit(1); }

  const files = fs.readdirSync(DIST).filter(f => f.endsWith('.exe') || f.endsWith('.blockmap') || f.endsWith('.yml'));
  console.log(`上传 ${files.length} 个文件到 OSS...`);

  for (const f of files) {
    const fp = path.join(DIST, f);
    const buf = fs.readFileSync(fp);
    const r = await ossRequest('PUT', `prospector/${f}`, buf);
    if (r.status === 200) console.log(`  ✅ ${f}`);
    else console.log(`  ❌ ${f} — HTTP ${r.status}`);
  }

  // 更新 latest.yml 的 URL 为 OSS 地址
  const ymlPath = path.join(DIST, 'latest.yml');
  let yml = fs.readFileSync(ymlPath, 'utf-8');
  const cdnBase = `https://${OSS.bucket}.${OSS.region}.aliyuncs.com/prospector`;
  yml = yml.replace(/url:\s*.+/g, (m) => m.replace(/: .+$/, `: ${cdnBase}/${path.basename(m.split(': ')[1])}`));
  yml = yml.replace(/path:\s*.+/g, (m) => m.replace(/: .+$/, `: ${cdnBase}/${path.basename(m.split(': ')[1])}`));
  fs.writeFileSync(ymlPath, yml);
  console.log('  ✅ latest.yml 已更新 CDN 地址');

  // 重新上传 latest.yml
  const ymlBuf = fs.readFileSync(ymlPath);
  const rr = await ossRequest('PUT', 'prospector/latest.yml', ymlBuf);
  console.log(rr.status === 200 ? '  ✅ latest.yml 同步到 OSS' : '  ❌ latest.yml 上传失败');
}

main().catch(e => { console.error(e); process.exit(1); });
