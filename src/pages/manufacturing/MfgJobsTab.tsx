import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeError } from "@/hooks/useCharacters";
import {
  listIndustryJobs,
  saveIndustryJobs,
  type EveCharacter,
  type IndustryJobRow,
} from "@/lib/db";
import {
  fetchCharacterIndustryJobs,
  fetchCorporationIndustryJobs,
  type JobFetchRow,
} from "@/lib/manufacturing/api";
import { formatDuration } from "@/lib/manufacturing/calc";
import { mfgTypeName, type MfgData } from "@/lib/manufacturing/data";
import { cn } from "@/lib/utils";

import "./MfgJobsTab.css";

/** activity_id → 中文 */
const ACTIVITY_LABEL: Record<number, string> = {
  1: "制造",
  3: "时间效率研究",
  4: "材料效率研究",
  5: "复制",
  8: "发明",
  9: "反应",
};

function jobProgress(job: IndustryJobRow, now: number): number {
  const start = Date.parse(job.start_date);
  const end = Date.parse(job.end_date);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return job.status === "delivered" ? 100 : 0;
  }
  return Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
}

/**
 * 生产队列：角色与军团两条来源。
 *
 * 军团作业需要角色具备工厂经理角色，否则 ESI 直接 403。
 */
export default function MfgJobsTab({
  characters,
  activeCharacterId,
  data,
}: {
  characters: EveCharacter[];
  activeCharacterId: number | null;
  data: MfgData | null;
}) {
  const [tab, setTab] = useState<string>("");
  const [scope, setScope] = useState<"character" | "corporation">("character");
  const [rows, setRows] = useState<IndustryJobRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const selected =
    tab || (activeCharacterId !== null ? String(activeCharacterId) : "");
  const character = characters.find(
    (item) => String(item.character_id) === selected,
  );

  // 进度条每秒走一次；作业少，重渲染成本可忽略
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(
    async (ownerId: number, kind: "character" | "corporation") => {
      try {
        setRows(await listIndustryJobs(ownerId, kind));
      } catch (err) {
        setError(describeError(err));
      }
    },
    [],
  );

  useEffect(() => {
    if (!selected) return;
    const ownerId =
      scope === "corporation"
        ? (character?.corporation_id ?? 0)
        : Number(selected);
    if (ownerId <= 0) {
      setRows([]);
      return;
    }
    void load(ownerId, scope);
  }, [selected, scope, character?.corporation_id, load]);

  const handleSync = async () => {
    if (!selected) return;

    setSyncing(true);
    setError(null);

    try {
      let fetched: JobFetchRow[] = [];

      if (scope === "corporation") {
        const corporationId = character?.corporation_id ?? null;
        if (!corporationId) {
          throw new Error("该角色没有军团信息，无法读取军团作业");
        }
        fetched = await fetchCorporationIndustryJobs(
          corporationId,
          Number(selected),
        );
      } else {
        fetched = await fetchCharacterIndustryJobs(Number(selected));
      }

      const ownerId =
        scope === "corporation"
          ? (character?.corporation_id as number)
          : Number(selected);

      await saveIndustryJobs(
        ownerId,
        scope,
        fetched.map((job) => ({
          job_id: job.jobId,
          installer_id: job.installerId,
          activity_id: job.activityId,
          blueprint_type_id: job.blueprintTypeId,
          product_type_id: job.productTypeId,
          facility_id: job.facilityId,
          runs: job.runs,
          licensed_runs: job.licensedRuns,
          cost: job.cost,
          probability: job.probability,
          status: job.status,
          start_date: job.startDate,
          end_date: job.endDate,
        })),
      );

      await load(ownerId, scope);
      toast.success(`已同步 ${fetched.length.toLocaleString()} 条生产作业`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Tabs
      value={selected}
      onValueChange={setTab}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="mfg-jobs-tab__toolbar">
        <TabsList className="h-auto flex-wrap">
          {characters.map((item) => (
            <TabsTrigger
              key={item.character_id}
              value={String(item.character_id)}
              className="shrink-0"
            >
              {item.name}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="inline-flex overflow-hidden rounded border border-border">
          {(
            [
              ["character", "角色作业"],
              ["corporation", "军团作业"],
            ] as const
          ).map(([value, label], index) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              className={cn(
                "px-2 py-1 text-[11px] transition-colors",
                index > 0 && "border-l border-border",
                scope === value
                  ? "bg-cyan-500/20 text-cyan-300"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8 text-xs"
          disabled={syncing || !selected}
          onClick={() => void handleSync()}
        >
          <RefreshCw className={syncing ? "animate-spin" : undefined} />
          {syncing ? "同步中…" : "同步队列"}
        </Button>
      </div>

      <TabsContent
        value={selected}
        className="mfg-jobs-tab mt-2 data-[state=inactive]:hidden"
      >
        {error && (
          <Alert variant="destructive" className="shrink-0">
            <AlertTitle>队列同步失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {rows.length === 0 ? (
          <p className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            没有进行中的作业。点右上角「同步队列」拉取。
          </p>
        ) : (
          <div className="mfg-jobs-tab__table">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>产物</TableHead>
                  <TableHead>活动</TableHead>
                  <TableHead className="text-right">流程</TableHead>
                  <TableHead>进度</TableHead>
                  <TableHead>剩余</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((job) => {
                  const percent = jobProgress(job, now);
                  const end = Date.parse(job.end_date);
                  const remain =
                    Number.isFinite(end) && end > now ? (end - now) / 1000 : 0;

                  return (
                    <TableRow key={job.job_id}>
                      <TableCell>
                        <span className="block">
                          {mfgTypeName(data, job.product_type_id)}
                        </span>
                        <span className="block font-mono text-[10px] text-muted-foreground/60">
                          {job.product_type_id}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {ACTIVITY_LABEL[job.activity_id] ?? job.activity_id}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {job.runs.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded bg-muted/60">
                            <div
                              className="h-full rounded bg-cyan-400/80"
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {percent.toFixed(0)}%
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {remain > 0 ? formatDuration(remain) : "已完成"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {job.status === "active"
                            ? "进行中"
                            : job.status === "ready"
                              ? "待交付"
                              : job.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
