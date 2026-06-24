"""
Scrapling 抓取微服务 — Milogin's Prospector 后台
启动: python scrape_service.py (默认 http://127.0.0.1:8765)
"""
import sys
import os
import re
import json
import asyncio
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Query
import uvicorn

# ── Scrapling 检查 ──────────────────────────────────────────────────
try:
    from scrapling.fetchers import Fetcher, DynamicFetcher
    SCRAPLING_OK = True
except ImportError:
    SCRAPLING_OK = False
    print("[scrapling-service] ⚠️ Scrapling 未安装: pip install 'scrapling[all]' && scrapling install")


# ── 常量 ────────────────────────────────────────────────────────────
NON_COMPANY_DOMAINS = [
    'linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com',
    'youtube.com', 'tiktok.com', 'wikipedia.org', 'reddit.com',
    'google.com', 'apple.com', 'microsoft.com', 'amazon.com',
]

# 决策角色关键词（葡/西/英）
LOGISTICS_KW = [
    'supply chain', 'logistics', 'procurement', 'compras', 'buyer',
    'import', 'export', 'customs', 'shipping', 'freight', 'transport',
    'cadena de suministro', 'logística', 'adquisiciones', 'importación',
    'exportación', 'aduana', 'supply', 'purchasing', 'sourcing',
    'suprimentos', 'comprador', 'planejamento', 'comercio exterior',
]

EXECUTIVE_KW = [
    'ceo', 'president', 'director', 'general manager', 'vp', 'vice president',
    'managing director', 'country manager', 'plant manager',
    'director general', 'gerente general', 'presidente',
]


# ── 浏览器复用（模块级常驻）─────────────────────────────────────────
_browser = None
_browser_lock = asyncio.Lock()

async def get_browser():
    """获取或创建 Chromium 实例（常驻复用，避免冷启动）"""
    global _browser
    if _browser is not None:
        return _browser

    async with _browser_lock:
        if _browser is not None:
            return _browser
        try:
            from scrapling.engines._browsers._controllers import DynamicSession
            session = DynamicSession(headless=True, network_idle=True)
            await session.start()
            _browser = session
            print("[scrapling-service] Chromium 已启动（常驻复用）")
            return _browser
        except Exception as e:
            print(f"[scrapling-service] Chromium 启动失败: {e}")
            return None


