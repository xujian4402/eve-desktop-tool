import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  getCharacterScopes,
  getTypeGroupNameMap,
  type AssetsPayload,
  type EveCharacter,
} from "@/lib/db";
import { describeError, useCharacters } from "@/hooks/useCharacters";
import {
  LOCATION_KIND_LABEL,
  formatLocationFlag,
} from "@/lib/location-flags";
import { useUiStore, type AccountTab } from "@/stores/ui-store";
import { cn } from "@/lib/utils";

/**
 * 当前功能真正依赖的作用域。授权时实际申请的是 ESI 全部权限（见 Rust 侧 SCOPES），
 * 这里只用于提示「哪些关键权限缺失会导致功能不可用」。
 */
const KEY_SCOPES: { scope: string; purpose: string }[] = [
  { scope: "publicData", purpose: "读取角色、军团、联盟等公开信息" },
  {
    scope: "esi-markets.read_character_orders.v1",
    purpose: "读取角色自己挂出的买单与卖单",
  },
  {
    scope: "esi-markets.structure_markets.v1",
    purpose: "读取星城等玩家建筑的市场订单",
  },
  {
    scope: "esi-universe.read_structures.v1",
    purpose: "解析建筑名称与所在星系",
  },
  {
    scope: "esi-search.search_structures.v1",
    purpose: "按名称搜索建筑",
  },
  {
    scope: "esi-assets.read_assets.v1",
    purpose: "读取角色资产并按建筑分组展示",
  },
  {
    scope: "esi-location.read_location.v1",
    purpose: "读取角色当前停靠的建筑",
  },
];


/** 每页展示的物品条数 */
const ASSET_PAGE_SIZE = 50;

/** 拍平后的一行物品（带所属位置） */
interface AssetRow {
  typeId: number;
  typeName: string | null;
  quantity: number;
  locationFlag: string;
  isBlueprintCopy: boolean;
  locationId: number;
  locationName: string;
  locationKind: string;
  /** 该位置下所有物品的总件数 */
  locationTotal: number;
}

/**
 * 授权等待的分阶段提示。
 * 桌面端无法感知浏览器标签页是否被关闭，只能在等待过久时主动引导用户取消。
 */
function loginHint(seconds: number): { text: string; warn: boolean } {
  if (seconds < 12) return { text: "正在打开浏览器", warn: false };
  if (seconds < 45) return { text: "请在浏览器中完成授权", warn: false };
  return { text: "浏览器页面已关闭？请点「取消」重试", warn: true };
}

