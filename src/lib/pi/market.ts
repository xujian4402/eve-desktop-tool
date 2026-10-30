import { invoke } from "@tauri-apps/api/core";

/**
 * Jita 行情拉取（用于「配方与收益」一键填价）。
 *
 * 复用 Rust 侧 `fetch_region_type_orders`（公开接口，不需要角色授权）：
 * 只按 type_id 拉取，逐个物品计算最优买价 / 卖价。
 */

/** The Forge（Jita 所在星域） */
export const JITA_REGION_ID = 10000002;

/** Rust 侧 RegionOrder 的前端视图（只保留计算需要的字段） */
interface RegionOrder {
  orderId: number;
  isBuyOrder: boolean;
  price: number;
  volumeRemain: number;
}

export interface BestPrice {
  typeId: number;
  /** 最高买单价（有人挂单买入 → 立刻能卖出的价格） */
  buy: number | null;
  /** 最低卖单价（立刻能买到的价格） */
  sell: number | null;
}

/** 拉取单个物品在 Jita 的最优买卖价 */
export async function fetchBestPrice(typeId: number): Promise<BestPrice> {
  const orders = await invoke<RegionOrder[]>("fetch_region_type_orders", {
    regionId: JITA_REGION_ID,
    typeId,
  });

  let buy: number | null = null;
  let sell: number | null = null;

  for (const order of orders) {
    if (order.volumeRemain <= 0) continue;
    if (order.isBuyOrder) {
      if (buy === null || order.price > buy) buy = order.price;
    } else if (sell === null || order.price < sell) {
      sell = order.price;
    }
  }

  return { typeId, buy, sell };
}

export interface FetchPricesOptions {
  /** 并发数，默认 3（ESI 有速率限制，太高容易 420/429） */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface FetchPricesResult {
  prices: Map<number, BestPrice>;
  /** 拉取失败的 type_id（限流、超时等） */
  failed: number[];
  cancelled: boolean;
}

/**
 * 并发拉取多个物品的 Jita 最优价。
 *
 * 单个物品失败不影响其它物品；返回的 failed 用于界面提示。
 */
export async function fetchBestPrices(
  typeIds: number[],
  options: FetchPricesOptions = {},
): Promise<FetchPricesResult> {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const prices = new Map<number, BestPrice>();
  const failed: number[] = [];

  let cursor = 0;
  let done = 0;
  let cancelled = false;

  const worker = async () => {
    while (cursor < typeIds.length) {
      if (options.isCancelled?.()) {
        cancelled = true;
        return;
      }

      const typeId = typeIds[cursor];
      cursor += 1;

      try {
        prices.set(typeId, await fetchBestPrice(typeId));
      } catch {
        failed.push(typeId);
      }

      done += 1;
      options.onProgress?.(done, typeIds.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, typeIds.length) }, () => worker()),
  );

  return { prices, failed, cancelled };
}