# ── 辅助函数 ────────────────────────────────────────────────────────
def is_company_url(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ''
        return not any(d in host.lower() for d in NON_COMPANY_DOMAINS)
    except Exception:
        return False


def extract_text(page, max_chars: int = 3000) -> str:
    """从 Scrapling 页面提取可见文本"""
    for tag in page.css('script, style, nav, footer, iframe, noscript'):
        try: tag.remove()
        except: pass

    parts = []
    for h in page.css('h1, h2, h3'):
        try:
            t = re.sub(r'<[^>]+>', '', h.html_content).strip()
            if t and 3 < len(t) < 80:
                parts.append(t)
        except: pass

    for p in page.css('p, li'):
        try:
            t = re.sub(r'<[^>]+>', '', p.html_content).strip()
            if t and len(t) > 15:
                parts.append(t[:300])
        except: pass

    text = '\n'.join(parts)
    return text[:max_chars]


def crawl_page(url: str, stealth: bool = False) -> dict:
    """抓取单个页面"""
    try:
        if stealth:
            from scrapling.fetchers import StealthyFetcher
            page = StealthyFetcher.fetch(url, solve_cloudflare=True, network_idle=True, timeout=20000)
        else:
            page = DynamicFetcher.fetch(url, headless=True, network_idle=True, timeout=20000)
        return {
            'ok': True,
            'url': url,
            'title': (page.css('title::text').get() or '').strip(),
            'text': extract_text(page),
        }
    except Exception as e:
        # fallback 到静态抓取
        try:
            page = Fetcher.get(url, impersonate='chrome', stealthy_headers=True)
            return {
                'ok': True,
                'url': url,
                'title': (page.css('title::text').get() or '').strip(),
                'text': extract_text(page),
            }
        except Exception as e2:
            return {'ok': False, 'url': url, 'error': str(e2)[:100]}


# ═══════════════════════════════════════════════════════════════════
# 应用
# ═══════════════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[scrapling-service] ✅ 启动: http://127.0.0.1:8765")
    if SCRAPLING_OK:
        print("[scrapling-service]    TLS 指纹伪装 + Cloudflare 绕过")
    yield
    global _browser
    if _browser:
        try: await _browser.stop()
        except: pass
        _browser = None
        print("[scrapling-service] Chromium 已释放")


app = FastAPI(title="Scrapling Service", version="2.0.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok", "scrapling": SCRAPLING_OK}


# ═══════════════════════════════════════════════════════════════════
# 网页搜索（DDG，静态抓取）
# ═══════════════════════════════════════════════════════════════════
@app.get("/search/web")
def search_web(q: str = Query(...), n: int = Query(8)):
    if not SCRAPLING_OK:
        return {"ok": False, "error": "scrapling_not_installed", "results": []}

    try:
        page = Fetcher.get(
            f"https://html.duckduckgo.com/html/?q={q}",
            impersonate="chrome", stealthy_headers=True,
        )
        results = []
        seen = set()
        for item in page.css('.result'):
            title_el = item.css('.result__title a')
            snippet_el = item.css('.result__snippet')
            title = title_el.text.strip() if title_el else ''
            snippet = snippet_el.text.strip() if snippet_el else ''
            href = title_el[0].attrib.get('href', '') if title_el else ''
            if href:
                from urllib.parse import urlparse, parse_qs
                parsed = urlparse(href)
                params = parse_qs(parsed.query)
                real_url = params.get('uddg', [href])[0]
            else:
                real_url = ''

            if not title or len(title) < 3 or real_url in seen:
                continue
            seen.add(real_url)
            results.append({
                "title": title[:120], "snippet": snippet[:300],
                "url": real_url, "is_company": is_company_url(real_url),
            })

        company_url = next((r['url'] for r in results if r['is_company']), '')

        return {
            "ok": True,
            "foundUrl": company_url,
            "snippets": '\n'.join(
                f"- **{r['title']}**: {r['snippet']}\n  {r['url']}"
                for r in results[:n]
            ),
            "results": results[:n],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200], "results": []}


# ═══════════════════════════════════════════════════════════════════
# 官网抓取（DynamicFetcher，JS 渲染）
# ═══════════════════════════════════════════════════════════════════
@app.get("/scrape/website")
def scrape_website(
    url: str = Query(...),
    stealth: bool = Query(True),
    max_chars: int = Query(3000),
):
    if not SCRAPLING_OK:
        return {"ok": False, "error": "scrapling_not_installed", "text": ""}
    if not url.startswith('http'):
        return {"ok": False, "error": "invalid_url", "text": ""}
    if not is_company_url(url):
        return {"ok": False, "error": "non_company_url", "text": ""}

    result = crawl_page(url, stealth=stealth)
    return {
        **result,
        "has_content": len(result.get('text', '')) > 100,
    }


