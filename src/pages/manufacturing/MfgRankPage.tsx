import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { rankMfg } from "@/lib/mfg/api";
import { cn } from "@/lib/utils";

import { duration, isk } from "./shared";

/**
 * 利润排行。
 *
 * 后端遍历全部配方，用本地最低卖价与 adjusted 兜底价估算利润，
 * 按「每小时利润」排序。
 */
export default function MfgRankPage() {
  const [me, setMe] = useState(10);
  const [te, setTe] = useState(20);
  const [activity, setActivity] = useState("manufacturing");
  const [minMargin, setMinMargin] = useState(0);
  const [limit, setLimit] = useState(100);

  const rankQuery = useQuery({
    queryKey: ["mfg-rank", me, te, activity, minMargin, limit],
    queryFn: () => rankMfg(me, te, activity, minMargin / 100, limit),
    staleTime: 2 * 60_000,
  });

  const items = rankQuery.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">类型</span>
          <Select value={activity} onValueChange={setActivity}>
            <SelectTrigger size="sm" className="h-8 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manufacturing">制造</SelectItem>
              <SelectItem value="reaction">反应</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">ME %</span>
          <Input
            type="number"
            min={0}
            max={10}
            value={me}
            onChange={(event) => setMe(Number(event.target.value) || 0)}
            className="h-8 w-20 text-xs tabular-nums"
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">TE %</span>
          <Input
            type="number"
            min={0}
            max={20}
            value={te}
            onChange={(event) => setTe(Number(event.target.value) || 0)}
            className="h-8 w-20 text-xs tabular-nums"
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            最低利润率 %
          </span>
          <Input
            type="number"
            value={minMargin}
            onChange={(event) => setMinMargin(Number(event.target.value) || 0)}
            className="h-8 w-24 text-xs tabular-nums"
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">显示条数</span>
          <Input
            type="number"
            min={10}
            max={500}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value) || 100)}
            className="h-8 w-24 text-xs tabular-nums"
          />
        </label>

        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          disabled={rankQuery.isFetching}
          onClick={() => void rankQuery.refetch()}
        >
          {rankQuery.isFetching ? (
            <Spinner className="size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          重新计算
        </Button>
      </section>

      {rankQuery.isError && (
        <p className="text-[11px] text-rose-400">
          计算失败：
          {rankQuery.error instanceof Error
            ? rankQuery.error.message
            : String(rankQuery.error)}
        </p>
      )}

      <section className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="grid grid-cols-[36px_minmax(0,1fr)_80px_80px_80px_80px_70px_70px_70px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
          <span>#</span>
          <span>产品</span>
          <span className="text-right">材料</span>
          <span className="text-right">作业费</span>
          <span className="text-right">总成本</span>
          <span className="text-right">收入</span>
          <span className="text-right">利润</span>
          <span className="text-right">利润率</span>
          <span className="text-right">每小时</span>
        </div>

        {rankQuery.isPending && (
          <p className="py-6 text-center text-[11px] text-muted-foreground/60">
            计算中…
          </p>
        )}

        {!rankQuery.isPending && items.length === 0 && (
          <p className="py-6 text-center text-[11px] text-muted-foreground/60">
            没有满足条件的产品。可降低最低利润率，或先同步市场订单与价格。
          </p>
        )}

        {items.map((item, index) => (
          <div
            key={item.productId}
            className="grid grid-cols-[36px_minmax(0,1fr)_80px_80px_80px_80px_70px_70px_70px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
          >
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {index + 1}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate" title={item.name}>
                {item.name}
              </span>
              {item.activity === "reaction" && (
                <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[9px] text-violet-300">
                  反应
                </span>
              )}
            </span>
            <span className="text-right font-mono tabular-nums text-muted-foreground">
              {isk(item.materialCost)}
            </span>
            <span className="text-right font-mono tabular-nums text-muted-foreground">
              {isk(item.jobCost)}
            </span>
            <span className="text-right font-mono tabular-nums">
              {isk(item.totalCost)}
            </span>
            <span className="text-right font-mono tabular-nums text-cyan-300/80">
              {isk(item.revenue)}
            </span>
            <span
              className={cn(
                "text-right font-mono tabular-nums",
                item.profit >= 0 ? "text-emerald-300/90" : "text-rose-300/90",
              )}
            >
              {isk(item.profit)}
            </span>
            <span
              className={cn(
                "text-right font-mono tabular-nums",
                item.margin >= 0 ? "text-emerald-300/80" : "text-rose-300/80",
              )}
            >
              {(item.margin * 100).toFixed(1)}%
            </span>
            <span className="text-right font-mono tabular-nums text-amber-300/90">
              {isk(item.perHour)}
            </span>
          </div>
        ))}
      </section>

      <p className="shrink-0 text-[10px] text-muted-foreground/50">
        共 {items.length} 条 · 按每小时利润排序 · 时长参考值：
        {items[0] ? duration(items[0].seconds) : "—"}
      </p>
    </div>
  );
}
