import { invoke } from "@tauri-apps/api/core";

/* ============================================================
   类型（与 src-tauri/src/mfg/model.rs 对应）
   ============================================================ */

/** 当前库里的 SDE 状态 */
export interface MfgSdeStatus {
  ready: boolean;
  /** 库中记录的生成日期 */
  generatedAt: string | null;
  /** 随应用打包的生成日期 */
  bundledAt: string;
  blueprints: number;
  inventions: number;
  types: number;
}

/** SDE 导入结果 */
export interface MfgSyncResult {
  /** false = 版本一致，已跳过 */
  imported: boolean;
  generatedAt: string;
  blueprints: number;
  inventions: number;
  research: number;
  types: number;
  decryptors: number;
  facilities: number;
  rigs: number;
  elapsedMs: number;
}

/** 产品（蓝图产物） */
export interface MfgProductView {
  productTypeId: number;
  blueprintTypeId: number;
  name: string;
  nameEn: string;
  groupId: number;
  /** "manufacturing" | "reaction" */
  activity: string;
  outputQty: number;
  baseTime: number;
}

export interface MfgMaterialView {
  typeId: number;
  name: string;
  quantity: number;
  volume: number;
}

export interface MfgSkillView {
  typeId: number;
  name: string;
  level: number;
}

/** 配方详情 */
export interface MfgRecipeView {
  productTypeId: number;
  blueprintTypeId: number;
  productName: string;
  outputQty: number;
  baseTime: number;
  activity: string;
  maxRuns: number;
  materials: MfgMaterialView[];
  skills: MfgSkillView[];
}

export interface MfgFacilityTypeView {
  typeId: number;
  name: string;
  /** "npc" | "engineering" | "refinery" */
  category: string;
  meBonus: number;
  teBonus: number;
  costBonus: number;
  tax: number;
  rigSlots: number;
}

export interface MfgRigView {
  typeId: number;
  name: string;
  category: string;
  /** "material" | "time" | "cost" */
  effect: string;
  bonus: number;
}

/* ============================================================
   命令封装
   ============================================================ */

/** 导入内嵌 SDE（版本一致时自动跳过） */
export async function syncMfgSde(force = false): Promise<MfgSyncResult> {
  return invoke<MfgSyncResult>("mfg_sync_sde", { force });
}

export async function getMfgSdeStatus(): Promise<MfgSdeStatus> {
  return invoke<MfgSdeStatus>("mfg_sde_status");
}

export async function listMfgFacilityTypes(): Promise<MfgFacilityTypeView[]> {
  return invoke<MfgFacilityTypeView[]>("mfg_facility_types");
}

export async function listMfgRigs(): Promise<MfgRigView[]> {
  return invoke<MfgRigView[]>("mfg_rigs");
}

/** 产品搜索（空关键字返回前 N 条） */
export async function searchMfgProducts(
  keyword: string,
  limit = 60,
): Promise<MfgProductView[]> {
  return invoke<MfgProductView[]>("mfg_search_products", { keyword, limit });
}

export async function getMfgRecipe(productId: number): Promise<MfgRecipeView> {
  return invoke<MfgRecipeView>("mfg_recipe", { productId });
}

/** 批量取中文名 */
export async function getMfgTypeNames(
  typeIds: number[],
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("mfg_type_names", { typeIds });
}

/* ============================================================
   计算预览（P0 验证公式用，P1 换成基于配方的完整命令）
   ============================================================ */

export interface MfgCalcContext {
  facilityMe: number;
  facilityTe: number;
  facilityCost: number;
  rigMe: number;
  rigTe: number;
  systemCostIndex: number;
  facilityTax: number;
  skillTimeMul: number;
}

export interface MfgCalcPreviewInput {
  runs: number;
  me: number;
  te: number;
  baseTime: number;
  materials: Array<{ typeId: number; baseQuantity: number }>;
  estimatedItemValue?: number;
  context: MfgCalcContext;
}

export interface MfgCalcPreviewOutput {
  materials: Array<{ typeId: number; baseQuantity: number; quantity: number }>;
  seconds: number;
  jobCost: number;
}

/** 试算材料 / 时间 / 作业费（纯计算，不查库） */
export async function calcMfgPreview(
  input: MfgCalcPreviewInput,
): Promise<MfgCalcPreviewOutput> {
  return invoke<MfgCalcPreviewOutput>("mfg_calc_preview", { input });
}

