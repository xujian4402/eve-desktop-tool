import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCharacters } from "@/hooks/useCharacters";
import {
  COLONY_LEVEL_HINT,
  fetchCharacterColonies,
  fetchColonyDetail,
  type PiColony,
  type PiColonyPin,
} from "@/lib/pi/colonies";
import {
  loadPiSystems,
  PI_SCHEMATICS,
  piTypeName,
  type PiSystemPlanets,
} from "@/lib/pi/data";
import { facilityTypeOf, factoryTierOf } from "@/lib/pi/facility-kinds";
import { planetTypeCodeName } from "@/lib/pi/planet-types";
import { cn } from "@/lib/utils";

/** 设施展示顺序 */
const PIN_KIND_ORDER: Record<string, number> = {
  extractor: 0,
  factory: 1,
  storage: 2,
  other: 3,
};

/** 安全等级配色 */
function securityClass(security: number): string {
  if (security >= 0.5) return "text-emerald-400";
  if (security > 0) return "text-amber-400";
  if (security > -1) return "text-rose-400";
  return "text-violet-400";
}

/** 毫秒 → 「3天2小时」 */
function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分`;
}

/** 采集器剩余运行时间（ESI 只读，无法启停） */
function extractorStatus(expiry: string | null): {
  label: string;
  tone: "ok" | "warn" | "bad";
} {
  if (!expiry) return { label: "无到期时间", tone: "warn" };
  const diff = new Date(expiry).getTime() - Date.now();
  if (diff <= 0) return { label: `已过期${formatDuration(-diff)}`, tone: "bad" };
  return {
    label: `剩${formatDuration(diff)}`,
    tone: diff < 6 * 3600_000 ? "warn" : "ok",
  };
}

/**
 * 我的菜地：按角色展示行星殖民地，卡片内直接铺开全部设施（不折叠）。
 *
 * 数据来自 ESI `/characters/{id}/planets/` 与 `/planets/{planet_id}/`，
 * 星系名与安全等级取自内置 SDE 星系表。
 */
export function PiColoniesPanel() {
  const { characters, activeCharacter } = useCharacters();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<string>("");

  const fallbackId = activeCharacter?.character_id ?? characters[0]?.character_id;
  const selected = tab || (fallbackId !== undefined ? String(fallbackId) : "");

  const systemsQuery = useQuery({
    queryKey: ["pi-systems"],
    queryFn: loadPiSystems,
    staleTime: Infinity,
  });

  const coloniesQuery = useQuery({
    queryKey: ["pi-colonies", selected],
    queryFn: () => fetchCharacterColonies(Number(selected)),
    enabled: selected !== "",
    staleTime: 60_000,
  });

  const systemMap = useMemo(() => {
    const map = new Map<number, PiSystemPlanets>();
    for (const system of systemsQuery.data ?? []) map.set(system.id, system);
    return map;
  }, [systemsQuery.data]);

  const colonies = coloniesQuery.data ?? [];

  const stats = useMemo(() => {
    const pins = colonies.reduce((sum, item) => sum + item.numPins, 0);
    const maxLevel = colonies.reduce(
      (max, item) => Math.max(max, item.upgradeLevel),
      0,
    );
    const systems = new Set(colonies.map((item) => item.solarSystemId)).size;
    return { pins, maxLevel, systems };
  }, [colonies]);

  const sortedColonies = useMemo(
    () =>
      colonies
        .slice()
        .sort(
          (a, b) =>
            b.upgradeLevel - a.upgradeLevel ||
            a.solarSystemId - b.solarSystemId,
        ),
    [colonies],
  );

  const refreshAll = async () => {
    await coloniesQuery.refetch();
    // 设施详情缓存一并失效，卡片里的状态才是最新的
    await queryClient.invalidateQueries({ queryKey: ["pi-colony-detail"] });
  };

  if (characters.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>还没有授权角色</EmptyTitle>
            <EmptyDescription>
              先到「个人中心」授权 EVE 角色，这里会列出该角色已建立的行星殖民地。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Tabs value={selected} onValueChange={setTab} className="min-h-0 flex-1">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={coloniesQuery.isFetching || selected === ""}
            onClick={() => void refreshAll()}
          >
            <RefreshCw
              className={coloniesQuery.isFetching ? "animate-spin" : undefined}
            />
            刷新
          </Button>

          {colonies.length > 0 && (
            <span className="text-xs text-muted-foreground">
              共 <b className="text-foreground/85">{colonies.length}</b> 个殖民地 ·{" "}
              {stats.systems} 个星系 · {stats.pins} 个设施 · 最高{" "}
              {COLONY_LEVEL_HINT[stats.maxLevel] ?? `${stats.maxLevel} 级`}
            </span>
          )}

          <span className="text-[11px] text-muted-foreground/60">
            采集器启停需在游戏内操作（ESI 未提供写接口）
          </span>
        </div>

        <TabsContent
          value={selected}
          className="mt-2 flex min-h-0 flex-col gap-2"
        >
          {coloniesQuery.error && (
            <Alert variant="destructive" className="shrink-0">
              <AlertTitle>读取殖民地失败</AlertTitle>
              <AlertDescription>
                {coloniesQuery.error instanceof Error
                  ? coloniesQuery.error.message
                  : String(coloniesQuery.error)}
              </AlertDescription>
            </Alert>
          )}

          {coloniesQuery.isPending && selected !== "" ? (
            <p className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              正在读取殖民地面板…
            </p>
          ) : colonies.length === 0 ? (
            <p className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              该角色没有行星殖民地，或授权缺少 esi-planets.manage_planets.v1。
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {sortedColonies.map((colony) => (
                  <ColonyCard
                    key={colony.planetId}
                    characterId={Number(selected)}
                    colony={colony}
                    system={systemMap.get(colony.solarSystemId)}
                  />
                ))}
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** 一个殖民地的卡片：头部信息 + 展开的全部设施（始终显示） */
function ColonyCard({
  characterId,
  colony,
  system,
}: {
  characterId: number;
  colony: PiColony;
  system: PiSystemPlanets | undefined;
}) {
  const detailQuery = useQuery({
    queryKey: ["pi-colony-detail", characterId, colony.planetId],
    queryFn: () => fetchColonyDetail(characterId, colony.planetId),
    staleTime: 60_000,
  });

  const pins = useMemo(
    () =>
      (detailQuery.data ?? [])
        .slice()
        .sort(
          (a, b) =>
            (PIN_KIND_ORDER[a.kind] ?? 9) - (PIN_KIND_ORDER[b.kind] ?? 9) ||
            a.pinId - b.pinId,
        ),
    [detailQuery.data],
  );

  const counts = useMemo(() => {
    let extractor = 0;
    let factory = 0;
    for (const pin of pins) {
      if (pin.kind === "extractor") extractor += 1;
      else if (pin.kind === "factory") factory += 1;
    }
    return { extractor, factory };
  }, [pins]);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/70 bg-card/40 p-2">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-medium text-foreground/90">
          {system?.name ?? `#${colony.solarSystemId}`}
        </span>
        <Badge variant="secondary" className="px-1 py-0 text-[9px]">
          {planetTypeCodeName(colony.planetType)}
        </Badge>
        {system && (
          <span className={cn("font-mono text-[10px]", securityClass(system.security))}>
            {system.security.toFixed(2)}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/70">
          {COLONY_LEVEL_HINT[colony.upgradeLevel] ?? `${colony.upgradeLevel}级`}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          {colony.numPins} 设施
          {counts.extractor > 0 ? ` · 采${counts.extractor}` : ""}
          {counts.factory > 0 ? ` · 厂${counts.factory}` : ""}
        </span>
      </div>

      {/* 设施（直接铺开） */}
      <div className="flex flex-col gap-0.5">
        {detailQuery.isPending && (
          <span className="text-[10px] text-muted-foreground/70">
            读取设施…
          </span>
        )}
        {detailQuery.error && (
          <span className="text-[10px] text-rose-400/90">
            {detailQuery.error instanceof Error
              ? detailQuery.error.message
              : String(detailQuery.error)}
          </span>
        )}
        {pins.map((pin) => (
          <PinRow key={pin.pinId} pin={pin} />
        ))}
        {detailQuery.isSuccess && pins.length === 0 && (
          <span className="text-[10px] text-muted-foreground/60">
            没有读取到设施
          </span>
        )}
      </div>
    </div>
  );
}

