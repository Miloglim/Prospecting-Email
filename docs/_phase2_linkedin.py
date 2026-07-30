"""
Phase 2: LinkedIn联系人搜索
直接调 linkedin_mcp_server CLI → 批量搜联系人 → 保存
"""
import subprocess, json, time, sys, io, os, re, threading, queue
import pandas as pd
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

PYTHON_EXE = 'D:/Python/python.exe'
PROFILE_DIR = os.path.expanduser('~/.linkedin-mcp/standalone')

class LinkedInMCP:
    """LinkedIn MCP 客户端，通过 stdio JSON-RPC 通信"""

    def __init__(self):
        self.proc = None
        self.pending = {}
        self.next_id = 2
        self.buf = ''
        self._lock = threading.Lock()
        self._reader_thread = None

    def start(self):
        args = [
            PYTHON_EXE, '-m', 'linkedin_mcp_server.cli_main',
            '--transport', 'stdio', '--log-level', 'ERROR',
            '--user-data-dir', PROFILE_DIR,
        ]
        print(f"启动 LinkedIn MCP: {' '.join(args)}")
        self.proc = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1
        )

        # 启动 stdout 读取线程
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()

        # 初始化
        rsp = self._call('initialize', {
            'protocolVersion': '2024-11-05',
            'capabilities': {},
            'clientInfo': {'name': 'batch-scraper', 'version': '1.0'},
        })
        if rsp.get('result'):
            self.proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
            self.proc.stdin.flush()
            print("LinkedIn MCP 就绪")
            return True
        print("LinkedIn MCP 初始化失败")
        return False

    def _read_loop(self):
        """后台读取 stdout 行"""
        while self.proc and self.proc.poll() is None:
            try:
                line = self.proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    msg_id = msg.get('id')
                    if msg_id and msg_id in self.pending:
                        self.pending[msg_id]['result'] = msg
                        self.pending[msg_id]['event'].set()
                except json.JSONDecodeError:
                    pass
            except:
                break

    def _call(self, method, params=None, timeout=30):
        """发送 JSON-RPC 请求并等待响应"""
        msg_id = self.next_id
        self.next_id += 1
        req = {'jsonrpc': '2.0', 'id': msg_id, 'method': method}
        if params:
            req['params'] = params

        event = threading.Event()
        self.pending[msg_id] = {'event': event, 'result': None}

        self.proc.stdin.write(json.dumps(req) + '\n')
        self.proc.stdin.flush()

        if event.wait(timeout):
            result = self.pending.pop(msg_id, {}).get('result', {})
            return result

        self.pending.pop(msg_id, None)
        return None

    def search_people(self, keywords):
        """搜索LinkedIn联系人"""
        rsp = self._call('tools/call', {
            'name': 'search_people',
            'arguments': {'keywords': keywords}
        })
        if not rsp:
            return []

        # 解析结果（复用 linkedin-client.js 的解析逻辑）
        content = rsp.get('result', {}).get('content', [])
        text = ''
        for c in content:
            if c.get('type') == 'text':
                text += c.get('text', '') + '\n'

        return self._parse_results(text)

    def _parse_results(self, text):
        """解析 LinkedIn 搜索结果文本"""
        people = []
        lines = text.split('\n')
        for i, line in enumerate(lines):
            line = line.strip()
            # 去掉项目符号
            name = line.lstrip('•·- ').strip()
            if len(name) < 3 or len(name) > 60:
                continue
            if any(w in name.lower() for w in ['这些结果', 'linkedin', '关于', '无障碍', '帮助中心',
                '隐私', '广告', '商业服务', '获取领英', 'no valid', '共同好友', '关注', '加为好友']):
                continue

            title = ''
            location = ''
            if i + 1 < len(lines):
                next_line = lines[i + 1].strip()
                if 5 < len(next_line) < 120:
                    title = next_line
            if i + 2 < len(lines) and title:
                loc_line = lines[i + 2].strip()
                if 3 < len(loc_line) < 60:
                    location = loc_line

            if title:
                people.append({'name': name, 'title': title, 'location': location, 'source': 'linkedin'})

        return people

    def stop(self):
        if self.proc:
            self.proc.terminate()
            self.proc = None

# ====== 主流程 ======
def main():
    df = pd.read_excel('docs/已清洗.xlsx')

    # 只处理有cleaned名字的货代（优先）
    forwarders = df[(df['type'] == 'forwarder') & (df['cleaned'].notna()) & (df['cleaned'] != 'None')]
    print(f"货代: {len(forwarders)}")

    # 去重
    seen = set()
    companies = []
    for _, row in forwarders.iterrows():
        name = str(row['cleaned']).strip()
        if name and name != 'nan' and name not in seen:
            seen.add(name)
            companies.append(name)

    print(f"去重后: {len(companies)}")

    # 加载已有结果
    contacts_file = 'docs/_phase2_contacts.json'
    all_contacts = {}
    if os.path.exists(contacts_file):
        with open(contacts_file, 'r', encoding='utf-8') as f:
            all_contacts = json.load(f)
        print(f"已有结果: {len(all_contacts)} 家公司")

    # 启动 LinkedIn
    mcp = LinkedInMCP()
    if not mcp.start():
        print("LinkedIn MCP 启动失败")
        return

    try:
        search_queries = [
            'supply chain OR logistics OR freight',
            'compras OR importacao OR exportacao OR comercial',
        ]

        for idx, company in enumerate(companies):
            if company in all_contacts:
                continue  # 已有

            company_contacts = []
            for query in search_queries:
                keywords = f'{company} {query}'
                print(f"[{idx+1}/{len(companies)}] 搜索: {keywords[:90]}")

                results = mcp.search_people(keywords)
                for p in results:
                    # 去重（同名同title）
                    key = f"{p['name']}|{p['title']}"
                    if not any(f"{c['name']}|{c['title']}" == key for c in company_contacts):
                        p['company'] = company
                        company_contacts.append(p)

                time.sleep(1)  # LinkedIn 频率控制

            all_contacts[company] = company_contacts
            print(f"  -> {len(company_contacts)} 个联系人")

            # 每10家保存
            if (idx + 1) % 10 == 0:
                with open(contacts_file, 'w', encoding='utf-8') as f:
                    json.dump(all_contacts, f, ensure_ascii=False, indent=2)
                print(f"  --- saved {len(all_contacts)} companies ---")

            time.sleep(2)  # 公司间延迟
    finally:
        mcp.stop()

    # 最终保存
    with open(contacts_file, 'w', encoding='utf-8') as f:
        json.dump(all_contacts, f, ensure_ascii=False, indent=2)

    total_contacts = sum(len(v) for v in all_contacts.values())
    print(f"\n=== Phase 2 完成 ===")
    print(f"公司: {len(all_contacts)}")
    print(f"联系人: {total_contacts}")
    print(f"已保存: {contacts_file}")

if __name__ == '__main__':
    main()
