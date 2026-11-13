import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCharacters } from "@/hooks/useCharacters";
import {
  getMyIndustry,
  syncCostIndex,
  syncMyBlueprints,
  syncMyJobs,
} from "@/lib/mfg/api";
import { cn } from "@/lib/utils";

import { duration, isk } from "./shared";

const ACTIVITY_LABEL: Record<number, string> = {
  1: "制造",
  3: "研究 TE",
  4: "研究 ME",
  5: "拷贝",
  8: "发明",
};

/** 我的工业：蓝图与工业任务 */
export default function MfgMyIndustryPage() {
  const queryClient = useQueryClient();
  const { characters } = useCharacters();
  const [characterId, setCharacterId] = useState<number | null>(null);

  useEffect(() => {
    const current = characters[0];
    if (characterId === null && current) setCharacterId(current.character_id);
  }, [characters, characterId]);

  const industryQuery = useQuery({
    queryKey: ["mfg-my-industry", characterId],
    queryFn: () => getMyIndustry(characterId as number),
    enabled: characterId !== null,
    staleTime: 30_000,
  });

  const blueprintMutation = useMutation({
    mutationFn: () => syncMyBlueprints(characterId as number),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["mfg-my-industry"] });
      toast.success(`已同步 ${result.synced} 张蓝图`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });

  const jobMutation = useMutation({
    mutationFn: () => syncMyJobs(characterId as number),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["mfg-my-industry"] });
      toast.success(`已同步 ${result.synced} 条任务`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });

  const costMutation = useMutation({
    mutationFn: syncCostIndex,
    onSuccess: (result) => toast.success(`成本指数已同步：${result.synced} 个星系`),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });

  const data = industryQuery.data;
  const busy =
    blueprintMutation.isPending || jobMutation.isPending || costMutation.isPending;

  if (characters.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/70">
        还没有绑定角色，先在「个人中心」添加。
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="flex flex-wrap gap-1">
          {characters.map((character) => (
            <button
              key={character.character_id}
              type="button"
              onClick={() => setCharacterId(character.character_id)}
              className={cn(
                "rounded border px-2 py-1 text-[11px] transition-colors",
                characterId === character.character_id
                  ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {character.name}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            disabled={busy || characterId === null}
            onClick={() => blueprintMutation.mutate()}
          >
            {blueprintMutation.isPending ? (
              <Spinner className="size-3" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            同步蓝图
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            disabled={busy || characterId === null}
            onClick={() => jobMutation.mutate()}
          >
            {jobMutation.isPending ? (
              <Spinner className="size-3" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            同步任务
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px]"
            disabled={busy}
            onClick={() => costMutation.mutate()}
            title="同步全星系成本指数（供制造地点使用）"
          >
            同步成本指数
          </Button>
        </div>
      </section>

      {industryQuery.isError && (
        <p className="text-[11px] text-rose-400">
          读取失败：
          {industryQuery.error instanceof Error
            ? industryQuery.error.message
            : String(industryQuery.error)}
        </p>
      )}

      {/* 任务 */}
      <section className="rounded-lg border border-border/70 bg-card/40 p-3">
        <h3 className="mb-1 text-[11px] font-medium text-foreground/80">
          工业任务 {data ? `(${data.jobs.length})` : ""}
        </h3>

        {!data || data.jobs.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground/60">
            没有任务。点「同步任务」从 ESI 拉取。
          </p>
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-[70px_minmax(0,1fr)_70px_90px_minmax(0,1fr)] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
              <span>动作</span>
              <span>产品</span>
              <span className="text-right">流程</span>
              <span className="text-right">剩余</span>
              <span>进度</span>
            </div>

            {data.jobs.map((job) => (
              <div
                key={job.jobId}
                className="grid grid-cols-[70px_minmax(0,1fr)_70px_90px_minmax(0,1fr)] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
              >
                <span className="text-muted-foreground">
                  {ACTIVITY_LABEL[job.activityId] ?? job.activityId}
                </span>
                <span className="min-w-0 truncate" title={job.name}>
                  {job.name}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {job.runs}
                </span>
                <span className="text-right font-mono tabular-nums text-cyan-300/90">
                  {job.remaining > 0 ? duration(job.remaining) : job.status}
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted/40">
                  <span
                    className="block h-full rounded-full bg-cyan-400/70"
                    style={{ width: `${Math.round(job.progress * 100)}%` }}
                  />
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 蓝图 */}
      <section className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border/70 bg-card/40 p-3">
        <h3 className="mb-1 shrink-0 text-[11px] font-medium text-foreground/80">
          我的蓝图 {data ? `(${data.blueprints.length})` : ""}
        </h3>

        {!data || data.blueprints.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground/60">
            没有蓝图。点「同步蓝图」从 ESI 拉取。
          </p>
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-[minmax(0,1fr)_60px_60px_70px_80px_90px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
              <span>蓝图（产物）</span>
              <span className="text-right">ME</span>
              <span className="text-right">TE</span>
              <span className="text-right">剩余</span>
              <span className="text-right">单件利润</span>
              <span className="text-right">每小时</span>
            </div>

            {data.blueprints.map((item) => (
              <div
                key={item.itemId}
                className="grid grid-cols-[minmax(0,1fr)_60px_60px_70px_80px_90px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate" title={item.name}>
                    {item.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1 text-[9px]",
                      item.isBpo
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-amber-500/15 text-amber-300",
                    )}
                  >
                    {item.isBpo ? "BPO" : "BPC"}
                  </span>
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {item.materialEfficiency}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {item.timeEfficiency}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {item.runs < 0 ? "∞" : item.runs}
                </span>
                <span
                  className={cn(
                    "text-right font-mono tabular-nums",
                    (item.profit ?? 0) >= 0
                      ? "text-emerald-300/90"
                      : "text-rose-300/90",
                  )}
                >
                  {isk(item.profit)}
                </span>
                <span className="text-right font-mono tabular-nums text-amber-300/90">
                  {isk(item.perHour)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
