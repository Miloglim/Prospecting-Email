"""
最终输出 v2：结合网页搜索发现的真邮箱 + 真员工名 + 格式推断
"""
import pandas as pd, json, urllib.parse, sys, io, os, re, unicodedata
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

df = pd.read_excel('docs/已清洗.xlsx')

# ====== 从网页搜索确认的真邮箱数据 ======
# 格式: {domain: {'format': 'first.last', 'employees': [{'name':, 'title':, 'email':}], 'general': ['info@', ...]}}
VERIFIED_DATA = {
    'cevalogistics.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Kay Knox', 'title': 'US Agent', 'email': 'kay.knox@cevalogistics.com'},
            {'name': 'Rene Schroeder', 'title': 'Germany Office', 'email': 'rene.schroeder@cevalogistics.com'},
        ],
        'general': ['sh-gl-ccs-rfi@cevalogistics.com'],
    },
    'hellmann.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Camila Atoguia', 'title': 'Contact Person, Guarulhos SP', 'email': 'camila.atoguia@hellmann.com'},
            {'name': 'Marcio Bergantin', 'title': 'Contact Person, Guarulhos SP', 'email': 'marcio.bergantin@hellmann.com'},
            {'name': 'Guilherme Correa', 'title': 'Air/Sea Business Process Manager', 'email': 'guilherme.correa@hellmann.com'},
            {'name': 'Angel Santana', 'title': 'President & CEO Brazil', 'email': 'angel.santana@hellmann.com'},
        ],
        'general': [],
    },
    'dsv.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Alessandro Rabello', 'title': 'Customs Clearance Supervisor, Rio', 'email': 'alessandro.rabello@dsv.com'},
            {'name': 'Priscila Kaziami', 'title': 'Import Supervisor, SP', 'email': 'priscila.kaziami@dsv.com'},
            {'name': 'Fernanda Wolfsohn', 'title': 'CRM Supervisor Mercosur', 'email': 'fernanda.wolfsohn@dsv.com'},
            {'name': 'Pedro Vasconcelos', 'title': 'Global Account Manager Oil&Gas', 'email': 'pedro.vasconcelos@dsv.com'},
        ],
        'general': ['br.marketing@br.dsv.com'],
    },
    'craneww.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Audrei Bizzi', 'title': 'Account Manager, SP', 'email': 'audrei.bizzi@craneww.com'},
        ],
        'general': ['webquery@craneww.com'],
    },
    'geodis.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Wagner Brito', 'title': 'President-CEO Brazil, SP', 'email': 'wagner.brito@geodis.com'},
        ],
        'general': [],
    },
    'rohlig.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Rodrigo Simoes', 'title': 'Managing Director Brazil', 'email': 'rodrigo.simoes@rohlig.com'},
            {'name': 'Gabriela Domingos', 'title': 'Freight Forwarder, SP', 'email': 'gabriela.domingos@rohlig.com'},
        ],
        'general': ['headoffice@rohlig.com'],
    },
    'dachser.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Daniela Schmidt', 'title': 'BDM, Porto Alegre', 'email': 'daniela.schmidt@dachser.com'},
        ],
        'general': ['info@dachser.com'],
    },
    'asiashipping.co': {
        'format': 'first.last',
        'employees': [
            {'name': 'Felipe Colussi Carlet', 'title': 'Customer Service, Curitiba', 'email': 'felipe.carlet@asiashipping.co'},
        ],
        'general': [],
    },
    'scangl.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Lucas Morgado', 'title': 'Key Account Director, Santos', 'email': 'lucas.morgado@scangl.com'},
            {'name': 'Ednaldo Borba', 'title': 'Northeast Customs Director, Recife', 'email': 'ednaldo.borba@scangl.com'},
        ],
        'general': [],
    },
    'dclogisticsbrasil.com': {
        'format': 'first.last',
        'employees': [
            {'name': 'Ivo A. Mafra', 'title': 'President', 'email': 'ivo.mafra@dclogisticsbrasil.com'},
        ],
        'general': [],
    },
    'savinodelbene.com': {
        'format': 'first.last',
        'employees': [],
        'general': [],
    },
    'kuehne-nagel.com': {
        'format': 'first.last',
        'employees': [],
        'general': [],
    },
    'expeditors.com': {
        'format': 'first.last',
        'employees': [],
        'general': [],
    },
    'jas.com': {
        'format': 'first.last',
        'employees': [],
        'general': [],
    },
    'chrobinson.com': {
        'format': 'first.last',
        'employees': [],
        'general': [],
    },
    'kwe.com': {
        'format': 'first.last',
        'employees': [],
        'general': [],
    },
    'logwin-logistics.com': {
        'format': 'first.last',
        'employees': [],
        'general': [],
    },
    'ecuworldwide.com': {
        'format': 'first.last',
        'employees': [],
        'general': [],
    },
    'craneww.com': {
        'format': 'first.last',
        'employees': [{'name': 'Audrei Bizzi', 'title': 'Account Manager, SP', 'email': 'audrei.bizzi@craneww.com'}],
        'general': ['webquery@craneww.com'],
    },
}

