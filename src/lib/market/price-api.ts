import { invoke } from "@tauri-apps/api/core";

/** Jita 所在星域：The Forge */
export const JITA_REGION_ID = 10000002;

/**
 * 批量获取某星域的最低卖价。
 *
 * 后端按 type_id 逐个请求并分批并发，单次最多 300 个物品。
 * 返回 `type_id → 最低卖价`，`null` 表示该物品在星域内没有卖单。
 *
 * 仅供界面展示，不参与任何计算。
 */
export async function fetchRegionBestSell(
  regionId: number,
  typeIds: number[],
): Promise<Record<string, number | null>> {
  return invoke<Record<string, number | null>>("fetch_region_best_sell", {
    regionId,
    typeIds,
  });
}
