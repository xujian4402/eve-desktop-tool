import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import {
  getTypeNameMap,
  listCharacterOrderTypeIds,
  listMarketGroups,
  listStructureTypeIds,
  listStructures,
  listTypeOrders,
  type MarketGroupRow,
  type MarketGroupSyncResult,
} from "@/lib/db";

const MARKET_GROUP_KEY = ["market-groups"] as const;
const TYPE_NAME_KEY = ["type-names"] as const;
const STRUCTURES_KEY = ["structures", "with-market"] as const;

/** 订单表格单侧最多展示条数 */
const ORDERS_PER_SIDE = 100;

interface GroupNode {
  id: number;
  name: string;
  /** 英文名，作为次要信息显示在中文名之后 */
  nameEn: string | null;
  description: string;
  parentId: number | null;
  types: number[];
}

type Selection =
  | { kind: "group"; id: number }
  | { kind: "type"; id: number }
  | null;

/** 扁平列表中的一行：分类或具体物品 */
type FlatRow =
  | {
      kind: "group";
      key: string;
      id: number;
      name: string;
      nameEn: string | null;
      typeCount: number;
      depth: number;
      hasChildren: boolean;
      isOpen: boolean;
    }
  | { kind: "type"; key: string; id: number; name: string; depth: number };


function parseTypes(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number")
      : [];
  } catch {
    return [];
  }
}

function toNode(row: MarketGroupRow): GroupNode {
  return {
    id: row.market_group_id,
    name: row.name,
    nameEn: row.name_en,
    description: row.description,
    parentId: row.parent_group_id,
    types: parseTypes(row.types),
  };
}

