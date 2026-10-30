import { PI_BY_OUTPUT, piTypeName } from "@/lib/pi/data";
import { harvestPlanetsOf, PI_PLANET_TYPES } from "@/lib/pi/planet-types";
import type {
  PiChainPlan,
  PiChainStep,
  PiMaterial,
  PiSchematic,
  PiTier,
} from "@/lib/pi/types";

/**
 * 生成生产计划（默认外购 P0 原始资源，自制全部中间品）。
 *
 * 口径：「单条产线满负荷 1 小时」——
 *   - P1 配方周期 1800 秒 → 1 小时跑 2 个周期
 *   - P2~P4 配方周期 3600 秒 → 1 小时跑 1 个周期
 * 成本、收入、物料量都是「每小时」的量，与工厂数量无关（1 条产线）。
 *
 * 取整规则：每个步骤按「需要的量 ÷ 单周期产出」向上取整，与实际跑工厂一致
 * （会略有富余，富余部分不再计入上游消耗）。
 */
export function buildChainPlan(
  rootTypeId: number,
  rootCycles = 0,
): PiChainPlan | null {
  const root = PI_BY_OUTPUT.get(rootTypeId);
  if (!root) return null;

  const rootOutputPerCycle = root.outputs[0]?.quantity ?? 1;
  const cyclesPerHour =
    rootCycles > 0 ? rootCycles : Math.max(1, Math.round(3600 / root.cycleTime));
  const rootNeed = cyclesPerHour * rootOutputPerCycle;

  const stepMap = new Map<number, PiChainStep>();
  const purchaseMap = new Map<number, number>();

  /** 递归展开，返回实际产出量 */
  const expand = (schematic: PiSchematic, need: number): number => {
    const outputPerCycle = schematic.outputs[0]?.quantity ?? 1;
    const cycles = Math.max(1, Math.ceil(need / outputPerCycle));
    const totalOutput = cycles * outputPerCycle;

    const existing = stepMap.get(schematic.id);
    if (existing) {
      existing.cycles += cycles;
      existing.totalOutput += totalOutput;
    } else {
      stepMap.set(schematic.id, {
        schematicId: schematic.id,
        outputTypeId: schematic.outputTypeId,
        name: schematic.name,
        tier: schematic.tier,
        cycles,
        cycleTime: schematic.cycleTime,
        outputPerCycle,
        totalOutput,
        inputs: [],
        facility: schematic.facility,
        planetTypes: schematic.planetTypes,
      });
    }

    for (const input of schematic.inputs) {
      const upstream = PI_BY_OUTPUT.get(input.typeId);
      const required = cycles * input.quantity;
      if (upstream) {
        const produced = expand(upstream, required);
        stepMap.get(schematic.id)?.inputs.push({
          typeId: input.typeId,
          name: input.name,
          quantity: produced,
          tier: upstream.tier,
        });
      } else {
        purchaseMap.set(
          input.typeId,
          (purchaseMap.get(input.typeId) ?? 0) + required,
        );
        stepMap.get(schematic.id)?.inputs.push({
          typeId: input.typeId,
          name: input.name,
          quantity: required,
          tier: 0,
        });
      }
    }

    return totalOutput;
  };

  expand(root, rootNeed);

  const steps = [...stepMap.values()]
    .map((step) => {
      // 同一配方的输入可能来自多次调用，按类型汇总
      const merged = new Map<number, PiMaterial & { tier: PiTier | 0 }>();
      for (const input of step.inputs) {
        const current = merged.get(input.typeId);
        if (current) {
          current.quantity += input.quantity;
        } else {
          merged.set(input.typeId, { ...input });
        }
      }
      return {
        ...step,
        inputs: [...merged.values()].sort((a, b) => a.typeId - b.typeId),
      };
    })
    .sort((a, b) => a.tier - b.tier || a.schematicId - b.schematicId);

  const purchases = [...purchaseMap]
    .map(([typeId, quantity]) => ({
      typeId,
      name: piTypeName(typeId),
      quantity,
      tier: 0 as const,
    }))
    .sort((a, b) => a.typeId - b.typeId);

  const outputsByTier = ([1, 2, 3, 4] as PiTier[])
    .map((tier) => ({
      tier,
      items: steps
        .filter((step) => step.tier === tier)
        .map((step) => ({
          typeId: step.outputTypeId,
          name: step.name,
          quantity: step.totalOutput,
        })),
    }))
    .filter((group) => group.items.length > 0);

  const cycleSecondsPerHour = steps.reduce(
    (sum, step) => sum + step.cycles * step.cycleTime,
    0,
  );

  // 采集行星：外购 P0 的可开采行星并集
  const harvestPlanets = harvestPlanetsOf(purchases.map((item) => item.typeId));

  // 加工行星：各步骤设施可安装的行星并集
  const processingSet = new Set<string>();
  steps.forEach((step) =>
    step.planetTypes.forEach((planet) => processingSet.add(planet)),
  );
  const processingPlanets = PI_PLANET_TYPES.filter((planet) =>
    processingSet.has(planet),
  );

  // 一颗行星能否跑完整条链：各步骤可安装行星集合的交集
  const sharedPlanets =
    steps.length === 0
      ? []
      : PI_PLANET_TYPES.filter((planet) =>
          steps.every((step) => step.planetTypes.includes(planet)),
        );

  return {
    rootTypeId,
    rootName: root.name,
    rootSchematicId: root.id,
    rootTier: root.tier,
    cycles: cyclesPerHour,
    steps,
    purchases,
    outputsByTier,
    cycleSecondsPerHour,
    harvestPlanets,
    processingPlanets,
    sharedPlanets,
    note: `按整数周期向上取整计算，中间品默认自制（仅外购 P0 原始资源）；口径为 1 条产线满负荷 1 小时（${cyclesPerHour} 个周期）。`,
  };
}
