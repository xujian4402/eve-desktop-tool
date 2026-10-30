import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

import {
  getCharacterOrderStats,
  listCharacterOrders,
  listMyOrderMarketPrices,
  saveCharacterOrders,
  type CharacterOrderStats,
  type CharacterOrderView,
  type EveCharacter,
  type OrderMarketPrice,
  type OrdersPayload,
} from "@/lib/db";
import { describeError } from "@/hooks/useCharacters";
import { formatOrderRange } from "@/lib/order-labels";

/** 判断自己的挂单在同建筑里的价格位置 */
function competitionLabel(
  order: CharacterOrderView,
  info: OrderMarketPrice | undefined,
): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!info) return { text: "—", tone: "muted" };

  if (order.is_buy_order) {
    if (info.best_buy === null) return { text: "—", tone: "muted" };
    if (order.price >= info.best_buy) return { text: "最高", tone: "ok" };
    return {
      text: `低 ${(info.best_buy - order.price).toLocaleString("zh-CN", {
        maximumFractionDigits: 2,
      })}`,
      tone: "warn",
    };
  }

  if (info.best_sell === null) return { text: "—", tone: "muted" };
  if (order.price <= info.best_sell) return { text: "最低", tone: "ok" };
  return {
    text: `高 ${(order.price - info.best_sell).toLocaleString("zh-CN", {
      maximumFractionDigits: 2,
    })}`,
    tone: "warn",
  };
}