# ═══════════════════════════════════════════════════════════════════
# 决策人深挖（并行抓取官网关键页面）
# ═══════════════════════════════════════════════════════════════════
@app.get("/scrape/contacts")
async def scrape_contacts(
    url: str = Query(...),
    company: str = Query(''),
):
    """
    并行抓取官网关键页面，提取业务信息和人物线索。
    返回：
    - company_info: 公司业务描述、地址、邮箱
    - people: 从页面文本中提取的可能人物（姓名+职位模式）
    - pages_crawled: 已抓取的页面列表
    """
    if not SCRAPLING_OK:
        return {"ok": False, "error": "scrapling_not_installed"}
    if not url.startswith('http'):
        return {"ok": False, "error": "invalid_url"}
    if not is_company_url(url):
        return {"ok": False, "error": "non_company_url"}

    # 从公司名提取域名
    domain = urlparse(url).netloc

    # 需要抓取的子页面候选
    sub_paths = ['/about/', '/about-us/', '/company/', '/contact/', '/careers/',
                 '/team/', '/leadership/', '/management/', '/our-story/',
                 '/who-we-are/', '/locations/', '/facilities/',
                 '/sobre/', '/equipe/', '/contato/', '/institucional/',
                 '/quem-somos/', '/smc-no-brasil/', '/empresa/']

    # 先抓首页，从导航中提取实际存在的子页面
    print(f"[scrapling-service] 并行抓取: {domain}")

    # 并行抓取：首页 + 从导航中发现的子页面
    homepage_result = await asyncio.to_thread(crawl_page, url)

    # 从首页提取导航链接
    nav_links = set()
    if homepage_result.get('ok'):
        try:
            page = DynamicFetcher.fetch(url, headless=True, network_idle=True, timeout=20000)
            for a in page.css('a[href]'):
                href = (a.attrib.get('href') or '').strip()
                if href and not href.startswith('#') and not href.startswith('javascript:'):
                    if href.startswith('/') or domain in href:
                        if href.startswith('/'):
                            href = f"{url.rstrip('/')}{href}"
                        nav_links.add(href)
        except:
            pass

    # 从导航中筛选有价值的子页面（匹配 about/team/contact/company 等）
    value_patterns = ['about', 'company', 'team', 'contact', 'career',
                      'leader', 'manage', 'people', 'history', 'location',
                      'facilit', 'innovation', 'mission', 'value', 'story',
                      'sobre', 'equipe', 'contato', 'institucional', 'empresa',
                      'quem-somos', 'gestao', 'governanca']
    target_urls = [url]  # 首页永远抓
    for link in nav_links:
        if len(target_urls) >= 6:
            break
        low = link.lower()
        if any(p in low for p in value_patterns):
            if link not in target_urls:
                target_urls.append(link)

    # 并行抓取所有目标页面
    tasks = [asyncio.to_thread(crawl_page, u) for u in target_urls]
    results = await asyncio.gather(*tasks)

    # 合并结果
    all_text = ''
    pages_crawled = []
    emails_found = set()
    addresses = []

    for r in results:
        if r.get('ok'):
            pages_crawled.append(r['url'])
            all_text += '\n' + r.get('text', '')
            # 提取邮箱
            found_emails = set(re.findall(
                r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',
                r.get('text', '')
            ))
            emails_found.update(found_emails)

    # 提取人物（正则匹配 "Name Surname, Title" 模式）
    # 西语/葡语/英语常见人物模式
    people_patterns = [
        # "John Smith, Supply Chain Director"
        r'([A-Z][a-zà-ü]+(?:\s+[A-Z][a-zà-ü]+){1,3})\s*[,—–-]\s*(.{5,80}?)(?:$|\n|\.)',
        # "John Smith — Supply Chain Director"
        r'([A-Z][a-zà-ü]+(?:\s+[A-Z][a-zà-ü]+){1,3})\s*[—–-]\s*(.{5,80}?)(?:$|\n|\.)',
    ]

    people = []
    seen_names = set()
    for pattern in people_patterns:
        for match in re.finditer(pattern, all_text):
            name = match.group(1).strip()
            title = match.group(2).strip()
            if name in seen_names or len(name.split()) < 2 or len(name.split()) > 4:
                continue
            if len(title) < 5 or len(title) > 80:
                continue
            seen_names.add(name)

            # 角色分类
            low_title = title.lower()
            dept = 'other'
            if any(kw in low_title for kw in LOGISTICS_KW):
                dept = 'logistics'
            elif any(kw in low_title for kw in EXECUTIVE_KW):
                dept = 'management'

            # 邮箱推断
            inferred_email = ''
            if emails_found and domain:
                # 从已找到的邮箱推断格式
                for e in emails_found:
                    if domain.replace('www.', '') in e:
                        parts = e.split('@')[0].split('.')
                        first = name.split()[0].lower()
                        last = name.split()[-1].lower()
                        if len(parts) == 1:
                            inferred_email = f"{first}.{last}@{domain.replace('www.', '')}"
                        elif len(parts) == 2:
                            inferred_email = f"{parts[0]}.{parts[1]}@{domain.replace('www.', '')}"
                            inferred_email = f"{first}.{last}@{domain.replace('www.', '')}"
                        break
                if not inferred_email:
                    first = name.split()[0].lower()
                    last = name.split()[-1].lower()
                    inferred_email = f"{first}.{last}@{domain.replace('www.', '')}"

            people.append({
                "name": name,
                "title": title,
                "department": dept,
                "email": inferred_email,
                "confidence": 0.4 if inferred_email else 0.2,
                "source": "website",
            })

    # 提取公司描述和地址
    company_info = {
        "domain": domain,
        "description": '',
        "addresses": [],
    }

    # 提取 meta description
    try:
        if homepage_result.get('ok'):
            desc_match = re.search(r'meta.*?description.*?content="([^"]+)"', homepage_result.get('text', ''))
            if desc_match:
                company_info['description'] = desc_match.group(1)[:300]
    except: pass

    # 地址：匹配常见的地址格式
    addr_patterns = [
        r'(\d{3,6}\s+.+?(?:Road|Street|Drive|Ave|Blvd|Rd|St|Dr|Avenue|Lane|Way|Industrial|Park).+?(?:\d{5}))',
        r'(Pedregal|Avenida|Av\.|Rua|Rodovia|Carretera).+?\d{4,5}',
    ]
    for pat in addr_patterns:
        for m in re.finditer(pat, all_text, re.IGNORECASE):
            addr = m.group(0).strip()
            if len(addr) > 15 and addr not in addresses:
                addresses.append(addr)
    company_info['addresses'] = addresses[:5]

    return {
        "ok": True,
        "company_info": company_info,
        "people": people[:15],
        "emails_found": list(emails_found)[:5],
        "pages_crawled": pages_crawled,
        "stats": {
            "pages_fetched": len(pages_crawled),
            "people_found": len(people),
            "logistics_people": sum(1 for p in people if p['department'] == 'logistics'),
            "management_people": sum(1 for p in people if p['department'] == 'management'),
        },
    }