/** 默认计算上下文：无建筑加成、成本指数 5% */
export const DEFAULT_MFG_CONTEXT: MfgCalcContext = {
  facilityMe: 0,
  facilityTe: 0,
  facilityCost: 0,
  rigMe: 0,
  rigTe: 0,
  systemCostIndex: 0.05,
  facilityTax: 0,
  skillTimeMul: 1,
};

/* ============================================================
   完整计算 / BOM / 排行 / 地点 / NPC / 发明 / 我的工业
   ============================================================ */

export interface MfgMaterialLine {
  typeId: number;
  baseQuantity: number;
  totalBase: number;
  quantity: number;
  unitPrice: number | null;
  subtotal: number | null;
  missingPrice: boolean;
}

export interface MfgJobOutput {
  productTypeId: number;
  blueprintTypeId: number;
  activity: string;
  runs: number;
  outputQty: number;
  seconds: number;
  materials: MfgMaterialLine[];
  estimatedItemValue: number;
  installFee: number;
  taxes: number;
  jobCost: number;
  materialCost: number;
  totalCost: number;
  productPrice: number | null;
  revenue: number | null;
  profit: number | null;
  margin: number | null;
  perHourProfit: number | null;
  missingPrice: number[];
}

export interface MfgBomLine {
  typeId: number;
  name: string;
  quantity: number;
  unitPrice: number | null;
  subtotal: number | null;
}

export interface MfgBomNode {
  productId: number;
  name: string;
  units: number;
  runs: number;
  outputQty: number;
  build: boolean;
  jobCost: number;
  materialCost: number;
  totalCost: number;
  children: MfgBomNode[];
  materials: MfgBomLine[];
}

export interface MfgBomResult {
  root: MfgBomNode;
  raw: MfgBomLine[];
  buildCount: number;
  depthLimited: boolean;
}

export interface MfgRankItem {
  productId: number;
  blueprintId: number;
  name: string;
  activity: string;
  materialCost: number;
  jobCost: number;
  totalCost: number;
  revenue: number;
  profit: number;
  margin: number;
  seconds: number;
  perHour: number;
}

export interface MfgLocationItem {
  solarSystemId: number;
  name: string;
  security: number;
  costIndex: number;
  jobCost: number;
}

export interface MfgNpcBlueprintView {
  bpTypeId: number;
  name: string;
  price: number;
  corpCount: number;
}

export interface MfgDecryptorView {
  typeId: number;
  name: string;
  probMul: number;
  meAdd: number;
  teAdd: number;
  runsAdd: number;
}

export interface MfgInventionOption {
  decryptorId: number | null;
  decryptorName: string;
  probability: number;
  runs: number;
  attemptCost: number;
  perRunCost: number;
  me: number;
  te: number;
}

export interface MfgInventionPlan {
  t2BlueprintId: number;
  t1BlueprintId: number;
  baseProbability: number;
  baseTime: number;
  productName: string;
  datacoreCost: number;
  installCost: number;
  options: MfgInventionOption[];
}

export interface MfgMyBlueprintView {
  itemId: number;
  typeId: number;
  productTypeId: number;
  name: string;
  locationId: number;
  quantity: number;
  materialEfficiency: number;
  timeEfficiency: number;
  runs: number;
  isBpo: boolean;
  perHour: number | null;
  profit: number | null;
}

export interface MfgMyJobView {
  jobId: number;
  activityId: number;
  productTypeId: number;
  blueprintTypeId: number;
  name: string;
  runs: number;
  status: string;
  startDate: string;
  endDate: string;
  remaining: number;
  progress: number;
}

export interface MfgMyIndustryView {
  blueprints: MfgMyBlueprintView[];
  jobs: MfgMyJobView[];
}

export interface MfgSyncCount {
  synced: number;
}

/** 单次作业完整计算 */
export async function calculateMfg(
  productId: number,
  runs: number,
  me: number,
  te: number,
  context: MfgCalcContext,
): Promise<MfgJobOutput> {
  return invoke<MfgJobOutput>("mfg_calculate", {
    productId,
    runs,
    me,
    te,
    context,
  });
}

