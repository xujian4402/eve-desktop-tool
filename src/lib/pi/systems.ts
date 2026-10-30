import { PI_SCHEMATICS, type PiSystemPlanets } from "@/lib/pi/data";
import {
  facilitiesOfPlanet,
  p0TypeIdsOfPlanet,
  PI_PLANET_TYPES,
  planetTypeName,
} from "@/lib/pi/planet-types";
import type { PiChainPlan, PiPlanetType, PiTier } from "@/lib/pi/types";

/** 单个星系的行星画像 */
export interface PiSystemProfile {
  system: PiSystemPlanets;
  /** 行星类型数量（按数量降序） */
  planetTypes: Array<{ typeId: number; name: string; count: number }>;
  planetTotal: number;
  /** 该星系能采集的 P0 typeId 并集 */
  harvestP0: number[];
  /** 该星系的行星能支持的加工设施档位 */
  facilities: string[];
  /** 选中产物里，这个星系可以加工的步骤 */
  process: string[];
  /** 仅凭设施能力，这个星系能生产的产物（按等级分组，不要求原料自给） */
  producible: Record<PiTier, string[]>;
  /** 可生产产物总数 */
  producibleCount: number;
}

/** 构建星系画像（结合所选产物，算出能加工哪些步骤） */
export function buildSystemProfile(
  system: PiSystemPlanets,
  plans: PiChainPlan[],
): PiSystemProfile {
  const planetTypes = Object.entries(system.planets)
    .map(([typeId, count]) => ({
      typeId: Number(typeId),
      name: planetTypeName(Number(typeId)),
      count,
    }))
    .filter((item) =>
      (PI_PLANET_TYPES as string[]).includes(item.name),
    )
    .sort((a, b) => b.count - a.count);

  const harvestSet = new Set<number>();
  const facilitySet = new Set<string>();

  for (const planet of planetTypes) {
    for (const p0 of p0TypeIdsOfPlanet(planet.name)) harvestSet.add(p0);
    for (const facility of facilitiesOfPlanet(planet.name)) {
      facilitySet.add(facility);
    }
  }

  const process: string[] = [];
  for (const plan of plans) {
    for (const step of plan.steps) {
      if (facilitySet.has(step.facility)) {
        process.push(`P${step.tier} ${step.name}`);
      }
    }
  }

  /** 设施到位就能生产的产物（不校验原料自给） */
  const producible: Record<PiTier, string[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const schematic of PI_SCHEMATICS) {
    if (facilitySet.has(schematic.facility)) {
      producible[schematic.tier].push(schematic.name);
    }
  }

  return {
    system,
    planetTypes,
    planetTotal: planetTypes.reduce((sum, item) => sum + item.count, 0),
    harvestP0: [...harvestSet],
    facilities: [...facilitySet],
    process: [...new Set(process)],
    producible,
    producibleCount:
      producible[1].length +
      producible[2].length +
      producible[3].length +
      producible[4].length,
  };
}

/** 多个星系合并后的能力统计（并集） */
export function aggregateProfiles(profiles: PiSystemProfile[]): {
  planets: number;
  p0Count: number;
  productCount: number;
  byTier: Array<{ tier: PiTier; count: number }>;
} {
  const p0 = new Set<number>();
  const byTier: Record<PiTier, Set<string>> = {
    1: new Set(),
    2: new Set(),
    3: new Set(),
    4: new Set(),
  };
  let planets = 0;

  for (const profile of profiles) {
    planets += profile.planetTotal;
    profile.harvestP0.forEach((typeId) => p0.add(typeId));
    ([1, 2, 3, 4] as PiTier[]).forEach((tier) => {
      profile.producible[tier].forEach((name) => byTier[tier].add(name));
    });
  }

  const productCount =
    byTier[1].size + byTier[2].size + byTier[3].size + byTier[4].size;

  return {
    planets,
    p0Count: p0.size,
    productCount,
    byTier: ([1, 2, 3, 4] as PiTier[]).map((tier) => ({
      tier,
      count: byTier[tier].size,
    })),
  };
}

/** 所选星系对 P0 需求的覆盖情况 */
export function p0Coverage(
  requiredP0: number[],
  profiles: PiSystemProfile[],
): { covered: Set<number>; missing: number[] } {
  const available = new Set<number>();
  for (const profile of profiles) {
    for (const typeId of profile.harvestP0) available.add(typeId);
  }

  const covered = new Set<number>();
  const missing: number[] = [];
  for (const typeId of requiredP0) {
    if (available.has(typeId)) covered.add(typeId);
    else missing.push(typeId);
  }

  return { covered, missing };
}

/** 星系安全等级配色档位 */
export function securityTone(security: number): "high" | "low" | "null" | "wormhole" {
  if (security >= 0.5) return "high";
  if (security > 0) return "low";
  if (security > -1) return "null";
  return "wormhole";
}

/** 行星类型显示顺序（按标准顺序） */
export function sortPlanetTypes<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      (PI_PLANET_TYPES as string[]).indexOf(a.name as PiPlanetType) -
      (PI_PLANET_TYPES as string[]).indexOf(b.name as PiPlanetType),
  );
}