# ═══════════════════════════════════════════════════════════════════
# 客户发现（多数据源并行搜索）
# ═══════════════════════════════════════════════════════════════════
@app.get("/search/discover")
async def search_discover(
    country: str = Query(...),
    industry: str = Query(''),
    role: str = Query('importer'),
    keywords: str = Query(''),
    limit: int = Query(20),
):
    """
    多数据源并行搜索潜在客户。
    数据源：Serper + Google Maps + Exa + LinkedIn + DDG + ConnectAmericas + Kompass
    """
    import httpx

    # ── 读配置 ──
    config = {}
    config_path = os.path.join(os.path.dirname(__file__), '..', 'send', 'config.json')
    try:
        if os.path.exists(config_path):
            config = json.loads(open(config_path, encoding='utf-8').read())
    except: pass
    search_cfg = config.get('search') or {}
    serper_key = search_cfg.get('serperKey', '')
    exa_key = search_cfg.get('exaKey', '')
    maps_key = search_cfg.get('googleMapsKey', '')
    cc = country[:2].lower() if len(country) > 2 else ''

    # ── 搜索词构建 ──
    role_map = {
        'importer': 'import company',
        'distributor': 'distribution company',
        'manufacturer': 'manufacturing company',
        'any': 'company',
    }
    role_term = role_map.get(role, 'company')
    base_q = f"{country} {industry} {role_term} {keywords}".strip()

    # ═══════════════════════════════════════════════════════════════
    # 搜索函数
    # ═══════════════════════════════════════════════════════════════

    async def search_serper(q):
        """Serper.dev Google 搜索"""
        if not serper_key: return []
        try:
            async with httpx.AsyncClient(timeout=15) as cl:
                r = await cl.post('https://google.serper.dev/search',
                    headers={'X-API-KEY': serper_key, 'Content-Type': 'application/json'},
                    json={'q': q, 'num': 10, 'gl': cc if cc else 'us'})
                return _parse_serper(r.json(), country, industry)
        except Exception as e:
            print(f'[discover] Serper: {e}'); return []

    async def search_google_maps(q):
        """Google Maps Places API Text Search"""
        if not maps_key: return []
        try:
            async with httpx.AsyncClient(timeout=15) as cl:
                r = await cl.post('https://places.googleapis.com/v1/places:searchText',
                    headers={'X-Goog-Api-Key': maps_key, 'Content-Type': 'application/json',
                             'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.websiteUri,places.internationalPhoneNumber,places.rating,places.types,places.businessStatus'},
                    json={'textQuery': q, 'maxResultCount': 10})
                data = r.json()
                items = []
                for p in (data.get('places') or []):
                    name = p.get('displayName', {}).get('text', '')
                    if not name: continue
                    website = p.get('websiteUri', '')
                    addr = p.get('formattedAddress', '')
                    phone = p.get('internationalPhoneNumber', '')
                    rating = p.get('rating', 0)
                    types = p.get('types', [])
                    items.append({
                        'company': name[:100], 'website': website,
                        'country': country, 'category': industry,
                        'snippet': f"{addr} | ☎ {phone} | ⭐{rating}" if addr else '',
                        'source': 'google_maps', 'confidence': 0.75 if website else 0.55,
                        'address': addr, 'phone': phone, 'rating': rating,
                    })
                return items
        except Exception as e:
            print(f'[discover] Google Maps: {e}'); return []

    async def search_exa(q):
        """Exa AI 语义搜索"""
        if not exa_key: return []
        try:
            async with httpx.AsyncClient(timeout=20) as cl:
                r = await cl.post('https://api.exa.ai/search',
                    headers={'x-api-key': exa_key, 'Content-Type': 'application/json'},
                    json={'query': q, 'numResults': 8, 'type': 'auto'})
                data = r.json()
                items = []
                for org in (data.get('results') or [])[:8]:
                    title, link = org.get('title', ''), org.get('url', '')
                    snippet = org.get('text', org.get('snippet', ''))
                    if not link: continue
                    items.append({
                        'company': title[:100], 'website': link,
                        'country': country, 'category': industry,
                        'snippet': snippet[:300], 'source': 'exa', 'confidence': 0.8,
                    })
                return items
        except Exception as e:
            print(f'[discover] Exa: {e}'); return []

    async def search_ddg(q):
        """DDG 搜索"""
        try:
            result = await asyncio.to_thread(Fetcher.get,
                f'https://html.duckduckgo.com/html/?q={q}',
                impersonate='chrome', stealthy_headers=True)
            items = []
            for item in result.css('.result')[:6]:
                title_el = item.css('.result__title a')
                snippet_el = item.css('.result__snippet')
                title = title_el.text.strip() if title_el else ''
                snippet = snippet_el.text.strip() if snippet_el else ''
                href = title_el[0].attrib.get('href', '') if title_el else ''
                real_url = ''
                if href:
                    from urllib.parse import urlparse, parse_qs
                    p = urlparse(href); params = parse_qs(p.query)
                    real_url = params.get('uddg', [href])[0]
                if title and real_url and len(title) > 3:
                    items.append({
                        'company': title[:100], 'website': real_url,
                        'country': country, 'category': industry,
                        'snippet': snippet[:300], 'source': 'ddg', 'confidence': 0.4,
                    })
            return items
        except Exception as e:
            print(f'[discover] DDG: {e}'); return []

    async def search_connectamericas(q):
        """ConnectAmericas — IDB 拉美 B2B 平台"""
        try:
            result = await asyncio.to_thread(Fetcher.get,
                f'https://connectamericas.com/search?search={q}&type=company',
                impersonate='chrome', stealthy_headers=True)
            items = []
            for card in result.css('.company-card, .search-result-item, .company-item')[:10]:
                name_el = card.css('h3, h4, .company-name, .name')
                link_el = card.css('a[href]')
                desc_el = card.css('p, .description')
                name = name_el[0].text.strip() if name_el else ''
                link = link_el[0].attrib.get('href', '') if link_el else ''
                desc = desc_el[0].text.strip() if desc_el else ''
                if name and len(name) > 3:
                    items.append({
                        'company': name[:100], 'website': link if link.startswith('http') else f'https://connectamericas.com{link}',
                        'country': country, 'category': industry,
                        'snippet': desc[:300], 'source': 'connectamericas', 'confidence': 0.65,
                    })
            return items
        except Exception as e:
            print(f'[discover] ConnectAmericas: {e}'); return []

    async def search_kompass(q):
        """Kompass 全球企业名录"""
        try:
            result = await asyncio.to_thread(Fetcher.get,
                f'https://www.kompass.com/searchCompanies?text={q}&searchType=SUPPLIER',
                impersonate='chrome', stealthy_headers=True)
            items = []
            for card in result.css('.company-card, .search-result, .result-item, li')[:10]:
                name_el = card.css('h2, h3, .company-name, .name, a')
                link_el = card.css('a[href]')
                desc_el = card.css('p, .description, .activity')
                name = name_el[0].text.strip() if name_el else ''
                link = ''
                if link_el:
                    href = link_el[0].attrib.get('href', '')
                    link = f'https://www.kompass.com{href}' if href.startswith('/') else href
                desc = desc_el[0].text.strip() if desc_el else ''
                if name and len(name) > 5:
                    items.append({
                        'company': name[:100], 'website': link,
                        'country': country, 'category': industry,
                        'snippet': desc[:300], 'source': 'kompass', 'confidence': 0.6,
                    })
            return items
        except Exception as e:
            print(f'[discover] Kompass: {e}'); return []

    # ═══════════════════════════════════════════════════════════════
    # 并行搜索
    # ═══════════════════════════════════════════════════════════════
    q_search = f"{country} {industry} {role_term}".strip()
    q_es = f'"{country}" "{industry}" importador empresa' if industry else ''

    tasks = [
        search_serper(q_search),
        search_serper(q_es) if serper_key and q_es else asyncio.sleep(0),
        search_exa(f'{q_search} company profile'),
        search_ddg(q_search),
        search_connectamericas(f'{country} {industry}'),
        search_kompass(f'{country} {industry}'),
        # Google Maps 被墙，保留函数等有 VPN 后启用:
        # search_google_maps(q_search),
    ]
    all_results = await asyncio.gather(*tasks)

    # 合并去重
    seen_domains = set()
    seen_names = set()
    merged = []
    for batch in all_results:
        if not isinstance(batch, list): continue
        for item in batch:
            # 用域名去重
            try:
                domain = urlparse(item['website']).netloc if item.get('website') else ''
            except: domain = ''
            key = domain or item['company'].lower()[:50]
            if key and key in seen_domains: continue
            if key: seen_domains.add(key)
            # 降低社交媒体 URL 的置信度
            if any(s in (item.get('website') or '') for s in ['linkedin','facebook','wikipedia','youtube']):
                item['confidence'] = max(0.1, item['confidence'] - 0.3)
            merged.append(item)

    # 统计来源
    sources = {}
    for item in merged:
        src = item['source']
        sources[src] = sources.get(src, 0) + 1

    merged.sort(key=lambda x: x['confidence'], reverse=True)

    return {
        'ok': True,
        'companies': merged[:limit],
        'total': len(merged),
        'sources': sources,
        'query': base_q,
    }


