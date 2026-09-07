# -*- coding: utf-8 -*-
"""本地写入工具：把一批记录落进 SQLite（幂等，按内容去重）。

心跳流程解析完报价后，除了写钉钉 AI 表格，再跑一次本脚本即完成双写。

用法：
    python push_records.py --table rates --file batch.json [--db freight_rate.db]

batch.json 支持两种结构：
    [ {"起运港": "...", "目的港": "...", ...}, ... ]
    { "table": "rates", "records": [ ... ] }
字段名与钉钉 AI 表格列名逐字一致；未识别的字段忽略。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

try:  # Windows 控制台默认 GBK，中文输出会乱码
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 非控制台环境（重定向到文件）无需处理
    pass


sys.path.insert(0, str(Path(__file__).resolve().parent))
import freightdb  # noqa: E402


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="写入运价/舱位记录到本地库")
    ap.add_argument("--table", choices=["rates", "space"], help="目标表（JSON 内含 table 时可省略）")
    ap.add_argument("--file", required=True, help="记录 JSON 文件")
    ap.add_argument("--db", default=str(here / "freight_rate.db"), help="SQLite 文件路径")
    args = ap.parse_args()

    payload = freightdb.load_json(args.file)
    if isinstance(payload, dict):
        kind = payload.get("table") or args.table
        records = payload.get("records", [])
    else:
        kind = args.table
        records = payload
    if not kind:
        sys.exit("缺少 table 指定（rates / space）")
    if not isinstance(records, list) or not records:
        sys.exit("records 为空")

    conn = freightdb.connect(args.db)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    n = freightdb.upsert_records(conn, kind, records, now)
    conn.close()
    print(json.dumps({"ok": True, "table": kind, "accepted": n}, ensure_ascii=False))


if __name__ == "__main__":
    main()
