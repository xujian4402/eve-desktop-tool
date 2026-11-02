import { useState } from "react";
import { RefreshCw, Package } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  groupValueBySource,
  PI_INVENTORY_GROUPS,
  PI_MARKETS,
  PI_READONLY_TYPE_IDS,
  piTierLabel,
  totalValueBySource,
} from "@/lib/pi/inventory";
import { cn } from "@/lib/utils";

function isk(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

/**
 * 上半部分：P0~P4 物资清单。
 *
 * 每种物品可以标记「市场」（按行情价买入并计入成本）或「库存」（用 ESI 读到的数量抵扣），
 * 并显示单价、库存数量与该等级/全部的库存估值。
 */
export function PiInventoryPanel({
  prices,
  stock,
  stockDraft,
  marketQty,
  marketDraft,
  market,
  characters,
  characterValue,
  onCharacterChange,
  onMarketChange,
  onPriceChange,
  onStockChange,
  onMarketQtyChange,
  onClearStock,
  onClearAllStock,
  onBulkFill,
  onRefreshPrices,
  onFetchStock,
  fetchingPrices,
  fetchingStock,
  priceMessage,
  stockMessage,
}: {
  prices: Record<number, string>;
  /** 库存里已有的数量 */
  stock: Map<number, number>;
  /** 库存输入框的草稿值（保留用户正在输入的内容） */
  stockDraft: Record<number, string>;
  /** 计划从市场买入的数量（与库存数量互不影响） */
  marketQty: Map<number, number>;
  /** 市场数量输入框的草稿值 */
  marketDraft: Record<number, string>;
  market: number;
  /** 可读取库存的角色 */
  characters: Array<{ id: number; name: string }>;
  /** "all" 表示全部角色，否则是角色 ID 字符串 */
  characterValue: string;
  onCharacterChange: (value: string) => void;
  onMarketChange: (marketId: number) => void;
  onPriceChange: (typeId: number, value: string) => void;
  onStockChange: (typeId: number, raw: string) => void;
  onMarketQtyChange: (typeId: number, raw: string) => void;
  /** 清除当前等级的全部库存数量 */
  onClearStock: (typeIds: number[]) => void;
  /** 清除所有等级的库存与市场数量 */
  onClearAllStock: () => void;
  /** 把当前等级的全部物品的市场数量设为同一个值 */
  onBulkFill: (typeIds: number[], quantity: number) => void;
  onRefreshPrices: () => void;
  onFetchStock: () => void;
  fetchingPrices: boolean;
  fetchingStock: boolean;
  priceMessage: string | null;
  stockMessage: string | null;
}) {
  const [tier, setTier] = useState<string>("0");
  /** 一键录入用的数量（只作用于当前等级） */
  const [bulkQuantity, setBulkQuantity] = useState("");
  const current =
    PI_INVENTORY_GROUPS.find((group) => String(group.tier) === tier) ??
    PI_INVENTORY_GROUPS[0];
  /** P4 为只读参考页签：不能改数量，也不参与统计 */
  const currentReadonly = current.tier === 4;

  return (
    // 高度随内容自适应（不参与 flex-1 平分），下方合成结果占剩余空间
    <div className="flex shrink-0 flex-col gap-2">
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

        {(() => {
          const split = totalValueBySource(stock, marketQty, prices);
          return (
            <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              <span>
                库存价值{" "}
                <b className="font-mono tabular-nums text-emerald-300/90">
                  {isk(split.stockValue)}
                </b>
              </span>
              <span>
                市场采购{" "}
                <b className="font-mono tabular-nums text-amber-300/90">
                  {isk(split.buyValue)}
                </b>
              </span>
              <span className="text-muted-foreground/60">ISK</span>
            </span>
          );
        })()}

        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80">
          {priceMessage ?? stockMessage ?? ""}
        </span>
      </div>

      <Tabs value={tier} onValueChange={setTier} className="min-h-0">
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
            disabled={currentReadonly}
            title="清空本级所有物品的库存与市场数量"
            onClick={() => onClearStock(current.items.map((item) => item.typeId))}
          >
            清除本级数量
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={onClearAllStock}
          >
            全部清除
          </Button>

          <Input
            value={bulkQuantity}
            onChange={(event) => setBulkQuantity(event.target.value)}
            inputMode="numeric"
            placeholder="数量"
            className="h-7 w-20 text-right text-[11px]"
            title="一键录入的市场数量"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={currentReadonly || !Number(bulkQuantity)}
            title={
              currentReadonly
                ? "P4 为只读参考，不参与计算"
                : "把当前等级所有物品的市场数量设为这个值"
            }
            onClick={() => {
              onBulkFill(
                current.items.map((item) => item.typeId),
                Number(bulkQuantity),
              );
              setBulkQuantity("");
            }}
          >
            一键录入
          </Button>
        </div>

        {PI_INVENTORY_GROUPS.map((group) => (
        <TabsContent
          key={group.tier}
          value={String(group.tier)}
          forceMount
          className="mt-2 data-[state=inactive]:hidden"
        >
          {/* 卡片按容器宽度自适应列数（最小 200px，自动折行），高度随内容，过高才滚动 */}
          <div className="max-h-[40vh] overflow-auto">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5 p-0.5">
              {group.items.map((item) => {
                const stockQty = stock.get(item.typeId) ?? 0;
                const planQty = marketQty.get(item.typeId) ?? 0;
                const unit = Number(prices[item.typeId]);
                const readonly = PI_READONLY_TYPE_IDS.has(item.typeId);

                return (
                  <div
                    key={item.typeId}
                    className={cn(
                      "flex flex-col gap-1 rounded-md border border-border/70 bg-card/30 px-2 py-1.5",
                      readonly && "bg-card/10",
                    )}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex min-w-0 flex-1 items-baseline gap-1">
                        <span
                          className="min-w-0 truncate text-[11px] text-foreground/90"
                          title={item.name}
                        >
                          {item.name}
                        </span>
                        <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">
                          {item.typeId}
                        </span>
                      </div>

                      {readonly && (
                        <span
                          className="shrink-0 rounded border border-border/60 px-1 py-px text-[10px] leading-tight text-muted-foreground/70"
                          title="P4 只做价格与数量展示，不参与任何计算"
                        >
                          只读
                        </span>
                      )}
                    </div>

                    {readonly ? (
                      <>
                        <div className="flex items-center gap-1">
                          <span className="shrink-0 text-[9px] leading-none text-muted-foreground/70">
                            单价(ISK)
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate rounded border border-border/50 bg-muted/20 px-1 py-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground/90"
                            title="单价（只读）"
                          >
                            {Number.isFinite(unit) && unit > 0
                              ? unit.toLocaleString("zh-CN", {
                                  maximumFractionDigits: 2,
                                })
                              : "—"}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="shrink-0 text-[9px] leading-none text-muted-foreground/70">
                            库存数量
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate rounded border border-border/50 bg-muted/20 px-1 py-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground/90"
                            title="库存数量（只读）"
                          >
                            {stockQty > 0
                              ? stockQty.toLocaleString("zh-CN")
                              : "—"}
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <label className="flex items-center gap-1">
                          <span className="shrink-0 text-[9px] leading-none text-muted-foreground/70">
                            单价(ISK)
                          </span>
                          <Input
                            value={prices[item.typeId] ?? ""}
                            onChange={(event) =>
                              onPriceChange(item.typeId, event.target.value)
                            }
                            inputMode="decimal"
                            title="市场单价"
                            className="h-6 min-w-0 flex-1 px-1 text-right text-[11px]"
                          />
                        </label>
                        <div className="flex items-end gap-1">
                          <label className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-[9px] leading-none text-amber-300/70">
                              市场数量
                            </span>
                            <Input
                              value={
                                marketDraft[item.typeId] ??
                                (planQty > 0 ? String(planQty) : "")
                              }
                              onChange={(event) =>
                                onMarketQtyChange(
                                  item.typeId,
                                  event.target.value,
                                )
                              }
                              inputMode="numeric"
                              title="计划从市场买入的数量（按单价计入采购成本）"
                              className="h-6 min-w-0 px-1 text-right text-[11px] text-amber-300/90"
                            />
                          </label>
                          <label className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-[9px] leading-none text-emerald-300/70">
                              库存数量
                            </span>
                            <Input
                              value={
                                stockDraft[item.typeId] ??
                                (stockQty > 0 ? String(stockQty) : "")
                              }
                              onChange={(event) =>
                                onStockChange(item.typeId, event.target.value)
                              }
                              inputMode="numeric"
                              title="库存里已有的数量（优先抵扣，不计成本）"
                              className="h-6 min-w-0 px-1 text-right text-[11px] text-emerald-300/90"
                            />
                          </label>
                        </div>
                      </>
                    )}

                  </div>
                );
              })}
            </div>
          </div>

          {group.tier === 4 ? (
            <p className="mt-1 flex shrink-0 flex-wrap items-center justify-end gap-x-3 text-[11px] text-muted-foreground/70">
              <span>
                P4 高级材料只做价格与数量参考，不计入库存价值、采购成本与收益
              </span>
              <span className="text-muted-foreground/50">
                共 {group.items.length} 项
              </span>
            </p>
          ) : (
            (() => {
              const split = groupValueBySource(
                group,
                stock,
                marketQty,
                prices,
              );
              return (
                <p className="mt-1 flex shrink-0 flex-wrap items-center justify-end gap-x-3 text-[11px] text-muted-foreground/80">
                  <span>
                    {group.label} 库存价值{" "}
                    <b className="font-mono tabular-nums text-emerald-300/90">
                      {isk(split.stockValue)}
                    </b>
                  </span>
                  <span>
                    市场采购{" "}
                    <b className="font-mono tabular-nums text-amber-300/90">
                      {isk(split.buyValue)}
                    </b>
                  </span>
                  <span className="text-muted-foreground/60">
                    ISK · 共 {group.items.length} 项
                  </span>
                </p>
              );
            })()
          )}
        </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
