import type { PiFacilityTier, PiPlanetType } from "@/lib/pi/types";

/**
 * P0 原始资源 × 行星类型 对照表。
 *
 * 新版 SDE 的 planetResources 只描述星系的 power / workforce / 试剂，
 * 不再包含「哪种行星产哪种 P0」的分布，因此以常量维护（数据来自 EVE 设定）。
 *
 * 规律：每种行星恰好出产 5 种 P0；水基液体分布最广（6 种行星）。
 */
export const PI_PLANET_TYPES: PiPlanetType[] = [
  "贫瘠行星",
  "温和行星",
  "熔岩行星",
  "气体行星",
  "海洋行星",
  "冰体行星",
  "等离子行星",
  "风暴行星",
];

/** P0 类型 ID → 可开采的行星类型 */
export const P0_PLANET_TYPES: Record<number, PiPlanetType[]> = {
  2073: ["贫瘠行星", "冰体行星", "海洋行星", "温和行星"], // 微生物
  2288: ["贫瘠行星", "海洋行星", "温和行星"], // 碳化合物
  2286: ["冰体行星", "海洋行星"], // 浮游生物群
  2306: ["熔岩行星", "等离子行星"], // 非立方晶体
  2309: ["气体行星", "风暴行星"], // 离子溶液
  2305: ["温和行星"], // 自养生物
  2311: ["气体行星"], // 活性气体
  2310: ["气体行星", "冰体行星", "风暴行星"], // 稀有气体
  2308: ["熔岩行星", "等离子行星", "风暴行星"], // 悬浮等离子
  2270: ["贫瘠行星", "等离子行星"], // 贵金属
  2287: ["海洋行星", "温和行星"], // 复杂有机生命体
  2267: ["贫瘠行星", "气体行星", "熔岩行星", "等离子行星", "风暴行星"], // 基础金属
  2307: ["熔岩行星"], // 长英矿物岩浆
  2272: ["冰体行星", "熔岩行星", "等离子行星"], // 重金属
  2268: [
    "贫瘠行星",
    "气体行星",
    "冰体行星",
    "海洋行星",
    "风暴行星",
    "温和行星",
  ], // 水基液体
};

export function planetTypesOfP0(typeId: number): PiPlanetType[] {
  return P0_PLANET_TYPES[typeId] ?? [];
}

/** 反向：行星类型 → 可开采的 P0 类型 ID */
export function p0TypeIdsOfPlanet(planetType: string): number[] {
  return Object.entries(P0_PLANET_TYPES)
    .filter(([, planets]) => planets.includes(planetType as PiPlanetType))
    .map(([typeId]) => Number(typeId));
}

/** 汇总一组 P0 的采集行星（并集，按标准顺序） */
export function harvestPlanetsOf(p0TypeIds: number[]): PiPlanetType[] {
  const set = new Set<PiPlanetType>();
  for (const typeId of p0TypeIds) {
    for (const planet of planetTypesOfP0(typeId)) set.add(planet);
  }
  return PI_PLANET_TYPES.filter((planet) => set.has(planet));
}

/** 行星类型 ID → 标准行星类型名（对应 SDE mapPlanets 里的 typeID） */
export const PLANET_TYPE_ID_TO_NAME: Record<number, PiPlanetType> = {
  11: "温和行星",
  12: "冰体行星",
  13: "气体行星",
  2014: "海洋行星",
  2015: "熔岩行星",
  2016: "贫瘠行星",
  2017: "风暴行星",
  2063: "等离子行星",
};

/** 行星类型 ID → 中文名（未知类型回退 #id） */
export function planetTypeName(typeId: number): string {
  return PLANET_TYPE_ID_TO_NAME[typeId] ?? `#${typeId}`;
}

/** 设施档位（从低到高） */
export const PI_FACILITY_TIERS: PiFacilityTier[] = [
  "基础工业设施",
  "高级工业设施",
  "高科技工厂",
];

/** 某行星类型可安装的设施档位：只有贫瘠/温和行星能装高科技工厂 */
export function facilitiesOfPlanet(planetType: string): PiFacilityTier[] {
  const normalized = planetType.includes("行星") ? planetType : `${planetType}行星`;
  return normalized === "贫瘠行星" || normalized === "温和行星"
    ? [...PI_FACILITY_TIERS]
    : ["基础工业设施", "高级工业设施"];
}

/** 行星类型 → 可用设施说明 */
export const PLANET_FACILITY_HINT: Record<PiPlanetType, string> = {
  贫瘠行星: "基础 / 高级工业设施 + 高科技工厂",
  温和行星: "基础 / 高级工业设施 + 高科技工厂",
  熔岩行星: "基础 / 高级工业设施",
  气体行星: "基础 / 高级工业设施",
  海洋行星: "基础 / 高级工业设施",
  冰体行星: "基础 / 高级工业设施",
  等离子行星: "基础 / 高级工业设施",
  风暴行星: "基础 / 高级工业设施",
};
