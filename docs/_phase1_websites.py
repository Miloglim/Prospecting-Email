"""
Phase 1: 官网 + 邮箱域名发现
读取已清洗.xlsx → Tavily搜索 → 提取官网URL → 提取域名 → 保存
"""
import pandas as pd, json, requests, time, sys, io, os, re, unicodedata
from urllib.parse import urlparse
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from dotenv import load_dotenv
load_dotenv('E:/Agents Basement/projects/Prospecting Email/.env')
TAVILY_KEY = os.getenv('TAVILY_API_KEY')

# 读取
df = pd.read_excel('docs/已清洗.xlsx')
print(f"总行数: {len(df)}")

# 取需要搜索的公司名
def get_search_name(row):
    cleaned = str(row['cleaned'])
    if cleaned and cleaned != 'None' and cleaned != 'nan':
        return cleaned
    orig = str(row['original']).replace('...', '').strip()
    return orig

# 去重
names = {}
for i, row in df.iterrows():
    name = get_search_name(row)
    if name and name != 'nan':
        names[i] = name

print(f"有效公司: {len(names)} (去重后: {len(set(names.values()))})")

def extract_domain(url):
    """从URL提取域名"""
    if not url or not url.startswith('http'):
        return '', ''
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        domain = re.sub(r'^www\d?\.', '', domain)
        return url, domain
    except:
        return url, ''

def search_website(company_name):
    """Tavily搜索公司官网"""
    query = f'"{company_name}" official website'
    try:
        resp = requests.post('https://api.tavily.com/search', json={
            'api_key': TAVILY_KEY,
            'query': query,
            'search_depth': 'basic',
            'include_answer': False,
            'max_results': 5,
        }, timeout=15)
        data = resp.json()

        # 从搜索结果提取URL
        candidates = []
        for r in data.get('results', []):
            url = r.get('url', '')
            if not url:
                continue
            # 排除社交/目录网站
            skip_domains = ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com',
                          'youtube.com', 'wikipedia.org', 'bloomberg.com', 'zoominfo.com',
                          'signalhire.com', 'importgenius.com', 'volza.com', '52wmb.com',
                          'info-clipper.com', 'dunsguide.com', 'crunchbase.com',
                          'owler.com', 'pitchbook.com', 'trademo.com', 'panjiva.com']
            parsed = urlparse(url)
            if any(s in parsed.netloc.lower() for s in skip_domains):
                continue
            candidates.append(url)

        if candidates:
            return candidates[0]  # 第一个非社交URL
        return ''

    except Exception as e:
        return ''

# 加载已有结果
results = {}
if os.path.exists('docs/_phase1_results.json'):
    with open('docs/_phase1_results.json', 'r', encoding='utf-8') as f:
        results = json.load(f)
    print(f"已有结果: {len(results)}")

# 搜索
idx_list = [i for i in names if str(i) not in results]
print(f"需搜索: {len(idx_list)}")

count = 0
for i in idx_list:
    name = names[i]
    count += 1

    url = search_website(name)
    website, domain = extract_domain(url)

    results[str(i)] = {
        'name': name,
        'website': website,
        'domain': domain,
        'searched_at': time.strftime('%Y-%m-%d %H:%M:%S')
    }

    status = 'OK' if website else 'NO'
    print(f"[{count}/{len(idx_list)}] {status}: {name[:60]} -> {domain or 'no website'}")

    # 每20条保存
    if count % 20 == 0:
        with open('docs/_phase1_results.json', 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"  --- saved {len(results)} ---")

    time.sleep(0.25)

# 最终保存
with open('docs/_phase1_results.json', 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

# 合并到Excel
for i_str, data in results.items():
    i = int(i_str)
    df.at[i, 'website'] = data.get('website', '')
    df.at[i, 'domain'] = data.get('domain', '')

df.to_excel('docs/已清洗.xlsx', index=False)

found = sum(1 for v in results.values() if v.get('website'))
print(f"\n=== Phase 1 完成 ===")
print(f"找到官网: {found}/{len(results)} ({found/len(results)*100:.1f}%)")
print(f"已保存: docs/已清洗.xlsx")
