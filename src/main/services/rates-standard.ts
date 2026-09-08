// ── 港口词表归一（单一事实源：rates-portmap.json）──────────────────
// 2026-09-08 退役「离线透视表层」：这里原先还读 data/rates-standard.json
// （scripts/build-rates-standard.py 离线预计算的柜型宽表）做 queryStandard / standardToMarkdown。
// 那张表的问题：不会自己更新、不筛有效期与柜型（可能把过期价当真价）、截图地址烧死在 JSON 里。
// 现在两张表统一由 rates-clean 在查询时从实时镜像行算
// （规范 docs/rates-answer-chain-spec.md §3 与 §5-4），本模块只留两件纯词表的事：
//   · 任意写法 → 标准港名（resolveQueryPod）
//   · 标准港 → 航线级/区域码展开集（podRawExpansion，查具体港时把航线级报价也捞进来）
import portmapJson from "./rates-portmap.json";

interface PortMap {
  lanes: string[]; regionToLane: Record<string, string>;
  ports: Array<{ name: string; lane: string; aliases: string[] }>;
}

const PM = portmapJson as unknown as PortMap;

/** 航线 → 该航线下的标准港（原 JSON 的 lanePorts 就是这份数据的预拷贝，7 条航线逐字一致） */
const lanePorts = (): Record<string, string[]> => {
  const map: Record<string, string[]> = {};
  for (const p of PM.ports) {
    if (!p.lane) continue;
    (map[p.lane] ??= []).push(p.name);
  }
  return map;
};

/** 用户输入的港口（任意写法）→ 标准港名；认不出就原样大写 */
export function resolveQueryPod(q: string): string {
  const up = (q || "").trim().toUpperCase();
  if (!PM?.ports) return up;
  for (const p of PM.ports) {
    for (const a of [...p.aliases, p.name]) {
      const A = a.toUpperCase();
      if (A.length <= 3) {
        if (new RegExp(`(?<![A-Z])${A}(?![A-Z])`).test(up)) return p.name;
      } else if (up.includes(A)) return p.name;
    }
  }
  return up;
}

/** 该标准港所属航线（词表里没这条港 → null，不猜） */
export function laneOfPod(canon: string): string | null {
  return PM?.ports.find(p => p.name === canon)?.lane ?? null;
}

/**
 * 镜像库 podRaw 的展开集：查 SANTOS 时，podRaw=「南美东」（航线级）或区域码（WCSA→南美西 等）
 * 的行也应命中。返回需要额外 OR 进过滤的 podRaw 字面值（航线名 + 区域码）。
 */
export function podRawExpansion(canon: string): string[] {
  if (!canon) return [];
  const lanes = new Set<string>();
  for (const [lane, ports] of Object.entries(lanePorts())) {
    if (ports.includes(canon)) lanes.add(lane);
  }
  const direct = laneOfPod(canon);
  if (direct) lanes.add(direct);
  const out = new Set<string>(lanes);
  for (const [code, lane] of Object.entries(PM.regionToLane)) {
    if (lanes.has(lane)) out.add(code);
  }
  return [...out];
}
