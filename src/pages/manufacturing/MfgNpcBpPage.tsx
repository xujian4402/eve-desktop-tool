import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { listNpcBlueprints } from "@/lib/mfg/api";

import { isk } from "./shared";

/** NPC 蓝图：军团售卖的蓝图与价格 */
export default function MfgNpcBpPage() {
  const [keyword, setKeyword] = useState("");

  const query = useQuery({
    queryKey: ["mfg-npc-blueprints", keyword],
    queryFn: () => listNpcBlueprints(keyword, 300),
    staleTime: 5 * 60_000,
  });

  const items = query.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
        <label className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            蓝图名称（留空显示价格最低的前 300 条）
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="例如：矮脚鸡 / 护卫舰"
              className="h-8 pl-7 text-xs"
            />
          </div>
        </label>

        <span className="pb-1 text-[10px] text-muted-foreground/60">
          共 {items.length} 条
        </span>
      </section>

      {query.isError && (
        <p className="text-[11px] text-rose-400">
          读取失败：
          {query.error instanceof Error ? query.error.message : String(query.error)}
        </p>
      )}

      <section className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="grid grid-cols-[minmax(0,1fr)_120px_90px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
          <span>蓝图</span>
          <span className="text-right">NPC 售价</span>
          <span className="text-right">售卖军团</span>
        </div>

        {query.isPending && (
          <p className="py-6 text-center text-[11px] text-muted-foreground/60">
            读取中…
          </p>
        )}

        {items.map((item) => (
          <div
            key={item.bpTypeId}
            className="grid grid-cols-[minmax(0,1fr)_120px_90px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
          >
            <span className="min-w-0 truncate" title={item.name}>
              {item.name}
            </span>
            <span className="text-right font-mono tabular-nums text-cyan-300/90">
              {isk(item.price)} ISK
            </span>
            <span className="text-right font-mono tabular-nums text-muted-foreground">
              {item.corpCount}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
