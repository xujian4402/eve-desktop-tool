import { PI_SCHEMATICS, piTypeName } from "@/lib/pi/data";
import type { PiTier } from "@/lib/pi/types";

/**
 * 行星产物合成方案（纯函数）。
 *
 * 输入：手上有多少行星产物（来自角色 ESI 资产汇总）
 * 输出：这些库存最多能合成多少目标产物、每步要跑多少周期、缺什么
 *
 * 算法：
 *   1. 自顶向下按需求拆解：目标需要 N 个周期 → 其输入按配方消耗，
 *      被库存覆盖的部分不再需要生产，剩余继续往下一级拆
 *   2. 库存优先抵扣（库存已经做好，先花库存再开工最省原料）
 *   3. 单调性：周期越多需求越大 → 倍增 + 二分求「最大可行周期数」
 *   4. 计算用连续量，展示按整数周期向上取整（会有少量富余）
 */

export interface PiRecipe {
  schematicId: number;
  /** 产出物类型 ID */
  typeId: number;
  name: string;
  tier: PiTier;
  outputPerCycle: number;
  cycleTime: number;
  facility: string;
  inputs: Array<{ typeId: number; quantity: number }>;
}

/** 全部配方（由内置静态数据转换而来） */
export const PI_RECIPES: PiRecipe[] = PI_SCHEMATICS.map((item) => ({
  schematicId: item.id,
  typeId: item.outputTypeId,
  name: item.name,
  tier: item.tier,
  outputPerCycle: item.outputs[0]?.quantity ?? 1,
  cycleTime: item.cycleTime,
  facility: item.facility,
  inputs: item.inputs.map((input) => ({
    typeId: input.typeId,
    quantity: input.quantity,
  })),
}));

export const PI_RECIPE_MAP = new Map<number, PiRecipe>(
  PI_RECIPES.map((recipe) => [recipe.typeId, recipe]),
);

export interface PiSynthesisLine {
  typeId: number;
  name: string;
  tier: PiTier | 0;
  /** 需要投入的总量 */
  required: number;
  /** 其中由库存直接抵扣 */
  fromStock: number;
  /** 仍需生产（P0 侧为缺口） */
  remaining: number;
  /** 需要运行的周期数（连续量） */
  cycles: number;
  outputPerCycle: number;
  cycleTime: number;
  facility: string;
}

export interface PiSynthesisResult {
  targetTypeId: number;
  targetName: string;
  targetTier: PiTier;
  /** 目标产物的周期数（整数） */
  cycles: number;
  /** 本次新增产出（不含已有库存） */
  output: number;
  /** 已有库存 */
  stockOfTarget: number;
  feasible: boolean;
  /** 各级明细（等级降序，P0 在最后单独给） */
  lines: PiSynthesisLine[];
  p0: PiSynthesisLine[];
  /** 缺口 */
  shortfall: Array<{ typeId: number; name: string; amount: number }>;
  totalCycleSeconds: number;
}

const EPS = 1e-9;

interface Evaluation {
  lines: PiSynthesisLine[];
  p0: PiSynthesisLine[];
  shortfall: Array<{ typeId: number; name: string; amount: number }>;
  totalCycleSeconds: number;
}

