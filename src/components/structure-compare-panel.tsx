import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import {
  compareStructurePrices,
  listOrderBookLevels,
  listStructures,
  searchTypes,
  type StructurePriceRow,
} from "@/lib/db";

/** 最多同时对比几栋建筑 */
const MAX_COMPARE = 5;

/** 用 0 代表 Jita 市场（本地没有这个建筑，数据走 ESI 实时接口） */
const JITA_ID = 0;
const JITA_REGION_ID = 10000002;

/** Rust 侧 RegionOrder 的前端视图（只保留计算需要的字段） */
interface RegionOrder {
  orderId: number;
  isBuyOrder: boolean;
  price: number;
  volumeRemain: number;
}

/** 价差榜条数选项 */
const SPREAD_LIMITS = [20, 50, 100, 200] as const;

/** 可排序的列 */
type SortKey =
  | "diff"
  | "diffPercent"
  | "askVolume"
  | "matchedVolume"
  | "netProfit";
/** 方向：A 买 B 卖 / B 买 A 卖 / 双向取优 */
type SpreadDirection = "ab" | "ba" | "both";

interface BookLevel {
  price: number;
  volume: number;
}

interface ArbitrageResult {
  matchedVolume: number;
  cost: number;
  proceeds: number;
  grossProfit: number;
  taxCost: number;
  netProfit: number;
}

/**
 * 逐档撮合：拿「便宜那边的卖单」去吃「贵那边的买单」。
 *
 * 每吃穿一档，成交均价就会变差——滑点正是藏在这里。
 * 因此不能只看最优价差，必须从第一档开始逐层匹配到边际不盈利为止。
 */
function walkArbitrage(
  asks: BookLevel[],
  bids: BookLevel[],
  buyRate: number,
  sellRate: number,
): ArbitrageResult {
  const askLevels = asks
    .filter((level) => level.volume > 0)
    .sort((a, b) => a.price - b.price);
  const bidLevels = bids
    .filter((level) => level.volume > 0)
    .sort((a, b) => b.price - a.price);

  let askIndex = 0;
  let bidIndex = 0;
  let askLeft = askLevels[0]?.volume ?? 0;
  let bidLeft = bidLevels[0]?.volume ?? 0;

  let matchedVolume = 0;
  let cost = 0;
  let proceeds = 0;

  while (askIndex < askLevels.length && bidIndex < bidLevels.length) {
    const ask = askLevels[askIndex];
    const bid = bidLevels[bidIndex];

    // 税后边际不再盈利就停，继续撮只会更差
    if (bid.price * (1 - sellRate) <= ask.price * (1 + buyRate)) break;

    const quantity = Math.min(askLeft, bidLeft);
    matchedVolume += quantity;
    cost += ask.price * quantity;
    proceeds += bid.price * quantity;

    askLeft -= quantity;
    bidLeft -= quantity;

    if (askLeft <= 0) {
      askIndex += 1;
      askLeft = askLevels[askIndex]?.volume ?? 0;
    }
    if (bidLeft <= 0) {
      bidIndex += 1;
      bidLeft = bidLevels[bidIndex]?.volume ?? 0;
    }
  }

  const grossProfit = proceeds - cost;
  const taxCost = cost * buyRate + proceeds * sellRate;

  return {
    matchedVolume,
    cost,
    proceeds,
    grossProfit,
    taxCost,
    netProfit: grossProfit - taxCost,
  };
}

