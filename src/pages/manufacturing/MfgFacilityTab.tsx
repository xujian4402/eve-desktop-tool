import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listIndustryFacilities,
  listStructures,
  removeIndustryFacility,
  removeStructure,
  upsertIndustryFacility,
  upsertStructure,
  type IndustryFacilityRow,
  type MarketStructure,
  type StructureInfo,
} from "@/lib/db";
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
import { describeError, useCharacters } from "@/hooks/useCharacters";
import { fetchManufacturingStructures } from "@/lib/manufacturing/api";

import "./MfgFacilityTab.css";

interface Draft {
  material: string;
  time: string;
  tax: string;
}

/** 百分比字符串 → 小数（0.01 = 1%） */
function toRatio(value: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(1, numeric / 100);
}

function toPercentText(value: number): string {
  if (!value) return "";
  return (value * 100).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * 建筑配置：手动维护制造建筑的减免与结构税。
 *
 * ESI 不返回 rig 加成与结构税，只能由用户按游戏内实际数值填写。
 */
export default function MfgFacilityTab() {
  const { activeCharacter } = useCharacters();
  const characterId = activeCharacter?.character_id ?? null;
  const queryClient = useQueryClient();

  /** 让「成本计算」页的建筑下拉立即拿到新配置 */
  const refreshCalculator = () =>
    queryClient.invalidateQueries({ queryKey: ["industry-facilities"] });

  const [structures, setStructures] = useState<MarketStructure[]>([]);
  const [saved, setSaved] = useState<IndustryFacilityRow[]>([]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  /** 待删除的建筑（确认弹窗用） */
  const [pendingDelete, setPendingDelete] = useState<MarketStructure | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, facilities] = await Promise.all([
        // 制造建筑不一定开放市场，这里取全部已录入建筑
        listStructures(false),
        listIndustryFacilities(),
      ]);
      setStructures(list);
      setSaved(facilities);

      const next: Record<number, Draft> = {};
      for (const item of list) {
        const existing = facilities.find(
          (row) => row.facility_id === item.structure_id,
        );
        next[item.structure_id] = {
          material: existing ? toPercentText(existing.material_bonus) : "",
          time: existing ? toPercentText(existing.time_bonus) : "",
          tax: existing ? toPercentText(existing.tax_rate) : "",
        };
      }
      setDrafts(next);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const savedMap = useMemo(
    () => new Map(saved.map((row) => [row.facility_id, row])),
    [saved],
  );

  /**
   * 获取制造建筑：五源发现后只保留工程复合体
   * （莱塔卢 / 阿兹贝尔 / 索迪约），已录入的不重复写入。
   */
  const handleFetch = async () => {
    if (characterId === null) return;

    setFetching(true);
    setError(null);

    try {
      const found = await fetchManufacturingStructures(characterId);
      const known = new Set(structures.map((item) => item.structure_id));
      let added = 0;

      for (const item of found) {
        if (known.has(item.structureId)) continue;

        const info: StructureInfo = {
          structureId: item.structureId,
          name: item.name,
          solarSystemId: item.solarSystemId,
          solarSystemName: item.solarSystemName,
          typeId: item.typeId,
          ownerId: item.ownerId,
          hasMarket: false,
        };
        await upsertStructure(info, characterId);
        added += 1;
      }

      await load();
      await refreshCalculator();
      toast.success(
        added > 0
          ? `发现 ${found.length} 个制造建筑，新增 ${added} 个`
          : `发现 ${found.length} 个制造建筑，均已存在`,
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setFetching(false);
    }
  };

  const handleSave = async (structure: MarketStructure) => {
    const draft = drafts[structure.structure_id];
    if (!draft) return;

    try {
      await upsertIndustryFacility({
        facility_id: structure.structure_id,
        name: structure.name,
        solar_system_id: structure.solar_system_id,
        material_bonus: toRatio(draft.material),
        time_bonus: toRatio(draft.time),
        tax_rate: toRatio(draft.tax),
      });
      await load();
      await refreshCalculator();
      toast.success(`已保存：${structure.name ?? structure.structure_id}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  /**
   * 删除建筑：连同本地订单快照与制造配置一起移除。
   *
   * 建筑记录被删后，「成本计算」的建筑下拉也会同步消失。
   */
  const handleDelete = async () => {
    if (!pendingDelete) return;

    setDeleting(true);
    try {
      const id = pendingDelete.structure_id;
      await removeIndustryFacility(id);
      await removeStructure(id);
      await load();
      await refreshCalculator();
      toast.success(`已删除：${pendingDelete.name ?? `#${id}`}`);
      setPendingDelete(null);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mfg-facility-tab">
      <div className="mfg-facility-tab__toolbar">
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={fetching || characterId === null}
          onClick={() => void handleFetch()}
          title="按挂单 / 资产 / 合同 / 当前位置 / 军团建筑五个来源查找，只保留莱塔卢、阿兹贝尔、索迪约"
        >
          <RefreshCw className={fetching ? "animate-spin" : undefined} />
          {fetching ? "获取中…" : "获取制造建筑"}
        </Button>
        <span className="text-[10px] text-muted-foreground/60">
          只收集工程复合体（莱塔卢 / 阿兹贝尔 / 索迪约），已录入的不会重复写入
        </span>
      </div>

      <p className="mfg-facility-tab__hint">
        ESI 不提供建筑 rig 与结构税，请按游戏内「结构浏览器」里的实际数值填写；
        填 0 表示不计算该项。这些数值会被「成本计算」直接使用。
      </p>

      {error && (
        <p className="shrink-0 text-[11px] text-rose-400">{error}</p>
      )}

      {structures.length === 0 ? (
        <p className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          还没有已同步的市场建筑。先在「市场 → 获取玩家市场建筑」里录入。
        </p>
      ) : (
        <div className="mfg-facility-tab__table">
          <div className="mfg-facility-tab__row mfg-facility-tab__head">
            <span>建筑</span>
            <span>材料减免 %</span>
            <span>时间减免 %</span>
            <span>结构税 %</span>
            <span className="text-right">操作</span>
          </div>

          {structures.map((structure) => {
            const draft = drafts[structure.structure_id] ?? {
              material: "",
              time: "",
              tax: "",
            };
            const configured = savedMap.has(structure.structure_id);

            return (
              <div
                key={structure.structure_id}
                className="mfg-facility-tab__row"
              >
                <span className="min-w-0">
                  <span className="block truncate text-foreground/90">
                    {structure.name ?? `#${structure.structure_id}`}
                    {configured && (
                      <span className="ml-1 text-[10px] text-emerald-400/80">
                        已配置
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
                    {structure.solar_system_name ?? "—"}
                  </span>
                </span>

                <Input
                  value={draft.material}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [structure.structure_id]: {
                        ...draft,
                        material: event.target.value,
                      },
                    }))
                  }
                  inputMode="decimal"
                  placeholder="0"
                  className="h-7 text-right text-[11px]"
                />

                <Input
                  value={draft.time}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [structure.structure_id]: {
                        ...draft,
                        time: event.target.value,
                      },
                    }))
                  }
                  inputMode="decimal"
                  placeholder="0"
                  className="h-7 text-right text-[11px]"
                />

                <Input
                  value={draft.tax}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [structure.structure_id]: {
                        ...draft,
                        tax: event.target.value,
                      },
                    }))
                  }
                  inputMode="decimal"
                  placeholder="0"
                  className="h-7 text-right text-[11px]"
                />

                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => void handleSave(structure)}
                  >
                    保存
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
                    onClick={() => setPendingDelete(structure)}
                    title="从本地移除该建筑及其订单与制造配置"
                  >
                    删除
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
              将从本地移除「{pendingDelete?.name ?? "该建筑"}」、
              已同步的订单快照与制造配置，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {deleting ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