/** 给定目标周期数，核算需求、库存抵扣与缺口 */
function evaluate(
  stock: Map<number, number>,
  targetTypeId: number,
  targetCycles: number,
): Evaluation {
  const target = PI_RECIPE_MAP.get(targetTypeId);
  if (!target) {
    return { lines: [], p0: [], shortfall: [], totalCycleSeconds: 0 };
  }

  const stockLeft = new Map(stock);
  const required = new Map<number, number>();
  required.set(targetTypeId, targetCycles * target.outputPerCycle);

  const lines: PiSynthesisLine[] = [];
  const p0: PiSynthesisLine[] = [];
  const shortfall: Array<{ typeId: number; name: string; amount: number }> = [];
  let totalCycleSeconds = 0;

  // 等级降序：先处理高等级，库存优先抵扣高等级产物，最省下游原料
  const ordered = [...PI_RECIPE_MAP.values()].sort(
    (left, right) => right.tier - left.tier || left.typeId - right.typeId,
  );

  for (const recipe of ordered) {
    const demand = required.get(recipe.typeId) ?? 0;
    if (demand <= EPS) continue;

    // 目标产物自身的库存不参与抵扣：它与新增产出并列（已有 + 新增 = 合计）
    const isTarget = recipe.typeId === targetTypeId;
    const available = isTarget ? 0 : (stockLeft.get(recipe.typeId) ?? 0);
    const fromStock = Math.min(available, demand);
    if (!isTarget) stockLeft.set(recipe.typeId, available - fromStock);

    const remaining = demand - fromStock;
    const cycles = remaining / recipe.outputPerCycle;

    lines.push({
      typeId: recipe.typeId,
      name: recipe.name,
      tier: recipe.tier,
      required: demand,
      fromStock,
      remaining,
      cycles,
      outputPerCycle: recipe.outputPerCycle,
      cycleTime: recipe.cycleTime,
      facility: recipe.facility,
    });

    if (cycles > EPS) {
      totalCycleSeconds += cycles * recipe.cycleTime;
      for (const input of recipe.inputs) {
        required.set(
          input.typeId,
          (required.get(input.typeId) ?? 0) +
            remaining * (input.quantity / recipe.outputPerCycle),
        );
      }
    }
  }

  // P0：没有配方，只能从库存拿
  for (const [typeId, demand] of required) {
    if (PI_RECIPE_MAP.has(typeId) || demand <= EPS) continue;
    const available = stockLeft.get(typeId) ?? 0;
    const fromStock = Math.min(available, demand);
    const missing = demand - fromStock;

    const line: PiSynthesisLine = {
      typeId,
      name: piTypeName(typeId),
      tier: 0,
      required: demand,
      fromStock,
      remaining: missing,
      cycles: 0,
      outputPerCycle: 0,
      cycleTime: 0,
      facility: "",
    };
    p0.push(line);
    if (missing > EPS) {
      shortfall.push({ typeId, name: line.name, amount: missing });
    }
  }

  return { lines, p0, shortfall, totalCycleSeconds };
}

/** 求库存能合成的最大数量 */
export function synthesizeMax(
  stock: Map<number, number>,
  targetTypeId: number,
  maxCycles = 1_000_000,
): PiSynthesisResult {
  const target = PI_RECIPE_MAP.get(targetTypeId);
  const targetName = piTypeName(targetTypeId);
  const targetTier = (target?.tier ?? 1) as PiTier;
  const stockOfTarget = stock.get(targetTypeId) ?? 0;

  if (!target) {
    return {
      targetTypeId,
      targetName,
      targetTier,
      cycles: 0,
      output: 0,
      feasible: true,
      lines: [],
      p0: [],
      shortfall: [],
      stockOfTarget,
      totalCycleSeconds: 0,
    };
  }

  const feasibleAt = (cycles: number) =>
    evaluate(stock, targetTypeId, cycles).shortfall.length === 0;

  // 1) 倍增找「不可行上界」
  let hi = 1;
  while (hi < maxCycles && feasibleAt(hi)) {
    hi = Math.min(hi * 2, maxCycles);
  }
  const hitCeiling = hi === maxCycles && feasibleAt(maxCycles);

  // 2) 在 (lo, hi) 内二分：lo 恒可行，hi 不可行
  let lo = 0;
  if (hitCeiling) {
    lo = maxCycles;
  } else {
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (feasibleAt(mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }

  const best = lo;
  const result = evaluate(stock, targetTypeId, best);
  // 缺口按「再做一轮」计算，便于提示还差多少
  const nextStep = evaluate(stock, targetTypeId, best + 1);

  return {
    targetTypeId,
    targetName,
    targetTier,
    cycles: best,
    output: best * target.outputPerCycle,
    feasible: result.shortfall.length === 0,
    lines: result.lines.sort(
      (left, right) => right.tier - left.tier || right.required - left.required,
    ),
    p0: result.p0.sort((left, right) => right.required - left.required),
    shortfall: nextStep.shortfall,
    stockOfTarget,
    totalCycleSeconds: result.totalCycleSeconds,
  };
}

/** 批量求各产物的可合成数量（总览用） */
export function listSynthesisCaps(
  stock: Map<number, number>,
): Array<{ typeId: number; name: string; tier: PiTier; output: number }> {
  return PI_RECIPES.map((recipe) => ({
    typeId: recipe.typeId,
    name: recipe.name,
    tier: recipe.tier,
    output: synthesizeMax(stock, recipe.typeId).output,
  }))
    .filter((item) => item.output > 0)
    .sort((a, b) => b.output - a.output || a.tier - b.tier);
}
