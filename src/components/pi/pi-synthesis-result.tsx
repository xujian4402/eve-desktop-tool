import { useMemo, useState } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PI_PRODUCTS } from "@/lib/pi/data";
import {
  estimateCap,
  estimateTierProducts,
  type PiProductCost,
} from "@/lib/pi/estimate";
import { piTierLabel, type PiStockSource } from "@/lib/pi/inventory";
import type { PiPriceRow, PiTier } from "@/lib/pi/types";
import { cn } from "@/lib/utils";

function isk(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

const TIERS: PiTier[] = [4, 3, 2, 1];

/**
 * 排序：读过库存后按「库存可合成」降序排在最前（能立刻做的先看到），
 * 同数量再按 1 小时利润降序；未读库存时保持利润率排序。
 */
function orderByCap(
  items: PiProductCost[],
  caps: Map<number, number>,
  hasStock: boolean,
): PiProductCost[] {
  if (!hasStock) return items;

  return [...items].sort((a, b) => {
    const capDiff = (caps.get(b.typeId) ?? 0) - (caps.get(a.typeId) ?? 0);
    if (capDiff !== 0) return capDiff;
    return (b.profit ?? Number.NEGATIVE_INFINITY) - (a.profit ?? Number.NEGATIVE_INFINITY);
  });
}

/**
 * 下半部分：合成结果（P1~P4 全量，按等级分页签）。
 *
 * 口径：1 条产线满负荷 1 小时；标「库存」的原料优先抵扣且不计成本，
 * 标「购买」的原料按行情价买入；产物按最高买单卖出。
 * 另给出「库存最多还能合成多少个」，只统计标为库存的物资。
 */
export function PiSynthesisResult({
  priceRows,
  stock,
  source,
}: {
  priceRows: Map<number, PiPriceRow>;
  stock: Map<number, number>;
  source: Record<number, PiStockSource>;
}) {
  const [tier, setTier] = useState<string>("4");

  /** 只把标为「库存」的数量算进可合成上限 */
  const stockForSynthesis = useMemo(() => {
    const map = new Map<number, number>();
    for (const [typeId, quantity] of stock) {
      if ((source[typeId] ?? "buy") === "stock") map.set(typeId, quantity);
    }
    return map;
  }, [stock, source]);

  const hasStock = stock.size > 0;

  const rows = useMemo(
    () =>
      TIERS.map((item) => ({
        tier: item,
        items: estimateTierProducts(item, priceRows, stock, source),
      })),
    [priceRows, stock, source],
  );

  /** 库存可合成数（依赖库存而非价格，单独计算） */
  const caps = useMemo(() => {
    const map = new Map<number, number>();
    if (stockForSynthesis.size === 0) return map;
    for (const product of PI_PRODUCTS) {
      map.set(product.typeId, estimateCap(product.typeId, stockForSynthesis));
    }
    return map;
  }, [stockForSynthesis]);

  const current = rows.find((group) => String(group.tier) === tier) ?? rows[0];

  if (current.items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>没有可估算的产物</EmptyTitle>
          <EmptyDescription>
            请先运行 node scripts/build-pi-sde.mjs 生成配方数据。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const profitable = current.items.filter((item) => (item.profit ?? 0) > 0);
  const totalProfit = current.items.reduce(
    (sum, item) => sum + (item.profit ?? 0),
    0,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          {piTierLabel(current.tier)} 共 {current.items.length} 项
        </span>
        <span>
          盈利{" "}
          <b className="font-mono tabular-nums text-emerald-400/90">
            {profitable.length}
          </b>{" "}
          项
        </span>
        <span>
          合计利润{" "}
          <b
            className={cn(
              "font-mono tabular-nums",
              totalProfit >= 0 ? "text-emerald-400/90" : "text-rose-400/90",
            )}
          >
            {isk(totalProfit)}
          </b>{" "}
          ISK/小时
        </span>
        <span className="text-[11px] text-muted-foreground/70">
          口径：1 条产线 1 小时；库存项已抵扣且不计成本
          {hasStock ? "" : "（未读取库存）"}
        </span>
      </div>

      <Tabs
        value={tier}
        onValueChange={setTier}
        className="min-h-0 flex-1"
      >
        <TabsList className="shrink-0">
          {TIERS.map((item) => (
            <TabsTrigger key={item} value={String(item)}>
              {piTierLabel(item)}
            </TabsTrigger>
          ))}
        </TabsList>

        {rows.map((group) => (
          <TabsContent
            key={group.tier}
            value={String(group.tier)}
            className="mt-2 flex min-h-0 flex-col data-[state=inactive]:hidden"
          >
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border [&>[data-slot=table-container]]:overflow-visible">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>产物</TableHead>
                    {hasStock && (
                      <TableHead className="text-right">库存可合成</TableHead>
                    )}
                    <TableHead className="text-right">1h 产出</TableHead>
                    <TableHead className="text-right">需购买</TableHead>
                    <TableHead className="text-right">成本</TableHead>
                    <TableHead className="text-right">收入</TableHead>
                    <TableHead className="text-right">利润</TableHead>
                    <TableHead className="text-right">利润率</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orderByCap(group.items, caps, hasStock).map((item) => (
                    <TableRow key={item.typeId}>
                      <TableCell>
                        <span className="block">{item.name}</span>
                        <span className="block font-mono text-[10px] text-muted-foreground/60">
                          {item.typeId}
                        </span>
                      </TableCell>
                      {hasStock && (
                        <TableCell className="text-right tabular-nums">
                          {caps.get(item.typeId) ?? 0}
                        </TableCell>
                      )}
                      <TableCell className="text-right tabular-nums">
                        {item.outputQty.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {Math.ceil(item.buyCount).toLocaleString()}
                        {item.stockCount > 0 && (
                          <span className="block text-[10px] text-emerald-400/80">
                            库存 {Math.floor(item.stockCount).toLocaleString()}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {item.cost === null ? "缺价" : isk(item.cost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {item.revenue === null ? "缺价" : isk(item.revenue)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          item.profit === null
                            ? "text-muted-foreground/60"
                            : item.profit >= 0
                              ? "text-emerald-400"
                              : "text-rose-400",
                        )}
                      >
                        {item.profit === null ? "—" : isk(item.profit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {item.margin === null
                          ? "—"
                          : `${(item.margin * 100).toFixed(1)}%`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

