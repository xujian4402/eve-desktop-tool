import { PI_PRODUCTS } from "@/lib/pi/data";
import type { PiStockSource } from "@/lib/pi/inventory";
import { buildChainPlan } from "@/lib/pi/schematic";
import { synthesizeMax } from "@/lib/pi/synthesis";
import type { PiPriceRow, PiTier } from "@/lib/pi/types";

/** 单个产物的成本/收益估算（口径：1 条产线满负荷 1 小时） */
export interface PiProductCost {
  typeId: number;
  name: string;
  tier: PiTier;
  /** 1 小时产出数量 */
  outputQty: number;
  /** 需要外购的原料件数（已扣掉库存抵扣） */
  buyCount: number;
  /** 用库存抵扣的原料件数 */
  stockCount: number;
  /** 缺价时为 null */
  cost: number | null;
  revenue: number | null;
  profit: number | null;
  margin: number | null;
  /** 有原料没填价 */
  costIncomplete: boolean;
  /** 产物本身没填价 */
  revenueIncomplete: boolean;
}

/**
 * 估算单个产物的成本与收益。
 *
 * 标「库存」的原料优先抵扣且不计成本；标「购买」的原料全部按行情卖单价买入。
 * 产物按行情买单价卖出。
 */
export function estimateProductCost(
  typeId: number,
  priceRows: Map<number, PiPriceRow>,
  stock: Map<number, number>,
  source: Record<number, PiStockSource>,
): PiProductCost | null {
  const plan = buildChainPlan(typeId);
  if (!plan) return null;

  let cost = 0;
  let buyCount = 0;
  let stockCount = 0;
  let costIncomplete = false;

  for (const item of plan.purchases) {
    const required = item.quantity;
    const usable =
      (source[item.typeId] ?? "buy") === "stock"
        ? Math.min(stock.get(item.typeId) ?? 0, required)
        : 0;
    const toBuy = Math.max(0, required - usable);

    stockCount += usable;
    buyCount += toBuy;

    const unit = priceRows.get(item.typeId)?.sell;
    if (unit === null || unit === undefined) {
      if (toBuy > 0) costIncomplete = true;
      continue;
    }
    cost += unit * toBuy;
  }

  const rootStep = plan.steps.find(
    (step) => step.outputTypeId === plan.rootTypeId,
  );
  const outputQty = rootStep?.totalOutput ?? 0;
  const sellUnit = priceRows.get(typeId)?.buy ?? null;
  const revenueIncomplete = sellUnit === null;
  const revenue = sellUnit === null ? null : sellUnit * outputQty;

  const finalCost = costIncomplete ? null : cost;
  const profit =
    finalCost !== null && revenue !== null ? revenue - finalCost : null;
  const margin =
    finalCost !== null && finalCost > 0 && profit !== null
      ? profit / finalCost
      : null;

  return {
    typeId,
    name: plan.rootName,
    tier: plan.rootTier,
    outputQty,
    buyCount,
    stockCount,
    cost: finalCost,
    revenue,
    profit,
    margin,
    costIncomplete,
    revenueIncomplete,
  };
}

/** 批量估算某个等级下的全部产物 */
export function estimateTierProducts(
  tier: PiTier,
  priceRows: Map<number, PiPriceRow>,
  stock: Map<number, number>,
  source: Record<number, PiStockSource>,
): PiProductCost[] {
  return PI_PRODUCTS.filter((product) => product.tier === tier)
    .map((product) => estimateProductCost(product.typeId, priceRows, stock, source))
    .filter((item): item is PiProductCost => item !== null)
    .sort((a, b) => {
      const marginA = a.margin ?? Number.NEGATIVE_INFINITY;
      const marginB = b.margin ?? Number.NEGATIVE_INFINITY;
      if (marginB !== marginA) return marginB - marginA;
      return (b.profit ?? Number.NEGATIVE_INFINITY) - (a.profit ?? Number.NEGATIVE_INFINITY);
    });
}

/** 库存最多能合成多少个该产物（只统计标为「库存」的物资） */
export function estimateCap(
  typeId: number,
  stockForSynthesis: Map<number, number>,
): number {
  return synthesizeMax(stockForSynthesis, typeId).output;
}
