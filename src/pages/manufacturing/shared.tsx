import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** 数字格式化：1.23B / 456.7M / 12.3K */
export function isk(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

/** 秒 → 1天2小时 */
export function duration(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0 秒";

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);

  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分`;
}

/** 指标格 */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose";
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/40 px-2.5 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-mono text-[13px] tabular-nums",
          tone === "emerald" && "text-emerald-300/90",
          tone === "rose" && "text-rose-300/90",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** 数字输入框（带标签） */
export function NumField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || min)}
        className="h-8 w-20 text-xs tabular-nums"
      />
    </label>
  );
}
