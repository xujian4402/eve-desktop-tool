import type { MonitorHit } from "@/lib/monitor/api";

/**
 * 命中记录列表：战斗与预警共用，只是过滤条件不同。
 *
 * 展示时间、命中的关键字、目标（或频道）与原始行，最多 300 条。
 */
export function MonitorHitList({
  hits,
  emptyText,
  showChannel = false,
}: {
  hits: MonitorHit[];
  emptyText: string;
  /** 聊天命中时把频道名单独标出 */
  showChannel?: boolean;
}) {
  if (hits.length === 0) {
    // 空状态占满整个列表区，文字居中，不画边框，避免出现「小框 + 大片空白」
    return (
      <div className="flex min-h-28 w-full flex-1 items-center justify-center px-3 py-6 text-center text-xs text-muted-foreground/70">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-md border border-border/70">
      {hits.map((hit, index) => (
        <div
          key={`${hit.time}-${index}-${hit.target}`}
          className="flex flex-col gap-1 border-b border-border/40 px-2.5 py-1.5 last:border-b-0"
        >
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span className="font-mono tabular-nums">{hit.time}</span>
            {showChannel && (
              <span className="rounded bg-cyan-500/15 px-1 text-cyan-300">
                {hit.target}
              </span>
            )}
            <span className="rounded bg-rose-500/15 px-1 text-rose-300">
              {hit.keyword}
            </span>
            {(hit.count ?? 1) > 1 && (
              <span className="rounded bg-amber-500/15 px-1 text-amber-300">
                ×{hit.count}
              </span>
            )}
            <span className="ml-auto truncate opacity-60" title={hit.source}>
              {hit.source}
            </span>
          </div>

          <p className="truncate text-[11px] text-foreground/80" title={hit.raw}>
            {hit.raw}
          </p>
        </div>
      ))}
    </div>
  );
}
