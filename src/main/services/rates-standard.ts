// ── 标准化运价层（data/rates-standard.json 的读取与港口归一查询）────────
// 离线建表：scripts/build-rates-standard.py（board 库 → 柜型透视 + 港口归一）。
// 本模块只做「读 + 集合匹配」，毫秒级、零 LLM 思考：
//   · 每行已带 ports（标准港集合）与 laneLevel（是否航线/区域级）
//   · 查 SANTOS 时，pod=南美东 / WCSA / 多港串 的行都会因 ports 含 SANTOS 而命中
// 词表单一事实源：rates-portmap.json（build 脚本与本模块共用）。
import * as fs from "fs";
import * as path from "path";
import { APP_ROOT } from "../config";
import portmapJson from "./rates-portmap.json";

export interface StandardRate {
  carrier: string; pol: string; pod: string; lane: string;
  p20: number | null; p40: number | null; pNor: number | null; pBase: number | null;
  freetime: string | null; transit: string | null; remark: string | null;
  validFrom: string | null; validTo: string | null; etd: string | null;
  ports: string[]; laneLevel: boolean;
}
interface StandardDoc {
  generatedAt: string; rowCount: number; lanes: string[];
  lanePorts: Record<string, string[]>; rates: StandardRate[];
}
interface PortMap {
  lanes: string[]; regionToLane: Record<string, string>;
  ports: Array<{ name: string; lane: string; aliases: string[] }>;
}

const STANDARD_PATH = (process.env.RATES_STANDARD_PATH || "").trim()
  || path.join(APP_ROOT, "data", "rates-standard.json");

let cache: { mtime: number; doc: StandardDoc } | null = null;

/** 读标准化文件（mtime 缓存）；文件不在返回 null → 调用方回退镜像查询 */
export function loadStandard(): StandardDoc | null {
  try {
    const st = fs.statSync(STANDARD_PATH);
    if (!cache || cache.mtime !== st.mtimeMs) {
      cache = { mtime: st.mtimeMs, doc: JSON.parse(fs.readFileSync(STANDARD_PATH, "utf-8")) as StandardDoc };
    }
    return cache.doc;
  } catch { return null; }
}

function loadPortmap(): PortMap | null {
  // 词表随代码打包（import 内联），运行时不读盘；Python 建表脚本读同一份 src 文件
  return portmapJson as unknown as PortMap;
}

/** 用户输入的港口（任意写法）→ 标准港名；认不出就原样大写 */
export function resolveQueryPod(q: string): string {
  const pm = loadPortmap();
  const up = (q || "").trim().toUpperCase();
  if (!pm) return up;
  for (const p of pm.ports) {
    for (const a of [...p.aliases, p.name]) {
      const A = a.toUpperCase();
      if (A.length <= 3) {
        if (new RegExp(`(?<![A-Z])${A}(?![A-Z])`).test(up)) return p.name;
      } else if (up.includes(A)) return p.name;
    }
  }
  return up;
}

/** 该标准港所属航线 + 同航线别名（供镜像过滤做 podRaw 展开） */
export function laneOfPod(canon: string): string | null {
  const pm = loadPortmap();
  return pm?.ports.find(p => p.name === canon)?.lane ?? null;
}

/**
 * 镜像库 podRaw 的展开集：查 SANTOS 时，podRaw=「南美东」（航线级）或区域码（WCSA→南美西 等）
 * 的行也应命中。返回需要额外 OR 进过滤的 podRaw 字面值（航线名 + 区域码）。
 */
export function podRawExpansion(canon: string): string[] {
  const pm = loadPortmap();
  const doc = loadStandard();
  if (!pm) return [];
  const lanes = new Set<string>();
  for (const [lane, ports] of Object.entries(doc?.lanePorts ?? {})) {
    if (ports.includes(canon)) lanes.add(lane);
  }
  const direct = laneOfPod(canon);
  if (direct) lanes.add(direct);
  const out = new Set<string>(lanes);
  for (const [code, lane] of Object.entries(pm.regionToLane)) {
    if (lanes.has(lane)) out.add(code);
  }
  return [...out];
}

/** 标准化层按港查询（集合匹配，含航线/区域级展开）；可再按船司/航线收窄 */
export function queryStandard(pod: string, opts: { carrier?: string; lane?: string } = {}): StandardRate[] {
  const doc = loadStandard();
  if (!doc) return [];
  const canon = resolveQueryPod(pod);
  return doc.rates.filter(r => {
    if (!(r.ports.includes(canon) || r.pod.toUpperCase() === canon)) return false;
    if (opts.carrier && r.carrier.toUpperCase() !== opts.carrier.toUpperCase()) return false;
    if (opts.lane && r.lane !== opts.lane) return false;
    return true;
  });
}

/** 标准化行 → 面向客户的 Markdown 表（列固定，机械生成） */
export function standardToMarkdown(rows: StandardRate[], max = 15): string {
  const usd = (n: number | null) => (n != null ? `$${n.toLocaleString("en-US")}` : "—");
  const head = ["| 船司 | 起运港 | 目的港 | 20GP | 40HQ&HC | 40NOR | Freetime | Transit | 有效期 |",
    "|---|---|---|---|---|---|---|---|---|"];
  const body = rows.slice(0, max).map(r =>
    `| ${r.carrier} | ${r.pol || "—"} | ${r.pod} | ${usd(r.p20)} | ${usd(r.p40)} | ${usd(r.pNor)} | ${r.freetime ?? "—"} | ${r.transit ?? "—"} | ${r.validFrom || r.validTo ? `${r.validFrom ?? "?"}~${r.validTo ?? "?"}` : "—"} |`);
  return [...head, ...body].join("\n");
}
