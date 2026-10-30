import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
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

/** 临期阈值（天） */
const EXPIRING_DAYS = 3;
/** 各榜单最多展示条数 */
const RANK_LIMIT = 12;
/** 天数换算成毫秒 */
const DAY_MS = 86_400_000;

function formatIsk(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

interface OrderWithContext {
  order: CharacterOrderView;
  /** 与市场最优价的差距；null 表示没有市场数据 */
  gap: number | null;
  /** true 表示自己处于不利位置 */
  undercut: boolean;
}

/**
 * 订单分析：把订单按竞争力、到期时间、建筑分布三个角度重排。
 *
 * 顶部可切换到「全部角色」或单个角色，各自独立统计。
 * 数据全部来自本地库；竞争力依赖该建筑已同步过市场订单。
 */
export default function OrderAnalysisPanel({
  characters,
}: {
  characters: EveCharacter[];
}) {
  const [loading, setLoading] = useState(true);
  const [byCharacter, setByCharacter] = useState<
    Record<number, OrderWithContext[]>
  >({});
  const [statsByCharacter, setStatsByCharacter] = useState<
    Record<number, CharacterOrderStats>
  >({});
  const [tab, setTab] = useState("all");

  const characterIds = characters.map((item) => item.character_id).join(",");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);

      const entries = await Promise.all(
        characters.map(async (character) => {
          const id = character.character_id;
          const [rows, stats, prices] = await Promise.all([
            listCharacterOrders(id),
            getCharacterOrderStats(id),
            listMyOrderMarketPrices(id),
          ]);

          const indexed: Record<string, OrderMarketPrice> = {};
          for (const price of prices) {
            indexed[`${price.structure_id}:${price.type_id}`] = price;
          }

          const enriched: OrderWithContext[] = rows.map((order) => {
            const info = indexed[`${order.location_id}:${order.type_id}`];

            let gap: number | null = null;
            let undercut = false;

            if (info) {
              if (order.is_buy_order) {
                if (info.best_buy !== null) {
                  gap = order.price - info.best_buy;
                  undercut = gap < 0;
                }
              } else if (info.best_sell !== null) {
                gap = order.price - info.best_sell;
                undercut = gap > 0;
              }
            }

            return { order, gap, undercut };
          });

          return [id, { enriched, stats }] as const;
        }),
      );

      if (cancelled) return;

      const orders: Record<number, OrderWithContext[]> = {};
      const stats: Record<number, CharacterOrderStats> = {};

      for (const [id, value] of entries) {
        orders[id] = value.enriched;
        stats[id] = value.stats;
      }

      setByCharacter(orders);
      setStatsByCharacter(stats);
      setLoading(false);
    };

    void load();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterIds]);

  /** 「全部角色」的合并数据 */
  const merged = useMemo(() => {
    const orders: OrderWithContext[] = [];
    const stats: CharacterOrderStats = {
      order_count: 0,
      sell_value: 0,
      buy_value: 0,
      escrow_total: 0,
    };

    for (const character of characters) {
      const list = byCharacter[character.character_id] ?? [];
      orders.push(...list);

      const item = statsByCharacter[character.character_id];
      if (item) {
        stats.order_count += item.order_count;
        stats.sell_value += item.sell_value;
        stats.buy_value += item.buy_value;
        stats.escrow_total += item.escrow_total;
      }
    }

    return { orders, stats };
  }, [characters, byCharacter, statsByCharacter]);

  if (characters.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>需要先授权角色</EmptyTitle>
          <EmptyDescription>
            在「角色」标签页添加 EVE 角色后即可分析挂单。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 正在汇总订单…
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-3">
      <TabsList className="gap-1.5">
        <TabsTrigger value="all">
          全部角色
          <span className="ml-1 font-mono text-[10px] text-muted-foreground">
            {merged.orders.length}
          </span>
        </TabsTrigger>
        {characters.map((character) => {
          const count = byCharacter[character.character_id]?.length ?? 0;
          return (
            <TabsTrigger
              key={character.character_id}
              value={String(character.character_id)}
            >
              {character.name}
              <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                {count}
              </span>
            </TabsTrigger>
          );
        })}
      </TabsList>

      <TabsContent value="all" className="mt-0">
        <AnalysisView orders={merged.orders} totals={merged.stats} />
      </TabsContent>

      {characters.map((character) => {
        const orders = byCharacter[character.character_id] ?? [];
        const stats =
          statsByCharacter[character.character_id] ?? {
            order_count: 0,
            sell_value: 0,
            buy_value: 0,
            escrow_total: 0,
          };

        return (
          <TabsContent
            key={character.character_id}
            value={String(character.character_id)}
            className="mt-0"
          >
            <AnalysisView orders={orders} totals={stats} />
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

/** 单个角色（或合并视图）的分析内容 */
function AnalysisView({
  orders,
  totals,
}: {
  orders: OrderWithContext[];
  totals: CharacterOrderStats;
}) {
  const undercutOrders = useMemo(
    () =>
      orders
        .filter((item) => item.undercut && item.gap !== null)
        .sort((a, b) => Math.abs(b.gap as number) - Math.abs(a.gap as number))
        .slice(0, RANK_LIMIT),
    [orders],
  );

  const expiringOrders = useMemo(
    () =>
      orders
        .map((item) => ({
          ...item,
          expiresAt: item.order.issued_at + item.order.duration * DAY_MS,
        }))
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .slice(0, RANK_LIMIT),
    [orders],
  );

  const byLocation = useMemo(() => {
    const map = new Map<string, { name: string; count: number; value: number }>();

    for (const item of orders) {
      const key = `${item.order.location_id}`;
      const name = item.order.location_name ?? `#${item.order.location_id}`;
      const value = item.order.price * item.order.volume_remain;
      const entry = map.get(key) ?? { name, count: 0, value: 0 };
      entry.count += 1;
      entry.value += value;
      map.set(key, entry);
    }

    return [...map.values()].sort((a, b) => b.value - a.value).slice(0, RANK_LIMIT);
  }, [orders]);

  const expiringCount = orders.filter((item) => {
    const expiresAt = item.order.issued_at + item.order.duration * DAY_MS;
    return expiresAt - Date.now() < EXPIRING_DAYS * DAY_MS;
  }).length;

  if (orders.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>该角色还没有订单数据</EmptyTitle>
          <EmptyDescription>
            到「我的订单」标签页同步一次，再回来查看分析。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {[
          { label: "挂单笔数", value: totals.order_count.toLocaleString() },
          { label: "卖单价值", value: formatIsk(totals.sell_value) },
          { label: "买单价值", value: formatIsk(totals.buy_value) },
          { label: "托管金额", value: formatIsk(totals.escrow_total) },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-border bg-card/40 px-3 py-2"
          >
            <span className="block text-[11px] text-muted-foreground">
              {item.label}
            </span>
            <span className="block font-mono text-base text-foreground/90">
              {item.value}
            </span>
          </div>
        ))}
      </section>

      {expiringCount > 0 && (
        <p className="text-xs text-amber-400">
          有 {expiringCount} 笔订单将在 {EXPIRING_DAYS} 天内到期
        </p>
      )}

      <section>
        <h3 className="mb-2 text-sm font-medium text-foreground/85">
          被压价的挂单
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
            仅统计已同步过市场订单的建筑
          </span>
        </h3>

        {undercutOrders.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            没有被压价的挂单，或相关建筑尚未同步市场订单。
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[1.6fr_1fr_0.9fr_1fr_1.2fr] gap-2 border-b border-border bg-background/40 px-3 py-1.5 text-[10px] text-muted-foreground">
              <span>物品</span>
              <span>方向</span>
              <span>我的价格</span>
              <span>差距</span>
              <span>位置</span>
            </div>
            {undercutOrders.map((item) => (
              <div
                key={item.order.order_id}
                className="grid grid-cols-[1.6fr_1fr_0.9fr_1fr_1.2fr] items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] last:border-b-0"
              >
                <span className="min-w-0 truncate text-foreground/85">
                  {item.order.type_name ?? `#${item.order.type_id}`}
                </span>
                <span className="text-muted-foreground">
                  {item.order.is_buy_order ? "买单" : "卖单"}
                </span>
                <span className="font-mono tabular-nums text-foreground/80">
                  {item.order.price.toLocaleString("zh-CN", {
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span className="font-mono tabular-nums text-amber-400">
                  {item.gap !== null
                    ? `${item.gap > 0 ? "+" : ""}${item.gap.toLocaleString(
                        "zh-CN",
                        { maximumFractionDigits: 2 },
                      )}`
                    : "—"}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {item.order.location_name ?? `#${item.order.location_id}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-foreground/85">最接近到期</h3>
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[1.6fr_0.9fr_1fr_1fr_1.2fr] gap-2 border-b border-border bg-background/40 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>物品</span>
            <span>方向</span>
            <span>单价</span>
            <span>剩余</span>
            <span>到期</span>
          </div>
          {expiringOrders.map((item) => {
            const days = Math.max(
              0,
              Math.ceil((item.expiresAt - Date.now()) / DAY_MS),
            );

            return (
              <div
                key={item.order.order_id}
                className="grid grid-cols-[1.6fr_0.9fr_1fr_1fr_1.2fr] items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] last:border-b-0"
              >
                <span className="min-w-0 truncate text-foreground/85">
                  {item.order.type_name ?? `#${item.order.type_id}`}
                </span>
                <span className="text-muted-foreground">
                  {item.order.is_buy_order ? "买单" : "卖单"}
                </span>
                <span className="font-mono tabular-nums text-foreground/80">
                  {item.order.price.toLocaleString("zh-CN", {
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    days <= EXPIRING_DAYS
                      ? "text-amber-400"
                      : "text-muted-foreground",
                  )}
                >
                  {days} 天
                </span>
                <span className="text-muted-foreground">
                  {new Date(item.expiresAt).toLocaleDateString("zh-CN")}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-foreground/85">挂单分布</h3>
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[1.8fr_0.8fr_1fr] gap-2 border-b border-border bg-background/40 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>位置</span>
            <span>笔数</span>
            <span>挂单价值</span>
          </div>
          {byLocation.map((item) => (
            <div
              key={item.name}
              className="grid grid-cols-[1.8fr_0.8fr_1fr] items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] last:border-b-0"
            >
              <span className="min-w-0 truncate text-foreground/85">
                {item.name}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {item.count}
              </span>
              <span className="font-mono tabular-nums text-foreground/80">
                {formatIsk(item.value)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <Badge
        variant="outline"
        className="w-fit text-[10px] text-muted-foreground"
      >
        数据来自本地订单快照，竞争力判断仅覆盖已同步的建筑
      </Badge>
    </div>
  );
}
