import { PI_SCHEMATICS } from "@/lib/pi/data";
import { buildChainPlan } from "@/lib/pi/schematic";
import type {
  PiChainPlan,
  PiPriceRow,
  PiProfitResult,
  PiTier,
} from "@/lib/pi/types";

/**
 * 行星工业收益计算（纯函数，P1~P4 通用）。
 *
 * 口径：
 *   - 成本：外购物料（P0 原始资源）按「最低卖单」买入
 *   - 收入：目标产物按「最高买单」即时卖出
 *   - 利润率：利润 ÷ 成本
 *   - 时间：1 条产线满负荷 1 小时
 *
 * 缺价的物品不计入金额，并单独计数提示（避免用 0 价把利润算歪）。
 */
export function computeProfit(
  plan: PiChainPlan,
  prices: Map<number, PiPriceRow>,
): PiProfitResult {
  const lines: PiProfitResult["lines"] = [];
  let cost = 0;
  let revenue = 0;
  let missingPriceCount = 0;
  let costIncomplete = false;
  let revenueIncomplete = false;

  for (const purchase of plan.purchases) {
    const unitPrice = prices.get(purchase.typeId)?.sell ?? null;
    if (unitPrice === null) {
      missingPriceCount += 1;
      costIncomplete = true;
    }
    const amount = unitPrice === null ? null : unitPrice * purchase.quantity;
    if (amount !== null) cost += amount;
    lines.push({
      typeId: purchase.typeId,
      name: purchase.name,
      kind: "purchase",
      quantity: purchase.quantity,
      unitPrice,
      amount,
    });
  }

  const rootStep = plan.steps.find(
    (step) => step.outputTypeId === plan.rootTypeId,
  );
  if (rootStep) {
    const unitPrice = prices.get(rootStep.outputTypeId)?.buy ?? null;
    if (unitPrice === null) {
      missingPriceCount += 1;
      revenueIncomplete = true;
    }
    const amount = unitPrice === null ? null : unitPrice * rootStep.totalOutput;
    if (amount !== null) revenue += amount;
    lines.push({
      typeId: rootStep.outputTypeId,
      name: rootStep.name,
      kind: "revenue",
      quantity: rootStep.totalOutput,
      unitPrice,
      amount,
    });
  }

  const profit = revenue - cost;

  return {
    rootTypeId: plan.rootTypeId,
    rootName: plan.rootName,
    cost,
    revenue,
    profit,
    margin: cost > 0 && !revenueIncomplete ? profit / cost : null,
    lines,
    missingPriceCount,
    costIncomplete,
    revenueIncomplete,
  };
}

/** 单个产物的收益排行行 */
export interface PiProfitRankRow {
  typeId: number;
  name: string;
  tier: PiTier;
  plan: PiChainPlan;
  profit: PiProfitResult;
  /** 按每小时利润排序用的值（缺价时为 null） */
  sortKey: number | null;
}

/**
 * 批量计算 P1~P4 全部产物的收益（口径同上：外购 P0、自制中间品、1 条产线 1 小时）。
 *
 * 68 个产物各自独立展开配方链，价格没填的产物利润不可信（costIncomplete），
 * 由调用方决定是否展示。默认按利润率降序，利润率相同再按利润降序。
 */
export function computeProductProfits(
  prices: Map<number, PiPriceRow>,
): PiProfitRankRow[] {
  const rows: PiProfitRankRow[] = [];

  for (const schematic of PI_SCHEMATICS) {
    const plan = buildChainPlan(schematic.outputTypeId);
    if (!plan) continue;
    const profit = computeProfit(plan, prices);
    rows.push({
      typeId: schematic.outputTypeId,
      name: schematic.name,
      tier: schematic.tier,
      plan,
      profit,
      sortKey: profit.revenueIncomplete ? null : profit.profit,
    });
  }

  /** 数据完整度：0 完整，1 缺部分原料价，2 缺产物价（缺价的行利润不可信，排后面） */
  const completeness = (row: PiProfitRankRow): number =>
    row.profit.revenueIncomplete ? 2 : row.profit.costIncomplete ? 1 : 0;

  return rows.sort((a, b) => {
    const completeDiff = completeness(a) - completeness(b);
    if (completeDiff !== 0) return completeDiff;

    const marginA = a.profit.margin ?? Number.NEGATIVE_INFINITY;
    const marginB = b.profit.margin ?? Number.NEGATIVE_INFINITY;
    if (marginB !== marginA) return marginB - marginA;
    return (b.sortKey ?? Number.NEGATIVE_INFINITY) - (a.sortKey ?? Number.NEGATIVE_INFINITY);
  });
}
