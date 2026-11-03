import { invoke } from "@tauri-apps/api/core";

/**
 * 角色的一个行星殖民地（对应 ESI /characters/{id}/planets/）。
 *
 * 需要授权作用域 esi-planets.manage_planets.v1。
 */
export interface PiColony {
  planetId: number;
  solarSystemId: number;
  /**
   * 行星类型代码（ESI 原文）：temperate / barren / oceanic / ice / gas / lava / storm / plasma
   */
  planetType: string | null;
  /** 殖民地等级 0~5 */
  upgradeLevel: number;
  /** 已放置的设施数量 */
  numPins: number;
  /** ISO 时间字符串 */
  lastUpdate: string;
}

/** 拉取某角色已建立的全部行星殖民地 */
export async function fetchCharacterColonies(
  characterId: number,
): Promise<PiColony[]> {
  return invoke<PiColony[]>("fetch_character_colonies", { characterId });
}

/** 殖民地里的一个设施 */
export interface PiColonyPin {
  pinId: number;
  typeId: number;
  contents: Array<{ typeId: number; amount: number }>;
  /** extractor 采集器 / factory 工厂 / storage 储存 / other 其它 */
  kind: "extractor" | "factory" | "storage" | "other";
  cycleTime: number | null;
  productTypeId: number | null;
  qtyPerCycle: number | null;
  schematicId: number | null;
  expiryTime: string | null;
  lastCycleStart: string | null;
}

/** 拉取某个行星殖民地的设施详情 */
export async function fetchColonyDetail(
  characterId: number,
  planetId: number,
): Promise<PiColonyPin[]> {
  return invoke<PiColonyPin[]>("fetch_colony_detail", {
    characterId,
    planetId,
  });
}

/** 殖民地等级 → 产能说明 */
export const COLONY_LEVEL_HINT: Record<number, string> = {
  0: "指挥中心 Lv0",
  1: "指挥中心 Lv1",
  2: "指挥中心 Lv2",
  3: "指挥中心 Lv3",
  4: "指挥中心 Lv4",
  5: "指挥中心 Lv5",
};
