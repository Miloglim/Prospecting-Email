#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-rates-standard.py — 把 board 库（freight_rate.db）一次性标准化成机械可读 JSON。

设计目标（用户拍板）：让大模型"毫秒级查、零思考"——
  · 柜型透视成列（20GP / 40HQ&HC / 40NOR），模型不用自己做 pivot
  · 脏 pod 归一成"标准港集合"：pod=航线名(南美东)/区域码(WCSA)/多港串(Buenaventura, Callao)
    都展开成具体港列表，查 SANTOS 时能命中 pod=南美东 的行
  · Freetime / Transit 从 free_days / remark 里机械抽取，模型不解析自然语言

词表单一事实源：src/main/services/rates-portmap.json（TS 查询层共用同一份）。

用法：python scripts/build-rates-standard.py [board_db_path] [out_json_path]
默认：docs/local_board/freight_rate.db → data/rates-standard.json
"""
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORTMAP = os.path.join(ROOT, "src", "main", "services", "rates-portmap.json")
DEFAULT_DB = os.path.join(ROOT, "docs", "local_board", "freight_rate.db")
DEFAULT_OUT = os.path.join(ROOT, "data", "rates-standard.json")

LANE_AS_POD = None  # 由 portmap lanes 填充


def load_portmap():
    with open(PORTMAP, encoding="utf-8") as f:
        pm = json.load(f)
    ports = pm["ports"]
    lane_ports = defaultdict(list)
    alias_index = {}  # 别名(upper) -> canonical name
    for p in ports:
        lane_ports[p["lane"]].append(p["name"])
        for a in p["aliases"]:
            alias_index[a.upper()] = p["name"]
        alias_index[p["name"].upper()] = p["name"]
    return pm, ports, lane_ports, alias_index


def resolve_pod(pod_raw, lane, lane_ports, alias_index, region_to_lane, lanes):
    """脏 pod → (标准港集合, 是否航线/区域级)。"""
    raw = (pod_raw or "").strip()
    up = raw.upper()
    if not raw:
        return [], False
    # 1) pod 直接是航线名（如「南美东」）→ 展开成该航线全部港
    if raw in lanes:
        return list(lane_ports.get(raw, [])), True
    # 2) pod 是区域码（WCSA/MXESE…）→ 先映射到航线再展开
    if up in region_to_lane:
        return list(lane_ports.get(region_to_lane[up], [])), True
    # 3) 逐港别名子串匹配（处理多港串 / 带代码 / 带括号）
    hits = []
    for alias, canon in alias_index.items():
        # 词边界子串：避免 "LA" 命中 "LAZARO"——短别名(<=3)要求整词
        if len(alias) <= 3:
            if re.search(r"(?<![A-Z])" + re.escape(alias) + r"(?![A-Z])", up):
                if canon not in hits:
                    hits.append(canon)
        else:
            if alias in up:
                if canon not in hits:
                    hits.append(canon)
    if hits:
        return hits, False
    # 4) 未收录 → 原样作为一个"港"，仍可精确匹配
    return [up], False


FT_RE = re.compile(r"(\d{1,3})\s*(?:天|FT|FREE\s*DAYS|FREE\s*DAY)", re.I)
TRANSIT_RE = re.compile(r"(?:transit|航程|TT)\s*[:：]?\s*(\d{1,3})\s*(?:天|days|D)?", re.I)


def norm_freetime(raw):
    if not raw:
        return None
    m = FT_RE.search(raw)
    return f"{m.group(1)}天" if m else raw.strip()


def norm_transit(remark, message_text):
    for src in (remark, message_text):
        if not src:
            continue
        m = TRANSIT_RE.search(src)
        if m:
            return f"{m.group(1)}天"
    return None


def pivot(rows):
    """同 (船司,起运港,目的港原文,航线,有效期) 的多条柜型行 → 一行三列价。"""
    groups = defaultdict(lambda: {"p20": None, "p40": None, "pNor": None, "pBase": None,
                                  "freetimes": set(), "transits": set(), "remarks": set(),
                                  "etd": None})
    order = []
    for r in rows:
        key = (r["carrier"], r["pol"], r["podRaw"], r["lane"], r["validFrom"], r["validTo"])
        if key not in groups:
            order.append(key)
        g = groups[key]
        price = r["price"]
        ct = (r["container"] or "").upper()
        if "20" in ct:
            g["p20"] = price
        elif "NOR" in ct:
            g["pNor"] = price
        elif "40" in ct:
            g["p40"] = price
        else:
            # 未注明柜型的价：单独留一列，不丢信息也不瞎塞
            if g["pBase"] is None or (price is not None and (g["pBase"] is None or price < g["pBase"])):
                g["pBase"] = price
        if r["freetime"]:
            g["freetimes"].add(r["freetime"])
        if r["transit"]:
            g["transits"].add(r["transit"])
        if r["remark"]:
            g["remarks"].add(r["remark"][:120])
        if r["etd"] and not g["etd"]:
            g["etd"] = r["etd"]
    out = []
    for key in order:
        carrier, pol, podRaw, lane, vf, vt = key
        g = groups[key]
        out.append({
            "carrier": carrier, "pol": pol, "pod": podRaw, "lane": lane,
            "p20": g["p20"], "p40": g["p40"], "pNor": g["pNor"], "pBase": g["pBase"],
            "freetime": "/".join(sorted(g["freetimes"])) or None,
            "transit": "/".join(sorted(g["transits"])) or None,
            "remark": "；".join(sorted(g["remarks"])) or None,
            "validFrom": vf, "validTo": vt, "etd": g["etd"],
        })
    return out


def main():
    db_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB
    out_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    pm, ports, lane_ports, alias_index = load_portmap()
    lanes = pm["lanes"]
    region_to_lane = {k.upper(): v for k, v in pm["regionToLane"].items()}

    db = sqlite3.connect(db_path)
    cur = db.cursor()
    rows = []
    for (carrier, pol, pod, route, ct, usd, vf, vt, etd, fd, remark, mtext, status) in cur.execute(
        "SELECT carrier,pol,pod,route,container_type,freight_usd,valid_from,valid_to,etd,"
        "free_days,remark,message_text,status FROM freight_rates WHERE status='当前生效'"
    ):
        price = None
        if usd not in (None, ""):
            try:
                price = round(float(str(usd).replace(",", "")))
            except ValueError:
                price = None
        pod_ports, lane_level = resolve_pod(pod, route, lane_ports, alias_index, region_to_lane, lanes)
        rows.append({
            "carrier": (carrier or "未注明").strip(),
            "pol": (pol or "").strip(),
            "podRaw": (pod or "").strip(),
            "lane": (route or "").strip(),
            "container": (ct or "").strip(),
            "price": price,
            "freetime": norm_freetime(fd),
            "transit": norm_transit(remark, mtext),
            "remark": (remark or "").strip(),
            "etd": etd,
            "validFrom": vf, "validTo": vt,
            "_ports": pod_ports, "_laneLevel": lane_level,
        })

    pivoted = pivot(rows)
    # 把港口集合挂回透视行（按 podRaw 关联）
    portmap_by_podraw = {}
    for r in rows:
        portmap_by_podraw.setdefault(r["podRaw"], (r["_ports"], r["_laneLevel"]))
    for row in pivoted:
        ports_list, lane_level = portmap_by_podraw.get(row["pod"], ([], False))
        row["ports"] = ports_list
        row["laneLevel"] = lane_level

    doc = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "source": os.path.basename(db_path),
        "rowCount": len(pivoted),
        "lanes": lanes,
        "lanePorts": {k: v for k, v in lane_ports.items()},
        "rates": pivoted,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    lane_level_n = sum(1 for r in pivoted if r["laneLevel"])
    print(f"OK: {len(pivoted)} 行透视 → {out_path}（其中航线/区域级 {lane_level_n} 行，查具体港时会展开命中）")


if __name__ == "__main__":
    main()
