# -*- coding: utf-8 -*-
"""从钉钉台账导出的 JSON 初始化本地库（历史回灌）。

用法：
    python init_db.py --json <导出的taizhang.json> [--db freight_rate.db]
"""
from __future__ import annotations

import argparse
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

SHEET_KIND = {"运价记录（规范版）": "rates", "运价记录": "rates", "舱位记录": "space"}


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="回灌钉钉台账导出数据到本地 SQLite")
    ap.add_argument("--json", required=True, help="导出的台账 JSON（sheet → rows 结构）")
    ap.add_argument("--db", default=str(here / "freight_rate.db"), help="SQLite 文件路径")
    ap.add_argument("--rebuild", action="store_true",
                    help="导入前清空两张表（本地仅为钉钉台账的镜像，可安全重建）")
    args = ap.parse_args()

    data = freightdb.load_json(args.json)
    conn = freightdb.connect(args.db)
    if args.rebuild:
        for spec in freightdb.TABLES.values():
            conn.execute(f'DELETE FROM {spec["table"]}')
        conn.execute("DELETE FROM sqlite_sequence")
        conn.commit()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    report = {}
    for sheet, block in data.items():
        kind = SHEET_KIND.get(sheet)
        if not kind:
            report[sheet] = "skipped(未知sheet)"
            continue
        rows = block["rows"] if isinstance(block, dict) and "rows" in block else block
        report[sheet] = freightdb.upsert_records(conn, kind, rows, now)
    conn.close()
    print("导入完成 ->", args.db)
    for k, v in report.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