export default function AccountPage() {
  const { accountTab, setAccountTab } = useUiStore();
  const {
    characters,
    activeCharacter,
    loading,
    loadError,
    authorizing,
    actionError,
    login,
    switchTo,
    remove,
  } = useCharacters();

  const [pendingUnbind, setPendingUnbind] = useState<EveCharacter | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);

  // 授权等待计时：用于分阶段提示与「等待过久」的引导
  useEffect(() => {
    if (!authorizing) {
      setWaitSeconds(0);
      return;
    }

    setWaitSeconds(0);
    const timer = setInterval(() => setWaitSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [authorizing]);

  const waitHint = loginHint(waitSeconds);

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
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1080px]">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">个人中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理已授权的 EVE 角色、资产与权限
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {authorizing ? (
            <>
              <Spinner className="size-3.5" />
              <span
                className={cn(
                  "text-xs tabular-nums",
                  waitHint.warn ? "text-amber-400" : "text-muted-foreground",
                )}
              >
                {waitHint.text} · {waitSeconds}s
              </span>
              <Button
                variant="outline"
                onClick={() => {
                  void invoke("eve_cancel_login");
                  toast.info("已取消授权");
                }}
              >
                取消
              </Button>
            </>
          ) : (
            <Button
              onClick={() => {
                void login()
                  .then((result) => toast.success(`已添加角色：${result.name}`))
                  .catch(() => {
                    // 失败原因由 actionError 统一展示
                  });
              }}
            >
              添加角色
            </Button>
          )}
        </div>
      </header>

      {/* 用户主动取消不算失败，已在点击时 toast 提示，这里不再重复展示 */}
      {actionError && !actionError.includes("已取消") && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={accountTab}
        onValueChange={(value) => setAccountTab(value as AccountTab)}
      >
        <TabsList>
          <TabsTrigger value="characters">角色</TabsTrigger>
          <TabsTrigger value="assets">资产</TabsTrigger>
          <TabsTrigger value="permissions">权限</TabsTrigger>
        </TabsList>

        <TabsContent value="characters" className="mt-4">
          {characters.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>还没有绑定角色</EmptyTitle>
                <EmptyDescription>
                  点击右上角「添加角色」，会在系统浏览器中打开 EVE 官方登录页。
                  授权完成后自动返回，凭据加密保存在本机系统凭据库中。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {characters.map((character) => {
                const isActive =
                  character.character_id === activeCharacter?.character_id;

                return (
                  <Item
                    key={character.character_id}
                    variant="outline"
                    className="bg-card/60"
                  >
                    <ItemMedia>
                      <Avatar className="size-10">
                        {character.portrait_url && (
                          <AvatarImage
                            src={character.portrait_url}
                            alt={character.name}
                          />
                        )}
                        <AvatarFallback>
                          {character.name.slice(0, 1)}
                        </AvatarFallback>
                      </Avatar>
                    </ItemMedia>

                    <ItemContent>
                      <ItemTitle>
                        {character.name}
                        {isActive && <Badge variant="secondary">当前</Badge>}
                      </ItemTitle>
                      <p className="text-xs text-muted-foreground">
                        {character.corporation_name ?? "未知军团"}
                        {character.alliance_name
                          ? ` · ${character.alliance_name}`
                          : ""}
                      </p>
                    </ItemContent>

                    <ItemActions>
                      {!isActive && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void switchTo(character.character_id)}
                        >
                          设为当前
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setPendingUnbind(character)}
                      >
                        解绑
                      </Button>
                    </ItemActions>
                  </Item>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="assets" className="mt-4">
          <AssetsPanel characterId={activeCharacter?.character_id ?? null} />
        </TabsContent>

        <TabsContent value="permissions" className="mt-4">
          <PermissionsPanel
            characterId={activeCharacter?.character_id ?? null}
            characterName={activeCharacter?.name ?? null}
          />
        </TabsContent>
      </Tabs>

      <AlertDialog
        open={pendingUnbind !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUnbind(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解绑角色？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{pendingUnbind?.name ?? "该角色"}」在本机的授权凭据与角色记录。
              之后如需使用，需要重新授权。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingUnbind;
                setPendingUnbind(null);
                if (!target) return;

                void (async () => {
                  try {
                    await remove(target.character_id);
                    toast.success("已解绑角色");
                  } catch {
                    // 失败原因由 useCharacters 统一写入 actionError
                  }
                })();
              }}
            >
              解绑
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AssetsPanel({ characterId }: { characterId: number | null }) {
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  /** 位置过滤：null 表示全部位置 */
  const [locationFilter, setLocationFilter] = useState<number | null>(null);

  const query = useQuery({
    queryKey: ["assets", characterId],
    queryFn: () =>
      invoke<AssetsPayload>("fetch_character_assets", { characterId }),
    enabled: characterId !== null,
    staleTime: 60_000,
  });

  // 物品所属市场分类（本地 SDE 数据，一次加载长期缓存）
  const groupNamesQuery = useQuery({
    queryKey: ["type-group-names"],
    queryFn: getTypeGroupNameMap,
    staleTime: 5 * 60_000,
  });

  const groupNames = groupNamesQuery.data ?? {};

  /** 把分组结构拍平成「一物一行」 */
  const allRows = useMemo<AssetRow[]>(() => {
    const groups = query.data?.groups ?? [];
    const rows: AssetRow[] = [];

    for (const group of groups) {
      for (const item of group.items) {
        rows.push({
          typeId: item.typeId,
          typeName: item.typeName,
          quantity: item.quantity,
          locationFlag: item.locationFlag,
          isBlueprintCopy: item.isBlueprintCopy,
          locationId: group.locationId,
          locationName: group.locationName,
          locationKind: group.locationKind,
          locationTotal: group.totalQuantity,
        });
      }
    }

    return rows;
  }, [query.data]);

  /** 可选位置（去重，按名称排序） */
  const locations = useMemo(() => {
    const map = new Map<number, { id: number; name: string; kind: string }>();

    for (const row of allRows) {
      if (!map.has(row.locationId)) {
        map.set(row.locationId, {
          id: row.locationId,
          name: row.locationName,
          kind: row.locationKind,
        });
      }
    }

    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [allRows]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();

    return allRows.filter((row) => {
      if (locationFilter !== null && row.locationId !== locationFilter) {
        return false;
      }
      if (!kw) return true;

      return (
        (row.typeName ?? "").toLowerCase().includes(kw) ||
        String(row.typeId).includes(kw) ||
        row.locationName.toLowerCase().includes(kw)
      );
    });
  }, [allRows, keyword, locationFilter]);

  // 过滤条件变化时回到第一页
  useEffect(() => {
    setPage(0);
  }, [keyword, characterId, locationFilter]);

  // 切换角色时清空位置过滤，避免残留上一个角色的选择
  useEffect(() => {
    setLocationFilter(null);
  }, [characterId]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ASSET_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(
    safePage * ASSET_PAGE_SIZE,
    (safePage + 1) * ASSET_PAGE_SIZE,
  );

  if (characterId === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>需要先授权角色</EmptyTitle>
          <EmptyDescription>
            在「角色」标签页添加 EVE 角色后即可查看资产。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>获取资产失败</AlertTitle>
        <AlertDescription>{describeError(query.error)}</AlertDescription>
      </Alert>
    );
  }

  const data = query.data;

  return (
    <div className="flex flex-col gap-3">
      {data.truncated && (
        <Alert>
          <AlertTitle>资产数量超过上限</AlertTitle>
          <AlertDescription>
            仅拉取了前 5 万条资产，部分物品可能没有显示。
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="按物品名称、类型 ID 或位置搜索"
            className="pl-8"
          />
        </div>

        <select
          className="h-9 max-w-56 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          value={locationFilter ?? ""}
          onChange={(event) =>
            setLocationFilter(Number(event.target.value) || null)
          }
        >
          <option value="">全部位置（{locations.length}）</option>
          {locations.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>

        <span className="text-sm text-muted-foreground">
          {keyword.trim() || locationFilter !== null
            ? `匹配 ${filtered.length.toLocaleString()} 条`
            : `共 ${data.assetCount.toLocaleString()} 条物品，分布在 ${data.groups.length} 个位置`}
        </span>

        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
          重新获取
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>没有匹配的物品</EmptyTitle>
            <EmptyDescription>换个关键字试试，或清空搜索框查看全部。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>物品</TableHead>
                  <TableHead>分类</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead>位置</TableHead>
                  <TableHead className="text-right">位置总量</TableHead>
                  <TableHead>槽位</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => (
                  <TableRow
                    key={`${row.locationId}-${row.typeId}-${row.locationFlag}-${row.isBlueprintCopy}`}
                  >
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 truncate">
                          {row.typeName ?? `#${row.typeId}`}
                        </span>
                        {row.isBlueprintCopy && (
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            蓝图拷贝
                          </Badge>
                        )}
                      </span>
                      <span className="block font-mono text-[10px] text-muted-foreground/60">
                        {row.typeId}
                      </span>
                    </TableCell>

                    <TableCell className="max-w-40 truncate text-muted-foreground">
                      {groupNames[row.typeId] ?? "—"}
                    </TableCell>

                    <TableCell className="text-right tabular-nums">
                      {row.quantity.toLocaleString()}
                    </TableCell>

                    <TableCell className="max-w-56">
                      <span className="block truncate">{row.locationName}</span>
                      <span className="block font-mono text-[10px] text-muted-foreground/60">
                        {LOCATION_KIND_LABEL[row.locationKind] ?? row.locationKind}
                        {row.locationId >= 1_000_000_000_000
                          ? ` · ${row.locationId}`
                          : ""}
                      </span>
                    </TableCell>

                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.locationTotal.toLocaleString()}
                    </TableCell>

                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {formatLocationFlag(row.locationFlag)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              第 {safePage + 1} / {totalPages} 页 · 共{" "}
              {filtered.length.toLocaleString()} 条
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage >= totalPages - 1}
              onClick={() =>
                setPage((value) => Math.min(totalPages - 1, value + 1))
              }
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function PermissionsPanel({
  characterId,
  characterName,
}: {
  characterId: number | null;
  characterName: string | null;
}) {
  const query = useQuery({
    queryKey: ["scopes", characterId],
    queryFn: () => getCharacterScopes(characterId as number),
    enabled: characterId !== null,
  });

  const granted = query.data ?? [];
  const missing = KEY_SCOPES.filter((item) => !granted.includes(item.scope));

  if (characterId === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>需要先授权角色</EmptyTitle>
          <EmptyDescription>在「角色」标签页添加 EVE 角色后即可查看授权范围。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (granted.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>没有记录授权范围</EmptyTitle>
          <EmptyDescription>
            该角色可能是旧版本授权的。重新授权一次即可记录完整的作用域列表。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        授权时申请 ESI 的全部权限，数据全部保存在本机，不会上传。
        {characterName ? `（以下以「${characterName}」的授权为准）` : ""}
      </p>

      {missing.length > 0 ? (
        <Alert variant="destructive" className="mb-3">
          <AlertTitle>缺少当前功能需要的权限</AlertTitle>
          <AlertDescription>
            <p>
              {missing.map((item) => item.scope).join("、")}
            </p>
            <p className="text-muted-foreground">
              这些权限缺失会导致市场、资产相关功能不可用，请在「角色」页解绑后重新授权。
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert className="mb-3">
          <AlertTitle>关键权限齐全</AlertTitle>
          <AlertDescription>
            市场与资产相关功能所需的 {KEY_SCOPES.length} 项权限均已授予。
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium text-foreground/85">已授予权限</span>
        <Badge variant="secondary" className="tabular-nums">
          {granted.length}
        </Badge>
      </div>

      <ScrollArea className="h-72 rounded-lg border border-border bg-card/40">
        <ul className="flex flex-col gap-0.5 p-2">
          {granted.map((scope) => {
            const isKey = KEY_SCOPES.some((item) => item.scope === scope);

            return (
              <li
                key={scope}
                className={cn(
                  "rounded-md px-2 py-1 font-mono text-xs",
                  isKey ? "bg-primary/10 text-primary" : "text-muted-foreground",
                )}
              >
                {scope}
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}
