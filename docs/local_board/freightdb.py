# -*- coding: utf-8 -*-
"""运价本地库公共层：表结构、字段映射、幂等写入与查询。

零第三方依赖，只用 Python 标准库（sqlite3 / hashlib / json）。
字段口径与钉钉 AI 表格「海运运价智能台账」逐字对齐，写入接口接受
与表格列同名的中文字段，便于心跳把同一份记录同时落两边。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import date
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

# ---------- 表注册 ----------

RATES_MAP: Dict[str, str] = {
    "起运港": "pol", "目的港": "pod", "航线": "route", "船司": "carrier",
    "柜型": "container_type", "海运费USD": "freight_usd", "有效期船期": "validity_raw",
    "目免": "free_days", "亏舱费": "dead_freight", "备注": "remark",
    "来源群": "source_group", "发送人": "sender", "消息时间": "message_time",
    "消息原文": "message_text", "运价图片": "image_url", "有效期起": "valid_from",
    "有效期止": "valid_to", "船期ETD": "etd", "被覆盖消息时间": "overridden_time",
    "记录状态": "status", "消息ID": "mid", "图片名": "image_file",
}

SPACE_MAP: Dict[str, str] = {
    "起运港": "pol", "目的港": "pod", "航线": "route", "船司": "carrier",
    "船名航次": "vessel_voyage", "船期截关": "cutoff_raw", "船期ETD": "etd",
    "箱型箱量": "box_desc", "柜型": "container_type", "箱量": "box_qty",
    "舱位类型": "space_type", "价格USD": "price_usd", "备注": "remark",
    "来源群": "source_group", "发送人": "sender", "消息时间": "message_time",
    "消息原文": "message_text", "舱位图": "image_url", "记录状态": "status", "消息ID": "mid",
    "图片名": "image_file",
}

# 内容指纹：同一条消息重复推送只会覆盖不会增行。
# 除「状态类字段 + 图片」外的全部业务字段参与指纹——状态会被心跳就地改写
# （旧价标「已被覆盖」），图片 token 每次导出都可能变，二者都不该产生新行。
KEY_EXCLUDE = {"image_url", "image_file", "status", "overridden_time", "synced_at"}

# 指纹字段 = 该表全部业务列（按列名排序，保证稳定）
def _key_fields(field_map: Dict[str, str]) -> List[str]:
    return sorted({c for c in field_map.values() if c not in KEY_EXCLUDE})


TABLES: Dict[str, Dict[str, Any]] = {
    "rates": {
        "table": "freight_rates",
        "map": RATES_MAP,
        "key": _key_fields(RATES_MAP),
        "ddl": """
            CREATE TABLE IF NOT EXISTS freight_rates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content_key TEXT NOT NULL UNIQUE,
                pol TEXT, pod TEXT, route TEXT, carrier TEXT,
                container_type TEXT, freight_usd TEXT, validity_raw TEXT,
                valid_from TEXT, valid_to TEXT, etd TEXT,
                free_days TEXT, dead_freight TEXT, remark TEXT,
                source_group TEXT, sender TEXT, message_time TEXT,
                message_text TEXT, image_url TEXT,
                status TEXT, overridden_time TEXT,
                synced_at TEXT, mid TEXT, image_file TEXT
            )""",
        "indexes": ["pod", "carrier", "route", "container_type", "source_group",
                    "message_time", "status"],
    },
    "space": {
        "table": "space_records",
        "map": SPACE_MAP,
        "key": _key_fields(SPACE_MAP),
        "ddl": """
            CREATE TABLE IF NOT EXISTS space_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content_key TEXT NOT NULL UNIQUE,
                pol TEXT, pod TEXT, route TEXT, carrier TEXT,
                vessel_voyage TEXT, cutoff_raw TEXT, etd TEXT,
                box_desc TEXT, container_type TEXT, box_qty TEXT,
                space_type TEXT, price_usd TEXT, remark TEXT,
                source_group TEXT, sender TEXT, message_time TEXT,
                message_text TEXT, image_url TEXT,
                status TEXT, synced_at TEXT, mid TEXT, image_file TEXT
            )""",
        "indexes": ["pod", "carrier", "route", "space_type", "source_group",
                    "message_time", "status"],
    },
}


def connect(db_path: str | Path) -> sqlite3.Connection:
    """打开（必要时创建）数据库并保证表结构存在。"""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    for spec in TABLES.values():
        conn.execute(spec["ddl"])
        for col in spec["indexes"]:
            conn.execute(
                f'CREATE INDEX IF NOT EXISTS idx_{spec["table"]}_{col} '
                f'ON {spec["table"]}({col})'
            )
        # 旧库升级：已存在的表按需补列
        have = {r[1] for r in conn.execute(f'PRAGMA table_info({spec["table"]})')}
        for col in ("mid", "image_file"):
            if col not in have:
                conn.execute(f'ALTER TABLE {spec["table"]} ADD COLUMN {col} TEXT')
    conn.commit()


def _coerce(val: Any) -> Optional[str]:
    """单元格值 → 可存文本。附件等复合结构取可读标识，不写 Python 字面量。"""
    if val is None:
        return None
    if isinstance(val, str):
        return val.strip() or None
    if isinstance(val, dict):
        for key in ("name", "fileName", "fileToken", "url", "text"):
            if val.get(key):
                return str(val[key]).strip()
        return None
    if isinstance(val, (list, tuple)):
        parts = [p for p in (_coerce(v) for v in val) if p]
        return " / ".join(parts) if parts else None
    return str(val).strip() or None


def normalize(cn_record: Dict[str, Any], spec: Dict[str, Any], now: str) -> Dict[str, Optional[str]]:
    """中文字段名记录 → 数据库列；空值丢弃，缺失状态补「当前生效」。"""
    row: Dict[str, Optional[str]] = {}
    for cn, col in spec["map"].items():
        val = _coerce(cn_record.get(cn))
        if val is not None:
            row[col] = val
    row.setdefault("status", "当前生效")
    basis = "\x1f".join(str(row.get(f) or "") for f in spec["key"])
    row["content_key"] = hashlib.sha256(basis.encode("utf-8")).hexdigest()
    row["synced_at"] = now
    return row


def upsert_records(conn: sqlite3.Connection, kind: str,
                   records: Iterable[Dict[str, Any]], now: str) -> int:
    """按 content_key 幂等写入，返回处理条数。"""
    spec = TABLES[kind]
    cols = sorted({c for r in records
                   for c in normalize(r, spec, now)})
    if not cols:
        return 0
    placeholders = ",".join("?" * len(cols))
    update_clause = ",".join(f"{c}=excluded.{c}" for c in cols if c != "content_key")
    sql = (
        f'INSERT INTO {spec["table"]} ({",".join(cols)}) VALUES ({placeholders}) '
        f"ON CONFLICT(content_key) DO UPDATE SET {update_clause}"
    )
    count = 0
    for rec in records:
        row = normalize(rec, spec, now)
        conn.execute(sql, [row.get(c) for c in cols])
        count += 1
    conn.commit()
    return count


# ---------- 查询 ----------

FILTER_COLUMNS = {
    "pol": "pol", "pod": "pod", "route": "route", "carrier": "carrier",
    "ctype": "container_type", "group": "source_group", "status": "status",
    "stype": "space_type",
}


def query(conn: sqlite3.Connection, kind: str, params: Dict[str, str]) -> Dict[str, Any]:
    spec = TABLES[kind]
    table = spec["table"]
    where: List[str] = []
    args: List[Any] = []
    for key, col in FILTER_COLUMNS.items():
        val = params.get(key)
        if val and col in [c for c in spec["map"].values()]:
            where.append(f"{col} = ?")
            args.append(val)
    kw = params.get("q")
    if kw:
        like = f"%{kw}%"
        where.append("(pod LIKE ? OR message_text LIKE ? OR remark LIKE ? OR validity_raw LIKE ?)")
        args += [like, like, like, like]
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute(f"SELECT COUNT(*) AS n FROM {table} {clause}", args).fetchone()["n"]
    limit = max(1, min(int(params.get("limit") or 50), 500))
    offset = max(0, int(params.get("offset") or 0))
    rows = conn.execute(
        f"SELECT * FROM {table} {clause} ORDER BY message_time DESC, id DESC LIMIT ? OFFSET ?",
        args + [limit, offset],
    ).fetchall()
    return {"total": total, "limit": limit, "offset": offset,
            "rows": [dict(r) for r in rows]}


def _norm_ctype(ct: Optional[str]) -> str:
    """柜型归一到三档列名：20GP / 40HQ-HC / 40NOR。"""
    c = (ct or "").upper()
    if c in ("20GP", "20"):
        return "20GP"
    if c in ("40NOR", "40N", "40NOR/HC"):
        return "40NOR"
    if c.startswith("40"):  # 40HQ/HC、40HC、40GP、40HQ 等并入 40HQ/HC
        return "40HQ/HC"
    return ct or ""


def query_grouped(conn: sqlite3.Connection, kind: str,
                  params: Dict[str, str]) -> Dict[str, Any]:
    """按身份分组 + 柜型转列 + 当前/历史折叠，供看板折叠视图。忽略 status 过滤以带出历史行。"""
    spec = TABLES[kind]
    table = spec["table"]
    where: List[str] = []
    args: List[Any] = []
    for key, col in FILTER_COLUMNS.items():
        if key == "status":  # 折叠需要历史(已被覆盖)行，不按状态过滤
            continue
        val = params.get(key)
        if val and col in spec["map"].values():
            where.append(f"{col} = ?")
            args.append(val)
    kw = params.get("q")
    if kw:
        like = f"%{kw}%"
        where.append("(pod LIKE ? OR message_text LIKE ? OR remark LIKE ? OR validity_raw LIKE ?)")
        args += [like] * 4
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    rows = [dict(r) for r in conn.execute(
        f"SELECT * FROM {table} {clause} ORDER BY message_time DESC, id DESC", args).fetchall()]

    price_col = "freight_usd" if kind == "rates" else "price_usd"
    today = date.today().isoformat()
    quotes: Dict[tuple, Dict[str, Any]] = {}
    for r in rows:
        qk = (r.get("carrier"), r.get("route"), r.get("pol"), r.get("pod"),
              r.get("etd") or "", r.get("message_time"), r.get("sender"))
        q = quotes.get(qk)
        if q is None:
            q = {k: r.get(k) for k in ("carrier", "route", "pol", "pod", "etd",
                                       "message_time", "sender", "source_group", "validity_raw",
                                       "valid_from", "valid_to", "status", "remark",
                                       "message_text", "image_url", "image_file", "free_days", "dead_freight",
                                       "synced_at")}
            q["cab"] = {}
            quotes[qk] = q
        ct = _norm_ctype(r.get("container_type"))
        pv = r.get(price_col)
        if ct and pv not in (None, ""):
            q["cab"][ct] = pv

    byid: Dict[tuple, List[Dict[str, Any]]] = {}
    for q in quotes.values():
        q["expired"] = bool(q.get("valid_to")) and str(q["valid_to"])[:10] < today
        byid.setdefault((q["carrier"], q["route"], q["pol"], q["pod"], q["etd"] or ""), []).append(q)

    groups: List[Dict[str, Any]] = []
    for idk, qs in byid.items():
        qs.sort(key=lambda x: x.get("message_time") or "", reverse=True)
        alive = [q for q in qs if not q["expired"] and q.get("status") != "已被覆盖"]
        cur = alive[0] if alive else None
        hist = [q for q in qs if q is not cur]
        groups.append({"id": {"carrier": idk[0], "route": idk[1], "pol": idk[2],
                              "pod": idk[3], "etd": idk[4]},
                       "current": cur, "history": hist})
    def _latest(g):
        q = g["current"] or (g["history"][0] if g["history"] else None)
        return (q or {}).get("message_time") or ""
    groups.sort(key=lambda g: (_latest(g), g["id"]["carrier"] or "", g["id"]["pod"] or ""),
                reverse=True)
    total = len(groups)
    limit = max(1, min(int(params.get("limit") or 50), 200))
    offset = max(0, int(params.get("offset") or 0))
    return {"total": total, "limit": limit, "offset": offset,
            "groups": groups[offset:offset + limit], "rows": rows}


def options(conn: sqlite3.Connection) -> Dict[str, Any]:
    def distinct(kind: str, fields: List[str]) -> Dict[str, List[str]]:
        table = TABLES[kind]["table"]
        out: Dict[str, List[str]] = {}
        for col in fields:
            vals = [r[0] for r in conn.execute(
                f"SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL ORDER BY {col}"
            ).fetchall()]
            out[col] = vals
        return out

    return {
        "rates": distinct("rates", ["pol", "route", "carrier", "container_type", "source_group"]),
        "space": distinct("space", ["pol", "route", "carrier", "container_type", "space_type", "source_group"]),
    }


def stats(conn: sqlite3.Connection) -> Dict[str, Any]:
    one = lambda sql, args=(): conn.execute(sql, args).fetchone()[0]
    latest = one("SELECT message_time FROM freight_rates ORDER BY message_time DESC LIMIT 1")
    return {
        "ratesTotal": one("SELECT COUNT(*) FROM freight_rates"),
        "ratesCurrent": one("SELECT COUNT(*) FROM freight_rates WHERE status = ?", ("当前生效",)),
        "spaceTotal": one("SELECT COUNT(*) FROM space_records"),
        "groups": len(options(conn)["rates"]["source_group"]),
        "carriers": len(options(conn)["rates"]["carrier"]),
        "latestMessage": latest or "",
    }


def load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))
