import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

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
  listCharacterOrders,
  listStructures,
  markStructureSync,
  removeStructure,
  saveCharacterOrders,
  saveStructureOrders,
  type CharacterOrderView,
  type MarketStructure,
  type OrdersPayload,
} from "../lib/db";
import BuildingIngest from "@/components/building-ingest";
import BuildingManager from "@/components/building-manager";
import MarketGroupBrowser from "@/components/market-group-browser";
import { describeError, useCharacters } from "../hooks/useCharacters";
import { MENU_ACCOUNT, type MenuKey } from "../lib/nav";
import { useUiStore, type MarketTab } from "../stores/ui-store";

function syncStatusLabel(status: string | null): string {
  switch (status) {
    case "ok":
      return "同步成功";
    case "running":
      return "同步中";
    case "error":
      return "同步失败";
    default:
      return "尚未同步";
  }
}

function formatIsk(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

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
  const [characterOrders, setCharacterOrders] = useState<CharacterOrderView[]>([]);
  const { marketTab, setMarketTab } = useUiStore();

  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [syncingMine, setSyncingMine] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MarketStructure | null>(null);
  /** 勾选待批量同步的建筑 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  /** 批量同步进度，null 表示未在批量同步 */
  const [batch, setBatch] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const activeCharacterId = activeCharacter?.character_id ?? null;

  const loadStructures = useCallback(async () => {
    // 只列出开放市场的建筑：无市场的建筑在这里同步不到任何订单
    setStructures(await listStructures(true));
  }, []);

  const loadMyOrders = useCallback(async () => {
    if (!activeCharacterId) {
      setCharacterOrders([]);
      return;
    }
    setCharacterOrders(await listCharacterOrders(activeCharacterId));
  }, [activeCharacterId]);

  useEffect(() => {
    if (loading || loadError) return;
    void (async () => {
      try {
        await loadStructures();
        await loadMyOrders();
        setActionError(null);
      } catch (err) {
        setActionError(describeError(err));
      }
    })();
  }, [loading, loadError, loadStructures, loadMyOrders]);

  /** 同步单个建筑的订单，返回是否成功（失败原因写入 actionError） */
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

  /** 批量同步勾选的建筑，串行执行避免触发 ESI 限流 */
  const handleSyncSelected = useCallback(async () => {
    const targets = structures.filter((item) =>
      selectedIds.has(item.structure_id),
    );
    if (targets.length === 0) return;

    setActionError(null);
    setBatch({ current: 0, total: targets.length });

    let succeeded = 0;

    for (let index = 0; index < targets.length; index += 1) {
      setBatch({ current: index + 1, total: targets.length });
      setSyncingId(targets[index].structure_id);

      const ok = await syncOne(targets[index]);
      if (ok) succeeded += 1;
    }

    setSyncingId(null);
    setBatch(null);
    setSelectedIds(new Set());
    await loadStructures();

    toast.success(`同步完成：成功 ${succeeded} / ${targets.length}`);
  }, [structures, selectedIds, syncOne, loadStructures]);

  const handleSyncMyOrders = useCallback(async () => {
    if (!activeCharacterId) {
      setActionError("请先在个人中心授权角色");
      return;
    }

    setSyncingMine(true);
    setActionError(null);
    try {
      const payload = await invoke<OrdersPayload>("sync_character_orders", {
        characterId: activeCharacterId,
      });
      await saveCharacterOrders(
        activeCharacterId,
        payload.orders,
        payload.fetchedAt,
      );
      await loadMyOrders();
      toast.success(`已同步 ${payload.orders.length.toLocaleString()} 条我的订单`);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSyncingMine(false);
    }
  }, [activeCharacterId, loadMyOrders]);

  const confirmRemove = useCallback(async () => {
    if (!pendingDelete) return;
    const { structure_id } = pendingDelete;
    setPendingDelete(null);
    setActionError(null);
    try {
      await removeStructure(structure_id);
      await loadStructures();
      toast.success("已删除星城及其订单");
    } catch (err) {
      setActionError(describeError(err));
    }
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
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1400px] flex-col">
      {actionError && (
        <Alert variant="destructive" className="mb-4">
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
          <TabsTrigger value="orders">我的订单</TabsTrigger>
          <TabsTrigger value="structures">同步市场订单</TabsTrigger>
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
              <Button
                size="sm"
                variant="outline"
                disabled={selectedIds.size === 0 || batch !== null}
                onClick={() => void handleSyncSelected()}
              >
                {batch
                  ? `同步中 ${batch.current}/${batch.total}`
                  : `同步选中 (${selectedIds.size})`}
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
                      {syncStatusLabel(structure.last_sync_status)}
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

        <TabsContent value="orders" className="mt-4 min-h-0 flex-1 overflow-auto">
        <Section
          title="我的订单"
          count={characterOrders.length}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={syncingMine}
              onClick={() => void handleSyncMyOrders()}
            >
              {syncingMine ? "同步中…" : "同步我的订单"}
            </Button>
          }
        >
          {characterOrders.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无数据</EmptyTitle>
                <EmptyDescription>
                  点击「同步我的订单」拉取当前角色挂出的买单与卖单。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">物品类型</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead className="text-right">单价 (ISK)</TableHead>
                  <TableHead className="text-right">剩余 / 总量</TableHead>
                  <TableHead className="text-right">托管 (ISK)</TableHead>
                  <TableHead>发布</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {characterOrders.map((order) => (
                  <TableRow key={order.order_id}>
                    <TableCell className="text-right font-mono tabular-nums">
                      {order.type_id}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          order.is_buy_order
                            ? "border-transparent bg-emerald-500/15 text-emerald-400"
                            : "border-transparent bg-amber-500/15 text-amber-400"
                        }
                      >
                        {order.is_buy_order ? "买单" : "卖单"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatIsk(order.price)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {order.volume_remain.toLocaleString()} /{" "}
                      {order.volume_total.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {order.escrow != null ? formatIsk(order.escrow) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTime(order.issued_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>

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
