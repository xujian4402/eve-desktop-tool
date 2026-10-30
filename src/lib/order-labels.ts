/**
 * EVE 订单与同步状态的中文对照表。
 *
 * 这些值直接来自 ESI 或本地表字段，集中在这里避免各页面各写一份。
 */

/** 订单范围（ESI order.range） */
export const ORDER_RANGE_LABEL: Record<string, string> = {
  station: "本空间站",
  solar_system: "本星系",
  region: "本星域",
};

/**
 * 把 ESI 的 order.range 转成中文。
 * 纯数字表示以挂单点为中心的跳跃数，如 "20" → "20 跳"。
 */
export function formatOrderRange(range: string): string {
  const known = ORDER_RANGE_LABEL[range];
  if (known) return known;

  if (/^\d+$/.test(range)) return `${range} 跳`;

  return range || "—";
}

/** 建筑订单的同步状态（market_structure.last_sync_status） */
export const SYNC_STATUS_LABEL: Record<string, string> = {
  ok: "同步成功",
  running: "同步中",
  error: "同步失败",
};

/** 同步状态中文名，未知状态回退为「尚未同步」 */
export function formatSyncStatus(status: string | null): string {
  if (!status) return "尚未同步";
  return SYNC_STATUS_LABEL[status] ?? "尚未同步";
}

/** 订单方向 */
export const ORDER_SIDE_LABEL = {
  sell: "卖单",
  buy: "买单",
} as const;

/** 挂单归属 */
export const ORDER_OWNER_LABEL = {
  personal: "个人",
  corporation: "军团",
} as const;
