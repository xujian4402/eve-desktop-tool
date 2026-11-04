import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listIndustryFacilities, type IndustryFacilityRow } from "@/lib/db";
import { loadPrices } from "@/lib/manufacturing/api";
import {
  calcJob,
  formatDuration,
  type MfgPriceMap,
} from "@/lib/manufacturing/calc";
import {
  mfgTypeName,
  type MfgData,
  type MfgRecipe,
} from "@/lib/manufacturing/data";
import { calcSkillBonus } from "@/lib/manufacturing/skills";
import { cn } from "@/lib/utils";

import "./MfgCalculatorTab.css";

function isk(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/**
 * 成本计算：选产物 → 填参数 → 出材料清单与利润。
 *
 * 时间减免来自两处：建筑 rig（「建筑配置」页手填）+ 角色技能（ESI 读取）。
 * 材料减免只有 ME 与建筑两项，技能在现行版本已不影响材料。
 */
export default function MfgCalculatorTab({
  data,
  skills,
}: {
  data: MfgData | null;
  /** 当前角色的制造业技能等级（skillId → 等级） */
  skills: Record<string, number>;
}) {
  const [typeId, setTypeId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [runs, setRuns] = useState("1");
  const [me, setMe] = useState("10");
  const [te, setTe] = useState("20");
  const [costIndex, setCostIndex] = useState("0.05");
  const [facilityId, setFacilityId] = useState<string>("none");
  const [prices, setPrices] = useState<MfgPriceMap>(new Map());

  // 建筑配置页保存/获取后会 invalidate 这个 key，这里自动拿到最新列表
  const facilitiesQuery = useQuery({
    queryKey: ["industry-facilities"],
    queryFn: () => listIndustryFacilities(),
    staleTime: 30_000,
  });
  const facilities: IndustryFacilityRow[] = facilitiesQuery.data ?? [];

  // 选中的建筑被删除或列表刷新后不存在时，回退到「不指定」
  useEffect(() => {
    if (facilityId === "none") return;
    if (facilities.some((item) => String(item.facility_id) === facilityId)) {
      return;
    }
    setFacilityId("none");
  }, [facilities, facilityId]);

  const recipe: MfgRecipe | null = useMemo(() => {
    if (!data || typeId === null) return null;
    return data.byProduct.get(typeId) ?? null;
  }, [data, typeId]);

  // 选中产物后按需取价：产物本身 + 全部材料
  useEffect(() => {
    if (!recipe) {
      setPrices(new Map());
      return;
    }

    let cancelled = false;
    const ids = [
      recipe.productTypeId,
      ...recipe.materials.map((item) => item.typeId),
    ];

    void loadPrices(ids).then((map) => {
      if (!cancelled) setPrices(map);
    });

    return () => {
      cancelled = true;
    };
  }, [recipe]);

  const facility =
    facilities.find((item) => String(item.facility_id) === facilityId) ?? null;

  /** 技能带来的时间减免：制造走工业理论 + 高级工业理论，反应只走反应理论 */
  const skillBonus = useMemo(
    () => calcSkillBonus(skills, recipe?.activity ?? "manufacturing"),
    [skills, recipe],
  );

  const result = useMemo(() => {
    if (!recipe) return null;

    return calcJob(recipe, prices, {
      runs: Number(runs) || 1,
      me: Number(me) || 0,
      te: Number(te) || 0,
      materialBonus: facility?.material_bonus ?? 0,
      // 建筑减免与技能减免叠加
      timeBonus: (facility?.time_bonus ?? 0) + skillBonus.timeBonus,
      facilityTax: facility?.tax_rate ?? 0,
      systemCostIndex: Number(costIndex) || 0,
    });
  }, [recipe, prices, runs, me, te, costIndex, facility, skillBonus]);

  const candidates = useMemo(() => {
    if (!data) return [];
    const kw = keyword.trim().toLowerCase();

    return data.recipes
      .filter((item) => item.activity === "manufacturing")
      .filter((item) => {
        if (!kw) return true;
        const name = mfgTypeName(data, item.productTypeId).toLowerCase();
        return name.includes(kw) || String(item.productTypeId).includes(kw);
      })
      .slice(0, 60);
  }, [data, keyword]);

  return (
    <div className="mfg-calc-tab">
      <div className="mfg-calc-tab__body">
        {/* 左侧参数 */}
        <div className="mfg-calc-tab__panel">
          <div className="mfg-calc-tab__field">
            <span className="mfg-calc-tab__label">搜索产物</span>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="名称或类型 ID"
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>

          <div className="mfg-calc-tab__field">
            <span className="mfg-calc-tab__label">
              产物（{candidates.length} 个候选）
            </span>
            <Select
              value={typeId === null ? "" : String(typeId)}
              onValueChange={(value) => setTypeId(Number(value))}
            >
              <SelectTrigger size="sm" className="h-8 w-full text-xs">
                <SelectValue placeholder="选择要制造的产物" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {candidates.map((item) => (
                  <SelectItem
                    key={item.productTypeId}
                    value={String(item.productTypeId)}
                  >
                    {mfgTypeName(data, item.productTypeId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="mfg-calc-tab__field">
              <span className="mfg-calc-tab__label">流程数</span>
              <Input
                value={runs}
                onChange={(event) => setRuns(event.target.value)}
                inputMode="numeric"
                className="h-8 text-right text-xs"
              />
            </div>
            <div className="mfg-calc-tab__field">
              <span className="mfg-calc-tab__label">ME</span>
              <Input
                value={me}
                onChange={(event) => setMe(event.target.value)}
                inputMode="numeric"
                className="h-8 text-right text-xs"
              />
            </div>
            <div className="mfg-calc-tab__field">
              <span className="mfg-calc-tab__label">TE</span>
              <Input
                value={te}
                onChange={(event) => setTe(event.target.value)}
                inputMode="numeric"
                className="h-8 text-right text-xs"
              />
            </div>
          </div>

          <div className="mfg-calc-tab__field">
            <span className="mfg-calc-tab__label">制造建筑（可选）</span>
            <Select value={facilityId} onValueChange={setFacilityId}>
              <SelectTrigger size="sm" className="h-8 w-full text-xs">
                <SelectValue placeholder="不指定" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不指定</SelectItem>
                {facilities.map((item) => (
                  <SelectItem
                    key={item.facility_id}
                    value={String(item.facility_id)}
                  >
                    {item.name ?? `#${item.facility_id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mfg-calc-tab__field">
            <span className="mfg-calc-tab__label">系统成本指数</span>
            <Input
              value={costIndex}
              onChange={(event) => setCostIndex(event.target.value)}
              inputMode="decimal"
              className="h-8 text-right text-xs"
            />
          </div>

          {facility && (
            <p className="text-[10px] text-muted-foreground">
              材料减免 {(facility.material_bonus * 100).toFixed(1)}% · 时间减免{" "}
              {(facility.time_bonus * 100).toFixed(1)}% · 结构税{" "}
              {(facility.tax_rate * 100).toFixed(2)}%
            </p>
          )}

          {skillBonus.parts.length > 0 ? (
            <p className="text-[10px] text-muted-foreground">
              技能时间减免 {(skillBonus.timeBonus * 100).toFixed(0)}%：
              {skillBonus.parts
                .map(
                  (part) =>
                    `${part.name} Lv${part.level}（-${(
                      part.level *
                      part.perLevel *
                      100
                    ).toFixed(0)}%）`,
                )
                .join(" · ")}
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground/60">
              未读取到制造业技能，时间只按 TE 与建筑减免计算
            </p>
          )}

          {!recipe && (
            <p className="text-[10px] text-amber-300/80">
              选择一个产物后才会显示材料与成本。
            </p>
          )}
        </div>

        {/* 右侧结果 */}
        <div className="mfg-calc-tab__result">
          {!recipe || !result ? (
            <p className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              在左侧选择产物，这里会列出材料清单、作业费与利润。
            </p>
          ) : (
            <>
              <div className="mfg-calc-tab__summary">
                <span className="text-muted-foreground">
                  产出{" "}
                  <b className="font-mono tabular-nums text-foreground/90">
                    {result.outputQuantity.toLocaleString()}
                  </b>{" "}
                  × {mfgTypeName(data, recipe.productTypeId)}
                </span>
                <span className="text-muted-foreground">
                  耗时{" "}
                  <b className="font-mono tabular-nums text-foreground/90">
                    {formatDuration(result.durationSeconds)}
                  </b>
                </span>
                <span className="text-muted-foreground">
                  材料成本{" "}
                  <b className="font-mono tabular-nums text-emerald-400">
                    {isk(result.materialCost)}
                  </b>
                </span>
                <span className="text-muted-foreground">
                  作业费{" "}
                  <b className="font-mono tabular-nums text-amber-300">
                    {isk(result.jobCost)}
                  </b>
                </span>
                <span className="text-muted-foreground">
                  总成本{" "}
                  <b className="font-mono tabular-nums text-foreground/90">
                    {isk(result.totalCost)}
                  </b>
                </span>
                <span className="text-muted-foreground">
                  收入{" "}
                  <b className="font-mono tabular-nums text-sky-300">
                    {isk(result.revenue)}
                  </b>
                </span>
                <span className="text-muted-foreground">
                  利润{" "}
                  <b
                    className={cn(
                      "font-mono tabular-nums",
                      (result.profit ?? 0) >= 0
                        ? "text-emerald-400"
                        : "text-rose-400",
                    )}
                  >
                    {isk(result.profit)}
                  </b>
                </span>
                <span className="text-muted-foreground">
                  利润率{" "}
                  {result.margin === null
                    ? "—"
                    : `${(result.margin * 100).toFixed(1)}%`}
                </span>
                {result.priceIncomplete && (
                  <Badge variant="outline" className="text-[10px]">
                    部分材料缺价
                  </Badge>
                )}
              </div>

              <div className="mfg-calc-tab__materials">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>材料</TableHead>
                      <TableHead className="text-right">单次基准</TableHead>
                      <TableHead className="text-right">本批需求</TableHead>
                      <TableHead className="text-right">单价</TableHead>
                      <TableHead className="text-right">成本</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.materials.map((line) => (
                      <TableRow key={line.typeId}>
                        <TableCell>
                          <span className="block">
                            {mfgTypeName(data, line.typeId)}
                          </span>
                          <span className="block font-mono text-[10px] text-muted-foreground/60">
                            {line.typeId}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {line.baseQuantity.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {line.quantity.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {isk(line.unitPrice)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {isk(line.cost)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
