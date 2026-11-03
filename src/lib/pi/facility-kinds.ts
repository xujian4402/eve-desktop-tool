/**
 * 行星工业设施类型识别。
 *
 * ESI 只给 pin 的 `type_id`，不告诉你「这是指挥中心还是发射平台」，
 * 这里按 SDE `types.jsonl` 里筛出的 PI 建筑 ID 归类。
 * 同一类设施在不同行星类型上各有独立 typeID，因此用集合而非区间判断。
 */

export interface PiFacilityKind {
  /** 完整名称，如「发射平台」 */
  label: string;
  /** 卡片徽章用的单字，如「射」 */
  short: string;
}

/** 指挥中心（2129~2163 覆盖各行星与等级，2254 为温和行星指挥中心） */
const COMMAND_CENTER_IDS = new Set<number>([
  2129, 2130, 2131, 2132, 2133,
  2134, 2135, 2136, 2137, 2138,
  2139, 2140, 2141, 2142, 2143,
  2144, 2145, 2146, 2147, 2148,
  2149, 2150, 2151, 2152, 2153,
  2154, 2155, 2156, 2157, 2158,
  2159, 2160, 2161, 2162, 2163,
  2254,
]);

/** 发射平台 */
const LAUNCHPAD_IDS = new Set<number>([
  2256, 2542, 2543, 2544, 2552, 2555, 2556, 2557,
]);

/** 储藏设施 */
const STORAGE_IDS = new Set<number>([
  2257, 2535, 2536, 2541, 2558, 2560, 2561, 2562,
]);

/** 采集控制器（ECU） */
const EXTRACTOR_CONTROL_IDS = new Set<number>([
  2848, 3060, 3061, 3062, 3063, 3064, 3067, 3068,
]);

/** 基础工业设施 */
const BASIC_INDUSTRY_IDS = new Set<number>([
  2469, 2471, 2473, 2481, 2483, 2490, 2492, 2493,
]);

/** 高级工业设施 */
const ADVANCED_INDUSTRY_IDS = new Set<number>([
  2470, 2472, 2474, 2480, 2484, 2485, 2491, 2494,
]);

/** 高科技工厂（只有贫瘠 / 温和行星能装） */
const HIGH_TECH_IDS = new Set<number>([2475, 2482]);

/** 工厂档位名称；不是工厂时返回 null */
export function factoryTierOf(typeId: number): string | null {
  if (BASIC_INDUSTRY_IDS.has(typeId)) return "基础工业设施";
  if (ADVANCED_INDUSTRY_IDS.has(typeId)) return "高级工业设施";
  if (HIGH_TECH_IDS.has(typeId)) return "高科技工厂";
  return null;
}

/** 判断 pin 属于哪类 POI 设施；未知返回 null */
export function facilityTypeOf(typeId: number): PiFacilityKind | null {
  if (COMMAND_CENTER_IDS.has(typeId)) {
    return { label: "指挥中心", short: "指" };
  }
  if (LAUNCHPAD_IDS.has(typeId)) {
    return { label: "发射平台", short: "射" };
  }
  if (STORAGE_IDS.has(typeId)) {
    return { label: "储藏设施", short: "储" };
  }
  if (EXTRACTOR_CONTROL_IDS.has(typeId)) {
    return { label: "采集控制器", short: "采" };
  }
  return null;
}
