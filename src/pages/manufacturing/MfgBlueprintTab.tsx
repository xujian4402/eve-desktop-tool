import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  listCharacterBlueprints,
  saveCharacterBlueprints,
  type BlueprintRow,
  type EveCharacter,
  type StructureInfo,
} from "@/lib/db";
import { fetchCharacterBlueprints } from "@/lib/manufacturing/api";
import { mfgTypeName, type MfgData } from "@/lib/manufacturing/data";

import "./MfgBlueprintTab.css";

/** 蓝图所在位置的名称缓存：建筑解析一次后复用，避免每次都请求 */
const LOCATION_CACHE_KEY = "mfg-location-names-v1";

function readLocationCache(): Record<number, string> {
  try {
    const raw = localStorage.getItem(LOCATION_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const next: Record<number, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) next[Number(key)] = value;
    }
    return next;
  } catch {
    return {};
  }
}

/**
 * 蓝图资产：按角色列出 BPO / BPC。
 *
 * BPO（原版）的 runs/quantity 都是 -1；BPC 显示剩余流程。
 */
export default function MfgBlueprintTab({
  characters,
  activeCharacterId,
  data,
}: {
  characters: EveCharacter[];
  activeCharacterId: number | null;
  data: MfgData | null;
}) {
  const [tab, setTab] = useState<string>("");
  const [rows, setRows] = useState<BlueprintRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** location_id → 名称（先查缓存，未命中的再解析） */
  const [locationNames, setLocationNames] =
    useState<Record<number, string>>(readLocationCache);

  const selected =
    tab || (activeCharacterId !== null ? String(activeCharacterId) : "");

  const load = useCallback(async (characterId: number) => {
    try {
      setRows(await listCharacterBlueprints(characterId));
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    void load(Number(selected));
  }, [selected, load]);

  // 位置名称：先看缓存，剩下的逐个解析（空间站解析失败就保留 ID）
  useEffect(() => {
    if (!selected || rows.length === 0) return;

    const unknown = [...new Set(rows.map((row) => row.location_id))].filter(
      (id) => id > 0 && !locationNames[id],
    );
    if (unknown.length === 0) return;

    let cancelled = false;

    void (async () => {
      const resolved: Record<number, string> = {};

      // 一次最多解析 20 个，避免蓝图分散在大量建筑时拖慢页面
      for (const locationId of unknown.slice(0, 20)) {
        try {
          const info = await invoke<StructureInfo>("resolve_structure", {
            structureId: locationId,
            characterId: Number(selected),
          });
          if (info.name) resolved[locationId] = info.name;
        } catch {
          // NPC 空间站或无访问权限的建筑：保持 #id 显示
        }
      }

      if (cancelled || Object.keys(resolved).length === 0) return;

      setLocationNames((current) => {
        const next = { ...current, ...resolved };
        try {
          localStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify(next));
        } catch {
          // 存储不可用时忽略
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [rows, selected, locationNames]);

  const handleSync = async () => {
    if (!selected) return;
    setSyncing(true);
    setError(null);

    try {
      const fetched = await fetchCharacterBlueprints(Number(selected));
      await saveCharacterBlueprints(
        Number(selected),
        fetched.map((row) => ({
          item_id: row.itemId,
          type_id: row.typeId,
          location_id: row.locationId,
          location_flag: row.locationFlag,
          quantity: row.quantity,
          material_efficiency: row.materialEfficiency,
          time_efficiency: row.timeEfficiency,
          runs: row.runs,
        })),
      );
      await load(Number(selected));
      toast.success(`已同步 ${fetched.length.toLocaleString()} 张蓝图`);
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
      <div className="mfg-blueprints-tab__toolbar">
        <TabsList className="h-auto flex-wrap">
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

        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8 text-xs"
          disabled={syncing || !selected}
          onClick={() => void handleSync()}
        >
          <RefreshCw className={syncing ? "animate-spin" : undefined} />
          {syncing ? "同步中…" : "同步蓝图"}
        </Button>
      </div>

      <TabsContent
        value={selected}
        className="mfg-blueprints-tab mt-2 data-[state=inactive]:hidden"
      >
        {error && (
          <Alert variant="destructive" className="shrink-0">
            <AlertTitle>蓝图操作失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {rows.length === 0 ? (
          <p className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            还没有蓝图数据，点右上角「同步蓝图」拉取。
          </p>
        ) : (
          <div className="mfg-blueprints-tab__table">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>产物</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead className="text-right">ME</TableHead>
                  <TableHead className="text-right">TE</TableHead>
                  <TableHead className="text-right">剩余流程</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead>位置</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const recipe =
                    data?.byBlueprint.get(row.type_id) ?? null;
                  // -1 表示无限（BPO）；BPC 才是有限流程
                  const isBpo = row.runs < 0 || row.quantity < 0;
                  const remainingRuns = row.runs < 0 ? "∞" : row.runs;
                  const copies = row.quantity < 0 ? "∞" : row.quantity;

                  return (
                    <TableRow key={row.item_id}>
                      <TableCell>
                        <span className="block text-foreground/90">
                          {recipe
                            ? mfgTypeName(data, recipe.productTypeId)
                            : mfgTypeName(data, row.type_id)}
                        </span>
                        <span className="block font-mono text-[10px] text-muted-foreground/60">
                          {row.type_id}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={isBpo ? "secondary" : "outline"}
                          className="text-[10px]"
                        >
                          {isBpo ? "BPO" : "BPC"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.material_efficiency}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.time_efficiency}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {remainingRuns}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {copies}
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">
                        <span
                          className="block max-w-[220px] truncate"
                          title={String(row.location_id)}
                        >
                          {locationNames[row.location_id] ??
                            `#${row.location_id}`}
                        </span>
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
