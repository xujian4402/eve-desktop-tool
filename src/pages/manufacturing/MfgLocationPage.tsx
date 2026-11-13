import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

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
import { locateMfg, searchMfgProducts, syncCostIndex } from "@/lib/mfg/api";

import { isk } from "./shared";

/** 制造地点：按星系成本指数排序 */
export default function MfgLocationPage() {
  const queryClient = useQueryClient();

  const [keyword, setKeyword] = useState("");
  const [productId, setProductId] = useState<number | null>(null);
  const [minSecurity, setMinSecurity] = useState(0);
  const [limit, setLimit] = useState(50);

  const productsQuery = useQuery({
    queryKey: ["mfg-products", keyword],
    queryFn: () => searchMfgProducts(keyword, 60),
    staleTime: 60_000,
  });

  const locationQuery = useQuery({
    queryKey: ["mfg-location-page", productId, minSecurity, limit],
    queryFn: () => locateMfg(productId as number, 10, 20, minSecurity, limit),
    enabled: productId !== null,
    retry: false,
    staleTime: 2 * 60_000,
  });

  const syncMutation = useMutation({
    mutationFn: syncCostIndex,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ["mfg-location-page"],
      });
      toast.success(`成本指数已同步：${result.synced} 个星系`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const products = productsQuery.data ?? [];
  const items = locationQuery.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
        <label className="flex min-w-[180px] flex-1 flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">产品搜索</span>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="例如：矮脚鸡"
              className="h-8 pl-7 text-xs"
            />
          </div>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">选择产品</span>
          <Select
            value={productId === null ? "" : String(productId)}
            onValueChange={(value) => setProductId(Number(value))}
          >
            <SelectTrigger
              size="sm"
              className="h-8 w-[240px] text-xs"
              disabled={products.length === 0}
            >
              <SelectValue placeholder="请选择" />
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
          <span className="text-[10px] text-muted-foreground">最低安等</span>
          <Input
            type="number"
            step={0.1}
            value={minSecurity}
            onChange={(event) =>
              setMinSecurity(Number(event.target.value) || 0)
            }
            className="h-8 w-20 text-xs tabular-nums"
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">显示条数</span>
          <Input
            type="number"
            min={10}
            max={300}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value) || 50)}
            className="h-8 w-24 text-xs tabular-nums"
          />
        </label>

        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          disabled={syncMutation.isPending}
          onClick={() => syncMutation.mutate()}
          title="从 ESI 拉取全星系成本指数（约 5000 个星系）"
        >
          {syncMutation.isPending ? (
            <Spinner className="size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          同步成本指数
        </Button>
      </section>

      {locationQuery.isError && (
        <p className="text-[11px] text-rose-400">
          {locationQuery.error instanceof Error
            ? locationQuery.error.message
            : String(locationQuery.error)}
        </p>
      )}

      {productId === null && (
        <p className="text-[11px] text-muted-foreground/60">
          选择一个产品后，按星系成本指数从低到高列出作业费最便宜的制造地点。
        </p>
      )}

      <section className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="grid grid-cols-[36px_minmax(0,1fr)_80px_90px_110px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
          <span>#</span>
          <span>星系</span>
          <span className="text-right">安等</span>
          <span className="text-right">成本指数</span>
          <span className="text-right">作业费</span>
        </div>

        {locationQuery.isFetching && (
          <p className="py-6 text-center text-[11px] text-muted-foreground/60">
            查询中…
          </p>
        )}

        {!locationQuery.isFetching && productId !== null && items.length === 0 && (
          <p className="py-6 text-center text-[11px] text-muted-foreground/60">
            没有数据。先点「同步成本指数」，或放宽最低安等。
          </p>
        )}

        {items.map((item, index) => (
          <div
            key={item.solarSystemId}
            className="grid grid-cols-[36px_minmax(0,1fr)_80px_90px_110px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
          >
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {index + 1}
            </span>
            <span className="truncate">{item.name}</span>
            <span className="text-right font-mono tabular-nums text-muted-foreground">
              {item.security.toFixed(2)}
            </span>
            <span className="text-right font-mono tabular-nums text-muted-foreground">
              {(item.costIndex * 100).toFixed(2)}%
            </span>
            <span className="text-right font-mono tabular-nums text-cyan-300/90">
              {isk(item.jobCost)}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
