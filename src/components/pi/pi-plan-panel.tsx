import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  loadPiSystems,
  PI_PRODUCTS,
  piTypeName,
  type PiSystemPlanets,
} from "@/lib/pi/data";
import {
  PI_PLANET_TYPES,
  PLANET_FACILITY_HINT,
  planetTypesOfP0,
} from "@/lib/pi/planet-types";
import { buildChainPlan } from "@/lib/pi/schematic";
import {
  aggregateProfiles,
  buildSystemProfile,
  p0Coverage,
  securityTone,
} from "@/lib/pi/systems";
import type { PiChainPlan, PiPlanetType } from "@/lib/pi/types";
import { cn } from "@/lib/utils";

/** 安全等级配色 */
const SECURITY_CLASS: Record<string, string> = {
  high: "text-emerald-400",
  low: "text-amber-400",
  null: "text-rose-400",
  wormhole: "text-violet-400",
};

/** 星系选择上限 */
const MAX_SYSTEMS = 5;

/** 弹窗内最多渲染的星系条数（全量 7,983 条，只渲染命中的前若干条） */
const SYSTEM_LIST_LIMIT = 120;

/**
 * 行星方案：弹窗里多选目标产物，汇总它们需要的 P0 采集与行星分工。
 *
 * 口径：P0 全部由行星自行采集，中间品在对应设施自产，不考虑外购原料。
 */
