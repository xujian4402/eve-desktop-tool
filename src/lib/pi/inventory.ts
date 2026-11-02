import { PI_P0, PI_SCHEMATICS_BY_TIER } from "@/lib/pi/data";
import type { PiPriceRow, PiTier } from "@/lib/pi/types";

/** 等级中文名（界面页签与统计统一使用） */
export const PI_TIER_LABEL: Record<0 | PiTier, string> = {
  0: "P0 原料",
  1: "P1 加工材料",
  2: "P2 精炼材料",
  3: "P3 特殊材料",
  4: "P4 高级材料",
};

export function piTierLabel(tier: 0 | PiTier): string {
  return PI_TIER_LABEL[tier];
}

export interface PiInventoryItem {
  typeId: number;
  name: string;
}

export interface PiInventoryGroup {
  tier: 0 | PiTier;
  label: string;
  /** P0 是买入项，P1~P4 是产出项 */
  role: "input" | "output";
  items: PiInventoryItem[];
}

/** 上半部分的分组：P0 原料 + P1~P4 产物 */
export const PI_INVENTORY_GROUPS: PiInventoryGroup[] = [
  {
    tier: 0,
    label: PI_TIER_LABEL[0],
    role: "input",
    items: PI_P0.map((item) => ({ typeId: item.typeId, name: item.name })),
  },
  ...PI_SCHEMATICS_BY_TIER.map((group) => ({
    tier: group.tier,
    label: PI_TIER_LABEL[group.tier],
    role: "output" as const,
    items: group.items.map((item) => ({
      typeId: item.outputTypeId,
      name: item.name,
    })),
  })),
];

/**
 * P4 高级材料在上半部分只做价格/数量展示：
 * 数量不参与库存估值、采购成本、合成抵扣等任何计算。
 */
export const PI_READONLY_TYPE_IDS: Set<number> = new Set(
  PI_INVENTORY_GROUPS.filter((group) => group.tier === 4).flatMap((group) =>
    group.items.map((item) => item.typeId),
  ),
);

export function isReadonlyItem(typeId: number): boolean {
  return PI_READONLY_TYPE_IDS.has(typeId);
}

/** 可选的行情市场（星域，均为主贸易枢纽） */
export const PI_MARKETS: Array<{ id: number; name: string }> = [
  { id: 10000002, name: "Jita · The Forge" },
  { id: 10000043, name: "Amarr · Domain" },
  { id: 10000032, name: "Dodixie · Sinq Laison" },
  { id: 10000030, name: "Rens · Heimatar" },
  { id: 10000042, name: "Hek · Metropolis" },
];

/** 把「字符串价格表」转成收益计算用的买卖价（P0 用卖单，其余用买单） */
export function toPriceRows(
  prices: Record<number, string>,
  isInput: (typeId: number) => boolean,
): Map<number, PiPriceRow> {
  const map = new Map<number, PiPriceRow>();
  for (const [key, value] of Object.entries(prices)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    const typeId = Number(key);
    const input = isInput(typeId);
    map.set(typeId, {
      typeId,
      sell: input ? numeric : null,
      buy: input ? null : numeric,
    });
  }
  return map;
}

/** 单品估值：库存数量 × 单价 */
export function itemValue(
  typeId: number,
  stock: Map<number, number>,
  prices: Record<number, string>,
): number {
  const quantity = stock.get(typeId) ?? 0;
  const price = Number(prices[typeId]);
  if (quantity <= 0 || !Number.isFinite(price) || price <= 0) return 0;
  return quantity * price;
}

/** 一组物品的库存估值（P4 只读，不计入） */
export function groupValue(
  group: PiInventoryGroup,
  stock: Map<number, number>,
  prices: Record<number, string>,
): number {
  return group.items.reduce(
    (sum, item) =>
      isReadonlyItem(item.typeId)
        ? sum
        : sum + itemValue(item.typeId, stock, prices),
    0,
  );
}

/** 全部物品的库存估值（P4 只读，不计入） */
export function totalValue(
  stock: Map<number, number>,
  prices: Record<number, string>,
): number {
  return PI_INVENTORY_GROUPS.reduce(
    (sum, group) => sum + groupValue(group, stock, prices),
    0,
  );
}

export interface PiValueSplit {
  /** 库存数量 × 单价 */
  stockValue: number;
  /** 市场（计划采购）数量 × 单价 */
  buyValue: number;
}

/** 按来源拆分价值：库存价值 vs 市场采购金额 */
export function valueBySource(
  items: PiInventoryItem[],
  stock: Map<number, number>,
  marketQty: Map<number, number>,
  prices: Record<number, string>,
): PiValueSplit {
  let stockValue = 0;
  let buyValue = 0;

  for (const item of items) {
    // P4 只做参考展示，数量不进任何金额统计
    if (isReadonlyItem(item.typeId)) continue;

    const price = Number(prices[item.typeId]);
    if (!Number.isFinite(price) || price <= 0) continue;

    stockValue += price * (stock.get(item.typeId) ?? 0);
    buyValue += price * (marketQty.get(item.typeId) ?? 0);
  }

  return { stockValue, buyValue };
}

/** 某个等级的价值拆分 */
export function groupValueBySource(
  group: PiInventoryGroup,
  stock: Map<number, number>,
  marketQty: Map<number, number>,
  prices: Record<number, string>,
): PiValueSplit {
  return valueBySource(group.items, stock, marketQty, prices);
}

/** 全部等级的价值拆分 */
export function totalValueBySource(
  stock: Map<number, number>,
  marketQty: Map<number, number>,
  prices: Record<number, string>,
): PiValueSplit {
  return valueBySource(
    PI_INVENTORY_GROUPS.flatMap((group) => group.items),
    stock,
    marketQty,
    prices,
  );
}

/** 库存 + 市场数量 = 本次可用的总数量（合成抵扣用） */
export function mergeQuantities(
  stock: Map<number, number>,
  marketQty: Map<number, number>,
): Map<number, number> {
  const merged = new Map(stock);
  for (const [typeId, quantity] of marketQty) {
    if (quantity <= 0) continue;
    merged.set(typeId, (merged.get(typeId) ?? 0) + quantity);
  }
  return merged;
}
