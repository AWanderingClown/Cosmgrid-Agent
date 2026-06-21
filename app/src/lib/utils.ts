import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 统一的 USD 成本格式化：小额用 4 位、大额用 2 位小数 */
export function formatCost(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}