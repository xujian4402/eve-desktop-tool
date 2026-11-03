import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, TrendingDown, TrendingUp } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listMarketTopGroups,
  listStructureSales,
  listStructures,
  type MarketStructure,
  type MarketTopGroup,
  type StructureSalesRow,
} from "@/lib/db";
import { describeError } from "@/hooks/useCharacters";
import { cn } from "@/lib/utils";

function isk(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function quantity(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

/** 销量榜：最高与最低各一张表 */
function SalesTable({
  title,
  hint,
  rows,
  tone,
}: {
  title: string;
  hint: string;
  rows: StructureSalesRow[];
  tone: "up" | "down";
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-border">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {tone === "up" ? (
            <TrendingUp className="size-3.5 text-emerald-400" />
          ) : (
            <TrendingDown className="size-3.5 text-amber-400" />
          )}
          {title}
        </span>
        <span className="text-[10px] text-muted-foreground/70">{hint}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto [&>[data-slot=table-container]]:overflow-visible">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>物品</TableHead>
              <TableHead className="text-right">成交量</TableHead>
              <TableHead className="text-right">剩余</TableHead>
              <TableHead className="text-right">挂单</TableHead>
              <TableHead className="text-right">均价</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={row.type_id}>
                <TableCell className="text-muted-foreground/60">
                  {index + 1}
                </TableCell>
                <TableCell>
                  <span className="block truncate" title={row.type_name ?? ""}>
                    {row.type_name ?? `#${row.type_id}`}
                  </span>
                  <span className="block font-mono text-[10px] text-muted-foreground/60">
                    {row.type_id}
                  </span>
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-mono tabular-nums",
                    tone === "up" ? "text-emerald-400" : "text-amber-300",
                  )}
                >
                  {quantity(row.sold_volume)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                  {quantity(row.remain_volume)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                  {row.order_count}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                  {isk(row.avg_price)}
                </TableCell>
              </TableRow>
            ))}

            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-8 text-center text-xs text-muted-foreground"
                >
                  暂无数据
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * 市场销量分析。
 *
 * ESI 不提供星城级别的历史销量，这里用订单的「总量 − 剩余量」作为代理指标：
 * 同一物品所有挂单中已被吃掉的数量，用来判断哪些货走得快、哪些几乎没人要。
 */
export default function MarketSalesPanel() {
  const [structures, setStructures] = useState<MarketStructure[]>([]);
  const [structureId, setStructureId] = useState<string>("");
  const [groups, setGroups] = useState<MarketTopGroup[]>([]);
  /** "0" 表示全部分类 */
  const [groupId, setGroupId] = useState<string>("0");
  const [rows, setRows] = useState<StructureSalesRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topN, setTopN] = useState("10");
  const [bottomN, setBottomN] = useState("10");

  useEffect(() => {
    void listMarketTopGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  const loadStructures = useCallback(async () => {
    const list = await listStructures(true);
    setStructures(list);
    setStructureId((current) => {
      if (current && list.some((item) => String(item.structure_id) === current)) {
        return current;
      }
      return list[0] ? String(list[0].structure_id) : "";
    });
  }, []);

  useEffect(() => {
    void loadStructures();
  }, [loadStructures]);

  const loadSales = useCallback(async (id: number, group: number) => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listStructureSales(id, group));
    } catch (err) {
      setError(describeError(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!structureId) {
      setRows([]);
      return;
    }
    void loadSales(Number(structureId), Number(groupId) || 0);
  }, [structureId, groupId, loadSales]);

  /** 只统计有成交的物品，"销量最低"才有意义 */
  const traded = useMemo(
    () => rows.filter((row) => row.sold_volume > 0),
    [rows],
  );

  const topCount = Math.max(1, Math.min(200, Number(topN) || 10));
  const bottomCount = Math.max(1, Math.min(200, Number(bottomN) || 10));

  const topRows = useMemo(
    () =>
      [...traded]
        .sort((a, b) => b.sold_volume - a.sold_volume)
        .slice(0, topCount),
    [traded, topCount],
  );

  const bottomRows = useMemo(
    () =>
      [...traded]
        .sort((a, b) => a.sold_volume - b.sold_volume)
        .slice(0, bottomCount),
    [traded, bottomCount],
  );

  if (structures.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>还没有可分析的建筑</EmptyTitle>
          <EmptyDescription>
            先在「同步市场订单」里录入并同步建筑，之后这里会基于订单数据做销量排行。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Select value={structureId} onValueChange={setStructureId}>
          <SelectTrigger size="sm" className="h-8 w-64 text-xs">
            <SelectValue placeholder="选择建筑" />
          </SelectTrigger>
          <SelectContent>
            {structures.map((item) => (
              <SelectItem
                key={item.structure_id}
                value={String(item.structure_id)}
              >
                {item.name ?? `#${item.structure_id}`}
                {item.solar_system_name ? ` · ${item.solar_system_name}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          type="button"
          onClick={() =>
            structureId &&
            void loadSales(Number(structureId), Number(groupId) || 0)
          }
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          title="重新读取该建筑的订单统计"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          刷新
        </button>

        <Select value={groupId} onValueChange={setGroupId}>
          <SelectTrigger
            size="sm"
            className="h-8 w-44 text-xs"
            title="按市场分类过滤物品（含子分类）"
          >
            <SelectValue placeholder="全部分类" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">全部分类</SelectItem>
            {groups.map((group) => (
              <SelectItem
                key={group.market_group_id}
                value={String(group.market_group_id)}
              >
                {group.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="ml-2 text-[11px] text-muted-foreground">
          最高 Top
        </span>
        <Input
          value={topN}
          onChange={(event) => setTopN(event.target.value)}
          inputMode="numeric"
          className="h-8 w-16 text-right text-xs"
          title="销量最高的前 N 个物品"
        />

        <span className="text-[11px] text-muted-foreground">最低 Top</span>
        <Input
          value={bottomN}
          onChange={(event) => setBottomN(event.target.value)}
          inputMode="numeric"
          className="h-8 w-16 text-right text-xs"
          title="销量最低的前 N 个物品"
        />

        <span className="text-[10px] text-muted-foreground/60">
          共 {traded.length} 种物品有成交记录
        </span>
      </div>

      {error && (
        <Alert variant="destructive" className="shrink-0">
          <AlertTitle>读取失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <p className="shrink-0 text-[10px] text-muted-foreground/60">
        销量 = 该建筑订单的「总量 − 剩余量」，代表这些挂单自创建以来成交的部分；
        仅统计有成交的物品。数据来自最近一次同步的建筑订单。
      </p>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <SalesTable
          title={`销量最高 Top ${topRows.length}`}
          hint="走得最快"
          rows={topRows}
          tone="up"
        />
        <SalesTable
          title={`销量最低 Top ${bottomRows.length}`}
          hint="几乎没人买"
          rows={bottomRows}
          tone="down"
        />
      </div>
    </div>
  );
}
