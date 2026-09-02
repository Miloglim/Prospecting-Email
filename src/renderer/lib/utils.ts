import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 标准 cn：clsx 组合 + tailwind-merge 去重冲突类 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
