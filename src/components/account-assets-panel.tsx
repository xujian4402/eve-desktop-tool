import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import { getTypeGroupNameMap, type AssetsPayload, type EveCharacter } from "@/lib/db";
import { LOCATION_KIND_LABEL, formatLocationFlag } from "@/lib/location-flags";

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
 * 资产面板：按角色分 Tab 展示，每个角色一份独立的筛选/分页状态。
 *
 * 高度行为：根 Tabs 用 `flex-1 + min-h-0` 拿到确定高度，
 * 每个 Tab 内的表格区 `flex-1 + overflow-auto` 内部滚动，
 * 所以页面不会随资产条数增长而整体滚动。
 */
export function AssetsPanel({
  characters,
  activeCharacterId,
}: {
  characters: EveCharacter[];
  activeCharacterId: number | null;
}) {
  const fallbackId = activeCharacterId ?? characters[0]?.character_id ?? null;
  const [selected, setSelected] = useState<number | null>(fallbackId);

  // 角色增删（解绑/切换当前角色）后，让选中项始终落在有效角色上
  useEffect(() => {
    const stillExists = characters.some(
      (character) => character.character_id === selected,
    );
    if (!stillExists) {
      setSelected(fallbackId);
    }
  }, [characters, fallbackId, selected]);

  if (characters.length === 0) {
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

  return (
    <Tabs
      value={selected === null ? "" : String(selected)}
      onValueChange={(value) => setSelected(Number(value))}
      className="min-h-0 flex-1 gap-3"
    >
      <TabsList className="max-w-full shrink-0 justify-start overflow-x-auto">
        {characters.map((character) => (
          <TabsTrigger
            key={character.character_id}
            value={String(character.character_id)}
            className="shrink-0"
          >
            {character.name}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Radix 用 hidden 属性隐藏未激活面板，而 display 工具类会覆盖 UA 的
          [hidden]{display:none}（项目没引入 preflight），所以要显式藏回去。 */}
      {characters.map((character) => (
        <TabsContent
          key={character.character_id}
          value={String(character.character_id)}
          className="flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          {/* 只挂载当前角色的资产视图：否则会同时拉取所有角色的资产 */}
          {selected === character.character_id && (
            <CharacterAssets characterId={character.character_id} />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** 单个角色的资产视图（搜索 / 位置过滤 / 分页表格） */
export function CharacterAssets({ characterId }: { characterId: number }) {
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  /** 位置过滤：null 表示全部位置 */
  const [locationFilter, setLocationFilter] = useState<number | null>(null);

  const query = useQuery({
    queryKey: ["assets", characterId],
    queryFn: () =>
      invoke<AssetsPayload>("fetch_character_assets", { characterId }),
    staleTime: 60_000,
  });

  // 物品所属市场分类（内置 SDE 静态数据，不依赖本地库是否已导入）
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
  }, [keyword, locationFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ASSET_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(
    safePage * ASSET_PAGE_SIZE,
    (safePage + 1) * ASSET_PAGE_SIZE,
  );

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
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {data.truncated && (
        <Alert className="shrink-0">
          <AlertTitle>资产数量超过上限</AlertTitle>
          <AlertDescription>
            仅拉取了前 5 万条资产，部分物品可能没有显示。
          </AlertDescription>
        </Alert>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2">
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
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border [&>[data-slot=table-container]]:overflow-visible">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
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

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
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
