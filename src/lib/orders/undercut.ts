import type { CharacterOrderView, OrderMarketPrice } from "@/lib/db";

/** 按 `建筑:物品` 索引最优报价 */
export function indexPrices(
  prices: OrderMarketPrice[],
): Record<string, OrderMarketPrice> {
  const indexed: Record<string, OrderMarketPrice> = {};
  for (const price of prices) {
    indexed[`${price.structure_id}:${price.type_id}`] = price;
  }
  return indexed;
}

/** 被竞争对手压价的订单：买单低于同建筑最高买价，或卖单高于同建筑最低卖价 */
export function findUndercutOrders(
  orders: CharacterOrderView[],
  prices: Record<string, OrderMarketPrice>,
): CharacterOrderView[] {
  return orders.filter((order) => {
    const info = prices[`${order.location_id}:${order.type_id}`];
    if (!info) return false;

    if (order.is_buy_order) {
      return info.best_buy !== null && order.price < info.best_buy;
    }
    return info.best_sell !== null && order.price > info.best_sell;
  });
}

/** 用 Web Audio 生成两声提示音，不依赖外部音频文件 */
export function playAlertSound(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    const now = ctx.currentTime;

    [880, 640].forEach((freq, index) => {
      const start = now + index * 0.24;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    });

    setTimeout(() => void ctx.close(), 900);
  } catch {
    // 浏览器限制自动播放时忽略，不影响文字提示
  }
}
