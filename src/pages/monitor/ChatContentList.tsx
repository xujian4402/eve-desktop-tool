import type { ChatLine } from "@/lib/monitor/api";

/**
 * 频道内容：把 Rust 端实时推送的聊天行按时间倒序展示。
 *
 * 与「命中记录」的区别：这里不筛选关键字，能直接确认程序是否读到了消息。
 */
export function ChatContentList({ lines }: { lines: ChatLine[] }) {
  if (lines.length === 0) {
    return (
      <div className="flex min-h-28 w-full flex-1 items-center justify-center px-3 py-6 text-center text-xs text-muted-foreground/70">
        还没有收到聊天内容。启动预警监控后，所选频道的新消息会实时出现在这里。
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-md border border-border/60">
      {lines.map((line, index) => (
        <div
          key={`${line.time}-${index}-${line.speaker}`}
          className="flex flex-col gap-0.5 border-b border-border/30 px-2.5 py-1 last:border-b-0"
        >
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span className="font-mono tabular-nums">
              {line.time.slice(11) || line.time}
            </span>
            <span className="rounded bg-cyan-500/15 px-1 text-cyan-300">
              {line.channel}
            </span>
            <span className="truncate text-foreground/80" title={line.speaker}>
              {line.speaker || "—"}
            </span>
          </div>

          <p className="break-words text-[11px] text-foreground/85" title={line.raw}>
            {line.message}
          </p>
        </div>
      ))}
    </div>
  );
}
