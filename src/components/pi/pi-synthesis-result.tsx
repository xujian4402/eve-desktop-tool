import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { synthesizeMax } from "@/lib/pi/synthesis";
import type { PiPriceRow, PiTier } from "@/lib/pi/types";
import { cn } from "@/lib/utils";

function isk(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/** 行情单价文本（缺价显示 —） */
function priceText(
  prices: Map<number, PiPriceRow>,
  typeId: number,
  side: "buy" | "sell",
): string {
  const value = prices.get(typeId)?.[side];
  return value === undefined || value === null ? "—" : isk(value);
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
  /** 下半部分视图：默认收益（全量分级）/ 指定产物收益 */
  const [view, setView] = useState<"default" | "focus">("default");
  /** 指定产物（可多选）：非空时列表只展示这些产物的合成结果 */
  const [focusTypeIds, setFocusTypeIds] = useState<number[]>([]);
  /** 指定产物页签的当前选中项 */
  const [activeFocus, setActiveFocus] = useState<string>("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [keyword, setKeyword] = useState("");

  /**
   * 可合成上限用的可用量：库存数量与「计划购买」的数量都算进来
   * （来源标记只影响成本口径：库存不计成本，购买按行情价计入）。
   */
  const stockForSynthesis = useMemo(() => new Map(stock), [stock]);

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

  /** 指定产物的库存可合成结果（含各级消耗与缺口），支持多个 */
  const focusResults = useMemo(
    () => focusTypeIds.map((typeId) => synthesizeMax(stockForSynthesis, typeId)),
    [focusTypeIds, stockForSynthesis],
  );

  /**
   * 上半部分填写的数量按「库存 / 购买」拆分的金额：
   * 库存 = 已有物资价值，购买 = 本次需要采购的支出。
   */
  const valueSplit = useMemo(() => {
    let stockValue = 0;
    let buyValue = 0;
    let incomplete = false;

    for (const [typeId, quantity] of stock) {
      if (quantity <= 0) continue;
      const row = priceRows.get(typeId);
      const unit = row?.buy ?? row?.sell ?? null;
      if (unit === null) {
        incomplete = true;
        continue;
      }
      const amount = unit * quantity;
      if ((source[typeId] ?? "buy") === "stock") stockValue += amount;
      else buyValue += amount;
    }

    return { stockValue, buyValue, incomplete };
  }, [stock, source, priceRows]);



  /** 指定产物的收入 / 采购成本 / 利润汇总（产物按最高买单，P0 按最低卖单） */
  const focusTotals = useMemo(() => {
    const items = focusResults.map((result) => {
      const sellUnit = priceRows.get(result.targetTypeId)?.buy ?? null;
      const revenue = sellUnit === null ? null : sellUnit * result.output;

      /**
       * 采购需求：
       * - 能合成（output > 0）时取该批次的 P0 缺口；
       * - 合不出来（output = 0）时 p0 明细为空，改用「再做 1 个还缺多少」评估，
       *   否则采购成本会恒为 0，看不出做这个产物到底要花多少钱。
       */
      const estimated = result.output === 0;
      const needs = estimated
        ? result.shortfall.map((item) => ({
            typeId: item.typeId,
            amount: Math.ceil(item.amount),
          }))
        : result.p0
            .filter((line) => line.remaining > 0.5)
            .map((line) => ({
              typeId: line.typeId,
              amount: Math.ceil(line.remaining),
            }));

      let cost = 0;
      let costIncomplete = false;
      for (const need of needs) {
        const unit = priceRows.get(need.typeId)?.sell ?? null;
        if (unit === null) {
          costIncomplete = true;
          continue;
        }
        cost += unit * need.amount;
      }

      const finalCost = costIncomplete ? null : cost;
      const profit =
        finalCost !== null && revenue !== null ? revenue - finalCost : null;
      const margin =
        finalCost !== null && finalCost > 0 && profit !== null
          ? profit / finalCost
          : null;

      return {
        targetTypeId: result.targetTypeId,
        targetName: result.targetName,
        output: result.output,
        sellUnit,
        revenue,
        cost: finalCost,
        profit,
        margin,
        /** 采购成本按「做 1 个的缺口」估算（当前库存合不出来） */
        estimated,
      };
    });

    const sumOf = (
      pick: (item: (typeof items)[number]) => number | null,
    ): number | null =>
      items.length === 0 || items.some((item) => pick(item) === null)
        ? null
        : items.reduce((acc, item) => acc + (pick(item) ?? 0), 0);

    return {
      items,
      revenue: sumOf((item) => item.revenue),
      cost: sumOf((item) => item.cost),
      profit: sumOf((item) => item.profit),
    };
  }, [focusResults, priceRows]);

  /** 选中项失效时回落到第一个指定产物 */
  const activeFocusId = focusResults.some(
    (result) => String(result.targetTypeId) === activeFocus,
  )
    ? activeFocus
    : String(focusResults[0]?.targetTypeId ?? "");

  const toggleFocus = (typeId: number) => {
    setFocusTypeIds((current) =>
      current.includes(typeId)
        ? current.filter((item) => item !== typeId)
        : [...current, typeId],
    );
  };

  /** 弹窗里的产物分组（按等级） */
  const pickerGroups = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return ([4, 3, 2, 1] as const).map((item) => ({
      tier: item,
      items: PI_PRODUCTS.filter((product) => {
        if (product.tier !== item) return false;
        if (!kw) return true;
        return (
          product.name.toLowerCase().includes(kw) ||
          String(product.typeId).includes(kw)
        );
      }),
    }));
  }, [keyword]);

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

  /** P1~P4 全等级统计（产物数 / 盈利项 / 合计利润 / 可合成种类） */
  const tierSummary = useMemo(
    () =>
      rows.map((group) => {
        const profitSum = group.items.reduce(
          (sum, item) => sum + (item.profit ?? 0),
          0,
        );
        // 总利润 / 总收入 = Σ(单位利润或收入 × 库存可合成数)
        // 两者独立累加：原料缺价时利润算不出，但收入仍然有效，不能一起丢掉
        let totalProfitSum = 0;
        let totalRevenueSum = 0;
        let hasProfit = false;
        let hasRevenue = false;
        for (const item of group.items) {
          const cap = caps.get(item.typeId) ?? 0;
          if (cap <= 0 || item.outputQty <= 0) continue;

          if (item.profit !== null) {
            hasProfit = true;
            totalProfitSum += (item.profit / item.outputQty) * cap;
          }
          if (item.revenue !== null) {
            hasRevenue = true;
            totalRevenueSum += (item.revenue / item.outputQty) * cap;
          }
        }

        return {
          tier: group.tier,
          total: group.items.length,
          /** 该等级 1 小时收入合计 */
          revenueSum: group.items.reduce(
            (sum, item) => sum + (item.revenue ?? 0),
            0,
          ),
          profitable: group.items.filter((item) => (item.profit ?? 0) > 0)
            .length,
          /** 有原料或产物没填价，利润无法计算 */
          missingPrice: group.items.filter(
            (item) => item.costIncomplete || item.revenueIncomplete,
          ).length,
          profitSum,
          /** 该等级全部产物的总利润（无库存或无价时为 null） */
          totalProfitSum: hasProfit ? totalProfitSum : null,
          /** 该等级全部产物按可合成数量卖出的总收入 */
          totalRevenueSum: hasRevenue ? totalRevenueSum : null,
          stockItemCount: group.items.filter(
            (item) => (caps.get(item.typeId) ?? 0) > 0,
          ).length,
        };
      }),
    [rows, caps],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Tabs
        value={view}
        onValueChange={(value) => setView(value as "default" | "focus")}
        className="min-h-0 flex-1"
      >
        <TabsList className="shrink-0">
          <TabsTrigger value="default">默认收益</TabsTrigger>
          <TabsTrigger value="focus">
            指定产物收益
            {focusTypeIds.length > 0 ? `（${focusTypeIds.length}）` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="focus"
          forceMount
          className="mt-2 flex min-h-0 flex-col gap-2 data-[state=inactive]:hidden"
        >
      {/* 指定产物（可多选）：列表只展示这些产物的合成结果 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={() => setPickerOpen(true)}
        >
          <Search />
          指定产物（{focusTypeIds.length}）
        </Button>

        {focusTypeIds.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => setFocusTypeIds([])}
          >
            清除
          </Button>
        )}

        {focusResults.map((result) => (
          <Badge
            key={result.targetTypeId}
            variant="secondary"
            className="gap-1"
          >
            {result.targetName}
            <b className="font-mono tabular-nums text-emerald-400">
              {result.output.toLocaleString()}
            </b>
            <button
              type="button"
              className="ml-0.5 text-muted-foreground hover:text-destructive"
              onClick={() => toggleFocus(result.targetTypeId)}
            >
              ×
            </button>
          </Badge>
        ))}

        {focusTypeIds.length > 0 && stock.size === 0 && (
          <span className="text-[11px] text-muted-foreground">
            未读取库存，按上方填写的数量计算
          </span>
        )}
      </div>

      {/* 库存价值 / 购买成本（按上半部分的标记与数量统计） */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          库存价值{" "}
          <b className="font-mono tabular-nums text-emerald-400">
            {isk(valueSplit.stockValue)}
          </b>
        </span>
        <span className="text-muted-foreground">
          购买成本{" "}
          <b className="font-mono tabular-nums text-sky-300">
            {valueSplit.incomplete
              ? `${isk(valueSplit.buyValue)}+`
              : isk(valueSplit.buyValue)}
          </b>
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          按上方填写的数量与「库存 / 购买」标记统计（含缺价项时以 + 标注）
        </span>
      </div>

      {/* 多产物收入汇总 */}
      {focusResults.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            收入合计{" "}
            <b className="font-mono tabular-nums text-emerald-400">
              {focusTotals.revenue === null ? "缺价" : isk(focusTotals.revenue)}
            </b>
          </span>
          <span className="text-muted-foreground">
            采购成本{" "}
            <b className="font-mono tabular-nums text-amber-300/90">
              {valueSplit.incomplete
                ? `${isk(valueSplit.buyValue)}+`
                : isk(valueSplit.buyValue)}
            </b>
          </span>
          <span className="text-muted-foreground">
            利润{" "}
            <b
              className={cn(
                "font-mono tabular-nums",
                (focusTotals.revenue === null
                  ? 0
                  : focusTotals.revenue - valueSplit.buyValue) >= 0
                  ? "text-emerald-400"
                  : "text-rose-400",
              )}
            >
              {focusTotals.revenue === null
                ? "—"
                : isk(focusTotals.revenue - valueSplit.buyValue)}
            </b>
          </span>
          <span className="text-muted-foreground">
            利润率{" "}
            {focusTotals.revenue === null || valueSplit.buyValue <= 0
              ? "—"
              : `${(((focusTotals.revenue - valueSplit.buyValue) / valueSplit.buyValue) * 100).toFixed(1)}%`}
          </span>

          <span className="text-[10px] text-muted-foreground/70">
            采购成本 = 上半部分标记「购买」的金额总和；收入按产物最高买单估算
          </span>
        </div>
      )}

      {focusResults.some((result) => result.shortfall.length > 0) && (
        <div className="shrink-0 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-[11px]">
          {focusResults
            .filter((result) => result.shortfall.length > 0)
            .map((result) => (
              <p key={result.targetTypeId} className="text-rose-400/90">
                {result.targetName} 再做 1 个还缺：
                {result.shortfall
                  .map((item) => `${item.name} ×${Math.ceil(item.amount)}`)
                  .join("，")}
              </p>
            ))}
        </div>
      )}

      {focusTypeIds.length === 0 && (
        <p className="shrink-0 text-xs text-muted-foreground">
          先点上方「指定产物」选择要查看的产物。
        </p>
      )}

      {focusResults.length > 0 && (
        /* 多个指定产物：用页签切换，每个产物展示它完整的合成结果（P1~P4 各级 + P0 原料） */
        <Tabs
          value={activeFocusId}
          onValueChange={setActiveFocus}
          className="min-h-0 flex-1"
        >
          <TabsList className="h-auto shrink-0 flex-wrap">
            {focusResults.map((result) => (
              <TabsTrigger
                key={result.targetTypeId}
                value={String(result.targetTypeId)}
              >
                {result.targetName}
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                  {result.output.toLocaleString()}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          {focusResults.map((result) => (
            <TabsContent
              key={result.targetTypeId}
              value={String(result.targetTypeId)}
              forceMount
              className="mt-2 flex min-h-0 flex-col data-[state=inactive]:hidden"
            >
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-t-lg border border-b-0 border-border bg-muted/40 px-3 py-2 text-xs">
                <span className="font-medium text-foreground/90">
                  {result.targetName}
                </span>
                <span className="text-muted-foreground">
                  库存可合成{" "}
                  <b className="font-mono tabular-nums text-emerald-400">
                    {result.output.toLocaleString()}
                  </b>{" "}
                  个 · {result.cycles.toLocaleString()} 周期
                  {result.stockOfTarget > 0
                    ? ` · 已有库存 ${result.stockOfTarget.toLocaleString()}`
                    : ""}
                </span>
              </div>

              {/* 该产物的收入 / 采购成本 / 利润 */}
              {(() => {
                const totals = focusTotals.items.find(
                  (item) => item.targetTypeId === result.targetTypeId,
                );
                if (!totals) return null;

                return (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 px-3 py-1.5 text-[11px]">
                    <span className="text-muted-foreground">
                      收入{" "}
                      <b className="font-mono tabular-nums text-emerald-400">
                        {totals.revenue === null ? "缺价" : isk(totals.revenue)}
                      </b>
                      {totals.sellUnit !== null && (
                        <span className="text-muted-foreground/70">
                          {" "}
                          （{totals.output.toLocaleString()} × {isk(totals.sellUnit)}）
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      原料采购{" "}
                      <b className="font-mono tabular-nums text-amber-300/90">
                        {totals.cost === null ? "缺价" : isk(totals.cost)}
                      </b>
                      {totals.estimated && (
                        <span
                          className="text-muted-foreground/70"
                          title="当前库存连 1 个都合不出来，采购成本按「做 1 个的缺口」估算"
                        >
                          {" "}
                          （按做 1 个估算）
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      总利润{" "}
                      <b
                        className={cn(
                          "font-mono tabular-nums",
                          (totals.profit ?? 0) >= 0
                            ? "text-emerald-400"
                            : "text-rose-400",
                        )}
                      >
                        {totals.profit === null ? "—" : isk(totals.profit)}
                      </b>
                      {totals.margin !== null && (
                        <span className="text-muted-foreground/70">
                          {" "}
                          （{(totals.margin * 100).toFixed(1)}%）
                        </span>
                      )}
                    </span>
                  </div>
                );
              })()}
              <div className="min-h-0 flex-1 overflow-auto rounded-b-lg border border-border [&>[data-slot=table-container]]:overflow-visible">
              <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>等级</TableHead>
                <TableHead>物品</TableHead>
                <TableHead className="text-right">需求</TableHead>
                <TableHead className="text-right">库存抵扣</TableHead>
                <TableHead className="text-right">需生产 / 缺口</TableHead>
                <TableHead className="text-right">单价</TableHead>
                <TableHead className="text-right">周期</TableHead>
                <TableHead>设施</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.lines.map((line) => (
                <TableRow key={`step-${line.typeId}`}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      P{line.tier}
                    </Badge>
                  </TableCell>
                  <TableCell>{line.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Math.ceil(line.required).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-400/90">
                    {line.fromStock > 0
                      ? Math.floor(line.fromStock).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {line.remaining > 0
                      ? Math.ceil(line.remaining).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {priceText(priceRows, line.typeId, "buy")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {line.cycles > 0 ? Math.ceil(line.cycles).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {line.facility || "—"}
                  </TableCell>
                </TableRow>
              ))}

              {result.p0.map((line) => (
                <TableRow key={`p0-${line.typeId}`}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      P0
                    </Badge>
                  </TableCell>
                  <TableCell>{line.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Math.ceil(line.required).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-400/90">
                    {line.fromStock > 0
                      ? Math.floor(line.fromStock).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      line.remaining > 0.5
                        ? "text-rose-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {line.remaining > 0.5
                      ? Math.ceil(line.remaining).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {priceText(priceRows, line.typeId, "sell")}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    —
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    需采集
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
              </Table>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      )}
        </TabsContent>

        <TabsContent
          value="default"
          forceMount
          className="mt-2 flex min-h-0 flex-col gap-2 data-[state=inactive]:hidden"
        >
      {/* P1~P4 全等级统计（点击卡片切换下方明细） */}
      <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4">
        {tierSummary.map((item) => {
          const active = String(item.tier) === tier;
          return (
            <button
              key={item.tier}
              type="button"
              onClick={() => setTier(String(item.tier))}
              className={cn(
                "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                active
                  ? "border-primary/60 bg-primary/10"
                  : "border-border/60 bg-card/40 hover:bg-muted/40",
              )}
            >
              <span className="flex items-center justify-between text-[11px] text-muted-foreground">
                {piTierLabel(item.tier)}
                <span className="font-mono tabular-nums">{item.total} 项</span>
              </span>
              <span
                className={cn(
                  "font-mono text-sm tabular-nums",
                  (item.totalProfitSum ?? 0) >= 0
                    ? "text-emerald-400"
                    : "text-rose-400",
                )}
                title="总利润 = Σ(单位利润 × 库存可合成数)"
              >
                {item.totalProfitSum === null
                  ? "—"
                  : isk(item.totalProfitSum)}
              </span>
              <span className="text-[10px] text-muted-foreground/70">
                总利润 · 1h {isk(item.profitSum)} · 盈利 {item.profitable} 项
                {item.missingPrice > 0
                  ? ` · 缺价 ${item.missingPrice} 项`
                  : ""}
                {hasStock ? ` · 可合成 ${item.stockItemCount} 种` : ""}
              </span>
            </button>
          );
        })}
      </div>

      <p className="shrink-0 text-[11px] text-muted-foreground/70">
        口径：每条产线 1 小时；「库存可合成」用的是上方填写的<b>数量</b>
        （库存与计划购买都算，{hasStock ? "已读取库存" : "未读取库存"}）；
        成本只对标记为「购买」的部分按行情价计入。金额均为 ISK/小时，点击卡片切换等级明细。
      </p>

      <Tabs
        value={tier}
        onValueChange={setTier}
        className="min-h-0 flex-1"
      >
        <TabsList className="shrink-0">
          {TIERS.map((item) => {
            const count =
              rows.find((group) => group.tier === item)?.items.length ?? 0;
            return (
              <TabsTrigger key={item} value={String(item)}>
                {piTierLabel(item)}
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                  {count}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        {rows.map((group) => (
          <TabsContent
            key={group.tier}
            value={String(group.tier)}
            forceMount
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
                    <TableHead className="text-right">总利润</TableHead>
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
                        {item.cost === null
                          ? item.costIncomplete
                            ? "缺原料价"
                            : "—"
                          : isk(item.cost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {item.revenue === null
                          ? item.revenueIncomplete
                            ? "未定价"
                            : "—"
                          : isk(item.revenue)}
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
                      <TableCell className="text-right tabular-nums">
                        {(() => {
                          const cap = caps.get(item.typeId) ?? 0;
                          if (
                            !hasStock ||
                            cap <= 0 ||
                            item.profit === null ||
                            item.outputQty <= 0
                          ) {
                            return (
                              <span className="text-muted-foreground/50">—</span>
                            );
                          }
                          const total = (item.profit / item.outputQty) * cap;
                          return (
                            <span
                              className={cn(
                                total >= 0 ? "text-emerald-400" : "text-rose-400",
                              )}
                            >
                              {isk(total)}
                            </span>
                          );
                        })()}
                      </TableCell>

                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        ))}
      </Tabs>
        </TabsContent>
      </Tabs>

      {/* 指定产物多选弹窗 */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>指定产物</DialogTitle>
            <DialogDescription>
              可多选，选中后会逐个列出它们的库存可合成结果。当前已选{" "}
              {focusTypeIds.length} 个。
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索产物名称 / ID"
              className="pl-8"
            />
          </div>

          <ScrollArea className="h-80 rounded-lg border border-border">
            <div className="flex flex-col gap-2.5 p-2">
              {pickerGroups.map((group) => (
                <section key={group.tier}>
                  <p className="mb-1 px-0.5 text-[10px] text-muted-foreground/70">
                    P{group.tier} · {group.items.length} 项
                  </p>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-1.5">
                    {group.items.map((product) => {
                      const active = focusTypeIds.includes(product.typeId);
                      return (
                        <button
                          key={product.typeId}
                          type="button"
                          onClick={() => toggleFocus(product.typeId)}
                          title={product.name}
                          className={cn(
                            "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                            active
                              ? "border-primary/60 bg-primary/10 text-primary"
                              : "border-border/70 bg-card/30 text-muted-foreground hover:bg-muted/50",
                          )}
                        >
                          <span
                            className={cn(
                              "grid size-3.5 shrink-0 place-items-center rounded-sm border text-[9px]",
                              active
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border",
                            )}
                          >
                            {active ? "✓" : ""}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {product.name}
                          </span>
                          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                            P{product.tier}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}

              {pickerGroups.every((group) => group.items.length === 0) && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  没有匹配的产物
                </p>
              )}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={focusTypeIds.length === 0}
              onClick={() => setFocusTypeIds([])}
            >
              清空
            </Button>
            <Button onClick={() => setPickerOpen(false)}>
              完成（{focusTypeIds.length}）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

