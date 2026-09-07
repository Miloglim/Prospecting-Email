# -*- coding: utf-8 -*-
"""把 dws 导出的台账 xlsx 转成 init_db.py 能吃的 JSON（全量校准第一步）。

用法（三步链）：
    1) dws aitable export data --base-id <B> --scope all --export-format excel --timeout-ms 30000 --format json
       → 取返回里的 downloadUrl，curl 下载成 taizhang.xlsx
    2) python import_xlsx.py --xlsx taizhang.xlsx --out taizhang.json
    3) python init_db.py --json taizhang.json --rebuild

注：钉钉导出的 xlsx 里 sheet 维度元数据不可靠，必须 reset_dimensions 后再迭代。
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

try:  # Windows 控制台默认 GBK，中文输出会乱码
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 输出被重定向时无需处理
    pass

warnings.filterwarnings("ignore")
import openpyxl  # noqa: E402


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="台账 xlsx → 导入 JSON")
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--out", default=str(here / "taizhang.json"))
    args = ap.parse_args()

    wb = openpyxl.load_workbook(args.xlsx, read_only=True, data_only=True)
    result = {}
    for ws in wb.worksheets:
        ws.reset_dimensions()  # 导出文件的 dims 不可信，不重置会只读到 1 行
        headers, rows = None, []
        for raw in ws.iter_rows(values_only=True):
            vals = [None if c is None else str(c) for c in raw]
            if headers is None:
                headers = vals
                continue
            if all(v is None for v in vals):
                continue
            rows.append(dict(zip(headers, vals)))
        result[ws.title] = {"headers": headers, "count": len(rows), "rows": rows}
        print(f"  {ws.title}: {len(rows)} 行")

    Path(args.out).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    print("已写出 ->", args.out)


if __name__ == "__main__":
    main()
