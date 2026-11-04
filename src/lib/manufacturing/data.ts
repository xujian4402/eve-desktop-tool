/**
 * 制造业静态数据（由 scripts/build-manufacturing-sde.mjs 生成）。
 *
 * 与行星工业一致：JSON 通过动态 import 按需加载，
 * 首屏不背 1.9 MB 的蓝图表。
 */

export type MfgActivity = "manufacturing" | "reaction";

export interface MfgMaterial {
  typeId: number;
  /** 单次运行的基础消耗（未计 ME） */
  quantity: number;
}

export interface MfgRecipe {
  blueprintTypeId: number;
  productTypeId: number;
  /** 单次运行产出数量 */
  productQuantity: number;
  activity: MfgActivity;
  /** 单次运行基础时间（秒，未计 TE） */
  time: number;
  maxProductionLimit: number;
  materials: MfgMaterial[];
}

interface RawPayload {
  generatedAt: string;
  types: Record<string, string>;
  recipes: MfgRecipe[];
}

export interface MfgData {
  recipes: MfgRecipe[];
  /** 产物 typeId → 配方 */
  byProduct: Map<number, MfgRecipe>;
  /** 蓝图 typeId → 配方 */
  byBlueprint: Map<number, MfgRecipe>;
  typeNames: Record<string, string>;
}

let cache: MfgData | null = null;
let pending: Promise<MfgData> | null = null;

/** 加载全部蓝图配方（约 5,000 条） */
export async function loadMfgData(): Promise<MfgData> {
  if (cache) return cache;
  if (pending) return pending;

  pending = (async () => {
    const mod = await import("@/data/manufacturing/blueprints.json");
    const payload = mod.default as unknown as RawPayload;

    const byProduct = new Map<number, MfgRecipe>();
    const byBlueprint = new Map<number, MfgRecipe>();

    for (const recipe of payload.recipes) {
      // 多种蓝图共用一个产物时（T1/T2 变体），保留第一条即可
      if (!byProduct.has(recipe.productTypeId)) {
        byProduct.set(recipe.productTypeId, recipe);
      }
      byBlueprint.set(recipe.blueprintTypeId, recipe);
    }

    cache = {
      recipes: payload.recipes,
      byProduct,
      byBlueprint,
      typeNames: payload.types,
    };
    return cache;
  })();

  return pending;
}

/** 物品名称（缺失时回退 #id） */
export function mfgTypeName(
  data: MfgData | null,
  typeId: number,
): string {
  return data?.typeNames[String(typeId)] ?? `#${typeId}`;
}
