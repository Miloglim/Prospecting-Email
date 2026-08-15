/** CRM 分类固定值（与 crm.service STAGES / 前端 CRM_STAGES 同步） */
export const CRM_STAGE_KEYS = ["reaching", "quoting", "trial", "cooperating", "lost", "other"] as const;

/**
 * v4.0 tags 收敛迁移：从旧 tags JSON 数组提取首个 CRM 阶段 key，丢弃自定义标签。
 * 无阶段但 status=reached 时补触达中（正联动默认值）。
 * @returns 新 tags 文本（JSON 数组）或 null（未设置）
 */
export function migrateTagsValue(oldTags: string | null, status: string): string | null {
  let stage: string | null = null;
  try {
    const arr = JSON.parse(oldTags || "[]");
    if (Array.isArray(arr)) stage = CRM_STAGE_KEYS.find(k => arr.includes(k)) || null;
  } catch {
    stage = null; // 坏 JSON → 视为未设置
  }
  if (!stage && status === "reached") stage = "reaching";
  return stage ? JSON.stringify([stage]) : null;
}