function formatIsk(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/** 价差百分比：以收购价为基准，便于判断倒卖空间 */
function spreadPercent(row: StructurePriceRow): number | null {
  if (row.best_buy === null || row.best_sell === null) return null;
  if (row.best_buy <= 0) return null;
  return ((row.best_sell - row.best_buy) / row.best_buy) * 100;
}

/**
 * 玩家市场对比。
 *
 * 上半部分：挑 2~5 栋建筑 + 一个物品，比较该物品在各栋的最优买卖价。
 * 下半部分：两栋建筑之间的卖家价差榜，按逐档撮合算出可成交量与税后净利。
 *
 * 数据全部来自本地订单快照，不请求 ESI。
 */
export default function StructureComparePanel({
  compact = false,
  presetTypeId = null,
  presetTypeName = null,
}: {
  /** 紧凑模式：只保留「选择建筑 + 对比物品 + 单物品对比」，隐藏卖家价差榜 */
  compact?: boolean;
  /** 外部（交易市场分类树）选中的物品，变化时自动填入对比 */
  presetTypeId?: number | null;
  presetTypeName?: string | null;
} = {}) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [keyword, setKeyword] = useState("");
  const [typeId, setTypeId] = useState<number | null>(presetTypeId);
  const [typeName, setTypeName] = useState<string>(presetTypeName ?? "");

  // 左侧分类树切换物品时，右侧对比物品自动跟随
  useEffect(() => {
    if (presetTypeId === null) return;
    setTypeId(presetTypeId);
    setTypeName(presetTypeName ?? `#${presetTypeId}`);
  }, [presetTypeId, presetTypeName]);

  /** 价差榜参数 */
  const [spreadA, setSpreadA] = useState<number | null>(null);
  const [spreadB, setSpreadB] = useState<number | null>(null);
  const [spreadLimit, setSpreadLimit] = useState<number>(50);
  const [sortKey, setSortKey] = useState<SortKey>("netProfit");
  const [sortDesc, setSortDesc] = useState(true);
  const [spreadDirection, setSpreadDirection] =
    useState<SpreadDirection>("both");
  const [buyFeePercent, setBuyFeePercent] = useState(0);
  const [sellFeePercent, setSellFeePercent] = useState(0);
  /** 用户点「对比差价」后才真正开始计算，避免边选建筑边跑重查询 */
  const [spreadPair, setSpreadPair] = useState<{
    a: number;
    b: number;
  } | null>(null);

  const structuresQuery = useQuery({
    queryKey: ["structures", "with-market"],
    queryFn: () => listStructures(true),
    staleTime: 60_000,
  });

  const structures = structuresQuery.data ?? [];

  const typesQuery = useQuery({
    queryKey: ["type-search", keyword],
    queryFn: () => searchTypes(keyword),
    enabled: keyword.trim().length > 0,
    staleTime: 60_000,
  });

  /** 只把本地建筑交给本地查询，Jita 单独走 ESI */
  const localIds = useMemo(
    () => selectedIds.filter((id) => id !== JITA_ID),
    [selectedIds],
  );

  const compareQuery = useQuery({
    queryKey: ["structure-compare", typeId, localIds],
    queryFn: () => compareStructurePrices(typeId as number, localIds),
    enabled: typeId !== null && localIds.length >= 1,
    staleTime: 30_000,
  });

  /** Jita 实时盘口：最高买价 / 最低卖价 / 买卖单量 */
  const jitaQuery = useQuery({
    queryKey: ["jita-compare", typeId],
    queryFn: () =>
      invoke<RegionOrder[]>("fetch_region_type_orders", {
        regionId: JITA_REGION_ID,
        typeId: typeId as number,
      }),
    enabled: typeId !== null && selectedIds.includes(JITA_ID),
    staleTime: 60_000,
  });

  const jitaRow = useMemo<StructurePriceRow | null>(() => {
    if (!selectedIds.includes(JITA_ID) || typeId === null) return null;

    const orders = jitaQuery.data ?? [];
    let bestBuy: number | null = null;
    let bestSell: number | null = null;
    let buyVolume = 0;
    let sellVolume = 0;

    for (const order of orders) {
      if (order.isBuyOrder) {
        bestBuy =
          bestBuy === null ? order.price : Math.max(bestBuy, order.price);
        buyVolume += order.volumeRemain;
      } else {
        bestSell =
          bestSell === null ? order.price : Math.min(bestSell, order.price);
        sellVolume += order.volumeRemain;
      }
    }

    return {
      structure_id: JITA_ID,
      name: "Jita 市场",
      solar_system_name: "The Forge",
      best_buy: bestBuy,
      best_sell: bestSell,
      sell_volume: sellVolume,
      buy_volume: buyVolume,
      order_count: orders.length,
      last_synced_at: null,
    };
  }, [selectedIds, typeId, jitaQuery.data]);

  const levelsQuery = useQuery({
    queryKey: ["order-book-levels", spreadPair?.a, spreadPair?.b],
    queryFn: () =>
      listOrderBookLevels(spreadPair?.a as number, spreadPair?.b as number),
    enabled: spreadPair !== null,
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    const list = [...(compareQuery.data ?? [])];
    if (jitaRow) list.push(jitaRow);

    return list.sort((a, b) => {
      const sa = spreadPercent(a) ?? -Infinity;
      const sb = spreadPercent(b) ?? -Infinity;
      return sb - sa;
    });
  }, [compareQuery.data, jitaRow]);

  /** 逐档撮合出的价差榜 */
  const spreadRows = useMemo(() => {
    const levels = levelsQuery.data ?? [];
    if (levels.length === 0 || spreadPair === null) return [];

    const { a: structureA, b: structureB } = spreadPair;

    // 按「建筑:物品」归档盘口
    const books = new Map<
      string,
      { asks: BookLevel[]; bids: BookLevel[]; name: string | null }
    >();

    for (const level of levels) {
      const key = `${level.structure_id}:${level.type_id}`;
      const book =
        books.get(key) ?? { asks: [], bids: [], name: level.name };

      const entry = { price: level.price, volume: level.volume };
      if (level.is_buy_order === 1) book.bids.push(entry);
      else book.asks.push(entry);

      books.set(key, book);
    }

    const buyRate = buyFeePercent / 100;
    const sellRate = sellFeePercent / 100;

    const typeIds = new Set(levels.map((level) => level.type_id));
    const results: {
      typeId: number;
      name: string | null;
      askA: number;
      askB: number;
      diff: number;
      diffPercent: number;
      cheapSide: "A" | "B";
      cheapName: string;
      cheapVolume: number;
      askVolumeA: number;
      askVolumeB: number;
      matchedVolume: number;
      netProfit: number;
      unitProfit: number;
      marginPercent: number;
      from: number;
      to: number;
    }[] = [];

    /** 最低卖价 */
    const lowestAsk = (asks: BookLevel[]): number | null => {
      let best: number | null = null;
      for (const level of asks) {
        if (level.volume <= 0) continue;
        if (best === null || level.price < best) best = level.price;
      }
      return best;
    };

    /** 卖单总量 */
    const totalAskVolume = (asks: BookLevel[]): number =>
      asks.reduce((sum, level) => sum + level.volume, 0);

    for (const id of typeIds) {
      const bookA = books.get(`${structureA}:${id}`);
      const bookB = books.get(`${structureB}:${id}`);
      if (!bookA || !bookB) continue;

      const askA = lowestAsk(bookA.asks);
      const askB = lowestAsk(bookB.asks);
      if (askA === null || askB === null) continue;

      // 价差按「便宜一侧」为基准，便于横向比较
      const cheaper = Math.min(askA, askB);
      const diff = Math.abs(askA - askB);
      const diffPercent = cheaper > 0 ? (diff / cheaper) * 100 : 0;

      const cheapIsA = askA <= askB;

      // 方向筛选：只保留指定便宜侧
      if (spreadDirection === "ab" && !cheapIsA) continue;
      if (spreadDirection === "ba" && cheapIsA) continue;

      // 从便宜侧买、到贵侧卖
      const result = cheapIsA
        ? walkArbitrage(bookA.asks, bookB.bids, buyRate, sellRate)
        : walkArbitrage(bookB.asks, bookA.bids, buyRate, sellRate);

      if (result.matchedVolume <= 0 || result.netProfit <= 0) continue;

      const askVolumeA = totalAskVolume(bookA.asks);
      const askVolumeB = totalAskVolume(bookB.asks);
      const cheapStructureId = cheapIsA ? structureA : structureB;

      results.push({
        typeId: id,
        name: bookA.name,
        askA,
        askB,
        diff,
        diffPercent,
        cheapSide: cheapIsA ? "A" : "B",
        cheapName:
          structures.find((item) => item.structure_id === cheapStructureId)
            ?.name ?? `#${cheapStructureId}`,
        cheapVolume: cheapIsA ? askVolumeA : askVolumeB,
        askVolumeA,
        askVolumeB,
        matchedVolume: result.matchedVolume,
        netProfit: result.netProfit,
        unitProfit: result.netProfit / result.matchedVolume,
        marginPercent:
          result.cost > 0 ? (result.netProfit / result.cost) * 100 : 0,
        from: cheapIsA ? structureA : structureB,
        to: cheapIsA ? structureB : structureA,
      });
    }

    results.sort((a, b) => {
      const value = (row: (typeof results)[number]): number => {
        switch (sortKey) {
          case "diff":
            return row.diff;
          case "diffPercent":
            return row.diffPercent;
          case "askVolume":
            return row.cheapVolume;
          case "matchedVolume":
            return row.matchedVolume;
          default:
            return row.netProfit;
        }
      };

      return sortDesc ? value(b) - value(a) : value(a) - value(b);
    });

    return results;
  }, [
    levelsQuery.data,
    spreadPair,
    spreadDirection,
    sortKey,
    sortDesc,
    buyFeePercent,
    sellFeePercent,
  ]);

  /** 实际展示的行：截断放在渲染层，改 Top 立即生效 */
  const displayedSpreadRows = spreadRows.slice(0, spreadLimit);

  const toggleStructure = (id: number) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, id];
    });
  };

  const pickType = (id: number, name: string) => {
    setTypeId(id);
    setTypeName(name);
    setKeyword("");
  };

  if (structuresQuery.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 正在读取建筑列表…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto [&>*]:shrink-0">
      {/* 选建筑 + 选物品 + 单物品对比：只在紧凑模式（交易市场右侧）出现 */}
      {compact && (
        <>
      {/* 建筑选择 */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-xs font-medium text-foreground/85">选择建筑</h3>
          <Badge variant="secondary" className="tabular-nums text-[11px]">
            {selectedIds.length} / {MAX_COMPARE}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            至少选择 2 栋进行对比
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {/* Jita 走 ESI 实时行情，用于和自有建筑比价 */}
          {(() => {
            const active = selectedIds.includes(JITA_ID);
            const full = !active && selectedIds.length >= MAX_COMPARE;

            return (
              <button
                type="button"
                disabled={full}
                title="Jita 市场（实时 ESI 行情）"
                onClick={() => toggleStructure(JITA_ID)}
                className={cn(
                  "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                  active
                    ? "border-amber-400/60 bg-amber-400/10 text-amber-100"
                    : "border-border text-muted-foreground hover:border-amber-500/30 hover:text-foreground",
                  full && "cursor-not-allowed opacity-40",
                )}
              >
                {active && <Check className="size-3" />}
                Jita 市场
              </button>
            );
          })()}

          {structures.map((item) => {
            const active = selectedIds.includes(item.structure_id);
            const full = !active && selectedIds.length >= MAX_COMPARE;

            return (
              <button
                key={item.structure_id}
                type="button"
                disabled={full}
                onClick={() => toggleStructure(item.structure_id)}
                className={cn(
                  "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                  active
                    ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100"
                    : "border-border text-muted-foreground hover:border-cyan-500/30 hover:text-foreground",
                  full && "cursor-not-allowed opacity-40",
                )}
              >
                {active && <Check className="size-3" />}
                {item.name ?? `#${item.structure_id}`}
              </button>
            );
          })}
        </div>

        {structures.length === 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            还没有同步过订单的建筑；也可以勾选上方「Jita 市场」查看实时行情。
          </p>
        )}
      </section>

      {/* 物品搜索 */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-xs font-medium text-foreground/85">对比物品</h3>
          {typeId !== null && (
            <Badge variant="outline" className="gap-1 text-[11px]">
              {typeName}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setTypeId(null);
                  setTypeName("");
                }}
              >
                ×
              </button>
            </Badge>
          )}
        </div>

        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索物品名称或类型 ID"
            className="h-8 pl-8 text-xs"
          />
        </div>

        {keyword.trim().length > 0 &&
          (typesQuery.isPending ? (
            <p className="mt-2 text-[11px] text-muted-foreground">搜索中…</p>
          ) : (typesQuery.data ?? []).length === 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              没有匹配的物品
            </p>
          ) : (
            <div className="mt-2 grid max-h-52 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-border bg-card/40 p-1 sm:grid-cols-3 lg:grid-cols-6">
              {(typesQuery.data ?? []).map((item) => (
                <button
                  key={item.type_id}
                  type="button"
                  title={`${item.name} · ${item.type_id}`}
                  onClick={() => pickType(item.type_id, item.name)}
                  className="truncate rounded px-1.5 py-1 text-left text-[11px] text-foreground/80 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                  {item.name}
                </button>
              ))}
            </div>
          ))}
      </section>

      {/* 单物品对比 */}
      <section>
        {typeId === null ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>先选一个物品</EmptyTitle>
              <EmptyDescription>
                选中物品后会列出它在各栋建筑里的最优收购价与出售价。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : selectedIds.length < 2 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>再选一栋建筑</EmptyTitle>
              <EmptyDescription>至少选择 2 栋建筑才能横向对比。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : compareQuery.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> 正在汇总本地订单…
          </div>
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有数据</EmptyTitle>
              <EmptyDescription>
                所选建筑都没有同步过订单，或该物品在这些建筑里没有挂单。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-md border border-cyan-500/20">
            <div className="grid grid-cols-[1.4fr_1fr_1fr_0.9fr_1fr_0.9fr] gap-2 border-b border-cyan-500/15 bg-[#0a1118]/60 px-3 py-1.5 text-[10px] text-muted-foreground">
              <span>建筑</span>
              <span>最优收购</span>
              <span>最优出售</span>
              <span>价差</span>
              <span>卖 / 买 单量</span>
              <span>上次同步</span>
            </div>

            {rows.map((row) => {
              const percent = spreadPercent(row);
              const positive = percent !== null && percent > 0;

              return (
                <div
                  key={row.structure_id}
                  className="grid grid-cols-[1.4fr_1fr_1fr_0.9fr_1fr_0.9fr] items-center gap-2 border-b border-cyan-500/10 px-3 py-1.5 text-[11px] last:border-b-0"
                >
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      row.structure_id === JITA_ID
                        ? "text-amber-200"
                        : "text-foreground/85",
                    )}
                  >
                    {row.name ?? `#${row.structure_id}`}
                    {row.solar_system_name && (
                      <span className="ml-1 text-[10px] text-muted-foreground/60">
                        {row.solar_system_name}
                      </span>
                    )}
                  </span>

                  <span className="font-mono tabular-nums text-emerald-300/85">
                    {formatIsk(row.best_buy)}
                  </span>

                  <span className="font-mono tabular-nums text-amber-300/85">
                    {formatIsk(row.best_sell)}
                  </span>

                  <span
                    className={cn(
                      "font-mono tabular-nums",
                      positive ? "text-cyan-300" : "text-muted-foreground",
                    )}
                  >
                    {percent === null ? "—" : `${percent.toFixed(1)}%`}
                  </span>

                  <span className="font-mono tabular-nums text-muted-foreground">
                    {row.sell_volume.toLocaleString()} /{" "}
                    {row.buy_volume.toLocaleString()}
                  </span>

                  <span className="text-[10px] text-muted-foreground/70">
                    {row.structure_id === JITA_ID
                      ? "实时"
                      : row.last_synced_at
                        ? new Date(row.last_synced_at).toLocaleDateString(
                            "zh-CN",
                          )
                        : "未同步"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
        </>
      )}

      {/* 卖家价差榜（紧凑模式下不展示） */}
      {!compact && (
      <section className="pt-1">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-medium text-foreground/85">卖家价差榜</h3>
          {spreadPair !== null && !levelsQuery.isPending && (
            <Badge variant="secondary" className="tabular-nums text-[10px]">
              显示 {displayedSpreadRows.length} / 共 {spreadRows.length} 个机会
            </Badge>
          )}

          <select
            className="h-7 rounded-md border border-cyan-500/25 bg-[#0a1118]/80 px-1.5 text-[11px] text-cyan-50/90 outline-none focus:border-cyan-400/50"
            value={spreadA ?? ""}
            onChange={(event) => {
              setSpreadA(Number(event.target.value) || null);
              setSpreadPair(null);
            }}
          >
            <option value="">建筑 A</option>
            {structures.map((item) => (
              <option key={item.structure_id} value={item.structure_id}>
                {item.name ?? `#${item.structure_id}`}
                {item.solar_system_name ? ` · ${item.solar_system_name}` : ""}
              </option>
            ))}
          </select>

          <select
            className="h-7 rounded-md border border-cyan-500/25 bg-[#0a1118]/80 px-1.5 text-[11px] text-cyan-50/90 outline-none focus:border-cyan-400/50"
            value={spreadB ?? ""}
            onChange={(event) => {
              setSpreadB(Number(event.target.value) || null);
              setSpreadPair(null);
            }}
          >
            <option value="">建筑 B</option>
            {structures.map((item) => (
              <option key={item.structure_id} value={item.structure_id}>
                {item.name ?? `#${item.structure_id}`}
                {item.solar_system_name ? ` · ${item.solar_system_name}` : ""}
              </option>
            ))}
          </select>

          <select
            className="h-7 rounded-md border border-cyan-500/25 bg-[#0a1118]/80 px-1.5 text-[11px] text-cyan-50/90 outline-none focus:border-cyan-400/50"
            value={spreadDirection}
            onChange={(event) =>
              setSpreadDirection(event.target.value as SpreadDirection)
            }
          >
            <option value="both">全部方向</option>
            <option value="ab">仅 A 便宜</option>
            <option value="ba">仅 B 便宜</option>
          </select>

          <select
            className="h-7 rounded-md border border-cyan-500/25 bg-[#0a1118]/80 px-1.5 text-[11px] text-cyan-50/90 outline-none focus:border-cyan-400/50"
            value={String(spreadLimit)}
            onChange={(event) => setSpreadLimit(Number(event.target.value))}
          >
            {SPREAD_LIMITS.map((value) => (
              <option key={value} value={value}>
                Top {value}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            买入费率
            <Input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={buyFeePercent}
              onChange={(event) =>
                setBuyFeePercent(Number(event.target.value) || 0)
              }
              className="h-7 w-16 text-[11px]"
            />
            %
          </label>

          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            卖出费率
            <Input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={sellFeePercent}
              onChange={(event) =>
                setSellFeePercent(Number(event.target.value) || 0)
              }
              className="h-7 w-16 text-[11px]"
            />
            %
          </label>

          <Button
            size="sm"
            className="h-7"
            disabled={
              spreadA === null || spreadB === null || spreadA === spreadB
            }
            onClick={() => {
              if (spreadA === null || spreadB === null) return;
              setSpreadPair({ a: spreadA, b: spreadB });
            }}
          >
            对比差价
          </Button>

          {spreadA !== null && spreadB !== null && spreadA === spreadB && (
            <span className="text-[11px] text-amber-400">
              请选择两栋不同的建筑
            </span>
          )}
        </div>

        {spreadPair === null ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            选好两栋建筑后点「对比差价」。计算按逐档盘口撮合：从便宜一侧的最低卖单
            开始吃，逐层匹配贵一侧的买单，直到边际不盈利为止，因此成交量与均价
            都是扣过滑点的真实值。费率填 0 时按毛利润计算。
          </p>
        ) : levelsQuery.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> 正在读取盘口…
          </div>
        ) : spreadRows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有可成交的价差</EmptyTitle>
              <EmptyDescription>
                两栋建筑之间不存在「一侧卖单低于另一侧买单」且扣费后仍盈利的物品，
                或订单尚未同步。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-md border border-cyan-500/20">
            <div className="min-w-[820px]">
              <div className="grid grid-cols-[1.4fr_1fr_1fr_0.9fr_0.7fr_1fr_0.9fr_0.8fr_1fr] gap-2 border-b border-cyan-500/15 bg-[#0a1118]/60 px-3 py-1.5 text-[10px] text-muted-foreground">
                <span>物品</span>
                <span>A 最低卖价</span>
                <span>B 最低卖价</span>
                {(
                  [
                    { key: "diff", label: "价差 (ISK)" },
                    { key: "diffPercent", label: "价差 (%)" },
                  ] as const
                ).map((column) => (
                  <button
                    key={column.key}
                    type="button"
                    onClick={() => {
                      if (sortKey === column.key) setSortDesc(!sortDesc);
                      else {
                        setSortKey(column.key);
                        setSortDesc(true);
                      }
                    }}
                    className={cn(
                      "flex items-center gap-0.5 text-left transition-colors hover:text-foreground",
                      sortKey === column.key && "text-cyan-300",
                    )}
                  >
                    {column.label}
                    {sortKey === column.key && (sortDesc ? "↓" : "↑")}
                  </button>
                ))}
                <span>便宜侧</span>
                {(
                  [
                    { key: "askVolume", label: "可购量 (A/B)" },
                    { key: "matchedVolume", label: "可成交量" },
                    { key: "netProfit", label: "预计利润 (ISK)" },
                  ] as const
                ).map((column) => (
                  <button
                    key={column.key}
                    type="button"
                    onClick={() => {
                      if (sortKey === column.key) setSortDesc(!sortDesc);
                      else {
                        setSortKey(column.key);
                        setSortDesc(true);
                      }
                    }}
                    className={cn(
                      "flex items-center gap-0.5 text-left transition-colors hover:text-foreground",
                      sortKey === column.key && "text-cyan-300",
                    )}
                  >
                    {column.label}
                    {sortKey === column.key && (sortDesc ? "↓" : "↑")}
                  </button>
                ))}
              </div>

              {displayedSpreadRows.map((row) => (
                <div
                  key={`${row.typeId}-${row.cheapSide}`}
                  className="grid grid-cols-[1.4fr_1fr_1fr_0.9fr_0.7fr_1fr_0.9fr_0.8fr_1fr] items-center gap-2 border-b border-cyan-500/10 px-3 py-1.5 text-[11px] last:border-b-0"
                >
                  <span className="min-w-0 truncate text-foreground/85">
                    {row.name ?? `#${row.typeId}`}
                  </span>

                  <span
                    className={cn(
                      "font-mono tabular-nums",
                      row.cheapSide === "A"
                        ? "text-cyan-300"
                        : "text-foreground/70",
                    )}
                  >
                    {formatIsk(row.askA)}
                  </span>

                  <span
                    className={cn(
                      "font-mono tabular-nums",
                      row.cheapSide === "B"
                        ? "text-cyan-300"
                        : "text-foreground/70",
                    )}
                  >
                    {formatIsk(row.askB)}
                  </span>

                  <span className="font-mono tabular-nums text-foreground/80">
                    {formatIsk(row.diff)}
                  </span>

                  <span className="font-mono tabular-nums text-cyan-300">
                    {row.diffPercent.toFixed(1)}%
                  </span>

                  <span
                    className="min-w-0 truncate text-[10px] text-cyan-200"
                    title={`${row.cheapSide} · ${row.cheapName}`}
                  >
                    {row.cheapName}
                  </span>

                  <span className="font-mono tabular-nums text-muted-foreground">
                    {row.askVolumeA.toLocaleString()} /{" "}
                    {row.askVolumeB.toLocaleString()}
                  </span>

                  <span className="font-mono tabular-nums text-foreground/80">
                    {row.matchedVolume.toLocaleString()}
                  </span>

                  <span className="font-mono tabular-nums text-emerald-300/90">
                    +{formatIsk(row.netProfit)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      )}
    </div>
  );
}