def _parse_serper(data, country, industry):
    """解析 Serper 搜索结果"""
    items = []
    for org in (data.get('organic') or [])[:8]:
        title = org.get('title', '')
        link = org.get('link', '')
        snippet = org.get('snippet', '')
        if not link or len(title) < 3: continue
        has_company = any(w in title.lower() for w in
            ['inc','ltd','s.a.','llc','corp','gmbh','company','group','industr','enterprise','sa de cv','srl','ltda'])
        items.append({
            'company': title[:100], 'website': link,
            'country': country, 'category': industry,
            'snippet': snippet[:300], 'source': 'serper',
            'confidence': 0.7 if has_company else 0.5,
        })
    return items


# ═══════════════════════════════════════════════════════════════════
# 邮箱反查（根据公司名/已知邮箱，推断其他员工邮箱）
# ═══════════════════════════════════════════════════════════════════
@app.get("/scrape/email-pattern")
async def email_pattern(
    company: str = Query(''),
    domain: str = Query(''),
):
    """
    根据公司名或已知邮箱域名，推断邮箱格式并查找相关人员。
    返回 pattern + 可推断的员工邮箱列表。
    """
    import httpx

    # 推断域名
    if not domain and company:
        # 通过 Serper 搜索公司官网
        config = {}
        config_path = os.path.join(os.path.dirname(__file__), '..', 'send', 'config.json')
        try:
            if os.path.exists(config_path):
                config = json.loads(open(config_path, encoding='utf-8').read())
        except: pass
        serper_key = (config.get('search') or {}).get('serperKey', '')
        if serper_key:
            try:
                async with httpx.AsyncClient(timeout=10) as cl:
                    r = await cl.post('https://google.serper.dev/search',
                        headers={'X-API-KEY': serper_key, 'Content-Type': 'application/json'},
                        json={'q': f'{company} official website', 'num': 1})
                    data = r.json()
                    first = (data.get('organic') or [{}])[0]
                    link = first.get('link', '')
                    if link:
                        domain = urlparse(link).netloc
            except: pass

    if not domain:
        return {'ok': False, 'error': 'no_domain', 'message': '无法确定公司域名，请提供已知邮箱'}

    # 抓取公司官网获取真实邮箱
    emails_found = set()
    website_text = ''
    try:
        page = Fetcher.get(f'https://{domain}', impersonate='chrome', stealthy_headers=True)
        text = page.css('body').html_content if page.css('body') else ''
        emails_found = set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text))
        website_text = re.sub(r'<[^>]+>', ' ', text)[:5000]
    except:
        try:
            page = DynamicFetcher.fetch(f'https://{domain}', headless=True, network_idle=True, timeout=20000)
            text = page.css('body').html_content if page.css('body') else ''
            emails_found = set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text))
            website_text = re.sub(r'<[^>]+>', ' ', text)[:5000]
        except: pass

    # 推断邮箱格式
    pattern = ''
    confidence = 0.0
    company_emails = [e for e in emails_found if domain.replace('www.', '') in e]
    if company_emails:
        confidence = 0.8
        # 分析格式
        formats = {}
        for e in company_emails[:10]:
            local = e.split('@')[0].lower()
            if '.' in local and '_' not in local:
                parts = local.split('.')
                if len(parts) == 2 and len(parts[0]) > 1:
                    fmt = 'firstname.lastname'
                else:
                    fmt = 'unknown'
            elif '_' in local:
                fmt = 'firstname_lastname'
            elif len(local) <= 8 and local.isalpha():
                fmt = 'short'
            else:
                fmt = 'custom'
            formats[fmt] = formats.get(fmt, 0) + 1
        pattern = max(formats, key=formats.get) if formats else 'firstname.lastname'

    if not pattern and domain:
        pattern = 'firstname.lastname'
        confidence = 0.3

    inferred_email = f'{{first}}.{format_email_domain(domain, pattern)}' if pattern else ''

    # 从官网文本提取人名+职位
    people = []
    name_patterns = [
        r'([A-Z][a-zà-ü]+(?:\s+[A-Z][a-zà-ü]+){1,2})\s*[,—–-]\s*(.{5,80}?)(?:\n|\.|$)',
    ]
    seen = set()
    for pat in name_patterns:
        for m in re.finditer(pat, website_text):
            name = m.group(1).strip()
            title = m.group(2).strip()
            if name in seen or len(name.split()) < 2: continue
            seen.add(name)
            first = name.split()[0].lower()
            last = name.split()[-1].lower()
            email = ''
            if pattern == 'firstname.lastname':
                email = f'{first}.{last}@{domain.replace("www.", "")}'
            elif pattern == 'firstname_lastname':
                email = f'{first}_{last}@{domain.replace("www.", "")}'
            people.append({
                'name': name, 'title': title,
                'email': email, 'confidence': 0.5 if email else 0.2,
                'source': 'website',
            })

    return {
        'ok': True,
        'domain': domain,
        'pattern': inferred_email,
        'confidence': confidence,
        'sample_emails': list(company_emails)[:3],
        'people': people[:20],
    }


def format_email_domain(domain, pattern):
    """格式化邮箱显示"""
    domain = domain.replace('www.', '')
    return f'@{domain}'


# ═══════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8765))
    print(f"[scrapling-service] 启动...")
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning')
