import { useState } from "react";
import { RefreshCw, Package } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  groupValue,
  PI_INVENTORY_GROUPS,
  PI_MARKETS,
  piTierLabel,
  totalValue,
  type PiStockSource,
} from "@/lib/pi/inventory";
import { cn } from "@/lib/utils";

function isk(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

/**
 * 上半部分：P0~P4 物资清单。
 *
 * 每种物品可以标记「购买」（按行情价计入成本）或「库存」（用 ESI 读到的数量抵扣），
 * 并显示单价、库存数量与该等级/全部的库存估值。
 */
export function PiInventoryPanel({
  prices,
  stock,
  stockDraft,
  source,
  market,
  characters,
  characterValue,
  onCharacterChange,
  onMarketChange,
  onPriceChange,
  onStockChange,
  onSourceChange,
  onClearStock,
  onClearAllStock,
  onRefreshPrices,
  onFetchStock,
  fetchingPrices,
  fetchingStock,
  priceMessage,
  stockMessage,
}: {
  prices: Record<number, string>;
  stock: Map<number, number>;
  /** 库存输入框的草稿值（保留用户正在输入的内容） */
  stockDraft: Record<number, string>;
  source: Record<number, PiStockSource>;
  market: number;
  /** 可读取库存的角色 */
  characters: Array<{ id: number; name: string }>;
  /** "all" 表示全部角色，否则是角色 ID 字符串 */
  characterValue: string;
  onCharacterChange: (value: string) => void;
  onMarketChange: (marketId: number) => void;
  onPriceChange: (typeId: number, value: string) => void;
  onStockChange: (typeId: number, raw: string) => void;
  onSourceChange: (typeId: number, value: PiStockSource) => void;
  /** 清除当前等级的全部库存数量 */
  onClearStock: (typeIds: number[]) => void;
  /** 清除所有等级的库存数量 */
  onClearAllStock: () => void;
  onRefreshPrices: () => void;
  onFetchStock: () => void;
  fetchingPrices: boolean;
  fetchingStock: boolean;
  priceMessage: string | null;
  stockMessage: string | null;
}) {
  const [tier, setTier] = useState<string>("0");
  const current =
    PI_INVENTORY_GROUPS.find((group) => String(group.tier) === tier) ??
    PI_INVENTORY_GROUPS[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          value={market}
          onChange={(event) => onMarketChange(Number(event.target.value))}
        >
          {PI_MARKETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>

        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={fetchingPrices}
          onClick={onRefreshPrices}
        >
          <RefreshCw className={fetchingPrices ? "animate-spin" : undefined} />
          {fetchingPrices ? "刷新中…" : "刷新行情"}
        </Button>

        <select
          className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          value={characterValue}
          onChange={(event) => onCharacterChange(event.target.value)}
          title="读取哪个角色的库存"
        >
          <option value="all">全部角色</option>
          {characters.map((character) => (
            <option key={character.id} value={String(character.id)}>
              {character.name}
            </option>
          ))}
        </select>

        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={fetchingStock}
          onClick={onFetchStock}
        >
          <Package className={fetchingStock ? "animate-pulse" : undefined} />
          {fetchingStock ? "读取中…" : "从 ESI 获取库存"}
        </Button>

        <span className="text-xs text-muted-foreground">
          库存估值{" "}
          <b className="font-mono tabular-nums text-emerald-300/90">
            {isk(totalValue(stock, prices))}
          </b>{" "}
          ISK
        </span>

        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80">
          {priceMessage ?? stockMessage ?? ""}
        </span>
      </div>

      <Tabs
        value={tier}
        onValueChange={setTier}
        className="min-h-0 flex-1"
      >
        <div className="flex shrink-0 items-center gap-2">
          <TabsList className="shrink-0">
            {PI_INVENTORY_GROUPS.map((group) => (
              <TabsTrigger key={group.tier} value={String(group.tier)}>
                {piTierLabel(group.tier)}
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {group.items.length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={() => onClearStock(current.items.map((item) => item.typeId))}
          >
            清除本级库存
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={onClearAllStock}
          >
            全部清除
          </Button>
        </div>

        {PI_INVENTORY_GROUPS.map((group) => (
        <TabsContent
          key={group.tier}
          value={String(group.tier)}
          className="mt-2 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          {/* 卡片按容器宽度自适应列数（最小 240px，自动折行） */}
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5 p-0.5">
              {group.items.map((item) => {
                const stockQty = stock.get(item.typeId) ?? 0;
                const unit = Number(prices[item.typeId]);
                const value =
                  stockQty > 0 && Number.isFinite(unit) && unit > 0
                    ? stockQty * unit
                    : 0;
                const mode = source[item.typeId] ?? "buy";

                return (
                  <div
                    key={item.typeId}
                    className="flex flex-col gap-1 rounded-md border border-border/70 bg-card/30 px-2 py-1.5"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span
                        className="min-w-0 flex-1 truncate text-[11px] text-foreground/90"
                        title={item.name}
                      >
                        {item.name}
                      </span>

                      <div className="inline-flex shrink-0 overflow-hidden rounded border border-border">
                        <button
                          type="button"
                          onClick={() => onSourceChange(item.typeId, "buy")}
                          className={cn(
                            "px-1 py-px text-[10px] leading-tight transition-colors",
                            mode === "buy"
                              ? "bg-amber-500/20 text-amber-300"
                              : "text-muted-foreground hover:bg-muted/60",
                          )}
                        >
                          购买
                        </button>
                        <button
                          type="button"
                          onClick={() => onSourceChange(item.typeId, "stock")}
                          className={cn(
                            "border-l border-border px-1 py-px text-[10px] leading-tight transition-colors",
                            mode === "stock"
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "text-muted-foreground hover:bg-muted/60",
                          )}
                        >
                          库存
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <Input
                        value={prices[item.typeId] ?? ""}
                        onChange={(event) =>
                          onPriceChange(item.typeId, event.target.value)
                        }
                        inputMode="decimal"
                        placeholder="单价"
                        className="h-6 min-w-0 flex-1 px-1 text-right text-[11px]"
                      />
                      <Input
                        value={
                          stockDraft[item.typeId] ??
                          (stockQty > 0 ? String(stockQty) : "")
                        }
                        onChange={(event) =>
                          onStockChange(item.typeId, event.target.value)
                        }
                        inputMode="numeric"
                        placeholder="库存"
                        className="h-6 min-w-0 flex-1 px-1 text-right text-[11px]"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-1 text-[10px]">
                      <span className="font-mono text-muted-foreground/50">
                        {item.typeId}
                      </span>
                      <span className="truncate font-mono tabular-nums text-muted-foreground">
                        {value > 0 ? `${isk(value)} ISK` : "—"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="mt-1 shrink-0 text-right text-[11px] text-muted-foreground/80">
            {group.label} 估值{" "}
            <b className="font-mono tabular-nums text-foreground/80">
              {isk(groupValue(group, stock, prices))}
            </b>{" "}
            ISK · 共 {group.items.length} 项
          </p>
        </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
