/** 行星工业相关类型定义 */

/** 行星产物等级：P0 为原始资源（无配方），P1~P4 为加工产物 */
export type PiTier = 1 | 2 | 3 | 4;

/** 行星类型（与 SDE 设施名前缀一致） */
export type PiPlanetType =
  | "贫瘠行星"
  | "温和行星"
  | "熔岩行星"
  | "气体行星"
  | "海洋行星"
  | "冰体行星"
  | "等离子行星"
  | "风暴行星";

/** 设施档位 */
export type PiFacilityTier = "基础工业设施" | "高级工业设施" | "高科技工厂";

export interface PiMaterial {
  typeId: number;
  name: string;
  quantity: number;
}

/** 一条配方（来自内置 SDE 静态数据，已算好等级与适用行星） */
export interface PiSchematic {
  id: number;
  name: string;
  nameEn: string;
  cycleTime: number;
  outputTypeId: number;
  facility: string;
  planetTypes: string[];
  inputs: PiMaterial[];
  outputs: PiMaterial[];
  tier: PiTier;
}

/** 生产链中的一步 */
export interface PiChainStep {
  schematicId: number;
  outputTypeId: number;
  name: string;
  tier: PiTier;
  cycles: number;
  cycleTime: number;
  outputPerCycle: number;
  totalOutput: number;
  inputs: Array<PiMaterial & { tier: PiTier | 0 }>;
  facility: string;
  planetTypes: string[];
}

/** 一条完整生产链（口径：1 条产线满负荷 1 小时） */
export interface PiChainPlan {
  rootTypeId: number;
  rootName: string;
  rootSchematicId: number;
  rootTier: PiTier;
  cycles: number;
  steps: PiChainStep[];
  purchases: Array<PiMaterial & { tier: 0 }>;
  outputsByTier: Array<{ tier: PiTier; items: PiMaterial[] }>;
  cycleSecondsPerHour: number;
  harvestPlanets: string[];
  processingPlanets: string[];
  sharedPlanets: string[];
  note: string;
}

/** 行情（买一/卖一） */
export interface PiPriceRow {
  typeId: number;
  sell: number | null;
  buy: number | null;
}

/** 收益计算结果 */
export interface PiProfitResult {
  rootTypeId: number;
  rootName: string;
  cost: number;
  revenue: number;
  profit: number;
  /** 利润率（成本为 0 或缺价时为 null） */
  margin: number | null;
  lines: Array<{
    typeId: number;
    name: string;
    kind: "purchase" | "revenue";
    quantity: number;
    unitPrice: number | null;
    amount: number | null;
  }>;
  missingPriceCount: number;
  costIncomplete: boolean;
  revenueIncomplete: boolean;
}

/** 一个可开发的主权星系（power / workforce / 试剂） */
export interface PiSystem {
  id: number;
  name: string;
  nameEn: string;
  security: number;
  regionId: number;
  regionName: string;
  power: number;
  workforce: number;
  starPower: number;
  planetCount: number;
  powerPlanetCount: number;
  workforcePlanetCount: number;
  reagentPlanetCount: number;
  reagentTypeIds: number[];
  reagentNames: string[];
  reagentAmount: number;
}

/** 星域汇总 */
export interface PiRegion {
  id: number;
  name: string;
  nameEn: string;
  systemCount: number;
  totalPower: number;
  totalWorkforce: number;
  reagentSystemCount: number;
}

/** 主权升级项 */
export interface PiUpgrade {
  id: number;
  name: string;
  exclusiveGroup: string | null;
  power: number;
  workforce: number;
  fuelTypeId: number | null;
  fuelName: string | null;
  fuelStartup: number | null;
  fuelHourly: number | null;
}

/** 主权预算核算结果 */
export interface PiBudgetResult {
  powerUsed: number;
  workforceUsed: number;
  powerLeft: number;
  workforceLeft: number;
  powerOver: boolean;
  workforceOver: boolean;
  fuel: Array<{
    typeId: number;
    name: string;
    startupCost: number;
    hourlyUpkeep: number;
  }>;
  fuelSelfSufficiency: Array<{
    typeId: number;
    name: string;
    supplyPerHour: number;
    demandPerHour: number;
    ratio: number | null;
  }>;
  /** 同组重复选择导致的冲突（互斥组名） */
  conflicts: string[];
}