function formatIskShort(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

export default function CharacterOrdersPanel({
  characters,
  activeCharacterId,
  onOpenType,
}: {
  characters: EveCharacter[];
  activeCharacterId: number | null;
  /** 点击物品时跳到交易市场查看价格 */
  onOpenType?: (typeId: number) => void;
}) {
  const [ordersMap, setOrdersMap] = useState<
    Record<number, CharacterOrderView[]>
  >({});
  const [statsMap, setStatsMap] = useState<
    Record<number, CharacterOrderStats>
  >({});
  /** 角色 ID → (建筑:物品 → 市场最优价) */
  const [priceMap, setPriceMap] = useState<
    Record<number, Record<string, OrderMarketPrice>>
  >({});

  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 当前查看的角色 tab */
  const [activeTab, setActiveTab] = useState<string>("");

  const characterIds = characters.map((item) => item.character_id).join(",");

  // 默认停在当前角色；角色列表变化时校正
  useEffect(() => {
    if (characters.length === 0) return;
    if (characters.some((item) => String(item.character_id) === activeTab)) {
      return;
    }
    setActiveTab(
      String(activeCharacterId ?? characters[0].character_id),
    );
  }, [characters, activeCharacterId, activeTab]);

  const loadAll = useCallback(async () => {
    const entries = await Promise.all(
      characters.map(async (item) => {
        const id = item.character_id;
        const [orders, stats, prices] = await Promise.all([
          listCharacterOrders(id),
          getCharacterOrderStats(id),
          listMyOrderMarketPrices(id),
        ]);

        const indexed: Record<string, OrderMarketPrice> = {};
        for (const price of prices) {
          indexed[`${price.structure_id}:${price.type_id}`] = price;
        }

        return [{ id, orders, stats, indexed }] as const;
      }),
    );

    const orders: Record<number, CharacterOrderView[]> = {};
    const stats: Record<number, CharacterOrderStats> = {};
    const prices: Record<number, Record<string, OrderMarketPrice>> = {};

    for (const [entry] of entries) {
      orders[entry.id] = entry.orders;
      stats[entry.id] = entry.stats;
      prices[entry.id] = entry.indexed;
    }

    setOrdersMap(orders);
    setStatsMap(stats);
    setPriceMap(prices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterIds]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const syncOne = async (characterId: number): Promise<number> => {
    const payload = await invoke<OrdersPayload>("sync_character_orders", {
      characterId,
    });
    await saveCharacterOrders(characterId, payload.orders, payload.fetchedAt);
    return payload.orders.length;
  };

  const handleSync = async (characterId: number) => {
    setSyncingId(characterId);
    setError(null);
    try {
      const count = await syncOne(characterId);
      await loadAll();
      toast.success(`已同步 ${count.toLocaleString()} 条订单`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSyncingId(null);
    }
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    setError(null);

    let succeeded = 0;
    for (const character of characters) {
      setSyncingId(character.character_id);
      try {
        await syncOne(character.character_id);
        succeeded += 1;
      } catch (err) {
        setError(`${character.name}：${describeError(err)}`);
      }
    }

    setSyncingId(null);
    setSyncingAll(false);
    await loadAll();
    toast.success(`同步完成：成功 ${succeeded} / ${characters.length}`);
  };

  if (characters.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>需要先授权角色</EmptyTitle>
          <EmptyDescription>
            在「角色」标签页添加 EVE 角色后即可同步并查看挂单。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={setActiveTab}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <TabsList className="gap-1.5">
          {characters.map((character) => {
            const count = ordersMap[character.character_id]?.length ?? 0;
            const isActive = character.character_id === activeCharacterId;

            return (
              <TabsTrigger
                key={character.character_id}
                value={String(character.character_id)}
              >
                {character.name}
                {isActive && (
                  <span className="ml-1 text-[10px] text-cyan-400">当前</span>
                )}
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                  {count}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={syncingAll}
          onClick={() => void handleSyncAll()}
        >
          <RefreshCw className={syncingAll ? "animate-spin" : undefined} />
          {syncingAll ? "同步中…" : "同步全部角色"}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>同步失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {characters.map((character) => {
        const orders = ordersMap[character.character_id] ?? [];
        const stats = statsMap[character.character_id];
        const prices = priceMap[character.character_id] ?? {};
        const busy = syncingId === character.character_id;

        const expiring = orders.filter((order) => {
          const expiresAt = order.issued_at + order.duration * 86_400_000;
          return expiresAt - Date.now() < 3 * 86_400_000;
        }).length;

        return (
          <TabsContent
            key={character.character_id}
            value={String(character.character_id)}
            className="mt-0"
          >
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {orders.length} 笔挂单
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  disabled={busy || syncingAll}
                  onClick={() => void handleSync(character.character_id)}
                >
                  {busy ? "同步中…" : "同步该角色"}
                </Button>
              </div>

              {stats && stats.order_count > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                  <span>
                    卖单价值{" "}
                    <b className="font-mono text-amber-300/90">
                      {formatIskShort(stats.sell_value)}
                    </b>
                  </span>
                  <span>
                    买单价值{" "}
                    <b className="font-mono text-emerald-300/90">
                      {formatIskShort(stats.buy_value)}
                    </b>
                  </span>
                  <span>
                    托管{" "}
                    <b className="font-mono text-foreground/80">
                      {formatIskShort(stats.escrow_total)}
                    </b>
                  </span>
                  <span>
                    3 天内到期{" "}
                    <b
                      className={
                        expiring > 0
                          ? "font-mono text-amber-400"
                          : "font-mono text-foreground/80"
                      }
                    >
                      {expiring}
                    </b>
                  </span>
                </div>
              )}

              {orders.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  暂无订单，点右上角「同步该角色」拉取挂单。
                </p>
              ) : (
                <div className="max-h-96 overflow-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>物品</TableHead>
                        <TableHead>方向</TableHead>
                        <TableHead>单价 (ISK)</TableHead>
                        <TableHead>市场</TableHead>
                        <TableHead>剩余 / 总量</TableHead>
                        <TableHead>最小量</TableHead>
                        <TableHead>托管 (ISK)</TableHead>
                        <TableHead>范围</TableHead>
                        <TableHead>位置</TableHead>
                        <TableHead>到期</TableHead>
                        <TableHead>归属</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orders.map((order) => {
                        const expiresAt =
                          order.issued_at + order.duration * 86_400_000;
                        const remainingDays = Math.max(
                          0,
                          Math.ceil((expiresAt - Date.now()) / 86_400_000),
                        );
                        const competition = competitionLabel(
                          order,
                          prices[`${order.location_id}:${order.type_id}`],
                        );

                        return (
                          <TableRow key={order.order_id}>
                            <TableCell>
                              <button
                                type="button"
                                disabled={!onOpenType}
                                title="在交易市场查看价格"
                                onClick={() => onOpenType?.(order.type_id)}
                                className="block max-w-full truncate text-left transition-colors enabled:hover:text-cyan-300 enabled:hover:underline"
                              >
                                {order.type_name ?? `#${order.type_id}`}
                              </button>
                              <span className="block font-mono text-[10px] text-muted-foreground/60">
                                {order.type_id}
                              </span>
                            </TableCell>

                            <TableCell>
                              <Badge
                                variant="outline"
                                className={
                                  order.is_buy_order
                                    ? "border-transparent bg-emerald-500/15 text-emerald-400"
                                    : "border-transparent bg-amber-500/15 text-amber-400"
                                }
                              >
                                {order.is_buy_order ? "买单" : "卖单"}
                              </Badge>
                            </TableCell>

                            <TableCell className="tabular-nums">
                              {order.price.toLocaleString("zh-CN", {
                                maximumFractionDigits: 2,
                              })}
                            </TableCell>

                            <TableCell
                              className={cn(
                                "whitespace-nowrap text-[11px]",
                                competition.tone === "ok" &&
                                  "text-emerald-400",
                                competition.tone === "warn" &&
                                  "text-amber-400",
                                competition.tone === "muted" &&
                                  "text-muted-foreground/60",
                              )}
                            >
                              {competition.text}
                            </TableCell>

                            <TableCell className="tabular-nums">
                              {order.volume_remain.toLocaleString()} /{" "}
                              {order.volume_total.toLocaleString()}
                            </TableCell>

                            <TableCell className="tabular-nums text-muted-foreground">
                              {order.min_volume.toLocaleString()}
                            </TableCell>

                            <TableCell className="tabular-nums text-muted-foreground">
                              {order.escrow != null
                                ? order.escrow.toLocaleString("zh-CN", {
                                    maximumFractionDigits: 2,
                                  })
                                : "—"}
                            </TableCell>

                            <TableCell className="text-muted-foreground">
                              {formatOrderRange(order.range)}
                            </TableCell>

                            <TableCell
                              className="max-w-40 truncate text-muted-foreground"
                              title={
                                order.location_name ??
                                `#${order.location_id}`
                              }
                            >
                              {order.location_name ?? `#${order.location_id}`}
                            </TableCell>

                            <TableCell className="whitespace-nowrap text-muted-foreground">
                              {remainingDays} 天
                              <span className="block text-[10px] text-muted-foreground/60">
                                {new Date(expiresAt).toLocaleDateString(
                                  "zh-CN",
                                )}
                              </span>
                            </TableCell>

                            <TableCell>
                              <Badge
                                variant="outline"
                                className="text-[10px] text-muted-foreground"
                              >
                                {order.is_corporation ? "军团" : "个人"}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
