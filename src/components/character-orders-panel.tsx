import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BellRing,
  Clock,
  RefreshCw,
  Search,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import {
  getCharacterOrderStats,
  listCharacterOrders,
  listMyOrderMarketPrices,
  type CharacterOrderStats,
  type CharacterOrderView,
  type EveCharacter,
  type OrderMarketPrice,
} from "@/lib/db";
import { formatOrderRange } from "@/lib/order-labels";
import { fetchRegionBestSell, JITA_REGION_ID } from "@/lib/market/price-api";
import { AUTO_SYNC_OPTIONS, useOrderSyncStore } from "@/stores/order-sync-store";

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

/** 自动同步倒计时：独立组件，避免整张订单表每秒重渲染 */
function AutoSyncCountdown({ nextAt }: { nextAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remain = Math.max(0, nextAt - now);
  const minutes = Math.floor(remain / 60_000);
  const seconds = Math.floor((remain % 60_000) / 1000);
  const urgent = remain <= 60_000;

  return (
    <span
      className={cn(
        "font-mono text-[11px] tabular-nums",
        urgent ? "text-amber-300" : "opacity-70",
      )}
    >
      {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
    </span>
  );
}

function formatIskShort(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

/* ============================================================
   排序 / 查询
   ============================================================ */

/** 可排序的列 */
type OrderSortKey =
  | "price"
  | "competition"
  | "volume"
  | "range"
  | "location"
  | "expiry";

interface OrderSort {
  key: OrderSortKey;
  desc: boolean;
}

/** 挂单范围换算成可比较的数值（数字表示跳跃数，region 视为最大） */
function rangeSortValue(range: string): number {
  if (/^\d+$/.test(range)) return Number(range);
  if (range === "station") return 0;
  if (range === "solar_system") return 1;
  if (range === "region") return 1000;
  return 500;
}

/**
 * 相对同建筑最优价的优势值（越大越有利）。
 * 买单高于最优买价、卖单低于最优卖价都算优势，用于「市场」列排序。
 */
function competitionAdvantage(
  order: CharacterOrderView,
  info: OrderMarketPrice | undefined,
): number | null {
  if (!info) return null;

  if (order.is_buy_order) {
    if (info.best_buy === null) return null;
    return order.price - info.best_buy;
  }

  if (info.best_sell === null) return null;
  return info.best_sell - order.price;
}

function orderSortValue(
  order: CharacterOrderView,
  key: OrderSortKey,
  prices: Record<string, OrderMarketPrice>,
): number | string {
  switch (key) {
    case "price":
      return order.price;
    case "volume":
      return order.volume_remain;
    case "range":
      return rangeSortValue(order.range);
    case "expiry":
      return order.issued_at + order.duration * 86_400_000;
    case "location":
      return (order.location_name ?? `#${order.location_id}`).toLowerCase();
    case "competition":
      return (
        competitionAdvantage(
          order,
          prices[`${order.location_id}:${order.type_id}`],
        ) ?? Number.NEGATIVE_INFINITY
      );
  }
}

/** 按关键字过滤 + 按选定列排序（不改动原数组） */
function applyOrdersView(
  orders: CharacterOrderView[],
  keyword: string,
  sort: OrderSort | null,
  prices: Record<string, OrderMarketPrice>,
): CharacterOrderView[] {
  const kw = keyword.trim().toLowerCase();

  const filtered = kw
    ? orders.filter(
        (order) =>
          (order.type_name ?? "").toLowerCase().includes(kw) ||
          String(order.type_id).includes(kw),
      )
    : orders;

  if (!sort) return filtered;

  const dir = sort.desc ? -1 : 1;

  return [...filtered].sort((a, b) => {
    const va = orderSortValue(a, sort.key, prices);
    const vb = orderSortValue(b, sort.key, prices);

    if (typeof va === "string" || typeof vb === "string") {
      return dir * String(va).localeCompare(String(vb), "zh-CN");
    }

    return dir * (va - vb);
  });
}

/** 可点击排序的表头 */
function SortHeader({
  label,
  sortKey,
  sort,
  onToggle,
  className,
}: {
  label: string;
  sortKey: OrderSortKey;
  sort: OrderSort | null;
  onToggle: (key: OrderSortKey) => void;
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort?.desc ? ArrowDown : ArrowUp;

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        title={`按「${label}」排序`}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          active && "text-cyan-300",
        )}
      >
        {label}
        <Icon
          className={cn(
            "size-3 shrink-0",
            active ? "opacity-100" : "opacity-40",
          )}
        />
      </button>
    </TableHead>
  );
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

  // 同步状态与定时器都在 store 里：切到别的菜单也不会中断
  const syncingId = useOrderSyncStore((state) => state.syncingId);
  const syncingAll = useOrderSyncStore((state) => state.syncingAll);
  const autoSync = useOrderSyncStore((state) => state.autoSync);
  const intervalMinutes = useOrderSyncStore((state) => state.intervalMinutes);
  const nextSyncAt = useOrderSyncStore((state) => state.nextSyncAt);
  const undercutCount = useOrderSyncStore((state) => state.undercutCount);
  const lastCacheExpiresAt = useOrderSyncStore(
    (state) => state.lastCacheExpiresAt,
  );
  const error = useOrderSyncStore((state) => state.lastError);
  const revision = useOrderSyncStore((state) => state.revision);
  const toggleAutoSync = useOrderSyncStore((state) => state.toggleAutoSync);
  const setIntervalMinutes = useOrderSyncStore(
    (state) => state.setIntervalMinutes,
  );
  const syncOrders = useOrderSyncStore((state) => state.sync);
  /** 当前查看的角色 tab */
  const [activeTab, setActiveTab] = useState<string>("");
  /** 物品名称/ID 查询：跨角色保留，方便对比同一件物品 */
  const [keyword, setKeyword] = useState("");
  /** 排序列：null 表示沿用后端的默认顺序 */
  const [sort, setSort] = useState<OrderSort | null>(null);


  /** 点击表头：升序 → 降序 → 取消排序 */
  const toggleSort = (key: OrderSortKey) => {
    setSort((current) => {
      if (current?.key !== key) return { key, desc: false };
      if (!current.desc) return { key, desc: true };
      return null;
    });
  };

  const characterIds = characters.map((item) => item.character_id).join(",");

  /** 所有订单涉及的物品（去重），用于批量拉 Jita 价格 */
  const orderTypeIds = useMemo(() => {
    const set = new Set<number>();
    for (const list of Object.values(ordersMap)) {
      for (const order of list) set.add(order.type_id);
    }
    return [...set];
  }, [ordersMap]);

  /** Jita 最低卖价：仅作展示，不参与排序与盈亏计算 */
  const jitaQuery = useQuery({
    queryKey: ["jita-best-sell", orderTypeIds.join(",")],
    queryFn: () => fetchRegionBestSell(JITA_REGION_ID, orderTypeIds),
    enabled: orderTypeIds.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const jitaPrices = jitaQuery.data ?? {};

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

  // 首次进入读库；同步完成（revision 变化）后重新读
  useEffect(() => {
    void loadAll();
  }, [loadAll, revision]);

  const handleSync = (characterId: number) => {
    void syncOrders([characterId]);
  };

  const handleSyncAll = () => {
    void syncOrders(characters.map((item) => item.character_id));
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
      className="min-h-0 flex-1 gap-3"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
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

        {undercutCount > 0 && (
          <Badge variant="destructive" className="gap-1 text-[10px]">
            <BellRing className="size-3" />
            {undercutCount} 笔被压价
          </Badge>
        )}

        <Button
          variant="outline"
          size="sm"
          className={cn(
            "ml-auto h-8 gap-1.5 text-xs",
            autoSync && "border-emerald-500/40 text-emerald-300",
          )}
          onClick={() => toggleAutoSync()}
          title={
            autoSync
              ? `每 ${intervalMinutes} 分钟自动同步一次（含建筑行情与压价提醒），点击关闭`
              : "点击开启自动同步"
          }
        >
          <Clock className={cn("size-3.5", !autoSync && "opacity-50")} />
          {autoSync ? (
            <>
              自动同步
              {nextSyncAt !== null && <AutoSyncCountdown nextAt={nextSyncAt} />}
            </>
          ) : (
            "自动同步已关"
          )}
        </Button>

        <Select
          value={String(intervalMinutes)}
          onValueChange={(value) => setIntervalMinutes(Number(value))}
          disabled={!autoSync}
        >
          <SelectTrigger
            size="sm"
            className="h-8 w-[92px] text-xs"
            title="自动同步间隔（最短 20 分钟）"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* 把当前值也并进选项，避免历史设置不在预设里时显示空白 */}
            {[...new Set<number>([...AUTO_SYNC_OPTIONS, intervalMinutes])]
              .sort((a, b) => a - b)
              .map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {minutes} 分钟
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          disabled={syncingAll}
          onClick={() => handleSyncAll()}
        >
          <RefreshCw className={syncingAll ? "animate-spin" : undefined} />
          {syncingAll ? "同步中…" : "同步全部角色"}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="shrink-0">
          <AlertTitle>同步失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {characters.map((character) => {
        const allOrders = ordersMap[character.character_id] ?? [];
        const stats = statsMap[character.character_id];
        const prices = priceMap[character.character_id] ?? {};
        const busy = syncingId === character.character_id;
        /** 查询 + 排序后的可见订单 */
        const orders = applyOrdersView(allOrders, keyword, sort, prices);

        // 到期统计始终基于全量订单，不受查询/排序影响
        const expiring = allOrders.filter((order) => {
          const expiresAt = order.issued_at + order.duration * 86_400_000;
          return expiresAt - Date.now() < 3 * 86_400_000;
        }).length;

        return (
          <TabsContent
            key={character.character_id}
            value={String(character.character_id)}
            className="mt-0 flex min-h-0 flex-col data-[state=inactive]:hidden"
          >
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {keyword.trim() || sort
                    ? `匹配 ${orders.length.toLocaleString()} / 共 ${allOrders.length.toLocaleString()} 笔`
                    : `${allOrders.length} 笔挂单`}
                </span>

                {lastCacheExpiresAt !== null &&
                  lastCacheExpiresAt > Date.now() && (
                    <span
                      className="text-[11px] text-amber-300/80"
                      title="ESI 对订单接口有约 20 分钟缓存，缓存期内重新同步不会拿到新数据"
                    >
                      ESI 缓存至{" "}
                      {new Date(lastCacheExpiresAt).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}

                <div className="relative w-56">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="按物品名称或类型 ID 查询"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  disabled={busy || syncingAll}
                  onClick={() => handleSync(character.character_id)}
                >
                  {busy ? "同步中…" : "同步该角色"}
                </Button>
              </div>

              {stats && stats.order_count > 0 && (
                <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-[11px] text-muted-foreground">
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
                <p className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  {allOrders.length === 0
                    ? "暂无订单，点右上角「同步该角色」拉取挂单。"
                    : "没有匹配的订单，换个关键字试试。"}
                </p>
              ) : (
                <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border [&>[data-slot=table-container]]:overflow-visible">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-card">
                      <TableRow>
                        <TableHead>物品</TableHead>
                        <TableHead>方向</TableHead>
                        <SortHeader
                          label="单价 (ISK)"
                          sortKey="price"
                          sort={sort}
                          onToggle={toggleSort}
                        />
                        <SortHeader
                          label="市场"
                          sortKey="competition"
                          sort={sort}
                          onToggle={toggleSort}
                        />
                        <TableHead>Jita 最低</TableHead>
                        <SortHeader
                          label="剩余 / 总量"
                          sortKey="volume"
                          sort={sort}
                          onToggle={toggleSort}
                        />
                        <TableHead>最小量</TableHead>
                        <TableHead>托管 (ISK)</TableHead>
                        <SortHeader
                          label="范围"
                          sortKey="range"
                          sort={sort}
                          onToggle={toggleSort}
                        />
                        <SortHeader
                          label="位置"
                          sortKey="location"
                          sort={sort}
                          onToggle={toggleSort}
                        />
                        <SortHeader
                          label="到期"
                          sortKey="expiry"
                          sort={sort}
                          onToggle={toggleSort}
                        />
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

                            <TableCell className="whitespace-nowrap tabular-nums text-[11px] text-cyan-300/90">
                              {(() => {
                                if (jitaQuery.isPending) {
                                  return (
                                    <span className="text-muted-foreground/50">
                                      …
                                    </span>
                                  );
                                }

                                const value = jitaPrices[String(order.type_id)];
                                if (value === undefined) {
                                  return (
                                    <span className="text-muted-foreground/50">
                                      —
                                    </span>
                                  );
                                }
                                if (value === null) {
                                  return (
                                    <span className="text-muted-foreground/60">
                                      无卖单
                                    </span>
                                  );
                                }
                                return value.toLocaleString("zh-CN", {
                                  maximumFractionDigits: 2,
                                });
                              })()}
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
