// ── 工具元数据缓存（渲染端）─────────────────────────────────────
// 唯一事实源 = 主进程注册表（agent/manifest.ts），经 agent:toolMeta 一次取回。
// 渲染端不维护第二份工具清单：缓存未就绪/获取失败时退回「工具名原样」与空引导，
// 不阻塞使用；元数据到达后订阅方统一刷新一次。
import { useSyncExternalStore } from "react";

interface ToolMetaDto {
  labels: Record<string, string>;
  followUps: Record<string, string[]>;
}

let cache: ToolMetaDto | null = null;
let version = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  listeners.forEach(l => l());
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 幂等拉取一次；失败静默（退回原样名展示），不抛给调用方 */
export function ensureToolMeta(): Promise<void> {
  if (cache) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await window.api.invoke("agent:toolMeta") as { success: boolean; data?: ToolMetaDto };
      if (r?.success && r.data) { cache = r.data; notify(); }
    } catch { /* 注册表不可达：保持回退显示 */ }
  })();
  return loading;
}

/** 工具 UI 中文名；未就绪或未收录时回退工具名本身 */
export function toolLabelText(name?: string): string {
  return (name && cache?.labels[name]) || name || "工具";
}

/** 追问引导；未就绪或未收录返回空（调用方走默认引导） */
export function followUpsOf(tool: string): string[] {
  return cache?.followUps[tool] ?? [];
}

/** 订阅元数据版本：注册表到达后让用到的组件重渲染一次 */
export function useToolMetaVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
