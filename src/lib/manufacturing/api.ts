import { invoke } from "@tauri-apps/api/core";

import { listBestPrices } from "@/lib/db";
import type { MfgPriceMap } from "@/lib/manufacturing/calc";

/** Rust 侧 BlueprintView（camelCase） */
export interface BlueprintFetchRow {
  itemId: number;
  typeId: number;
  locationId: number;
  locationFlag: string;
  quantity: number;
  materialEfficiency: number;
  timeEfficiency: number;
  runs: number;
}

/** Rust 侧 JobView（camelCase） */
export interface JobFetchRow {
  jobId: number;
  activityId: number;
  blueprintTypeId: number;
  productTypeId: number;
  facilityId: number;
  installerId: number | null;
  runs: number;
  licensedRuns: number | null;
  cost: number | null;
  probability: number | null;
  status: string;
  startDate: string;
  endDate: string;
}

export interface IndustrySystemCost {
  solarSystemId: number;
  manufacturing: number | null;
  reaction: number | null;
  fetchedAt: number;
}

export async function fetchCharacterBlueprints(
  characterId: number,
): Promise<BlueprintFetchRow[]> {
  return invoke<BlueprintFetchRow[]>("fetch_character_blueprints", {
    characterId,
  });
}

export async function fetchCharacterIndustryJobs(
  characterId: number,
): Promise<JobFetchRow[]> {
  return invoke<JobFetchRow[]>("fetch_character_industry_jobs", {
    characterId,
  });
}

export async function fetchCorporationIndustryJobs(
  corporationId: number,
  characterId: number,
): Promise<JobFetchRow[]> {
  return invoke<JobFetchRow[]>("fetch_corporation_industry_jobs", {
    corporationId,
    characterId,
  });
}

export async function fetchIndustrySystems(): Promise<IndustrySystemCost[]> {
  return invoke<IndustrySystemCost[]>("fetch_industry_systems");
}

/** 制造业相关技能等级：skillId → 等级 */
export async function fetchCharacterSkills(
  characterId: number,
): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("fetch_character_skills", {
    characterId,
  });
}

/** 角色可访问的制造建筑（工程复合体） */
export interface ManufacturingStructure {
  structureId: number;
  name: string;
  solarSystemId: number | null;
  solarSystemName: string | null;
  typeId: number;
  ownerId: number | null;
}

export async function fetchManufacturingStructures(
  characterId: number,
): Promise<ManufacturingStructure[]> {
  return invoke<ManufacturingStructure[]>("fetch_manufacturing_structures", {
    characterId,
  });
}

/* ============================================================
   价格：本地建筑行情优先，缺失时回退 ESI 全局参考价
   ============================================================ */

let adjustedCache: { at: number; data: Record<string, number> } | null = null;
const ADJUSTED_TTL = 10 * 60 * 1000;

async function loadAdjustedPrices(): Promise<Record<string, number>> {
  if (adjustedCache && Date.now() - adjustedCache.at < ADJUSTED_TTL) {
    return adjustedCache.data;
  }
  try {
    const data = await invoke<Record<string, number>>("fetch_market_prices");
    adjustedCache = { at: Date.now(), data };
    return data;
  } catch {
    return adjustedCache?.data ?? {};
  }
}

/** 批量取价：sell / buy 分别回退到 adjusted_price */
export async function loadPrices(typeIds: number[]): Promise<MfgPriceMap> {
  const unique = [...new Set(typeIds)];
  const [localRows, adjusted] = await Promise.all([
    listBestPrices(unique).catch(() => []),
    loadAdjustedPrices(),
  ]);

  const local = new Map(localRows.map((row) => [row.type_id, row]));

  const map: MfgPriceMap = new Map();
  for (const typeId of unique) {
    const row = local.get(typeId);
    const fallback = adjusted[String(typeId)] ?? null;
    map.set(typeId, {
      buy: row?.best_buy ?? fallback,
      sell: row?.best_sell ?? fallback,
    });
  }

  return map;
}