export function PiPlanPanel() {
  const [selected, setSelected] = useState<number[]>([]);
  const [keyword, setKeyword] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  /** 星系维度：最多 5 个 */
  const [systemIds, setSystemIds] = useState<number[]>([]);
  const [systemKeyword, setSystemKeyword] = useState("");
  const [systemPickerOpen, setSystemPickerOpen] = useState(false);

  const systemsQuery = useQuery({
    queryKey: ["pi-systems"],
    queryFn: loadPiSystems,
    staleTime: Infinity,
  });
  const systems = systemsQuery.data ?? [];

  const plans = useMemo(
    () =>
      selected
        .map((typeId) => buildChainPlan(typeId))
        .filter((plan): plan is PiChainPlan => plan !== null),
    [selected],
  );

  /** 汇总：P0 采集清单 + 各行星能采什么 / 能加工什么 */
  const summary = useMemo(() => {
    const p0 = new Map<number, { name: string; quantity: number }>();
    const harvest = new Map<string, Set<number>>();
    const process = new Map<string, Set<string>>();

    for (const plan of plans) {
      for (const item of plan.purchases) {
        const current = p0.get(item.typeId) ?? {
          name: item.name,
          quantity: 0,
        };
        current.quantity += item.quantity;
        p0.set(item.typeId, current);

        for (const planet of planetTypesOfP0(item.typeId)) {
          const set = harvest.get(planet) ?? new Set<number>();
          set.add(item.typeId);
          harvest.set(planet, set);
        }
      }

      for (const step of plan.steps) {
        for (const planet of step.planetTypes) {
          const set = process.get(planet) ?? new Set<string>();
          set.add(`P${step.tier} ${step.name}`);
          process.set(planet, set);
        }
      }
    }

    return {
      p0: [...p0].sort((a, b) => b[1].quantity - a[1].quantity),
      harvest,
      process,
      totalSteps: plans.reduce((sum, plan) => sum + plan.steps.length, 0),
      totalOutputs: plans.reduce(
        (sum, plan) =>
          sum +
          (plan.steps.find((s) => s.outputTypeId === plan.rootTypeId)
            ?.totalOutput ?? 0),
        0,
      ),
    };
  }, [plans]);

  /** 已选星系（保持选择顺序） */
  const selectedSystems = useMemo(
    () =>
      systemIds
        .map((id) => systems.find((item) => item.id === id))
        .filter((item): item is PiSystemPlanets => Boolean(item)),
    [systemIds, systems],
  );

  /** 星系画像：行星分布 + 可采 P0 + 可加工步骤 */
  const profiles = useMemo(
    () => selectedSystems.map((system) => buildSystemProfile(system, plans)),
    [selectedSystems, plans],
  );

  /** 所选星系对 P0 需求的覆盖 */
  const coverage = useMemo(
    () => p0Coverage(summary.p0.map(([typeId]) => typeId), profiles),
    [summary.p0, profiles],
  );

  /** 所选星系的合并能力（行星 / 可采 P0 / 可产产物） */
  const systemTotals = useMemo(() => aggregateProfiles(profiles), [profiles]);

  const filteredSystems = useMemo(() => {
    const kw = systemKeyword.trim().toLowerCase();
    const pool = kw
      ? systems.filter(
          (item) =>
            item.name.toLowerCase().includes(kw) ||
            item.region.toLowerCase().includes(kw),
        )
      : systems;
    return pool.slice(0, SYSTEM_LIST_LIMIT);
  }, [systems, systemKeyword]);

  const toggleSystem = (id: number) => {
    setSystemIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_SYSTEMS) return current;
      return [...current, id];
    });
  };

  const groups = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return [4, 3, 2, 1].map((tier) => ({
      tier,
      items: PI_PRODUCTS.filter((product) => {
        if (product.tier !== tier) return false;
        if (!kw) return true;
        return (
          product.name.toLowerCase().includes(kw) ||
          String(product.typeId).includes(kw)
        );
      }),
    }));
  }, [keyword]);

  const toggle = (typeId: number) => {
    setSelected((current) =>
      current.includes(typeId)
        ? current.filter((item) => item !== typeId)
        : [...current, typeId],
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button size="sm" className="h-8 text-xs" onClick={() => setPickerOpen(true)}>
          <Search />
          选择产物
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => setSystemPickerOpen(true)}
        >
          <MapPin />
          选择星系（{systemIds.length}/{MAX_SYSTEMS}）
        </Button>
        <span className="text-xs text-muted-foreground">
          已选 {selected.length} 个目标产物
          {systemIds.length > 0 ? ` · ${systemIds.length} 个星系` : ""}
        </span>
        {(selected.length > 0 || systemIds.length > 0) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => {
              setSelected([]);
              setSystemIds([]);
            }}
          >
            清空
          </Button>
        )}
      </div>

      {plans.length === 0 && profiles.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>先选产物或星系</EmptyTitle>
              <EmptyDescription>
                点「选择产物」可多选目标产物，汇总它们需要的 P0 采集与行星分工；
                也可以只点「选择星系」查看该星系的行星分布与可采 P0，再决定生产什么。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <>
          {/* 只选星系时的能力概览 */}
          {plans.length === 0 && profiles.length > 0 && (
            <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4">
              <Stat
                label="已选星系"
                value={`${profiles.length} / ${MAX_SYSTEMS}`}
              />
              <Stat
                label="行星总数"
                value={systemTotals.planets.toLocaleString()}
              />
              <Stat
                label="可采 P0"
                value={`${systemTotals.p0Count} 种`}
                extra="按行星类型汇总"
              />
              <Stat
                label="可产产物"
                value={`${systemTotals.productCount} 种`}
                tone="good"
                extra={systemTotals.byTier
                  .map((item) => `P${item.tier} ${item.count}`)
                  .join(" / ")}
              />
            </div>
          )}

          <div
            className={cn(
              "flex shrink-0 flex-wrap gap-1.5",
              plans.length === 0 && "hidden",
            )}
          >
            {plans.map((plan) => (
              <Badge key={plan.rootTypeId} variant="secondary" className="gap-1">
                P{plan.rootTier} {plan.rootName}
                <button
                  type="button"
                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                  onClick={() => toggle(plan.rootTypeId)}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>

          <div
            className={cn(
              "grid shrink-0 grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5",
              plans.length === 0 && "hidden",
            )}
          >
            <Stat label="目标产物" value={`${plans.length} 个`} />
            <Stat label="生产步骤" value={`${summary.totalSteps} 个`} />
            <Stat label="P0 种类" value={`${summary.p0.length} 种`} />
            <Stat
              label="每小时总产出"
              value={summary.totalOutputs.toLocaleString()}
            />
            <Stat
              label="P0 星系覆盖"
              value={
                systemIds.length === 0
                  ? "未选星系"
                  : `${coverage.covered.size}/${summary.p0.length}`
              }
              tone={
                systemIds.length === 0
                  ? "muted"
                  : coverage.missing.length > 0
                    ? "bad"
                    : "good"
              }
            />
          </div>

          <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border">
            <div className="flex flex-col gap-4 p-3">
              {profiles.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-medium text-foreground/85">
                    已选星系（{profiles.length}/{MAX_SYSTEMS}）
                  </h3>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {profiles.map((profile) => (
                      <div
                        key={profile.system.id}
                        className="rounded-lg border border-border/60 bg-card/40 p-2.5 text-xs"
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <span
                            className="min-w-0 truncate font-medium text-foreground/90"
                            title={profile.system.name}
                          >
                            {profile.system.name}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 font-mono text-[10px]",
                              SECURITY_CLASS[securityTone(profile.system.security)],
                            )}
                          >
                            {profile.system.security.toFixed(2)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70">
                            {profile.system.region}
                          </span>
                          <button
                            type="button"
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() => toggleSystem(profile.system.id)}
                          >
                            ×
                          </button>
                        </div>
                        <p className="text-muted-foreground">
                          行星 {profile.planetTotal}：
                          {profile.planetTypes
                            .map((item) => `${item.name.replace("行星", "")} ${item.count}`)
                            .join(" / ") || "—"}
                        </p>
                        <p className="mt-0.5 text-muted-foreground/80">
                          可采 {profile.harvestP0.length} 种 P0
                          {plans.length > 0
                            ? ` · 可加工 ${profile.process.length} 个步骤`
                            : ""}
                        </p>
                        <p
                          className="mt-0.5 truncate text-[10px] text-emerald-400/85"
                          title={([1, 2, 3, 4] as const)
                            .flatMap((tier) =>
                              profile.producible[tier].map(
                                (name) => `P${tier} ${name}`,
                              ),
                            )
                            .join(" / ")}
                        >
                          可产 {profile.producibleCount} 种：P1{" "}
                          {profile.producible[1].length} / P2{" "}
                          {profile.producible[2].length} / P3{" "}
                          {profile.producible[3].length} / P4{" "}
                          {profile.producible[4].length}
                        </p>
                        <p
                          className="mt-0.5 truncate text-[10px] text-muted-foreground/60"
                          title={profile.harvestP0
                            .map((typeId) => piTypeName(typeId))
                            .join(" / ")}
                        >
                          可采：{profile.harvestP0
                            .map((typeId) => piTypeName(typeId))
                            .join(" / ")}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className={cn(plans.length === 0 && "hidden")}>
                <h3 className="mb-2 text-sm font-medium text-foreground/85">
                  P0 采集清单（自行采集，无外购）
                </h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-1.5">
                  {summary.p0.map(([typeId, item]) => {
                    const planets = planetTypesOfP0(typeId);
                    return (
                      <div
                        key={typeId}
                        className="flex flex-col gap-1 rounded-md border border-border/70 bg-card/30 px-2 py-1.5"
                      >
                        <div className="flex items-start justify-between gap-1.5">
                          <span
                            className="min-w-0 flex-1 truncate text-[11px] text-foreground/90"
                            title={item.name}
                          >
                            {item.name}
                          </span>
                          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                            {typeId}
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-muted-foreground/70">
                            每小时需求
                          </span>
                          <span className="font-mono tabular-nums text-foreground/85">
                            {Math.ceil(item.quantity).toLocaleString()}
                          </span>
                        </div>

                        <p
                          className={cn(
                            "truncate text-[10px]",
                            systemIds.length === 0
                              ? "text-muted-foreground/80"
                              : coverage.covered.has(typeId)
                                ? "text-emerald-400/85"
                                : "text-amber-400/90",
                          )}
                          title={
                            systemIds.length === 0
                              ? planets.join(" / ")
                              : coverage.covered.has(typeId)
                                ? `星系可采：${planets.join(" / ")}`
                                : "选中的星系里没有能采这种 P0 的行星"
                          }
                        >
                          {systemIds.length === 0
                            ? `可采：${planets.join(" / ") || "—"}`
                            : coverage.covered.has(typeId)
                              ? "选中星系可采集 ✓"
                              : "选中星系无法采集"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className={cn(plans.length === 0 && "hidden")}>
                <h3 className="mb-2 text-sm font-medium text-foreground/85">
                  行星分工
                </h3>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {PI_PLANET_TYPES.filter(
                    (planet) =>
                      summary.harvest.has(planet) || summary.process.has(planet),
                  ).map((planet) => {
                    const harvestIds = [...(summary.harvest.get(planet) ?? [])];
                    const processNames = [...(summary.process.get(planet) ?? [])];
                    return (
                      <div
                        key={planet}
                        className="rounded-lg border border-border/60 bg-card/40 p-2.5 text-xs"
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <span className="font-medium text-foreground/90">
                            {planet}
                          </span>
                          <span className="text-[10px] text-muted-foreground/70">
                            {PLANET_FACILITY_HINT[planet as PiPlanetType]}
                          </span>
                        </div>
                        <p className="text-muted-foreground">
                          采集：
                          {harvestIds
                            .map(
                              (typeId) =>
                                summary.p0.find(([id]) => id === typeId)?.[1]
                                  .name ?? `#${typeId}`,
                            )
                            .join("、") || "—"}
                        </p>
                        <p className="mt-0.5 text-muted-foreground">
                          加工：{processNames.join("、") || "—"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>

              <p
                className={cn(
                  "text-[11px] text-muted-foreground/70",
                  plans.length === 0 && "hidden",
                )}
              >
                口径：每个产物各按「1 条产线满负荷 1 小时」展开，多选时 P0 需求与加工步骤累加；
                P0 全部由行星采集，中间品在对应设施自产。
              </p>
            </div>
          </ScrollArea>
        </>
      )}

      {/* 产物多选弹窗 */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>选择目标产物</DialogTitle>
            <DialogDescription>
              可多选，当前已选 {selected.length} 个。
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索产物名称 / ID"
              className="pl-8"
            />
          </div>

          {/* 小卡片形式，列数随弹窗宽度自适应 */}
          <ScrollArea className="h-96 rounded-lg border border-border">
            <div className="flex flex-col gap-2.5 p-2">
              {groups.map((group) => (
                <section key={group.tier}>
                  <p className="mb-1 px-0.5 text-[10px] text-muted-foreground/70">
                    P{group.tier} · {group.items.length} 项
                  </p>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-1.5">
                    {group.items.map((product) => {
                      const active = selected.includes(product.typeId);
                      return (
                        <button
                          key={product.typeId}
                          type="button"
                          onClick={() => toggle(product.typeId)}
                          title={product.name}
                          className={cn(
                            "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                            active
                              ? "border-primary/60 bg-primary/10 text-primary"
                              : "border-border/70 bg-card/30 text-muted-foreground hover:bg-muted/50",
                          )}
                        >
                          <span
                            className={cn(
                              "grid size-3.5 shrink-0 place-items-center rounded-sm border text-[9px]",
                              active
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border",
                            )}
                          >
                            {active ? "✓" : ""}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {product.name}
                          </span>
                          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                            P{product.tier}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={selected.length === 0}
              onClick={() => setSelected([])}
            >
              清空
            </Button>
            <Button onClick={() => setPickerOpen(false)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 星系选择弹窗：最多 5 个 */}
      <Dialog open={systemPickerOpen} onOpenChange={setSystemPickerOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>选择星系</DialogTitle>
            <DialogDescription>
              最多选择 {MAX_SYSTEMS} 个星系，当前已选 {systemIds.length} 个。
              {systemsQuery.isPending
                ? " 星系数据加载中…"
                : ` 共 ${systems.length.toLocaleString()} 个含行星的星系。`}
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={systemKeyword}
              onChange={(event) => setSystemKeyword(event.target.value)}
              placeholder="搜索星系 / 星域名称"
              className="pl-8"
            />
          </div>

          <ScrollArea className="h-96 rounded-lg border border-border">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5 p-2">
              {filteredSystems.map((system) => {
                const active = systemIds.includes(system.id);
                const planetTotal = Object.values(system.planets).reduce(
                  (sum, count) => sum + count,
                  0,
                );

                return (
                  <button
                    key={system.id}
                    type="button"
                    onClick={() => toggleSystem(system.id)}
                    title={`${system.name} · ${system.region}`}
                    className={cn(
                      "flex flex-col gap-1 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                      active
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border/70 bg-card/30 text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate">
                        {system.name}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[10px]",
                          SECURITY_CLASS[securityTone(system.security)],
                        )}
                      >
                        {system.security.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-1 text-[10px] text-muted-foreground/70">
                      <span className="min-w-0 truncate">{system.region}</span>
                      <span className="shrink-0">行星 {planetTotal}</span>
                    </div>
                  </button>
                );
              })}

              {filteredSystems.length === 0 && (
                <p className="col-span-full py-6 text-center text-xs text-muted-foreground">
                  {systemsQuery.isPending ? "星系数据加载中…" : "没有匹配的星系"}
                </p>
              )}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={systemIds.length === 0}
              onClick={() => setSystemIds([])}
            >
              清空
            </Button>
            <Button onClick={() => setSystemPickerOpen(false)}>
              完成（{systemIds.length}/{MAX_SYSTEMS}）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "muted",
  extra,
}: {
  label: string;
  value: string;
  tone?: "muted" | "good" | "bad";
  extra?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "block font-mono text-sm tabular-nums text-foreground/90",
          tone === "good" && "text-emerald-400",
          tone === "bad" && "text-rose-400",
        )}
      >
        {value}
      </span>
      {extra && (
        <span className="block text-[10px] text-muted-foreground/70">
          {extra}
        </span>
      )}
    </div>
  );
}
