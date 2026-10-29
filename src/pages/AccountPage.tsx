import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
  type AssetGroup,
  type AssetsPayload,
  type EveCharacter,
} from "@/lib/db";
import { describeError, useCharacters } from "@/hooks/useCharacters";
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

const LOCATION_KIND_LABEL: Record<string, string> = {
  structure: "玩家建筑",
  station: "NPC 空间站",
  system: "太空",
};

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

  const query = useQuery({
    queryKey: ["assets", characterId],
    queryFn: () =>
      invoke<AssetsPayload>("fetch_character_assets", { characterId }),
    enabled: characterId !== null,
    staleTime: 60_000,
  });

  // 按物品名 / 类型 ID 过滤，只保留有匹配项的分组
  const filteredGroups = useMemo(() => {
    const all = query.data?.groups ?? [];
    const kw = keyword.trim().toLowerCase();
    if (!kw) return all;

    return all
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            (item.typeName ?? "").toLowerCase().includes(kw) ||
            String(item.typeId).includes(kw),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [query.data, keyword]);

  const searching = keyword.trim().length > 0;

  if (characterId === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>需要先授权角色</EmptyTitle>
          <EmptyDescription>在「角色」标签页添加 EVE 角色后即可查看资产。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (query.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>资产加载失败</AlertTitle>
        <AlertDescription>{describeError(query.error)}</AlertDescription>
      </Alert>
    );
  }

  const data = query.data;
  if (!data || data.groups.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>没有资产</EmptyTitle>
          <EmptyDescription>
            该角色的资产列表为空，或授权缺少资产读取权限。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div>
      {data.truncated && (
        <Alert className="mb-3">
          <AlertTitle>资产数量超过上限</AlertTitle>
          <AlertDescription>
            仅拉取了前 5 万条资产，部分物品可能没有显示。
          </AlertDescription>
        </Alert>
      )}

      {data.corporationNote && (
        <Alert className="mb-3">
          <AlertTitle>军团资产未加载</AlertTitle>
          <AlertDescription>{data.corporationNote}</AlertDescription>
        </Alert>
      )}

      <div className="mb-3 flex items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="按物品名称或类型 ID 搜索"
            className="pl-8"
          />
        </div>

        <span className="text-sm text-muted-foreground">
          {searching
            ? `匹配 ${filteredGroups.length} 个位置`
            : `个人 ${data.assetCount.toLocaleString()} 条${
                data.corporationAssetCount > 0
                  ? ` · 军团 ${data.corporationAssetCount.toLocaleString()} 条`
                  : ""
              }，分布在 ${data.groups.length} 个位置`}
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

      {filteredGroups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>没有匹配的物品</EmptyTitle>
            <EmptyDescription>换个关键字试试，或清空搜索框查看全部。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredGroups.map((group) => (
            <AssetGroupCard
              key={group.locationId}
              group={group}
              forceOpen={searching}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetGroupCard({
  group,
  forceOpen = false,
}: {
  group: AssetGroup;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(forceOpen);

  // 搜索时自动展开命中的分组，省去逐个点开
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-lg border border-border bg-card/60">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
          >
            <div className="min-w-0">
              <span className="block text-sm text-foreground">
                {group.locationName}
              </span>
              <span className="block font-mono text-[11px] text-muted-foreground">
                {group.locationId} · {group.items.length} 种物品 · 共{" "}
                {group.totalQuantity.toLocaleString()} 件
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="outline">
                {LOCATION_KIND_LABEL[group.locationKind] ?? group.locationKind}
              </Badge>
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
              />
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <Separator />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>物品</TableHead>
                <TableHead className="text-right">数量</TableHead>
                <TableHead>槽位</TableHead>
                <TableHead className="text-right">来源</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.items.map((item, index) => (
                <TableRow key={`${item.source}-${item.typeId}-${item.locationFlag}-${index}`}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {item.typeName ?? `#${item.typeId}`}
                      {item.isBlueprintCopy && (
                        <Badge variant="outline">蓝图拷贝</Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.quantity.toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {item.locationFlag}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant={item.source === "corporation" ? "secondary" : "outline"}
                      className="text-[11px]"
                    >
                      {item.source === "corporation" ? "军团" : "个人"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CollapsibleContent>
      </div>
    </Collapsible>
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
