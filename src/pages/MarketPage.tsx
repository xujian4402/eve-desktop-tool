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
import { Progress } from "@/components/ui/progress";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  formatTime,
  listStructures,
  markStructureSync,
  removeStructure,
  saveStructureOrders,
  type MarketStructure,
  type OrdersPayload,
} from "../lib/db";
import BuildingIngest from "@/components/building-ingest";
import BuildingManager from "@/components/building-manager";
import CharacterOrdersPanel from "@/components/character-orders-panel";
import MarketGroupBrowser from "@/components/market-group-browser";
import OrderAnalysisPanel from "@/components/order-analysis-panel";
import StructureComparePanel from "@/components/structure-compare-panel";
import { describeError, useCharacters } from "../hooks/useCharacters";
import { MENU_ACCOUNT, type MenuKey } from "../lib/nav";
import { useUiStore, type MarketTab } from "../stores/ui-store";
import { useSyncStore } from "../stores/sync-store";
import { formatSyncStatus } from "@/lib/order-labels";



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
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-center gap-2 gap-y-2">
        <h2 className="text-sm font-semibold text-foreground/85">{title}</h2>
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

interface MarketPageProps {
  onNavigate: (menu: MenuKey) => void;
}

export default function MarketPage({ onNavigate }: MarketPageProps) {
  const { characters, activeCharacter, loading, loadError } = useCharacters();

  const [structures, setStructures] = useState<MarketStructure[]>([]);
  const { marketTab, setMarketTab, setPendingTypeId } = useUiStore();
  const { batch, revision, startBatch } = useSyncStore();

  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MarketStructure | null>(null);
  /** 勾选待批量同步的建筑 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const activeCharacterId = activeCharacter?.character_id ?? null;

  const loadStructures = useCallback(async () => {
    // 只列出开放市场的建筑：无市场的建筑在这里同步不到任何订单
    setStructures(await listStructures(true));
  }, []);

  // 每次切到「同步市场订单」标签都重新读取一次，
  // 保证在别处（录入 / 同步建筑）改过之后回来看到的是最新状态
  useEffect(() => {
    if (marketTab !== "structures") return;
    void loadStructures();
  }, [marketTab, loadStructures]);

  const [refreshing, setRefreshing] = useState(false);

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
      const characterId = structure.auth_character_id ?? activeCharacterId;
      if (!characterId) {
        setActionError("请先在个人中心授权角色");
        return false;
      }

      try {
        const payload = await invoke<OrdersPayload>("sync_structure_orders", {
          structureId: structure.structure_id,
          characterId,
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
        setActionError(`${structure.name ?? structure.structure_id}：${message}`);
        return false;
      }
    },
    [activeCharacterId, batch],
  );

  // 批量同步在 store 里跑，结束后通过 revision 通知页面刷新
  useEffect(() => {
    if (revision === 0) return;
    void loadStructures();
  }, [revision, loadStructures]);

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

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 正在打开本地数据库…
      </div>
    );
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>本地数据库不可用</AlertTitle>
        <AlertDescription>
          <p>{loadError}</p>
          <p className="text-muted-foreground">
            该页面需要在 Tauri 窗口中运行（<code>pnpm tauri dev</code>），
            纯浏览器打开 <code>pnpm dev</code> 无法访问 SQLite。
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  if (characters.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1400px]">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>需要先授权 EVE 角色</EmptyTitle>
            <EmptyDescription>
              市场数据依赖 EVE 官方接口，需要先在个人中心完成角色授权，
              应用才能读取你的订单和星城行情。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => onNavigate(MENU_ACCOUNT)}>前往个人中心</Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-1 flex-col">
      {actionError && (
        <Alert variant="destructive" className="mb-4 shrink-0">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={marketTab}
        onValueChange={(value) => setMarketTab(value as MarketTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="gap-1.5">
          <TabsTrigger value="groups">交易市场</TabsTrigger>
          <TabsTrigger value="compare">市场对比</TabsTrigger>
          <TabsTrigger value="structures">同步市场订单</TabsTrigger>
          <TabsTrigger value="orders">我的订单</TabsTrigger>
          <TabsTrigger value="analysis">订单分析</TabsTrigger>
        </TabsList>

        <TabsContent value="structures" className="mt-4 min-h-0 flex-1 overflow-auto">
        <Section
          title="同步市场订单"
          count={structures.length}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <BuildingIngest
                characterId={activeCharacterId}
                onSaved={loadStructures}
              />

              {batch && (
                <div className="flex items-center gap-2">
                  <Progress
                    value={(batch.current / Math.max(batch.total, 1)) * 100}
                    className="h-1.5 w-28"
                  />
                  <span className="font-mono text-[11px] tabular-nums text-cyan-300/80">
                    {batch.current}/{batch.total}
                  </span>
                  {batch.name && (
                    <span className="max-w-32 truncate text-[11px] text-muted-foreground">
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
                  void startBatch(targets, activeCharacterId);
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
                            ? new Set(
                                structures.map((item) => item.structure_id),
                              )
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
                          {syncingId === structure.structure_id ? "同步中…" : "同步"}
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

          <div
            id="building-manager"
            className="mt-6 border-t border-border/60 pt-5"
          >
            <BuildingManager
              characterId={activeCharacterId}
              onSaved={loadStructures}
            />
          </div>
        </TabsContent>

        {/* 滚动交给面板内部的表格区，这里只做高度传递 */}
        <TabsContent
          value="orders"
          forceMount
          className="mt-4 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <CharacterOrdersPanel
            characters={characters}
            activeCharacterId={activeCharacterId}
            onOpenType={(typeId) => {
              setPendingTypeId(typeId);
              setMarketTab("groups");
            }}
          />
        </TabsContent>

        <TabsContent value="analysis" className="mt-4 min-h-0 flex-1 overflow-auto">
          <OrderAnalysisPanel characters={characters} />
        </TabsContent>

        <TabsContent value="compare" className="mt-4 min-h-0 flex-1 overflow-auto">
          <StructureComparePanel />
        </TabsContent>

        <TabsContent value="groups" className="mt-4 min-h-0 flex-1">
          <MarketGroupBrowser characterId={activeCharacterId} />
        </TabsContent>
      </Tabs>

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
