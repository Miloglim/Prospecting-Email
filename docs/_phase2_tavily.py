"""
Phase 2: Tavily网页挖掘 — 邮箱 + LinkedIn公开资料
搜索: "{公司}" email contact + site:linkedin.com
"""
import pandas as pd, json, requests, time, sys, io, os, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from dotenv import load_dotenv
load_dotenv('E:/Agents Basement/projects/Prospecting Email/.env')
TAVILY_KEY = os.getenv('TAVILY_API_KEY')

df = pd.read_excel('docs/已清洗.xlsx')
# 只处理已清洗的
valid = df[(df['cleaned'].notna()) & (df['cleaned'] != 'None') & (df['cleaned'] != 'nan')]
print(f"有效公司: {len(valid)}")

# 加载已有
contacts_file = 'docs/_phase2_contacts.json'
all_contacts = {}
if os.path.exists(contacts_file):
    with open(contacts_file, 'r', encoding='utf-8') as f:
        all_contacts = json.load(f)

# 邮箱正则
EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')
LINKEDIN_RE = re.compile(r'linkedin\.com/in/([a-zA-Z0-9_-]+)')

def search_contacts(company_name, domain=''):
    """多轮搜索找联系人和邮箱"""
    emails = set()
    people = []

    # 搜索1: 公开邮箱
    try:
        r = requests.post('https://api.tavily.com/search', json={
            'api_key': TAVILY_KEY, 'query': f'"{company_name}" email OR "@" contact', 'max_results': 5, 'include_answer': True
        }, timeout=15)
        data = r.json()
        text = data.get('answer', '') + ' '.join(r.get('url', '')+r.get('content','') for r in data.get('results', []))
        found = EMAIL_RE.findall(text)
        for e in found:
            e = e.lower().strip()
            if not any(kw in e for kw in ['example', 'test', 'noreply', 'no-reply', 'support@']):
                emails.add(e)
    except:
        pass

    # 搜索2: LinkedIn公开资料
    try:
        r = requests.post('https://api.tavily.com/search', json={
            'api_key': TAVILY_KEY, 'query': f'{company_name} manager OR director OR gerente OR diretor site:linkedin.com', 'max_results': 5, 'include_answer': True
        }, timeout=15)
        data = r.json()
        text = data.get('answer', '') + ' '.join(r.get('title', '')+r.get('content','') for r in data.get('results', []))

        # 提取LinkedIn profile名
        linkedin_profiles = LINKEDIN_RE.findall(text)

        # 从搜索结果标题提取人名+职位
        for r in data.get('results', []):
            title = r.get('title', '')
            # LinkedIn标题格式: "Name - Title - Company | LinkedIn"
            parts = title.split(' - ')
            if len(parts) >= 2 and 'LinkedIn' in title:
                name = parts[0].strip()
                role = parts[1].strip() if len(parts) > 1 else ''
                if len(name) > 3 and len(name) < 40 and not any(kw in name.lower() for kw in ['jobs', 'search', 'linkedin', 'profile']):
                    people.append({'name': name, 'title': role, 'source': 'linkedin_web'})

        # 提取人名格式（网页文本中）
        name_pattern = re.findall(r'([A-Z][a-zÀ-ÿ]+ [A-Z][a-zÀ-ÿ]+(?: [A-Z][a-zÀ-ÿ]+)?) (?:is|at|with|,).{0,30}(?:manager|director|gerente|diretor|head|chief|VP)', text, re.IGNORECASE)
        for n in name_pattern[:5]:
            if len(n) < 30:
                people.append({'name': n, 'title': '', 'source': 'web_text'})

    except:
        pass

    # 搜索3: 如果有域名，搜 "@domain" 邮箱
    if domain:
        try:
            r = requests.post('https://api.tavily.com/search', json={
                'api_key': TAVILY_KEY, 'query': f'@{domain} email', 'max_results': 3, 'include_answer': True
            }, timeout=15)
            data = r.json()
            text = data.get('answer', '') + ' '.join(r.get('content','') for r in data.get('results', []))
            found = EMAIL_RE.findall(text)
            for e in found:
                e = e.lower().strip()
                if e.endswith('@' + domain) and not any(kw in e for kw in ['example', 'test', 'noreply']):
                    emails.add(e)
        except:
            pass

    return {'emails': list(emails)[:10], 'people': people[:10]}

# 处理
to_process = [i for i, row in valid.iterrows() if str(row['cleaned']).strip() not in all_contacts]
print(f"需搜索: {len(to_process)}")

for count, i in enumerate(to_process):
    row = valid.loc[i]
    name = str(row['cleaned']).strip()
    domain = str(row.get('domain', '')).strip()

    result = search_contacts(name, domain)
    all_contacts[name] = result

    n_emails = len(result['emails'])
    n_people = len(result['people'])
    print(f"[{count+1}/{len(to_process)}] {name[:50]} -> {n_emails} emails, {n_people} people")

    if (count + 1) % 20 == 0:
        with open(contacts_file, 'w', encoding='utf-8') as f:
            json.dump(all_contacts, f, ensure_ascii=False, indent=2)
        print(f"  --- saved {len(all_contacts)} ---")

    time.sleep(0.3)

# 保存
with open(contacts_file, 'w', encoding='utf-8') as f:
    json.dump(all_contacts, f, ensure_ascii=False, indent=2)

total_e = sum(len(v.get('emails', [])) for v in all_contacts.values())
total_p = sum(len(v.get('people', [])) for v in all_contacts.values())
print(f"\n=== Phase 2 完成 ===")
print(f"公司: {len(all_contacts)}")
print(f"邮箱: {total_e}")
print(f"联系人: {total_p}")
print(f"已保存: {contacts_file}")
