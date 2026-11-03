import { PI_PRODUCTS } from "@/lib/pi/data";
import { mergeQuantities } from "@/lib/pi/inventory";
import { buildChainPlan } from "@/lib/pi/schematic";
import { evaluateSynthesis, synthesizeMax } from "@/lib/pi/synthesis";
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
  /** 总成本 = 库存成本 + 市场成本（缺价时为 null） */
  cost: number | null;
  /** 消耗库存原料的估值 */
  stockCost: number | null;
  /** 从市场补货的支出 */
  marketCost: number | null;
  revenue: number | null;
  profit: number | null;
  margin: number | null;
  /** 有原料没填价 */
  costIncomplete: boolean;
  /** 产物本身没填价 */
  revenueIncomplete: boolean;
}

/** 取该物品的单件价格：P0 用最低卖单，其余用最高买单 */
function unitPrice(
  priceRows: Map<number, PiPriceRow>,
  typeId: number,
): number | null {
  const row = priceRows.get(typeId);
  return row?.sell ?? row?.buy ?? null;
}

/**
 * 估算单个产物的成本与收益。
 *
 * 可用量 = 库存 + 计划从市场买入的数量，两者都优先抵扣（库存先扣）。
 * - 库存成本：被消耗的库存物料（P0~P3 各级）按其行情价折算；
 * - 市场成本：被消耗的市场物料 + P0 缺口（中间品默认自制，缺口最终落在 P0）。
 *
 * 中间品不重复计价：某层有缺口时，只把「造它所需的下层 P0 缺口」计入成本，
 * 不会同时把该层成品价格也算一遍。
 * 产物按行情买单卖出。
 */
export function estimateProductCost(
  typeId: number,
  priceRows: Map<number, PiPriceRow>,
  stock: Map<number, number>,
  marketQty: Map<number, number> = new Map(),
  /** 产物收入单价（默认取最高买单） */
  revenueUnit?: (typeId: number) => number | null,
): PiProductCost | null {
  const plan = buildChainPlan(typeId);
  if (!plan) return null;

  // 按 1 小时产线的周期数核算各级需求，库存 + 市场数量一起抵扣
  const detail = evaluateSynthesis(
    mergeQuantities(stock, marketQty),
    typeId,
    plan.cycles,
  );

  let stockCost = 0;
  let marketCost = 0;
  let buyCount = 0;
  let stockCount = 0;
  let costIncomplete = false;

  // 被抵扣的各级物料：先扣库存，再扣市场采购的数量
  for (const line of [...detail.lines, ...detail.p0]) {
    // 目标产物本身是产出，不算原料
    if (line.typeId === typeId || line.fromStock <= 0) continue;

    const stockAvail = stock.get(line.typeId) ?? 0;
    const useStock = Math.min(stockAvail, line.fromStock);
    const useMarket = line.fromStock - useStock;

    const unit = unitPrice(priceRows, line.typeId);
    if (unit === null) {
      costIncomplete = true;
      continue;
    }

    stockCost += unit * useStock;
    marketCost += unit * useMarket;
    stockCount += useStock;
    buyCount += useMarket;
  }

  // P0 缺口：中间品自制，所以缺口只买原始资源
  for (const line of detail.p0) {
    if (line.remaining <= 0) continue;

    const unit = unitPrice(priceRows, line.typeId);
    if (unit === null) {
      costIncomplete = true;
      continue;
    }
    marketCost += unit * line.remaining;
    buyCount += line.remaining;
  }

  const rootStep = plan.steps.find(
    (step) => step.outputTypeId === plan.rootTypeId,
  );
  const outputQty = rootStep?.totalOutput ?? 0;
  const sellUnit = revenueUnit
    ? revenueUnit(typeId)
    : (priceRows.get(typeId)?.buy ?? null);
  const revenueIncomplete = sellUnit === null;
  const revenue = sellUnit === null ? null : sellUnit * outputQty;

  const finalCost = costIncomplete ? null : stockCost + marketCost;
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
    stockCost: costIncomplete ? null : stockCost,
    marketCost: costIncomplete ? null : marketCost,
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
  marketQty: Map<number, number> = new Map(),
  revenueUnit?: (typeId: number) => number | null,
): PiProductCost[] {
  return PI_PRODUCTS.filter((product) => product.tier === tier)
    .map((product) =>
      estimateProductCost(
        product.typeId,
        priceRows,
        stock,
        marketQty,
        revenueUnit,
      ),
    )
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