# 加上已确认的 Phase1 域名
DIRECTORY_DOMAINS = {
    'emis.com', 'tendata.com', 'jctrans.com', 'importinfo.com', 'empresas.serasaexperian.com.br',
    'econodata.com.br', 'chemdmart.com', 'eximpedia.app', 'forwarderspages.com',
    'unglobalcompact.org', 'cnpj.biz', 'rocketreach.co', 'freshdi.com', 'marinetraffic.com',
    'fazcomex.com.br', 'unisco.com', 'gtran.net', 'all-forward.com', 'bnamericas.com',
    'olofamily.com', 'freightpages.org', 'cargoagentnetwork.com', 'cargoyellowpages.com',
    'tradeimex.in', 'fmc.gov', 'iata.org', 'loadmatch.com', 'freightnet.com', 'freightglobal.com',
}

if os.path.exists('docs/_phase1_results.json'):
    with open('docs/_phase1_results.json', 'r', encoding='utf-8') as f:
        phase1 = json.load(f)

def normalize_name(name):
    """标准化人名: 去重音 → 小写 → 替换空格为点"""
    s = unicodedata.normalize('NFKD', name)
    s = s.encode('ASCII', 'ignore').decode('ASCII')
    s = re.sub(r'[^a-zA-Z ]', '', s)
    return s.lower().replace(' ', '.')

def make_email(name, domain, format='first.last'):
    """根据格式生成邮箱"""
    if format == 'first.last':
        return f'{normalize_name(name)}@{domain}'
    return ''

# ====== 构建输出 ======
rows = []
for i, row in df.iterrows():
    cleaned = str(row['cleaned']) if pd.notna(row['cleaned']) and str(row['cleaned']) != 'None' else ''
    original = str(row['original']).replace('...', '').strip()
    company = cleaned if cleaned else original
    ctype = row.get('type', 'unknown')

    # 获取域名
    domain = ''
    website = ''
    if str(i) in phase1:
        d = phase1[str(i)].get('domain', '')
        w = phase1[str(i)].get('website', '')
        if d and d not in DIRECTORY_DOMAINS:
            domain = d
            website = w

    # LinkedIn搜索链接
    li_people = f'https://www.linkedin.com/search/results/people/?keywords={urllib.parse.quote(company)}'

    if domain and domain in VERIFIED_DATA:
        vd = VERIFIED_DATA[domain]
        fmt = vd['format']

        # 真员工行
        for emp in vd.get('employees', []):
            rows.append({
                'company': company, 'type': ctype, 'website': website, 'domain': domain,
                'contact_name': emp['name'], 'contact_title': emp['title'],
                'email': emp['email'], 'email_source': 'verified_web',
                'linkedin_search': li_people,
            })

        # 通用邮箱行
        for ge in vd.get('general', []):
            rows.append({
                'company': company, 'type': ctype, 'website': website, 'domain': domain,
                'contact_name': '', 'contact_title': 'General',
                'email': ge, 'email_source': 'verified_web',
                'linkedin_search': li_people,
            })

        # 如果没有员工也没有通用邮箱，至少留一行标记格式
        if not vd.get('employees') and not vd.get('general'):
            rows.append({
                'company': company, 'type': ctype, 'website': website, 'domain': domain,
                'contact_name': '', 'contact_title': f'Email format: {fmt}@',
                'email': '', 'email_source': 'format_confirmed',
                'linkedin_search': li_people,
            })

    elif domain:
        # 有域名但未验证 → 标记格式为 first.last（巴西行业标准）
        rows.append({
            'company': company, 'type': ctype, 'website': website, 'domain': domain,
            'contact_name': '', 'contact_title': 'Email format: first.last@ (Brazil standard)',
            'email': '', 'email_source': 'format_inferred',
            'linkedin_search': li_people,
        })
    else:
        # 无域名
        rows.append({
            'company': company, 'type': ctype, 'website': '', 'domain': '',
            'contact_name': '', 'contact_title': 'Need manual LinkedIn search',
            'email': '', 'email_source': 'manual_needed',
            'linkedin_search': li_people,
        })

out_df = pd.DataFrame(rows)
out_df = out_df.sort_values(['email_source', 'company'])
out_df.to_excel('docs/联系人清单.xlsx', index=False)

# 统计
verified_companies = out_df[out_df['email_source'] == 'verified_web']['company'].nunique()
verified_emails = (out_df['email_source'] == 'verified_web').sum()
format_companies = out_df[out_df['email_source'] == 'format_confirmed']['company'].nunique()
inferred_companies = out_df[out_df['email_source'] == 'format_inferred']['company'].nunique()
manual_companies = out_df[out_df['email_source'] == 'manual_needed']['company'].nunique()

print(f'真实验证邮箱: {verified_emails} 封 ({verified_companies} 家公司)')
print(f'格式确认(无具体人): {format_companies} 家')
print(f'格式推断(行业标准): {inferred_companies} 家')
print(f'需手动LinkedIn: {manual_companies} 家')
print(f'总计: {len(out_df)} 行 / {out_df["company"].nunique()} 家公司')
print(f'\n已保存: docs/联系人清单.xlsx')