/** 单个设施：一行紧凑展示 */
function PinRow({ pin }: { pin: PiColonyPin }) {
  if (pin.kind === "extractor") {
    const status = extractorStatus(pin.expiryTime);
    return (
      <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] leading-tight">
        <span className="shrink-0 rounded bg-muted/60 px-1 text-[9px] text-muted-foreground">
          采
        </span>
        <span className="text-foreground/85">
          {pin.productTypeId !== null
            ? piTypeName(pin.productTypeId)
            : "未设置采集程序"}
        </span>
        {pin.qtyPerCycle !== null && (
          <span className="font-mono text-muted-foreground">
            {pin.qtyPerCycle.toLocaleString()}/周期
          </span>
        )}
        {pin.cycleTime !== null && (
          <span className="text-muted-foreground/70">
            {Math.round(pin.cycleTime / 60)}分
          </span>
        )}
        <span
          className={cn(
            "ml-auto shrink-0",
            status.tone === "ok"
              ? "text-emerald-400/90"
              : status.tone === "warn"
                ? "text-amber-300/90"
                : "text-rose-400",
          )}
        >
          {status.label}
        </span>
      </div>
    );
  }

  if (pin.kind === "factory") {
    const schematic = pin.schematicId
      ? PI_SCHEMATICS.find((item) => item.id === pin.schematicId)
      : undefined;

    // ESI 的 factory_details 不带产物 ID，需要用配方表反查产出物
    const productTypeId = schematic?.outputTypeId ?? pin.productTypeId;
    // 按 type_id 区分基础 / 高级 / 高科技工厂
    const tier = factoryTierOf(pin.typeId);

    return (
      <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] leading-tight">
        <span className="shrink-0 rounded bg-muted/60 px-1 text-[9px] text-muted-foreground">
          厂
        </span>
        <span className="text-foreground/85">
          {schematic?.name ?? `配方#${pin.schematicId ?? 0}`}
        </span>
        {tier && (
          <span className="shrink-0 rounded bg-muted/40 px-1 text-[9px] text-muted-foreground/80">
            {tier}
          </span>
        )}
        {productTypeId !== null && productTypeId !== undefined && (
          <span className="text-muted-foreground/70">
            → {piTypeName(productTypeId)}
          </span>
        )}
      </div>
    );
  }

  // 指挥中心 / 发射平台 / 储藏设施：按 type_id 识别具体建筑
  const facility = facilityTypeOf(pin.typeId);

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] leading-tight">
      <span className="shrink-0 rounded bg-muted/60 px-1 text-[9px] text-muted-foreground">
        {facility?.short ?? "设"}
      </span>
      {facility && (
        <span className="text-foreground/85">{facility.label}</span>
      )}
      {pin.contents.length > 0 ? (
        <span className="text-muted-foreground">
          {pin.contents
            .slice(0, 3)
            .map(
              (item) =>
                `${piTypeName(item.typeId)}×${item.amount.toLocaleString()}`,
            )
            .join("、")}
          {pin.contents.length > 3 ? ` 等${pin.contents.length}种` : ""}
        </span>
      ) : (
        <span className="text-muted-foreground/60">空置</span>
      )}
    </div>
  );
}