function formatIsk(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/**
 * 市场物品分类树。
 *
 * 数据来自本地 market_group 表（由内置 SDE 静态数据一次性导入），
 * 树结构在前端构建：父分组缺失的脏数据挂到根节点，避免节点丢失。
 * 每个分组展开后，除了子分组外还会列出自己的「直属物品」。
 */
/** 物品列表的筛选模式 */
type FilterMode = "all" | "market" | "mine";

export default function MarketGroupBrowser({
  characterId,
}: {
  characterId: number | null;
}) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [structureId, setStructureId] = useState<number | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  /** 左栏宽度（可拖动分隔条调整） */
  const [leftWidth, setLeftWidth] = useState(240);
  /** 左栏整体收起，右侧占满 */
  const [collapsed, setCollapsed] = useState(false);

  const groupsQuery = useQuery({
    queryKey: MARKET_GROUP_KEY,
    queryFn: async () => {
      const rows = await listMarketGroups();
      if (rows.length > 0) return rows;

      // 首次进入：直接从内置 SDE 静态数据导入，无需联网、无需等待在线同步
      await invoke("seed_market_groups");
      await queryClient.invalidateQueries({ queryKey: TYPE_NAME_KEY });
      return listMarketGroups();
    },
    staleTime: 5 * 60_000,
  });

  const typeNamesQuery = useQuery({
    queryKey: TYPE_NAME_KEY,
    queryFn: getTypeNameMap,
    staleTime: 5 * 60_000,
  });

  const structuresQuery = useQuery({
    queryKey: STRUCTURES_KEY,
    queryFn: () => listStructures(true),
    staleTime: 60_000,
  });

  const typeNames = typeNamesQuery.data ?? {};
  const structures = structuresQuery.data ?? [];

  /** 该建筑内有订单的物品 */
  const marketTypesQuery = useQuery({
    queryKey: ["structure-type-ids", structureId],
    queryFn: () => listStructureTypeIds(structureId as number),
    enabled: structureId !== null && filterMode === "market",
    staleTime: 30_000,
  });

  /** 自己挂了单的物品 */
  const myTypesQuery = useQuery({
    queryKey: ["my-order-type-ids", characterId],
    queryFn: () => listCharacterOrderTypeIds(characterId as number),
    enabled: characterId !== null && filterMode === "mine",
    staleTime: 30_000,
  });

  /** 允许出现的物品类型；null 表示不过滤 */
  const allowedTypes = useMemo(() => {
    if (filterMode === "market") {
      return new Set(marketTypesQuery.data ?? []);
    }
    if (filterMode === "mine") {
      return new Set(myTypesQuery.data ?? []);
    }
    return null;
  }, [filterMode, marketTypesQuery.data, myTypesQuery.data]);

  // 默认选中第一个已录入的建筑
  useEffect(() => {
    if (structureId !== null) return;
    if (structures.length === 0) return;
    setStructureId(structures[0].structure_id);
  }, [structures, structureId]);

  const nodes = useMemo<GroupNode[]>(
    () => (groupsQuery.data ?? []).map(toNode),
    [groupsQuery.data],
  );

  const { roots, childrenMap } = useMemo(() => {
    const index = new Map<number, GroupNode>();
    for (const node of nodes) index.set(node.id, node);

    const children = new Map<number, GroupNode[]>();
    const rootList: GroupNode[] = [];

    for (const node of nodes) {
      const hasParent = node.parentId !== null && index.has(node.parentId);
      if (!hasParent) {
        rootList.push(node);
        continue;
      }
      const list = children.get(node.parentId as number);
      if (list) list.push(node);
      else children.set(node.parentId as number, [node]);
    }

    const sortByName = (a: GroupNode, b: GroupNode) =>
      a.name.localeCompare(b.name, "zh-Hans-CN");
    rootList.sort(sortByName);
    for (const list of children.values()) list.sort(sortByName);

    return { roots: rootList, childrenMap: children };
  }, [nodes]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await invoke<MarketGroupSyncResult>("sync_market_groups");
      await queryClient.invalidateQueries({ queryKey: MARKET_GROUP_KEY });
      await queryClient.invalidateQueries({ queryKey: TYPE_NAME_KEY });
      toast.success(
        `已同步 ${result.synced} 个分类${
          result.failed > 0 ? `（${result.failed} 个失败）` : ""
        }，解析 ${result.typeNames.toLocaleString()} 个物品名称`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  /** 拖动分隔条调整左栏宽度，限制在 180~520px */
  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = leftWidth;

    const onMove = (moveEvent: MouseEvent) => {
      const next = startWidth + (moveEvent.clientX - startX);
      setLeftWidth(Math.min(Math.max(next, 180), 520));
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  /** 展开的分类（默认全部收起，只显示顶层分类） */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleGroup = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 生成扁平行。
   * @param expandAll true 时忽略展开状态（搜索时用，避免命中项被折叠挡住）
   */
  const buildRows = (
    expandAll: boolean,
    allowed: Set<number> | null,
  ): FlatRow[] => {
    const rows: FlatRow[] = [];

    /** 返回该分支下是否有内容（用于过滤时剔除空分类） */
    const walk = (list: GroupNode[], depth: number): number => {
      let kept = 0;

      for (const node of list) {
        const children = childrenMap.get(node.id) ?? [];
        const matchedTypes =
          allowed === null
            ? node.types
            : node.types.filter((typeId) => allowed.has(typeId));

        const hasChildren = children.length > 0 || matchedTypes.length > 0;
        const isOpen = expandAll || expanded.has(node.id);

        const startIndex = rows.length;
        rows.push({
          kind: "group",
          key: `g-${node.id}`,
          id: node.id,
          name: node.name,
          nameEn: node.nameEn,
          typeCount: matchedTypes.length,
          depth,
          hasChildren,
          isOpen,
        });

        let childKept = 0;
        let typeKept = 0;

        if (hasChildren && isOpen) {
          childKept = walk(children, depth + 1);

          // 子分支都没内容时，连分组行一起撤掉
          if (allowed !== null && childKept === 0 && matchedTypes.length === 0) {
            rows.splice(startIndex);
            continue;
          }

          for (const typeId of matchedTypes) {
            rows.push({
              kind: "type",
              key: `t-${typeId}`,
              id: typeId,
              name: typeNames[typeId] ?? `#${typeId}`,
              depth: depth + 1,
            });
            typeKept += 1;
          }
        } else if (allowed !== null && matchedTypes.length === 0) {
          rows.splice(startIndex);
          continue;
        }

        kept += 1 + childKept + typeKept;
      }

      return kept;
    };

    walk(roots, 0);
    return rows;
  };

  /** 按当前展开状态可见的行 */
  const visibleRows = useMemo(
    // 筛选状态下强制展开，否则命中的物品藏在折叠的分类里
    () => buildRows(allowedTypes !== null, allowedTypes),
    [roots, childrenMap, typeNames, expanded, allowedTypes],
  );

  /** 全量行（所有分类都展开），仅搜索时使用 */
  const allRows = useMemo(
    () => buildRows(true, allowedTypes),
    [roots, childrenMap, typeNames, allowedTypes],
  );

  /** 搜索：分类名或物品名命中 */
  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return visibleRows;

    return allRows.filter((row) => row.name.toLowerCase().includes(kw));
  }, [visibleRows, allRows, keyword]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  const focusIndex = (index: number) => {
    if (index < 0 || index >= filteredRows.length) return;
    setActiveIndex(index);
    virtualizer.scrollToIndex(index, { align: "auto" });
  };

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (filteredRows.length === 0) return;

    const current = activeIndex ?? -1;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusIndex(Math.min(current + 1, filteredRows.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusIndex(Math.max(current - 1, 0));
        break;
      case "PageDown":
        event.preventDefault();
        focusIndex(Math.min(current + 12, filteredRows.length - 1));
        break;
      case "PageUp":
        event.preventDefault();
        focusIndex(Math.max(current - 12, 0));
        break;
      case "Home":
        event.preventDefault();
        focusIndex(0);
        break;
      case "End":
        event.preventDefault();
        focusIndex(filteredRows.length - 1);
        break;
      case "Enter": {
        event.preventDefault();
        const row = current >= 0 ? filteredRows[current] : undefined;
        if (!row) break;

        setSelection(
          row.kind === "group"
            ? { kind: "group", id: row.id }
            : { kind: "type", id: row.id },
        );
        break;
      }
      default:
        break;
    }
  };

  const renderRow = (row: FlatRow, index: number) => {
    const isActive = activeIndex === index;
    const isSelected =
      row.kind === "group"
        ? selection?.kind === "group" && selection.id === row.id
        : selection?.kind === "type" && selection.id === row.id;

    return (
      <div
        role="option"
        aria-selected={isSelected}
        tabIndex={isActive ? 0 : -1}
        onFocus={() => setActiveIndex(index)}
        onClick={() =>
          setSelection(
            row.kind === "group"
              ? { kind: "group", id: row.id }
              : { kind: "type", id: row.id },
          )
        }
        // 双击分类展开 / 折叠，与点击箭头等效
        onDoubleClick={() => {
          if (row.kind === "group" && row.hasChildren) toggleGroup(row.id);
        }}
        title={
          row.kind === "group" && row.hasChildren
            ? `双击展开 / 折叠${
                row.nameEn && row.nameEn !== row.name
                  ? ` · ${row.name} / ${row.nameEn}`
                  : ` · ${row.name}`
              }`
            : row.kind === "group" && row.nameEn && row.nameEn !== row.name
              ? `${row.name} / ${row.nameEn}`
              : row.name
        }
        className={cn(
          "relative flex h-8 cursor-pointer items-center gap-1.5 rounded-sm pr-2 outline-none transition-colors",
          isSelected
            ? "bg-cyan-400/10 text-white"
            : row.kind === "group"
              ? "text-[#b6cde2] hover:bg-white/[0.04]"
              : "text-[#8aa7bf] hover:bg-white/[0.04] hover:text-[#c4d8e8]",
        )}
        style={{
          paddingLeft: `${
            row.depth * 14 + (row.kind === "type" ? 34 : 6)
          }px`,
        }}
      >
        {isSelected && (
          <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-cyan-400" />
        )}

        {row.kind === "group" ? (
          <>
            <button
              type="button"
              tabIndex={-1}
              aria-label={row.isOpen ? "收起" : "展开"}
              onClick={(event) => {
                event.stopPropagation();
                toggleGroup(row.id);
              }}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center text-[#4b6c8a] transition-colors hover:text-cyan-300",
                !row.hasChildren && "invisible",
              )}
            >
              <ChevronRight
                className={cn(
                  "size-3 transition-transform duration-150",
                  row.isOpen && "rotate-90",
                )}
              />
            </button>

            <Folder className="size-3.5 shrink-0 text-cyan-400/60" />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                isSelected && "font-medium",
              )}
            >
              {row.name}
            </span>
            {row.nameEn && row.nameEn !== row.name && (
              <span className="hidden max-w-28 min-w-0 truncate text-[10px] text-[#5b7c99] xl:inline">
                {row.nameEn}
              </span>
            )}
            {row.typeCount > 0 && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-[#5b7c99]">
                {row.typeCount}
              </span>
            )}
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate pl-[26px] text-[12px]">
            {row.name}
          </span>
        )}
      </div>
    );
  };

  const selectedTypeId = selection?.kind === "type" ? selection.id : null;

  const totalGroups = nodes.length;

  if (groupsQuery.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 正在读取本地分类…
      </div>
    );
  }

  if (totalGroups === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>没有分类数据</EmptyTitle>
          <EmptyDescription>
            内置静态数据未能导入。可以从 ESI 在线同步一次（约 2100 个分组，需要几十秒）。
          </EmptyDescription>
        </EmptyHeader>
        <Button disabled={syncing} onClick={() => void handleSync()}>
          {syncing ? (
            <>
              <Spinner className="size-4" />
              同步中…
            </>
          ) : (
            "从 ESI 更新分类"
          )}
        </Button>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-9 max-w-56 rounded-md border border-cyan-500/25 bg-[#0a1118]/80 px-2 text-sm text-cyan-50/90 outline-none focus:border-cyan-400/50"
          value={structureId ?? ""}
          onChange={(event) =>
            setStructureId(Number(event.target.value) || null)
          }
        >
          {structures.length === 0 ? (
            <option value="">没有可用建筑</option>
          ) : (
            structures.map((item) => (
              <option key={item.structure_id} value={item.structure_id}>
                {item.name ?? `#${item.structure_id}`}
              </option>
            ))
          )}
        </select>

        <div className="flex items-center gap-0.5 rounded-md border border-cyan-500/20 bg-[#0a1118]/60 p-0.5">
          {(
            [
              { key: "all", label: "全部物品" },
              { key: "market", label: "市场有订单" },
              { key: "mine", label: "我的订单" },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilterMode(item.key)}
              className={cn(
                "rounded px-2 py-1 text-[11px] transition-colors",
                filterMode === item.key
                  ? "bg-cyan-400/15 text-cyan-100"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <Badge variant="secondary" className="tabular-nums">
          {totalGroups} 个分类
        </Badge>

        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={syncing}
          onClick={() => void handleSync()}
        >
          <RefreshCw className={syncing ? "animate-spin" : undefined} />
          {syncing ? "更新中…" : "从 ESI 更新分类"}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        {collapsed ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title="展开分类树"
            className="flex h-[360px] w-6 shrink-0 items-center justify-center md:h-full rounded-md border border-border bg-card/40 text-muted-foreground transition-colors hover:text-foreground"
          >
            <PanelLeftOpen className="size-3.5" />
          </button>
        ) : (
          <>
          <div
            className="flex h-[360px] min-h-0 w-full shrink-0 flex-col overflow-hidden md:h-full rounded-md border border-cyan-500/20 bg-[#0a1118]/85 shadow-[inset_0_1px_0_0_rgba(34,211,238,0.06)] md:w-[var(--left-w)]"
            style={{ "--left-w": `${leftWidth}px` } as React.CSSProperties}
          >
            <div className="flex items-center justify-between border-b border-cyan-500/15 px-3 py-2.5">
              <span className="text-[11px] font-medium tracking-wide text-cyan-200/85">
                分类树
              </span>
              <span className="font-mono text-[10px] text-[#5b7c99]">
                {totalGroups.toLocaleString()} 分组
              </span>
            </div>

            <div className="flex items-center gap-1 border-b border-cyan-500/10 p-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索分类名称"
                  className="h-8 border-0 bg-transparent pl-8 text-xs shadow-none focus-visible:ring-1"
                />
              </div>

              <button
                type="button"
                onClick={() => setCollapsed(true)}
                title="收起分类树"
                className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PanelLeftClose className="size-3.5" />
              </button>
            </div>

            <div
              ref={scrollRef}
              role="listbox"
              aria-label="物品分类与物品列表"
              onKeyDown={handleTreeKeyDown}
              className="min-h-0 flex-1 overflow-y-auto p-1"
            >
              {filteredRows.length === 0 ? (
                <p className="px-3 py-6 text-center text-[11px] text-[#5b7c99]">
                  {filterMode === "market"
                    ? "该建筑当前没有订单数据，或还没有同步过订单"
                    : filterMode === "mine"
                      ? "当前角色在这段时间内没有挂单物品"
                      : "没有匹配的分类或物品"}
                </p>
              ) : (
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {virtualizer.getVirtualItems().map((item) => {
                    const row = filteredRows[item.index];
                    if (!row) return null;

                    return (
                      <div
                        key={row.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: item.size,
                          transform: `translateY(${item.start}px)`,
                        }}
                      >
                        {renderRow(row, item.index)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={handleResizeStart}
            title="拖动调整宽度"
            className="hidden w-1 shrink-0 cursor-col-resize rounded-full bg-border/50 transition-colors hover:bg-primary/60 md:block"
          />
          </>
        )}

        <ScrollArea
          // 切换物品时重建滚动容器，避免停留在上一次的滚动位置
          key={`${structureId ?? 0}-${selectedTypeId ?? "none"}`}
          className="h-[360px] min-h-0 min-w-0 flex-1 rounded-md md:h-full border border-cyan-500/20 bg-[#0a1118]/85 p-4 shadow-[inset_0_1px_0_0_rgba(34,211,238,0.06)]"
        >
          {selectedTypeId === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <p className="text-sm text-muted-foreground">
                {selection?.kind === "group"
                  ? "这是分类，不是具体物品"
                  : "在左侧选择具体物品，查看出售与收购订单"}
              </p>
              <p className="text-xs text-muted-foreground/70">
                左侧列表中缩进的条目就是物品，点击即可查看订单
              </p>
            </div>
          ) : (
            <TypeOrders
              structureId={structureId}
              typeId={selectedTypeId}
              typeName={typeNames[selectedTypeId] ?? `#${selectedTypeId}`}
              hasStructure={structures.length > 0}
            />
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

/** 物品的卖单（上）与买单（下） */
function TypeOrders({
  structureId,
  typeId,
  typeName,
  hasStructure,
}: {
  structureId: number | null;
  typeId: number;
  typeName: string;
  hasStructure: boolean;
}) {
  const query = useQuery({
    queryKey: ["type-orders", structureId, typeId],
    queryFn: () => listTypeOrders(structureId as number, typeId),
    enabled: structureId !== null,
    staleTime: 30_000,
  });

  if (!hasStructure) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>还没有可查询的建筑</EmptyTitle>
          <EmptyDescription>
            到「同步市场订单」标签页录入建筑并同步一次订单。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (structureId === null || query.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 正在读取订单…
      </div>
    );
  }

  const rows = query.data ?? [];
  const sells = rows
    .filter((row) => row.is_buy_order === 0)
    .sort((a, b) => a.price - b.price);
  const buys = rows
    .filter((row) => row.is_buy_order === 1)
    .sort((a, b) => b.price - a.price);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium tracking-wide text-cyan-50">{typeName}</h3>
        <p className="mt-0.5 font-mono text-[11px] text-cyan-300/50">
          type_id {typeId} · 卖单 {sells.length} · 买单 {buys.length}
        </p>
      </div>

      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>该建筑没有这个物品的订单</EmptyTitle>
            <EmptyDescription>
              可能确实无人挂单，也可能尚未同步该建筑的订单。到「同步市场订单」标签页点「同步」后再看。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <OrderTable
            title="出售订单"
            tone="sell"
            orders={sells}
            emptyText="没有卖单"
          />
          <OrderTable
            title="收购订单"
            tone="buy"
            orders={buys}
            emptyText="没有买单"
          />
        </>
      )}
    </div>
  );
}

function OrderTable({
  title,
  tone,
  orders,
  emptyText,
}: {
  title: string;
  tone: "sell" | "buy";
  orders: {
    order_id: number;
    price: number;
    volume_remain: number;
    volume_total: number;
    min_volume: number;
    range: string;
  }[];
  emptyText: string;
}) {
  const sorted =
    tone === "sell"
      ? [...orders].sort((a, b) => a.price - b.price)
      : [...orders].sort((a, b) => b.price - a.price);

  const priceColor = tone === "sell" ? "text-amber-300/90" : "text-emerald-300/90";

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2 border-b border-cyan-500/10 pb-1.5">
        <span
          className={cn(
            "size-2 rounded-full",
            tone === "sell" ? "bg-amber-400" : "bg-emerald-400",
          )}
        />
        <h4 className="text-xs font-medium">{title}</h4>
        <Badge variant="outline" className="tabular-nums text-[11px]">
          {orders.length}
        </Badge>
        {orders.length > ORDERS_PER_SIDE && (
          <span className="text-[11px] text-muted-foreground">
            仅显示前 {ORDERS_PER_SIDE} 条
          </span>
        )}
      </div>

      {orders.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">价格 (ISK)</TableHead>
              <TableHead className="text-right">剩余 / 总量</TableHead>
              <TableHead className="text-right">最小量</TableHead>
              <TableHead>范围</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.slice(0, ORDERS_PER_SIDE).map((order) => (
              <TableRow key={order.order_id}>
                <TableCell className={`text-right font-mono tabular-nums ${priceColor}`}>
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
      )}
    </section>
  );
}
