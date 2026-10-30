import schematicsJson from "@/data/pi/pi-schematics.json";

import type { PiSchematic, PiTier } from "@/lib/pi/types";

/**
 * 行星工业静态数据（由 `scripts/build-pi-sde.mjs` 从官方 SDE 生成，随应用打包）。
 *
 * 配方只有 68 条，直接同步加载；星系聚合表约 800 KB，改为按需动态 import，
 * 避免拖慢其它页面的首屏。
 */
interface SchematicPayload {
  generatedAt: string;
  schematics: PiSchematic[];
  p0: Array<{ typeId: number; name: string }>;
  types: Record<string, string>;
}

const payload = schematicsJson as unknown as SchematicPayload;

/** 数据生成日期（SDE 快照日期） */
export const PI_DATA_VERSION = payload.generatedAt;

/** 全部配方（按等级升序） */
export const PI_SCHEMATICS: PiSchematic[] = payload.schematics;

/** P0 原始资源清单 */
export const PI_P0 = payload.p0;

/** 产出物类型 ID → 配方 */
export const PI_BY_OUTPUT = new Map<number, PiSchematic>(
  PI_SCHEMATICS.map((item) => [item.outputTypeId, item]),
);

/** 类型名称（中文优先），缺失时回退为 #id */
export function piTypeName(typeId: number): string {
  return payload.types[String(typeId)] ?? `#${typeId}`;
}

/** 等级解析：P0 返回 0 */
export function piTierOf(typeId: number): PiTier | 0 {
  return PI_BY_OUTPUT.get(typeId)?.tier ?? 0;
}

/** 各等级的配方分组（P1~P4） */
export const PI_SCHEMATICS_BY_TIER: Array<{
  tier: PiTier;
  items: PiSchematic[];
}> = ([1, 2, 3, 4] as PiTier[]).map((tier) => ({
  tier,
  items: PI_SCHEMATICS.filter((item) => item.tier === tier),
}));

/** 按类别筛出的可生产产物（P1~P4 全部） */
export const PI_PRODUCTS = PI_SCHEMATICS.map((item) => ({
  typeId: item.outputTypeId,
  name: item.name,
  tier: item.tier,
}));

/* ============================================================
   星系行星分布（按需加载，约 900 KB）
   ============================================================ */

export interface PiSystemPlanets {
  id: number;
  name: string;
  security: number;
  region: string;
  /** 行星类型 ID → 该星系内的数量 */
  planets: Record<string, number>;
}

let systemCache: PiSystemPlanets[] | null = null;

/** 加载含行星的星系（约 8,000 个） */
export async function loadPiSystems(): Promise<PiSystemPlanets[]> {
  if (systemCache) return systemCache;
  const mod = await import("@/data/pi/pi-systems.json");
  systemCache = (mod.default as unknown as { systems: PiSystemPlanets[] })
    .systems;
  return systemCache;
}


