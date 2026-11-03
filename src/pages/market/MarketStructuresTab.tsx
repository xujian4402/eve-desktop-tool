import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import BuildingIngest from "@/components/building-ingest";
import BuildingManager from "@/components/building-manager";
import {
  formatTime,
  listStructures,
  markStructureSync,
  removeStructure,
  saveStructureOrders,
  type MarketStructure,
  type OrdersPayload,
} from "@/lib/db";
import { describeError } from "@/hooks/useCharacters";
import { formatSyncStatus } from "@/lib/order-labels";
import { useSyncStore } from "@/stores/sync-store";

import "./MarketStructuresTab.css";

/** 带标题与数量的分区 */
function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="market-structures-tab__section">
      <div className="market-structures-tab__section-head">
        <h2 className="market-structures-tab__section-title">{title}</h2>
        {count !== undefined && (
          <Badge variant="secondary" className="text-[11px] tabular-nums">
            {count}
          </Badge>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * 同步市场订单。
 *
 * 只列出开放市场的建筑：用右上角「录入建筑」添加，
 * 之后可以单个同步或勾选批量同步，订单数据落本地库供其它页面使用。
 */
export default function MarketStructuresTab({
  characterId,
}: {
  characterId: number | null;
}) {
  const [structures, setStructures] = useState<MarketStructure[]>([]);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<MarketStructure | null>(null);
  /** 勾选待批量同步的建筑 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { batch, revision, startBatch } = useSyncStore();

  const loadStructures = useCallback(async () => {
    setStructures(await listStructures(true));
  }, []);

  useEffect(() => {
    void loadStructures();
  }, [loadStructures]);

  // 批量同步在 store 里跑，结束后通过 revision 通知本页刷新
  useEffect(() => {
    if (revision === 0) return;
    void loadStructures();
  }, [revision, loadStructures]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadStructures();
    } finally {
      setRefreshing(false);
    }
  }, [loadStructures]);

  const syncOne = useCallback(
    async (structure: MarketStructure): Promise<boolean> => {
      const authId = structure.auth_character_id ?? characterId;
      if (!authId) {
        setActionError("请先在个人中心授权角色");
        return false;
      }

      try {
        const payload = await invoke<OrdersPayload>("sync_structure_orders", {
          structureId: structure.structure_id,
          characterId: authId,
        });
        await saveStructureOrders(
          structure.structure_id,
          payload.orders,
          payload.fetchedAt,
        );
        await markStructureSync(
          structure.structure_id,
          "ok",
          null,
          payload.orders.length,
          payload.fetchedAt,
        );

        if (!batch) {
          toast.success(
            `已同步 ${payload.orders.length.toLocaleString()} 条订单${
              payload.truncated ? "（已达页数上限，结果不完整）" : ""
            }`,
          );
        }

        return true;
      } catch (err) {
        const message = describeError(err);
        await markStructureSync(
          structure.structure_id,
          "error",
          message,
          0,
          Date.now(),
        );
        setActionError(
          `${structure.name ?? structure.structure_id}：${message}`,
        );
        return false;
      }
    },
    [characterId, batch],
  );

  const handleSyncStructure = useCallback(
    async (structure: MarketStructure) => {
      setSyncingId(structure.structure_id);
      setActionError(null);
      try {
        await syncOne(structure);
        await loadStructures();
      } finally {
        setSyncingId(null);
      }
    },
    [loadStructures, syncOne],
  );

  const confirmRemove = useCallback(async () => {
    if (pendingDelete === null) return;

    const structureId = pendingDelete.structure_id;
    setPendingDelete(null);

    await removeStructure(structureId);
    await loadStructures();
  }, [loadStructures, pendingDelete]);

  return (
    <div className="market-structures-tab">
      {actionError && (
        <Alert variant="destructive" className="mb-4 shrink-0">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Section
        title="同步市场订单"
        count={structures.length}
        action={
          <div className="market-structures-tab__toolbar">
            <BuildingIngest characterId={characterId} onSaved={loadStructures} />

            {batch && (
              <div className="market-structures-tab__progress">
                <Progress
                  value={(batch.current / Math.max(batch.total, 1)) * 100}
                  className="h-1.5 w-28"
                />
                <span className="font-mono text-[11px] tabular-nums text-cyan-300/80">
                  {batch.current}/{batch.total}
                </span>
                {batch.name && (
                  <span className="market-structures-tab__progress-name">
                    {batch.name}
                  </span>
                )}
              </div>
            )}

            <Button
              size="sm"
              variant="ghost"
              disabled={refreshing || batch !== null}
              title="重新读取本地建筑与同步状态"
              onClick={() => void handleRefresh()}
            >
              <RefreshCw
                className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
              />
              刷新列表
            </Button>

            <Button
              size="sm"
              variant="outline"
              disabled={selectedIds.size === 0 || batch !== null}
              onClick={() => {
                const targets = structures.filter((item) =>
                  selectedIds.has(item.structure_id),
                );
                setSelectedIds(new Set());
                void startBatch(targets, characterId);
              }}
            >
              {batch ? "同步中…" : `同步选中 (${selectedIds.size})`}
            </Button>
          </div>
        }
      >
        {structures.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有可同步的建筑</EmptyTitle>
              <EmptyDescription>
                这里只列出开放市场的建筑。用右上角的「录入建筑」添加，
                未开放市场的建筑不会出现在这里。
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                onClick={() => {
                  document
                    .getElementById("building-ingest")
                    ?.querySelector("input")
                    ?.focus();
                }}
              >
                录入建筑
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="全选"
                    checked={
                      selectedIds.size === 0
                        ? false
                        : selectedIds.size === structures.length
                          ? true
                          : "indeterminate"
                    }
                    onCheckedChange={(checked) =>
                      setSelectedIds(
                        checked
                          ? new Set(structures.map((item) => item.structure_id))
                          : new Set(),
                      )
                    }
                  />
                </TableHead>
                <TableHead>建筑</TableHead>
                <TableHead>星系</TableHead>
                <TableHead className="text-right">订单数</TableHead>
                <TableHead>上次同步</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {structures.map((structure) => (
                <TableRow
                  key={structure.structure_id}
                  data-state={
                    selectedIds.has(structure.structure_id)
                      ? "selected"
                      : undefined
                  }
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`选择 ${structure.name ?? structure.structure_id}`}
                      checked={selectedIds.has(structure.structure_id)}
                      onCheckedChange={(checked) =>
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(structure.structure_id);
                          else next.delete(structure.structure_id);
                          return next;
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <span className="block text-foreground">
                      {structure.name ?? `#${structure.structure_id}`}
                    </span>
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {structure.structure_id}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {structure.solar_system_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {structure.order_count.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTime(structure.last_synced_at)}
                  </TableCell>
                  <TableCell
                    className={
                      structure.last_sync_status === "error"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                    title={structure.last_sync_error ?? undefined}
                  >
                    {formatSyncStatus(structure.last_sync_status)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={syncingId === structure.structure_id}
                        onClick={() => void handleSyncStructure(structure)}
                      >
                        {syncingId === structure.structure_id
                          ? "同步中…"
                          : "同步"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setPendingDelete(structure)}
                      >
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <div id="building-manager" className="market-structures-tab__manager">
        <BuildingManager characterId={characterId} onSaved={loadStructures} />
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除建筑？</AlertDialogTitle>
            <AlertDialogDescription>
              将从本地移除「{pendingDelete?.name ?? "该建筑"}」及其已同步的订单数据，
              此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRemove()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
