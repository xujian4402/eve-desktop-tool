import { useEffect, type ComponentType } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Factory, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getMfgSdeStatus, syncMfgSde } from "@/lib/mfg/api";

import MfgCalculatorPage from "./manufacturing/MfgCalculatorPage";
import MfgLocationPage from "./manufacturing/MfgLocationPage";
import MfgMyIndustryPage from "./manufacturing/MfgMyIndustryPage";
import MfgNpcBpPage from "./manufacturing/MfgNpcBpPage";
import MfgPlanPage from "./manufacturing/MfgPlanPage";
import MfgRankPage from "./manufacturing/MfgRankPage";

/** 六个二级页面，对应参考项目的全部制造功能 */
const TABS: Array<[string, string, ComponentType]> = [
  ["calculator", "制造计算", MfgCalculatorPage],
  ["plan", "制造规划", MfgPlanPage],
  ["rank", "利润排行", MfgRankPage],
  ["location", "制造地点", MfgLocationPage],
  ["npc", "NPC 蓝图", MfgNpcBpPage],
  ["my", "我的工业", MfgMyIndustryPage],
];

/**
 * 制造业。
 *
 * 功能对齐参考项目（eve-market-tool）：
 * 制造计算（多级 BOM / 发明 / 制造地点）、制造规划、利润排行、
 * NPC 蓝图、我的工业。计算全部在 Rust 侧完成。
 */
export default function ManufacturingPage() {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ["mfg-sde-status"],
    queryFn: getMfgSdeStatus,
  });

  const syncMutation = useMutation({
    mutationFn: () => syncMfgSde(true),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["mfg-sde-status"] });
      void queryClient.invalidateQueries({ queryKey: ["mfg-products"] });

      toast.success(
        result.imported
          ? `SDE 已导入：${result.blueprints} 条配方（${result.elapsedMs} ms）`
          : "版本一致，已跳过导入",
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const status = statusQuery.data;
  const ready = status?.ready ?? false;

  // 首次进入或 SDE 版本变化（例如新增 NPC 蓝图数据）时自动导入
  const stale =
    !!status &&
    !!status.generatedAt &&
    status.generatedAt !== status.bundledAt;

  useEffect(() => {
    if (
      statusQuery.isSuccess &&
      status &&
      (!status.ready || stale) &&
      !syncMutation.isPending
    ) {
      syncMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusQuery.isSuccess, status?.ready, stale]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1280px] flex-1 flex-col">
      <header className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Factory className="size-5" />
            制造业
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            蓝图配方、成本核算、多级 BOM、规划与利润排行
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
            <Database className="size-3" />
            {statusQuery.isPending
              ? "读取 SDE 状态…"
              : ready
                ? `配方 ${status?.blueprints ?? 0} · 发明 ${status?.inventions ?? 0} · 类型 ${status?.types ?? 0}`
                : "SDE 未导入"}
          </span>

          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            {syncMutation.isPending ? (
              <Spinner className="size-3.5" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {syncMutation.isPending ? "导入中…" : "导入 SDE"}
          </Button>
        </div>
      </header>

      {statusQuery.isError && (
        <p className="mb-2 shrink-0 text-[11px] text-rose-400">
          读取 SDE 状态失败：
          {statusQuery.error instanceof Error
            ? statusQuery.error.message
            : String(statusQuery.error)}
        </p>
      )}

      {!ready && !statusQuery.isPending ? (
        <p className="text-[11px] text-muted-foreground/60">
          SDE 数据未导入，正在自动导入（约 0.2 秒）。
        </p>
      ) : (
        <Tabs
          defaultValue="calculator"
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList className="h-8 w-full shrink-0 justify-start gap-1 overflow-x-auto">
            {TABS.map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-7 shrink-0 px-2 text-[11px]"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          {TABS.map(([value, , Component]) => (
            <TabsContent
              key={value}
              forceMount
              value={value}
              className="mt-2 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            >
              <Component />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
