"""
Real Email Extraction — 用 Jina Reader 抓官网联系页面，提取真实邮箱
"""
import pandas as pd, json, requests, time, sys, io, os, re
from urllib.parse import urljoin, urlparse
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

JINA_BASE = 'https://r.jina.ai'

df = pd.read_excel('docs/已清洗.xlsx')

# 找有域名的公司
with_domain = []
for i, row in df.iterrows():
    domain = str(row.get('domain', '')).strip()
    cleaned = str(row['cleaned']) if pd.notna(row['cleaned']) and str(row['cleaned']) != 'None' else ''
    if domain and cleaned:
        with_domain.append({'index': i, 'company': cleaned, 'domain': domain})

print(f"有域名公司: {len(with_domain)}")

# 邮箱正则
EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')

def fetch_page(url):
    """Jina Reader抓取页面"""
    try:
        resp = requests.get(f'{JINA_BASE}/{url}', headers={'Accept': 'text/markdown', 'X-Return-Format': 'markdown'}, timeout=20)
        if resp.status_code == 200 and len(resp.text) > 100:
            return resp.text[:10000]
        return ''
    except:
        return ''

def find_emails_on_domain(domain):
    """多页面搜索真实邮箱"""
    all_emails = {}  # email -> {page, context}

    # 页面列表
    pages = [
        f'https://{domain}/contato',
        f'https://{domain}/contact',
        f'https://{domain}/fale-conosco',
        f'https://{domain}/quem-somos',
        f'https://{domain}/about',
        f'https://www.{domain}/contato',
        f'https://www.{domain}/contact',
        f'https://www.{domain}',
        f'https://{domain}',
    ]

    seen_urls = set()
    for url in pages:
        if url in seen_urls:
            continue
        seen_urls.add(url)

        content = fetch_page(url)
        if not content:
            continue

        emails = EMAIL_RE.findall(content)
        for email in emails:
            email = email.lower().strip().rstrip('.').rstrip(',')
            # 过滤垃圾邮箱
            if any(kw in email for kw in ['example', 'test', 'noreply', 'no-reply', 'github', 'npm', 'python', 'w3.org', 'whatwg', 'domain.com']):
                continue
            # 必须是该域名的邮箱
            if email.endswith('@' + domain) or domain in email.split('@')[1]:
                if email not in all_emails:
                    # 提取上下文（邮箱前后50字符）
                    idx = content.lower().find(email)
                    ctx_start = max(0, idx - 80)
                    ctx_end = min(len(content), idx + len(email) + 80)
                    context = content[ctx_start:ctx_end].replace('\n', ' ').strip()
                    all_emails[email] = {
                        'url': url,
                        'context': context[:200]
                    }

    return all_emails

# 加载已有
results_file = 'docs/_real_emails.json'
results = {}
if os.path.exists(results_file):
    with open(results_file, 'r', encoding='utf-8') as f:
        results = json.load(f)
    print(f"已有结果: {len(results)} 家公司")

# 处理
to_process = [c for c in with_domain if c['domain'] not in results]
print(f"需搜索: {len(to_process)}")

for idx, c in enumerate(to_process):
    domain = c['domain']
    company = c['company']

    emails = find_emails_on_domain(domain)
    results[domain] = {
        'company': company,
        'domain': domain,
        'emails': {e: info for e, info in emails.items()}
    }

    n = len(emails)
    if n > 0:
        sample = list(emails.keys())[:3]
        print(f"[{idx+1}/{len(to_process)}] {company[:40]} -> {n} emails: {', '.join(sample)}")
    else:
        print(f"[{idx+1}/{len(to_process)}] {company[:40]} -> NONE")

    # 每30条保存
    if (idx + 1) % 30 == 0:
        with open(results_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"  --- saved {len(results)} domains ---")

    time.sleep(0.5)  # 频率控制

# 保存
with open(results_file, 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

# 统计
total_emails = sum(len(v['emails']) for v in results.values())
companies_with = sum(1 for v in results.values() if len(v['emails']) > 0)
print(f"\n=== 完成 ===")
print(f"搜索: {len(results)} 个域名")
print(f"找到真实邮箱的公司: {companies_with}")
print(f"真实邮箱总数: {total_emails}")
print(f"已保存: {results_file}")
