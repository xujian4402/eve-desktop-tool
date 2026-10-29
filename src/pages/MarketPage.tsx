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
  listStructureOrders,
  listStructures,
  markStructureSync,
  removeStructure,
  saveCharacterOrders,
  saveStructureOrders,
  type CharacterOrderView,
  type MarketStructure,
  type OrdersPayload,
  type StructureOrderView,
} from "../lib/db";
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
      <div className="mb-3 flex items-center gap-2">
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
  const [detailOrders, setDetailOrders] = useState<StructureOrderView[]>([]);
  const {
    marketTab,
    setMarketTab,
    marketDetailStructureId: detailStructureId,
    setMarketDetailStructureId: setDetailStructureId,
  } = useUiStore();

  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [syncingMine, setSyncingMine] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MarketStructure | null>(null);
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

  const handleSyncStructure = useCallback(
    async (structure: MarketStructure) => {
      const characterId = structure.auth_character_id ?? activeCharacterId;
      if (!characterId) {
        setActionError("请先在个人中心授权角色");
        return;
      }

      setSyncingId(structure.structure_id);
      setActionError(null);
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
        await loadStructures();
        if (detailStructureId === structure.structure_id) {
          setDetailOrders(await listStructureOrders(structure.structure_id));
        }
        toast.success(
          `已同步 ${payload.orders.length.toLocaleString()} 条订单${
            payload.truncated ? "（已达页数上限，结果可能不完整）" : ""
          }`,
        );
      } catch (err) {
        const message = describeError(err);
        await markStructureSync(
          structure.structure_id,
          "error",
          message,
          0,
          Date.now(),
        );
        await loadStructures();
        setActionError(message);
      } finally {
        setSyncingId(null);
      }
    },
    [activeCharacterId, detailStructureId, loadStructures],
  );

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
      if (detailStructureId === structure_id) {
        setDetailStructureId(null);
        setDetailOrders([]);
      }
      await loadStructures();
      toast.success("已删除星城及其订单");
    } catch (err) {
      setActionError(describeError(err));
    }
  }, [detailStructureId, loadStructures, pendingDelete, setDetailStructureId]);

  const handleShowDetail = useCallback(async (structureId: number) => {
    setActionError(null);
    try {
      setDetailStructureId(structureId);
      setDetailOrders(await listStructureOrders(structureId));
    } catch (err) {
      setActionError(describeError(err));
    }
  }, [setDetailStructureId]);

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
      <div className="mx-auto w-full max-w-[1080px]">
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
    <div className="mx-auto w-full max-w-[1080px]">
      {actionError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={marketTab}
        onValueChange={(value) => setMarketTab(value as MarketTab)}
      >
        <TabsList>
          <TabsTrigger value="structures">建筑订单</TabsTrigger>
          <TabsTrigger value="orders">我的订单</TabsTrigger>
          <TabsTrigger value="groups">物品分类</TabsTrigger>
          <TabsTrigger value="manage">建筑管理</TabsTrigger>
        </TabsList>

        <TabsContent value="structures" className="mt-4">
        <Section title="建筑订单" count={structures.length}>
          {structures.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>没有可同步的建筑</EmptyTitle>
                <EmptyDescription>
                  这里只列出开放市场的建筑。切到「建筑管理」录入或同步，
                  未开放市场的建筑不会出现在这里。
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => setMarketTab("manage")}>
                  去建筑管理
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
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
                  <TableRow key={structure.structure_id}>
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
                          onClick={() => void handleShowDetail(structure.structure_id)}
                        >
                          查看
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

        {detailStructureId !== null && (
          <Section title="建筑订单明细" count={detailOrders.length}>
            {detailOrders.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>该建筑还没有订单数据</EmptyTitle>
                  <EmptyDescription>点击上方的「同步」拉取订单后再查看。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground">
                  按单价排序，最多显示前 200 条。
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right">物品类型</TableHead>
                      <TableHead>方向</TableHead>
                      <TableHead className="text-right">单价 (ISK)</TableHead>
                      <TableHead className="text-right">剩余 / 总量</TableHead>
                      <TableHead className="text-right">最小量</TableHead>
                      <TableHead>范围</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detailOrders.map((order) => (
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
                          {order.min_volume.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {order.range}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </Section>
        )}

        </TabsContent>

        <TabsContent value="orders" className="mt-4">
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

        <TabsContent value="groups" className="mt-4">
          <MarketGroupBrowser />
        </TabsContent>

        <TabsContent value="manage" className="mt-4">
          <BuildingManager
            characterId={activeCharacterId}
            onSaved={loadStructures}
          />
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
