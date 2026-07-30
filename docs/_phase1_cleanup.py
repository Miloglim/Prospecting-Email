"""
Phase 1 清洗：过滤目录网站 → 重搜 → 提取真实官网
"""
import pandas as pd, json, requests, time, sys, io, os, re
from urllib.parse import urlparse
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from dotenv import load_dotenv
load_dotenv('E:/Agents Basement/projects/Prospecting Email/.env')
TAVILY_KEY = os.getenv('TAVILY_API_KEY')

# 目录/数据聚合网站（不是公司真实官网）
DIRECTORY_DOMAINS = {
    'emis.com', 'tendata.com', 'jctrans.com', 'importinfo.com',
    'empresas.serasaexperian.com.br', 'econodata.com.br',
    'chemdmart.com', 'eximpedia.app', 'forwarderspages.com',
    'unglobalcompact.org', 'cnpj.biz', 'rocketreach.co',
    'freshdi.com', 'marinetraffic.com', 'fazcomex.com.br',
    'unisco.com', 'gtran.net', 'all-forward.com', 'bnamericas.com',
    'olofamily.com', 'ymfglobal.com', 'freightpages.org',
    'cargoagentnetwork.com', 'cargoyellowpages.com',
    'tradeimex.in', 'fmc.gov', 'iata.org', 'loadmatch.com',
    'b2match.com', 'cargopartnersnetwork.com', 'fobshanghai.com',
    'bbs.fobshanghai.com', 'gov.br', 'dados.transportes.gov.br',
    'transport.ec.europa.eu', 'portaldatransparencia.gov.br',
    'finance.yahoo.com', 'dnb.com', 'leadiq.com', 'ampliz.com',
    'safer.fmcsa.dot.gov', 'discovernikkei.org', 'app.dealroom.co',
    'importkey.com', 'tradeford.com', 'usitc.gov',
    'help.shootproof.com', 'forgottenrealms.fandom.com',
    'imdb.com', 'ibm.com', 'doc.milestonesys.com',
    'reclameaqui.com.br', 'goldsupplier.com', 'lht56.goldsupplier.com',
    'autozine.org', 'wavelengthextracts.com',
    'es-energy.info', 'b2match.com', 'fiata.org',
    'searates.com', 'intermodal-logistics.eu', 'europe.breakbulk.com',
    'webnode.page', 'starlog-logistica.webnode.page',
    'wto.com', 'key.com', 'dk.com', 'iasa.net',
    'hbwty.com', 'logitrans-handling.be',
    'pangea-network.com', 'freightnet.com', 'freightglobal.com',
}

def is_good_domain(domain):
    """判断是否真实公司域名"""
    if not domain:
        return False
    domain = domain.lower()
    if domain in DIRECTORY_DOMAINS:
        return False
    # 这些TLD模式通常是真实公司网站
    return True

def search_real_website(company_name):
    """第二轮搜索：更精准地找公司官网"""
    queries = [
        f'"{company_name}" contato site:.br',
        f'"{company_name}" site oficial',
    ]

    for query in queries:
        try:
            resp = requests.post('https://api.tavily.com/search', json={
                'api_key': TAVILY_KEY,
                'query': query,
                'search_depth': 'basic',
                'include_answer': False,
                'max_results': 5,
            }, timeout=15)
            data = resp.json()

            for r in data.get('results', []):
                url = r.get('url', '')
                if not url:
                    continue
                parsed = urlparse(url)
                domain = parsed.netloc.lower()
                domain = re.sub(r'^www\d?\.', '', domain)

                if is_good_domain(domain):
                    return url, domain
        except:
            pass

    return '', ''

# 加载Phase1结果
with open('docs/_phase1_results.json', 'r', encoding='utf-8') as f:
    results = json.load(f)

# 分类
good = {}  # 好的真实网站
bad = {}   # 目录网站
no_url = {}  # 没找到

for k, v in results.items():
    domain = v.get('domain', '')
    website = v.get('website', '')
    if not website:
        no_url[k] = v
    elif is_good_domain(domain):
        good[k] = v
    else:
        bad[k] = v

print(f"真实官网: {len(good)}")
print(f"目录网站: {len(bad)}")
print(f"无URL: {len(no_url)}")
print(f"\n重搜目录+无URL: {len(bad) + len(no_url)} 条")

# 重搜
to_research = {**bad, **no_url}
fixed = 0
for k, v in to_research.items():
    name = v['name']
    url, domain = search_real_website(name)

    if url:
        results[k] = {**v, 'website': url, 'domain': domain}
        fixed += 1
        print(f"  FIXED: {name[:60]} -> {domain}")
    else:
        print(f"  STILL NO: {name[:60]}")

    time.sleep(0.3)

# 保存
with open('docs/_phase1_results.json', 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

# 合并到Excel
df = pd.read_excel('docs/已清洗.xlsx')
for i_str, data in results.items():
    i = int(i_str)
    df.at[i, 'website'] = data.get('website', '')
    df.at[i, 'domain'] = data.get('domain', '')
df.to_excel('docs/已清洗.xlsx', index=False)

# 统计
final_good = sum(1 for v in results.values() if v.get('website') and is_good_domain(v.get('domain', '')))
print(f"\n=== 清理完成 ===")
print(f"真实官网: {final_good}/{len(results)} ({final_good/len(results)*100:.1f}%)")
print(f"本次修复: {fixed}")
