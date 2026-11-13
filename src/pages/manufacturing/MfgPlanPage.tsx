import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { Calculator, PackageSearch, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useCharacters } from "@/hooks/useCharacters";
import type { AssetsPayload } from "@/lib/db";

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
import {
  calculateMfg,
  DEFAULT_MFG_CONTEXT,
  expandMfgBom,
  searchMfgProducts,
  type MfgCalcContext,
} from "@/lib/mfg/api";

import { duration, isk, Stat } from "./shared";

interface PlanLine {
  key: string;
  productId: number;
  name: string;
  units: number;
  me: number;
  te: number;
  /** 是否把材料也自制 */
  build: boolean;
}

interface PlanResult {
  name: string;
  units: number;
  cost: number;
  revenue: number;
  profit: number;
  seconds: number;
  raw: Map<number, { name: string; quantity: number; subtotal: number | null }>;
}

/**
 * 制造规划：多个产品一起算，汇总购物清单。
 *
 * 与计算器的区别：这里关注「一批要造多少、总共要买什么」，
 * 单件参数仍走同一套 Rust 计算。
 */
export default function MfgPlanPage() {
  const [keyword, setKeyword] = useState("");
  const [lines, setLines] = useState<PlanLine[]>([]);
  const [result, setResult] = useState<PlanResult[] | null>(null);
  /** 选中的角色（库存来源） */
  const [characterId, setCharacterId] = useState<number | null>(null);
  /** type_id → 库存数量 */
  const [inventory, setInventory] = useState<Map<number, number>>(new Map());

  const { characters } = useCharacters();

  const inventoryMutation = useMutation({
    mutationFn: (id: number) =>
      invoke<AssetsPayload>("fetch_character_assets", { characterId: id }),
    onSuccess: (payload) => {
      const map = new Map<number, number>();

      for (const group of payload.groups) {
        for (const item of group.items) {
          map.set(item.typeId, (map.get(item.typeId) ?? 0) + item.quantity);
        }
      }

      setInventory(map);
      toast.success(`已导入库存：${payload.assetCount} 条资产`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });

  const productsQuery = useQuery({
    queryKey: ["mfg-products", keyword],
    queryFn: () => searchMfgProducts(keyword, 60),
    staleTime: 60_000,
  });

  const products = productsQuery.data ?? [];
  const context: MfgCalcContext = DEFAULT_MFG_CONTEXT;

  const addLine = (productId: number) => {
    const product = products.find((item) => item.productTypeId === productId);
    if (!product) return;

    setLines((current) => [
      ...current,
      {
        key: `${productId}-${Date.now()}`,
        productId,
        name: product.name,
        units: 1,
        me: 10,
        te: 20,
        build: false,
      },
    ]);
  };

  const planMutation = useMutation({
    mutationFn: async () => {
      const output: PlanResult[] = [];

      for (const line of lines) {
        const job = await calculateMfg(
          line.productId,
          line.units,
          line.me,
          line.te,
          context,
        );

        const bom = await expandMfgBom(
          line.productId,
          line.units,
          line.me,
          line.te,
          line.build ? [line.productId] : [],
          context,
        );

        const raw = new Map<
          number,
          { name: string; quantity: number; subtotal: number | null }
        >();

        for (const item of bom.raw) {
          const existing = raw.get(item.typeId);
          if (existing) {
            existing.quantity += item.quantity;
            existing.subtotal =
              existing.subtotal === null || item.subtotal === null
                ? null
                : existing.subtotal + item.subtotal;
          } else {
            raw.set(item.typeId, {
              name: item.name,
              quantity: item.quantity,
              subtotal: item.subtotal,
            });
          }
        }

        output.push({
          name: line.name,
          units: line.units,
          cost: job.totalCost,
          revenue: job.revenue ?? 0,
          profit: job.profit ?? 0,
          seconds: job.seconds,
          raw,
        });
      }

      return output;
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success(`已计算 ${data.length} 个产品`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });

  // 合并所有产品的购物清单
  const shopping = (() => {
    const map = new Map<
      number,
      { name: string; quantity: number; subtotal: number | null }
    >();

    for (const item of result ?? []) {
      for (const [typeId, line] of item.raw) {
        const existing = map.get(typeId);
        if (existing) {
          existing.quantity += line.quantity;
          existing.subtotal =
            existing.subtotal === null || line.subtotal === null
              ? null
              : existing.subtotal + line.subtotal;
        } else {
          map.set(typeId, { ...line });
        }
      }
    }

    return [...map.entries()].sort((a, b) => b[1].quantity - a[1].quantity);
  })();

  const totalCost = (result ?? []).reduce((sum, item) => sum + item.cost, 0);
  const totalRevenue = (result ?? []).reduce((sum, item) => sum + item.revenue, 0);
  const totalProfit = (result ?? []).reduce((sum, item) => sum + item.profit, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <section className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
        <label className="flex min-w-[200px] flex-1 flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">搜索产品</span>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="输入产品名后添加到规划"
              className="h-8 pl-7 text-xs"
            />
          </div>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">选择并添加</span>
          <Select
            value=""
            onValueChange={(value) => addLine(Number(value))}
            disabled={products.length === 0}
          >
            <SelectTrigger size="sm" className="h-8 w-[240px] text-xs">
              <SelectValue placeholder="请选择产品" />
            </SelectTrigger>
            <SelectContent>
              {products.map((item) => (
                <SelectItem
                  key={item.productTypeId}
                  value={String(item.productTypeId)}
                >
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            库存来源角色
          </span>
          <Select
            value={characterId === null ? "" : String(characterId)}
            onValueChange={(value) => setCharacterId(Number(value))}
          >
            <SelectTrigger size="sm" className="h-8 w-[180px] text-xs">
              <SelectValue placeholder="选择角色" />
            </SelectTrigger>
            <SelectContent>
              {characters.map((character) => (
                <SelectItem
                  key={character.character_id}
                  value={String(character.character_id)}
                >
                  {character.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          disabled={characterId === null || inventoryMutation.isPending}
          onClick={() => inventoryMutation.mutate(characterId as number)}
          title="从 ESI 读取该角色资产，用于抵扣购物清单"
        >
          {inventoryMutation.isPending ? (
            <Spinner className="size-3.5" />
          ) : (
            <PackageSearch className="size-3.5" />
          )}
          导入库存
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          disabled={lines.length === 0 || planMutation.isPending}
          onClick={() => planMutation.mutate()}
        >
          {planMutation.isPending ? (
            <Spinner className="size-3.5" />
          ) : (
            <Calculator className="size-3.5" />
          )}
          计算规划
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1 text-xs"
          disabled={lines.length === 0}
          onClick={() => {
            setLines([]);
            setResult(null);
          }}
        >
          <Trash2 className="size-3.5" />
          清空
        </Button>
      </section>

      {/* 规划行 */}
      <section className="rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="grid grid-cols-[minmax(0,1fr)_80px_70px_70px_70px_40px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
          <span>产品</span>
          <span className="text-right">数量</span>
          <span className="text-right">ME %</span>
          <span className="text-right">TE %</span>
          <span className="text-center">全自制</span>
          <span />
        </div>

        {lines.length === 0 && (
          <p className="py-3 text-center text-[11px] text-muted-foreground/60">
            还没有添加产品。先在上方搜索并选择产品。
          </p>
        )}

        {lines.map((line, index) => (
          <div
            key={line.key}
            className="grid grid-cols-[minmax(0,1fr)_80px_70px_70px_70px_40px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
          >
            <span className="min-w-0 truncate" title={line.name}>
              {line.name}
            </span>
            <Input
              type="number"
              min={1}
              value={line.units}
              onChange={(event) =>
                setLines((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, units: Math.max(1, Number(event.target.value) || 1) }
                      : item,
                  ),
                )
              }
              className="h-7 text-xs tabular-nums"
            />
            <Input
              type="number"
              min={0}
              max={10}
              value={line.me}
              onChange={(event) =>
                setLines((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, me: Number(event.target.value) || 0 }
                      : item,
                  ),
                )
              }
              className="h-7 text-xs tabular-nums"
            />
            <Input
              type="number"
              min={0}
              max={20}
              value={line.te}
              onChange={(event) =>
                setLines((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, te: Number(event.target.value) || 0 }
                      : item,
                  ),
                )
              }
              className="h-7 text-xs tabular-nums"
            />
            <span className="flex justify-center">
              <input
                type="checkbox"
                className="size-3.5 accent-cyan-400"
                checked={line.build}
                onChange={() =>
                  setLines((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, build: !item.build } : item,
                    ),
                  )
                }
                title="勾选后把该产品的材料也按自制展开"
              />
            </span>
            <button
              type="button"
              onClick={() =>
                setLines((current) => current.filter((_, i) => i !== index))
              }
              className="text-muted-foreground/60 hover:text-rose-300"
              title="移除"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </section>

      {/* 汇总 */}
      {result && result.length > 0 && (
        <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="总成本" value={isk(totalCost)} tone="rose" />
          <Stat label="总收入" value={isk(totalRevenue)} />
          <Stat
            label="总利润"
            value={isk(totalProfit)}
            tone={totalProfit >= 0 ? "emerald" : "rose"}
          />
          <Stat
            label="每批耗时"
            value={duration(
              result.reduce((sum, item) => sum + item.seconds, 0),
            )}
          />
        </section>
      )}

      {/* 产线甘特 */}
      {result && result.length > 0 && (
        <section className="rounded-lg border border-border/70 bg-card/40 p-3">
          <h3 className="mb-1 text-[11px] font-medium text-foreground/80">
            产线排程（按列表顺序串行）
          </h3>

          {(() => {
            const total = result.reduce((sum, item) => sum + item.seconds, 0) || 1;
            let offset = 0;

            return result.map((item) => {
              const start = offset;
              offset += item.seconds;

              return (
                <div
                  key={`${item.name}-${start}`}
                  className="flex items-center gap-2 py-0.5 text-[11px]"
                >
                  <span className="w-40 shrink-0 truncate text-muted-foreground">
                    {item.name}
                  </span>
                  <span className="relative h-3 flex-1 overflow-hidden rounded-sm bg-muted/30">
                    <span
                      className="absolute top-0 h-full rounded-sm bg-cyan-400/60"
                      style={{
                        left: `${(start / total) * 100}%`,
                        width: `${Math.max(1, (item.seconds / total) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {duration(item.seconds)}
                  </span>
                </div>
              );
            });
          })()}
        </section>
      )}

      {/* 购物清单 */}
      {shopping.length > 0 && (
        <section className="rounded-lg border border-border/70 bg-card/40 p-3">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[11px] font-medium text-foreground/80">
              购物清单（{shopping.length} 种）
            </h3>
            {inventory.size > 0 && (
              <span className="text-[10px] text-muted-foreground/60">
                已用角色资产抵扣
              </span>
            )}
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_90px_90px_90px_90px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
            <span>材料</span>
            <span className="text-right">需求</span>
            <span className="text-right">库存</span>
            <span className="text-right">实购</span>
            <span className="text-right">小计</span>
          </div>

          {shopping.map(([typeId, line]) => {
            const stock = inventory.get(typeId) ?? 0;
            const buy = Math.max(0, line.quantity - stock);
            const unit =
              line.subtotal !== null && line.quantity > 0
                ? line.subtotal / line.quantity
                : null;
            const buyCost = unit === null ? null : unit * buy;

            return (
              <div
                key={typeId}
                className="grid grid-cols-[minmax(0,1fr)_90px_90px_90px_90px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
              >
                <span className="min-w-0 truncate" title={line.name}>
                  {line.name}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {line.quantity.toLocaleString("zh-CN")}
                </span>
                <span
                  className={
                    stock > 0
                      ? "text-right font-mono tabular-nums text-emerald-300/80"
                      : "text-right font-mono tabular-nums text-muted-foreground/50"
                  }
                >
                  {stock > 0 ? stock.toLocaleString("zh-CN") : "—"}
                </span>
                <span className="text-right font-mono tabular-nums text-cyan-300/90">
                  {buy.toLocaleString("zh-CN")}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {isk(buyCost)}
                </span>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
