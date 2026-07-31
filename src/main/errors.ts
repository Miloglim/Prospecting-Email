/** 统一返回类型 — 所有 service 函数必须返回此类型 */
export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: string; cause?: unknown };

/** 创建成功结果 */
export function okResult<T>(data: T): Result<T> {
  return { success: true, data };
}

/** 创建失败结果。cause 传原始错误，帮助调试 */
export function failResult(error: string, cause?: unknown): Result<never> {
  return { success: false, error, cause };
}
