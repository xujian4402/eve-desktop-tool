import type { MfgRecipe } from "@/lib/manufacturing/data";

/** 市场价：buy = 最高买单，sell = 最低卖单 */
export interface MfgPrice {
  buy: number | null;
  sell: number | null;
}

export type MfgPriceMap = Map<number, MfgPrice>;

/** SCC 附加费，固定 4% */
export const SCC_SURCHARGE = 0.04;

export interface MfgOptions {
  runs: number;
  /** 材料效率 0~10（蓝图 ME） */
  me: number;
  /** 时间效率 0~20（蓝图 TE） */
  te: number;
  /** 建筑材料减免，0.01 = 减少 1% */
  materialBonus: number;
  /** 建筑时间减免，0.01 = 减少 1% */
  timeBonus: number;
  /** 结构税，0.01 = 1% */
  facilityTax: number;
  /** 系统成本指数（0.05 = 5%），缺失时按 0 处理 */
  systemCostIndex: number;
}

export interface MfgMaterialLine {
  typeId: number;
  /** 基础单次消耗 */
  baseQuantity: number;
  /** 本批次实际消耗（已按效率裁剪并取整） */
  quantity: number;
  /** 单件价格（取 sell，缺失时回退 buy） */
  unitPrice: number | null;
  /** 本行材料成本 */
  cost: number | null;
}

export interface MfgResult {
  runs: number;
  outputQuantity: number;
  /** 总耗时（秒） */
  durationSeconds: number;
  materials: MfgMaterialLine[];
  /** 材料成本合计（缺价时为 null） */
  materialCost: number | null;
  /** 估算物品价值（材料基础价 × 基础数量，用于算作业费） */
  estimatedItemValue: number | null;
  /** 作业费：物品价值 ×（成本指数 ×（1 + 结构税）+ SCC） */
  jobCost: number | null;
  /** 材料成本 + 作业费 */
  totalCost: number | null;
  /** 按最低卖价出售的收入 */
  revenue: number | null;
  profit: number | null;
  margin: number | null;
  /** 有材料缺价 */
  priceIncomplete: boolean;
}

/**
 * 材料需求：EVE 在「整个作业」层面裁剪并向下取整，每 run 至少保留 1 件。
 *
 * 效率 = ME/100 + 建筑减免，上限 100%（不能免费）。
 */
export function calcMaterialQuantity(
  baseQuantity: number,
  runs: number,
  me: number,
  materialBonus: number,
): number {
  const efficiency = Math.min(1, Math.max(0, me / 100 + materialBonus));
  const raw = baseQuantity * runs * (1 - efficiency);
  return Math.max(runs, Math.floor(raw));
}

/** 生产时间：TE 与建筑减免叠加，四舍五入到秒 */
export function calcDuration(
  baseTime: number,
  runs: number,
  te: number,
  timeBonus: number,
): number {
  const efficiency = Math.min(1, Math.max(0, te / 100 + timeBonus));
  return Math.max(0, Math.round(baseTime * runs * (1 - efficiency)));
}

/** 「1秒 = 天/小时/分钟」的紧凑文本 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分`;
  return `${total}秒`;
}

/**
 * 计算一次完整作业：材料、耗时、作业费、收入与利润。
 *
 * 价格口径：材料按最低卖价买入（保守），产物按最低卖价卖出（保守），
 * 缺价时相关合计置 null，交由界面显示「缺价」。
 */
export function calcJob(
  recipe: MfgRecipe,
  prices: MfgPriceMap,
  options: MfgOptions,
): MfgResult {
  const runs = Math.max(1, Math.floor(options.runs));

  let priceIncomplete = false;

  const materials: MfgMaterialLine[] = recipe.materials.map((item) => {
    const quantity = calcMaterialQuantity(
      item.quantity,
      runs,
      options.me,
      options.materialBonus,
    );
    const price = prices.get(item.typeId);
    const unitPrice = price?.sell ?? price?.buy ?? null;

    if (unitPrice === null) priceIncomplete = true;

    return {
      typeId: item.typeId,
      baseQuantity: item.quantity,
      quantity,
      unitPrice,
      cost: unitPrice === null ? null : unitPrice * quantity,
    };
  });

  const materialCost = priceIncomplete
    ? null
    : materials.reduce((sum, line) => sum + (line.cost ?? 0), 0);

  // 作业费按「基础材料价值」算，与 ME 无关（EVE 用蓝图基础材料计价）
  let estimatedItemValue = 0;
  let basePriceIncomplete = false;
  for (const item of recipe.materials) {
    const price = prices.get(item.typeId);
    const unit = price?.sell ?? price?.buy ?? null;
    if (unit === null) {
      basePriceIncomplete = true;
      continue;
    }
    estimatedItemValue += unit * item.quantity * runs;
  }
  if (basePriceIncomplete) estimatedItemValue = 0;

  const jobCost =
    basePriceIncomplete || estimatedItemValue <= 0
      ? null
      : estimatedItemValue *
        (options.systemCostIndex * (1 + options.facilityTax) + SCC_SURCHARGE);

  const totalCost =
    materialCost === null || jobCost === null ? null : materialCost + jobCost;

  const outputQuantity = recipe.productQuantity * runs;
  const productPrice = prices.get(recipe.productTypeId);
  const sellPrice = productPrice?.sell ?? productPrice?.buy ?? null;
  const revenue = sellPrice === null ? null : sellPrice * outputQuantity;

  const profit =
    totalCost === null || revenue === null ? null : revenue - totalCost;
  const margin =
    totalCost !== null && totalCost > 0 && profit !== null
      ? profit / totalCost
      : null;

  return {
    runs,
    outputQuantity,
    durationSeconds: calcDuration(
      recipe.time,
      runs,
      options.te,
      options.timeBonus,
    ),
    materials,
    materialCost,
    estimatedItemValue: basePriceIncomplete ? null : estimatedItemValue,
    jobCost,
    totalCost,
    revenue,
    profit,
    margin,
    priceIncomplete,
  };
}
