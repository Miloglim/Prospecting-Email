# -*- coding: utf-8 -*-
"""运价台账本机服务：看板网页 + 数据接口（局域网可访问）。

零第三方依赖，只用标准库。数据来自本地 SQLite（与钉钉 AI 表格同口径）。

用法：
    python board_server.py [--host 0.0.0.0] [--port 8788] [--db freight_rate.db]

接口：
    GET  /                  看板页
    GET  /api/rates         运价查询   ?pol&pod&route&carrier&ctype&group&status&q&limit&offset
    GET  /api/space         舱位查询   同上，另支持 &stype
    GET  /api/stats         统计卡片
    GET  /api/options       筛选项枚举
    POST /api/push          写入       头 x-push-token，体 {"table":"rates","records":[中文字段...]}
                                      （同机脚本更推荐直接用 push_records.py 落库）
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sqlite3
import subprocess
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:  # Windows 控制台默认 GBK，中文输出会乱码
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 非控制台环境（重定向到文件）无需处理
    pass


sys.path.insert(0, str(Path(__file__).resolve().parent))
import freightdb  # noqa: E402

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"

CFG: dict = {"db": "", "token": ""}


def conn():
    c = sqlite3.connect(CFG["db"])
    c.row_factory = sqlite3.Row
    freightdb.init_schema(c)
    return c


def ensure_token(token_file: Path) -> str:
    if token_file.exists():
        t = token_file.read_text(encoding="utf-8").strip()
        if t:
            return t
    t = "frt_" + secrets.token_hex(16)
    token_file.write_text(t, encoding="utf-8")
    return t


class Handler(BaseHTTPRequestHandler):
    server_version = "FreightBoard/1.0"

    # ---------- 基础输出 ----------
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-push-token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_OPTIONS(self):  # CORS 预检
        self._send(204, b"", "text/plain")

    def log_message(self, fmt, *args):
        pass  # 关闭逐请求 stdout 日志

    # ---------- 路由 ----------
    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        db = conn()
        try:
            if p in ("/", "/index.html"):
                f = WEB / "index.html"
                return self._send(200, f.read_bytes(), "text/html; charset=utf-8")
            if p == "/api/rates":
                return self._json(200, {"ok": True, **freightdb.query(db, "rates", q)})
            if p == "/api/rates_grouped":
                return self._json(200, {"ok": True, **freightdb.query_grouped(db, "rates", q)})
            if p == "/api/space":
                return self._json(200, {"ok": True, **freightdb.query(db, "space", q)})
            if p == "/api/stats":
                return self._json(200, {"ok": True, **freightdb.stats(db)})
            if p == "/api/options":
                return self._json(200, {"ok": True, **freightdb.options(db)})
            if p.startswith("/images/"):
                from pathlib import Path as _P
                name = _P(urlparse(self.path).path).name  # 只取 basename，防目录穿越
                f = HERE / "images" / name
                if f.exists() and f.is_file():
                    ext = f.suffix.lower().lstrip(".")
                    ctype = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                             "gif": "image/gif", "webp": "image/webp"}.get(ext, "application/octet-stream")
                    return self._send(200, f.read_bytes(), ctype)
                return self._send(404, b"not found", "text/plain")
            return self._json(404, {"ok": False, "error": "not found"})
        except Exception as e:  # noqa: BLE001 - 统一转成结构化错误返回
            return self._json(500, {"ok": False, "error": str(e)})
        finally:
            db.close()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/push":
            return self._json(404, {"ok": False, "error": "not found"})
        if self.headers.get("x-push-token") != CFG["token"]:
            return self._json(401, {"ok": False, "error": "unauthorized"})
        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            return self._json(400, {"ok": False, "error": f"invalid json: {e}"})
        table = payload.get("table")
        if table not in ("rates", "space"):
            return self._json(400, {"ok": False, "error": 'table must be "rates" or "space"'})
        records = payload.get("records")
        if not isinstance(records, list) or not records:
            return self._json(400, {"ok": False, "error": "records empty"})
        if len(records) > 1000:
            return self._json(400, {"ok": False, "error": "records > 1000 per request"})
        db = conn()
        try:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            n = freightdb.upsert_records(db, table, records, now)
            return self._json(200, {"ok": True, "table": table, "accepted": n})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"ok": False, "error": str(e)})
        finally:
            db.close()


def spawn_daemon(args) -> int:
    """重新拉起一个完全脱离当前终端的实例，父进程立即退出（PowerShell 因此不会挂住）。"""
    flags = 0
    if os.name == "nt":
        DETACHED_PROCESS = 0x00000008          # 不继承控制台
        CREATE_NEW_PROCESS_GROUP = 0x00000200  # 独立进程组，Ctrl+C 打不到它
        CREATE_NO_WINDOW = 0x08000000          # 不弹黑窗
        flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    with open(args.log, "ab") as logf:
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()),
             "--host", args.host, "--port", str(args.port), "--db", args.db],
            stdout=logf, stderr=logf, stdin=subprocess.DEVNULL,
            cwd=str(HERE), creationflags=flags, close_fds=True,
        )
    (HERE / "board.pid").write_text(str(proc.pid), encoding="ascii")
    # 这两行走控制台（GBK 代码页），保持 ASCII 避免中文乱码；中文提示由 ps1 负责
    print(f"[freight-board] daemon started, pid={proc.pid}, log=board.log")
    return proc.pid


def main() -> None:
    ap = argparse.ArgumentParser(description="运价台账本机服务")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址，局域网访问需 0.0.0.0")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--db", default=str(HERE / "freight_rate.db"))
    ap.add_argument("--daemon", action="store_true", help="后台常驻（不占终端，日志写 board.log）")
    ap.add_argument("--log", default=str(HERE / "board.log"), help="--daemon 模式的日志文件")
    args = ap.parse_args()

    if args.daemon:
        spawn_daemon(args)
        return

    CFG["db"] = args.db
    CFG["token"] = ensure_token(HERE / "token.txt")
    freightdb.connect(args.db).close()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[freight-board] SQLite : {args.db}")
    print(f"[freight-board] 看板     : http://127.0.0.1:{args.port}/")
    print(f"[freight-board] 局域网   : http://<本机内网IP>:{args.port}/")
    print(f"[freight-board] 写入令牌 : {CFG['token']}（见 token.txt）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[freight-board] stopped")


if __name__ == "__main__":
    main()