/** 多级 BOM 展开 */
export async function expandMfgBom(
  productId: number,
  units: number,
  me: number,
  te: number,
  buildSet: number[],
  context: MfgCalcContext,
): Promise<MfgBomResult> {
  return invoke<MfgBomResult>("mfg_bom", {
    productId,
    units,
    me,
    te,
    buildSet,
    context,
  });
}

export async function rankMfg(
  me: number,
  te: number,
  activity: string,
  minMargin: number,
  limit: number,
): Promise<MfgRankItem[]> {
  return invoke<MfgRankItem[]>("mfg_rank", {
    me,
    te,
    activity,
    minMargin,
    limit,
  });
}

export async function locateMfg(
  productId: number,
  me: number,
  te: number,
  minSecurity: number,
  limit: number,
): Promise<MfgLocationItem[]> {
  return invoke<MfgLocationItem[]>("mfg_locations", {
    productId,
    me,
    te,
    minSecurity,
    limit,
  });
}

export async function listNpcBlueprints(
  keyword: string,
  limit = 200,
): Promise<MfgNpcBlueprintView[]> {
  return invoke<MfgNpcBlueprintView[]>("mfg_npc_blueprints", {
    keyword,
    limit,
  });
}

export async function listDecryptors(): Promise<MfgDecryptorView[]> {
  return invoke<MfgDecryptorView[]>("mfg_decryptors");
}

export async function planInvention(
  t2BlueprintId: number,
  skillBonus: number,
  context: MfgCalcContext,
): Promise<MfgInventionPlan> {
  return invoke<MfgInventionPlan>("mfg_invention_plan", {
    t2BlueprintId,
    skillBonus,
    context,
  });
}

export async function getMyIndustry(
  characterId: number,
): Promise<MfgMyIndustryView> {
  return invoke<MfgMyIndustryView>("mfg_my_industry", { characterId });
}

export async function syncMyBlueprints(
  characterId: number,
): Promise<MfgSyncCount> {
  return invoke<MfgSyncCount>("mfg_sync_my_blueprints", { characterId });
}

export async function syncMyJobs(
  characterId: number,
  corporationId?: number,
): Promise<MfgSyncCount> {
  return invoke<MfgSyncCount>("mfg_sync_my_jobs", {
    characterId,
    corporationId: corporationId ?? null,
  });
}

export async function syncCostIndex(): Promise<MfgSyncCount> {
  return invoke<MfgSyncCount>("mfg_cost_index_sync");
}

export interface MfgResearchLevel {
  target: number;
  seconds: number;
  cost: number;
}

export interface MfgResearchInfo {
  blueprintTypeId: number;
  meTime: number;
  teTime: number;
  copyTime: number;
  meLevels: MfgResearchLevel[];
  teLevels: MfgResearchLevel[];
}

/** 研究 / 拷贝时间与费用 */
export async function researchMfg(
  blueprintTypeId: number,
  currentMe: number,
  currentTe: number,
  eiv: number,
  context: MfgCalcContext,
): Promise<MfgResearchInfo> {
  return invoke<MfgResearchInfo>("mfg_research_info", {
    blueprintTypeId,
    currentMe,
    currentTe,
    eiv,
    context,
  });
}

/** 角色的制造业技能等级（技能 id → 等级） */
export async function getMfgCharacterSkills(
  characterId: number,
): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("mfg_character_skills", {
    characterId,
  });
}

/** 制造业相关技能 id */
export const MFG_SKILL = {
  /** 工业理论：每级 −4% 制造时间 */
  industry: 3380,
  /** 高级工业：每级 −3% 制造时间 */
  advancedIndustry: 3388,
  /** 反应学：每级 −4% 反应时间 */
  reactions: 45746,
} as const;

/**
 * 按技能等级算时间倍率。
 *
 * 制造：`(1 − 4%×工业理论) × (1 − 3%×高级工业)`
 * 反应：`(1 − 4%×反应学)`
 */
export function skillTimeMul(
  skills: Record<string, number> | undefined,
  activity: string,
): number {
  if (!skills) return 1;

  const industry = Number(skills[MFG_SKILL.industry] ?? 0);
  const advanced = Number(skills[MFG_SKILL.advancedIndustry] ?? 0);
  const reactions = Number(skills[MFG_SKILL.reactions] ?? 0);

  const mul =
    activity === "reaction"
      ? 1 - 0.04 * reactions
      : (1 - 0.04 * industry) * (1 - 0.03 * advanced);

  return Math.min(1, Math.max(0.1, mul));
}
