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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  loadPiSystems,
  PI_PRODUCTS,
  piTypeName,
  type PiSystemPlanets,
} from "@/lib/pi/data";
import {
  facilitiesOfPlanet,
  p0TypeIdsOfPlanet,
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
import type { PiChainPlan, PiPlanetType, PiTier } from "@/lib/pi/types";
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

  /** 最低行星标准：跑完所选产物至少需要怎样的行星配置 */
  const minimalStandard = useMemo(() => {
    // 1. 加工所需设施 → 适用等级
    const facilityTiers = new Map<string, Set<PiTier>>();
    for (const plan of plans) {
      for (const step of plan.steps) {
        const set = facilityTiers.get(step.facility) ?? new Set<PiTier>();
        set.add(step.tier);
        facilityTiers.set(step.facility, set);
      }
    }

    // 2. 每种设施能被哪些行星承载
    const facilityPlanets = new Map<string, string[]>();
    for (const facility of facilityTiers.keys()) {
      facilityPlanets.set(
        facility,
        PI_PLANET_TYPES.filter((planet) =>
          (facilitiesOfPlanet(planet) as string[]).includes(facility),
        ),
      );
    }

    // 3. 采集所需行星类型（P0 → 行星类型的并集）
    const harvestTypes = new Set<string>();
    for (const [typeId] of summary.p0) {
      for (const planet of planetTypesOfP0(typeId)) harvestTypes.add(planet);
    }

    // 4. 加工行星与采集行星能否合并：只要有一颗贫瘠/温和就能跑全部加工档位
    const fabricationPlanets = new Set<string>();
    for (const list of facilityPlanets.values()) {
      for (const planet of list) fabricationPlanets.add(planet);
    }
    const extraHarvest = [...harvestTypes].filter(
      (planet) => !fabricationPlanets.has(planet),
    );

    const fabricationCount = facilityTiers.size > 0 ? 1 : 0;

    return {
      facilityTiers: [...facilityTiers].map(([facility, tiers]) => ({
        facility,
        tiers: [...tiers].sort(),
        planets: facilityPlanets.get(facility) ?? [],
      })),
      harvestTypes: [...harvestTypes],
      extraHarvest,
      fabricationCount,
      total: fabricationCount + extraHarvest.length,
    };
  }, [plans, summary.p0]);

  /** 具体部署清单：几颗行星、每颗装什么、采什么、加工什么 */
  const deployment = useMemo(() => {
    const facilitiesNeeded = minimalStandard.facilityTiers.map(
      (item) => item.facility,
    );

    // 能装下全部所需设施的行星（只考虑已选产物实际用到的设施）
    const fabCandidates = PI_PLANET_TYPES.filter((planet) =>
      facilitiesNeeded.every((facility) =>
        (facilitiesOfPlanet(planet) as string[]).includes(facility),
      ),
    );

    // 需求 P0（typeId → 每小时需求）
    const p0Demand = new Map<number, { name: string; quantity: number }>();
    for (const [typeId, item] of summary.p0) {
      p0Demand.set(typeId, { name: item.name, quantity: item.quantity });
    }

    /** 某行星能采到本次需要的哪些 P0 */
    const harvestOf = (planet: string) =>
      p0TypeIdsOfPlanet(planet)
        .filter((typeId) => p0Demand.has(typeId))
        .map((typeId) => ({ typeId, ...p0Demand.get(typeId)! }))
        .sort((a, b) => b.quantity - a.quantity);

    /** 某行星的设施能加工哪些产物 */
    const processOf = (planet: string) => {
      const facilities = facilitiesOfPlanet(planet) as string[];
      const names = new Set<string>();
      for (const plan of plans) {
        for (const step of plan.steps) {
          if (facilities.includes(step.facility)) {
            names.add(`P${step.tier} ${step.name}`);
          }
        }
      }
      return [...names];
    };

    // 加工行星推荐：优先选能顺带采到更多 P0 的那颗
    const ranked = fabCandidates
      .map((planet) => ({ planet, p0: harvestOf(planet) }))
      .sort(
        (a, b) => b.p0.length - a.p0.length || b.p0.reduce((s, i) => s + i.quantity, 0) - a.p0.reduce((s, i) => s + i.quantity, 0),
      );

    // 采集行星：需要的行星类型里，不能由加工行星覆盖的
    const harvestOnly = minimalStandard.harvestTypes.filter(
      (planet) => !fabCandidates.includes(planet as PiPlanetType),
    );

    // 所有部署行星覆盖到的 P0（用于检查是否还有缺口）
    const covered = new Set<number>();
    if (ranked[0]) ranked[0].p0.forEach((item) => covered.add(item.typeId));
    const harvestOnlyDetail = harvestOnly.map((planet) => ({
      planet,
      p0: harvestOf(planet),
    }));
    for (const item of harvestOnlyDetail) {
      item.p0.forEach((p0) => covered.add(p0.typeId));
    }

    const uncovered = [...p0Demand]
      .filter(([typeId]) => !covered.has(typeId))
      .map(([typeId, item]) => ({ typeId, ...item }));

    return {
      ranked,
      harvestOnlyDetail,
      uncovered,
      processOf,
      total: (ranked.length > 0 ? 1 : 0) + harvestOnlyDetail.length,
    };
  }, [minimalStandard, summary.p0, plans]);

  /**
   * 一星一产物：每颗行星只采集 1 种 P0。
   *
   * 因此所需 P0 有几种，就至少要几颗采集行星；其中一颗可由加工行星兼任
   * （它一边跑产线，一边采那一种 P0）。
   */
  const routes = useMemo(() => {
    const facilitiesNeeded = minimalStandard.facilityTiers.map(
      (item) => item.facility,
    );
    const fabCandidates = PI_PLANET_TYPES.filter((planet) =>
      facilitiesNeeded.every((facility) =>
        (facilitiesOfPlanet(planet) as string[]).includes(facility),
      ),
    );
    const fabPlanet = fabCandidates[0] ?? null;

    const rows = summary.p0.map(([typeId, item]) => {
      const planets = planetTypesOfP0(typeId);
      const preferred =
        fabPlanet && planets.includes(fabPlanet)
          ? fabPlanet
          : (planets[0] ?? null);
      return {
        typeId,
        name: item.name,
        quantity: item.quantity,
        planets,
        preferred,
      };
    });

    // 加工行星顺带采集的那一项（推荐分配落在加工行星上的第一种 P0）
    const fabHarvest = fabPlanet
      ? (rows.find((row) => row.preferred === fabPlanet) ?? null)
      : null;

    const harvestPlanetCount = rows.length - (fabHarvest ? 1 : 0);
    const total = harvestPlanetCount + (fabPlanet ? 1 : 0);

    // 组合数：每种 P0 可选行星类型的数量相乘
    const combinations = rows.reduce(
      (acc, row) => acc * Math.max(1, row.planets.length),
      1,
    );

    return {
      rows,
      fabPlanet,
      fabCandidates,
      fabHarvest,
      harvestPlanetCount,
      total,
      combinations,
    };
  }, [summary.p0, minimalStandard]);

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
                <Tabs defaultValue="split" className="min-h-0">
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <h3 className="text-sm font-medium text-foreground/85">
                      行星分工
                    </h3>
                    <TabsList className="h-7">
                      <TabsTrigger value="split" className="text-[11px]">
                        分工明细
                      </TabsTrigger>
                      <TabsTrigger value="minimal" className="text-[11px]">
                        最低行星标准
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  <TabsContent
                    value="split"
                    className="data-[state=inactive]:hidden"
                  >
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {PI_PLANET_TYPES.filter(
                        (planet) =>
                          summary.harvest.has(planet) ||
                          summary.process.has(planet),
                      ).map((planet) => {
                        const harvestIds = [
                          ...(summary.harvest.get(planet) ?? []),
                        ];
                        const processNames = [
                          ...(summary.process.get(planet) ?? []),
                        ];
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
                  </TabsContent>

                  <TabsContent
                    value="minimal"
                    className="data-[state=inactive]:hidden"
                  >
                    {/* 结论 */}
                    <div className="mb-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs">
                      <p className="text-foreground/85">
                        每颗行星只采 1 种 P0，共需{" "}
                        <b className="font-mono text-emerald-400">
                          {routes.total}
                        </b>{" "}
                        颗行星
                        {routes.fabPlanet && (
                          <span className="text-muted-foreground">
                            {" "}
                            · 1 颗加工（{routes.fabPlanet}
                            {routes.fabHarvest
                              ? `，顺带采 ${routes.fabHarvest.name}`
                              : ""}
                            ）
                          </span>
                        )}
                        {routes.harvestPlanetCount > 0 && (
                          <span className="text-muted-foreground">
                            {" "}
                            · {routes.harvestPlanetCount} 颗纯采集
                          </span>
                        )}
                        {routes.combinations > 1 && (
                          <span className="text-muted-foreground">
                            {" "}
                            · 行星类型组合可达 {routes.combinations} 种
                          </span>
                        )}
                      </p>
                    </div>

                    {/* 加工行星 */}
                    {routes.fabPlanet && (
                      <div className="mb-2 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground/90">
                            行星 1 · 加工
                          </span>
                          <Badge variant="secondary" className="text-[10px]">
                            {routes.fabPlanet}
                          </Badge>
                          {routes.fabCandidates.length > 1 && (
                            <span className="text-[10px] text-muted-foreground">
                              也可用{" "}
                              {routes.fabCandidates.slice(1).join(" / ")}
                            </span>
                          )}
                        </div>
                        <p className="text-muted-foreground">
                          设施：
                          {(facilitiesOfPlanet(routes.fabPlanet) as string[]).join(
                            " + ",
                          )}
                        </p>
                        <p className="mt-0.5 text-muted-foreground">
                          加工：
                          {deployment.processOf(routes.fabPlanet).join("、") ||
                            "—"}
                        </p>
                        {routes.fabHarvest && (
                          <p className="mt-0.5 text-muted-foreground">
                            顺带采集：{routes.fabHarvest.name}（
                            {Math.ceil(
                              routes.fabHarvest.quantity,
                            ).toLocaleString()}
                            /h）
                          </p>
                        )}
                        {!routes.fabHarvest && (
                          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                            该行星只做加工，采集全靠其它行星
                          </p>
                        )}
                      </div>
                    )}

                    {/* 每颗采集行星（一星一产物） */}
                    <div className="flex flex-col gap-1.5">
                      {routes.rows.map((row, index) => {
                        const isFab = row.preferred === routes.fabPlanet;
                        return (
                          <div
                            key={row.typeId}
                            className={cn(
                              "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-2.5 py-1.5 text-[11px]",
                              isFab
                                ? "border-border/40 bg-muted/20 opacity-70"
                                : "border-border/60 bg-card/40",
                            )}
                          >
                            <span className="font-mono text-muted-foreground/60">
                              #
                              {index + (routes.fabHarvest ? 1 : 2)}
                            </span>
                            <span className="font-medium text-foreground/90">
                              {row.name}
                            </span>
                            <span className="font-mono tabular-nums text-muted-foreground">
                              {Math.ceil(row.quantity).toLocaleString()}/h
                            </span>
                            <span className="text-muted-foreground">
                              推荐：{row.preferred ?? "—"}
                              {isFab ? "（加工行星兼任）" : ""}
                            </span>
                            {row.planets.length > 1 && (
                              <span className="text-[10px] text-muted-foreground/70">
                                也可由 {row.planets.filter((p) => p !== row.preferred).join(" / ")}{" "}
                                采集
                              </span>
                            )}
                          </div>
                        );
                      })}

                      {routes.rows.length === 0 && (
                        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                          先选择产物，这里会列出每种 P0 要部署的行星。
                        </p>
                      )}
                    </div>

                    {routes.rows.length > 0 && (
                      <p className="mt-2 text-[10px] text-muted-foreground/70">
                        规则：1 颗行星只采 1 种 P0。想减少行星数时，可把多种 P0
                        放在同一颗行星上（本表按最保守的一星一产物计算）。
                      </p>
                    )}

                    {/* 设施-等级对照（附录） */}
                    <div className="mt-2 overflow-hidden rounded-lg border border-border">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/40 text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1.5 text-left font-medium">
                              设施
                            </th>
                            <th className="px-2 py-1.5 text-left font-medium">
                              覆盖等级
                            </th>
                            <th className="px-2 py-1.5 text-left font-medium">
                              可承载行星
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {minimalStandard.facilityTiers.map((item) => (
                            <tr
                              key={item.facility}
                              className="border-t border-border/60"
                            >
                              <td className="px-2 py-1.5">{item.facility}</td>
                              <td className="px-2 py-1.5 font-mono text-muted-foreground">
                                {item.tiers.map((tier) => `P${tier}`).join(" / ")}
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground">
                                {item.planets.join(" / ") || "—"}
                              </td>
                            </tr>
                          ))}
                          {minimalStandard.facilityTiers.length === 0 && (
                            <tr>
                              <td
                                colSpan={3}
                                className="px-2 py-3 text-center text-muted-foreground"
                              >
                                先选择产物
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </TabsContent>
                </Tabs>
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
