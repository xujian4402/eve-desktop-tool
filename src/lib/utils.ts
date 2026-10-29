import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui 约定的类名合并工具：后写的 Tailwind 类会覆盖冲突的前者 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
