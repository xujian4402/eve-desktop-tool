import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCharacters } from "@/hooks/useCharacters";
import {
  calculateMfg,
  DEFAULT_MFG_CONTEXT,
  expandMfgBom,
  getMfgCharacterSkills,
  getMfgRecipe,
  listMfgFacilityTypes,
  listMfgRigs,
  locateMfg,
  planInvention,
  researchMfg,
  searchMfgProducts,
  skillTimeMul as computeSkillMul,
  type MfgCalcContext,
  type MfgBomResult,
} from "@/lib/mfg/api";
import { cn } from "@/lib/utils";

import { duration, isk, NumField, Stat } from "./shared";

/**
 * 制造计算器。
 *
 * 单件计算 + 多级 BOM + 发明对比 + 制造地点，对应参考项目的「制造计算器」页。
 */
export default function MfgCalculatorPage() {
  const [keyword, setKeyword] = useState("");
  const [productId, setProductId] = useState<number | null>(null);
  const [runs, setRuns] = useState(1);
  const [me, setMe] = useState(10);
  const [te, setTe] = useState(20);
  const [facilityTypeId, setFacilityTypeId] = useState("0");
  const [costIndex, setCostIndex] = useState(0.05);
  const [facilityTax, setFacilityTax] = useState(0.5);
  const [buildSet, setBuildSet] = useState<number[]>([]);
  /** 技能加成来源角色（为空则按无技能计算） */
  const [characterId, setCharacterId] = useState<number | null>(null);
  /** 蓝图成本模式：none / bpo（市场原图，按流程分摊）/ copy（合同拷贝，每流程价） */
  const [bpMode, setBpMode] = useState<"none" | "bpo" | "copy">("none");
  const [bpPrice, setBpPrice] = useState(0);
  /** BPO 分摊的预计总流程数 */
  const [bpRuns, setBpRuns] = useState(100);

  const productsQuery = useQuery({
    queryKey: ["mfg-products", keyword],
    queryFn: () => searchMfgProducts(keyword, 60),
    staleTime: 60_000,
  });

  const recipeQuery = useQuery({
    queryKey: ["mfg-recipe", productId],
    queryFn: () => getMfgRecipe(productId as number),
    enabled: productId !== null,
    staleTime: 5 * 60_000,
  });

  const recipe = recipeQuery.data ?? null;

  const facilityQuery = useQuery({
    queryKey: ["mfg-facility-types"],
    queryFn: listMfgFacilityTypes,
    staleTime: 10 * 60_000,
  });

  const rigQuery = useQuery({
    queryKey: ["mfg-rigs"],
    queryFn: listMfgRigs,
    staleTime: 10 * 60_000,
  });

  const facility = facilityQuery.data?.find(
    (item) => String(item.typeId) === facilityTypeId,
  );

  const { characters } = useCharacters();

  const skillsQuery = useQuery({
    queryKey: ["mfg-skills", characterId],
    queryFn: () => getMfgCharacterSkills(characterId as number),
    enabled: characterId !== null,
    staleTime: 10 * 60_000,
    retry: false,
  });

  /** 技能带来的时间倍率（制造看工业理论 + 高级工业，反应看反应学） */
  const skillMul = useMemo(
    () =>
      computeSkillMul(
        skillsQuery.data,
        recipeQuery.data?.activity ?? "manufacturing",
      ),
    [skillsQuery.data, recipeQuery.data?.activity],
  );

  // 建筑 / 改装件 → 计算上下文
  const context: MfgCalcContext = useMemo(() => {
    const rigs = (rigQuery.data ?? []).filter(
      (rig) => rig.category === (facility?.category ?? "engineering"),
    );
    const materialRig = rigs
      .filter((rig) => rig.effect === "material")
      .reduce((sum, rig) => sum + rig.bonus, 0);
    const timeRig = rigs
      .filter((rig) => rig.effect === "time")
      .reduce((sum, rig) => sum + rig.bonus, 0);

    return {
      ...DEFAULT_MFG_CONTEXT,
      facilityMe: facility?.meBonus ?? 0,
      facilityTe: facility?.teBonus ?? 0,
      facilityCost: facility?.costBonus ?? 0,
      // 同一建筑最多同时生效 2 个同类型改装件，这里按已选的全部累加
      rigMe: materialRig,
      rigTe: timeRig,
      systemCostIndex: costIndex,
      facilityTax,
      skillTimeMul: skillMul,
    };
  }, [facility, rigQuery.data, costIndex, facilityTax, skillMul]);

  const jobQuery = useQuery({
    queryKey: ["mfg-calc", productId, runs, me, te, context],
    queryFn: () =>
      calculateMfg(productId as number, runs, me, te, context),
    enabled: productId !== null,
    staleTime: 30_000,
  });

  const researchQuery = useQuery({
    queryKey: [
      "mfg-research",
      recipe?.blueprintTypeId,
      me,
      te,
      jobQuery.data?.estimatedItemValue,
    ],
    queryFn: () =>
      researchMfg(
        recipe!.blueprintTypeId,
        me,
        te,
        jobQuery.data?.estimatedItemValue ?? 0,
        context,
      ),
    enabled: !!recipe && !!jobQuery.data,
    retry: false,
    staleTime: 5 * 60_000,
  });

  /** 蓝图成本分摊到每流程 */
  const bpCostPerRun = useMemo(() => {
    if (bpMode === "none" || bpPrice <= 0) return 0;
    if (bpMode === "copy") return bpPrice;
    return bpPrice / Math.max(1, bpRuns);
  }, [bpMode, bpPrice, bpRuns]);

  /** ME 0~10 影响表 */
  const meTableQuery = useQuery({
    queryKey: ["mfg-me-table", productId, runs, te, context],
    queryFn: async () => {
      const rows: Array<{ me: number; cost: number; profit: number }> = [];

      for (let value = 0; value <= 10; value += 1) {
        const job = await calculateMfg(
          productId as number,
          runs,
          value,
          te,
          context,
        );
        rows.push({
          me: value,
          cost: job.totalCost,
          profit: job.profit ?? 0,
        });
      }

      return rows;
    },
    enabled: productId !== null,
    staleTime: 2 * 60_000,
  });

  const bomQuery = useQuery({
    queryKey: ["mfg-bom", productId, runs, me, te, buildSet, context],
    queryFn: () =>
      expandMfgBom(productId as number, runs, me, te, buildSet, context),
    enabled: productId !== null && buildSet.length > 0,
    staleTime: 30_000,
  });

  const inventionQuery = useQuery({
    queryKey: ["mfg-invention", recipe?.blueprintTypeId],
    queryFn: () => planInvention(recipe!.blueprintTypeId, 0, context),
    enabled: recipe !== undefined && recipe !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const locationQuery = useQuery({
    queryKey: ["mfg-locations", productId, me, te],
    queryFn: () => locateMfg(productId as number, me, te, 0, 10),
    enabled: productId !== null && !!jobQuery.data,
    retry: false,
    staleTime: 2 * 60_000,
  });

  // 换产品时重置自制集合
  useEffect(() => {
    setBuildSet([]);
  }, [productId]);

  const job = jobQuery.data ?? null;
  const products = productsQuery.data ?? [];

  /** 把蓝图成本摊进去后的总成本与利润 */
  const bpTotal = bpCostPerRun * runs;
  const adjustedCost = (job?.totalCost ?? 0) + bpTotal;
  const adjustedProfit =
    job?.revenue === null || job?.revenue === undefined
      ? null
      : job.revenue - adjustedCost;

  const toggleBuild = (typeId: number) => {
    setBuildSet((current) =>
      current.includes(typeId)
        ? current.filter((id) => id !== typeId)
        : [...current, typeId],
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      {/* 参数区 */}
      <section className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            技能角色
            {skillsQuery.data && (
              <span className="ml-1 text-cyan-300/80">
                时间 −{Math.round((1 - skillMul) * 100)}%
              </span>
            )}
          </span>
          <Select
            value={characterId === null ? "" : String(characterId)}
            onValueChange={(value) => setCharacterId(Number(value))}
          >
            <SelectTrigger size="sm" className="h-8 w-[170px] text-xs">
              <SelectValue placeholder="按无技能计算" />
            </SelectTrigger>
            <SelectContent>
              {characters.map((character) => (
                <SelectItem
                  key={character.character_id}
                  value={String(character.character_id)}
                >
                  {character.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex min-w-[180px] flex-1 flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            产品（中文名 / 英文名 / typeID）
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="例如：矮脚鸡 / Bantam / 582"
              className="h-8 pl-7 text-xs"
            />
          </div>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">选择产品</span>
          <Select
            value={productId === null ? "" : String(productId)}
            onValueChange={(value) => setProductId(Number(value))}
          >
            <SelectTrigger
              size="sm"
              className="h-8 w-[240px] text-xs"
              disabled={products.length === 0}
            >
              <SelectValue
                placeholder={
                  productsQuery.isPending ? "搜索中…" : "请选择"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {products.map((item) => (
                <SelectItem
                  key={item.productTypeId}
                  value={String(item.productTypeId)}
                >
                  {item.name}
                  {item.nameEn ? ` · ${item.nameEn}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <NumField label="流程数" value={runs} min={1} onChange={setRuns} />
        <NumField label="ME %" value={me} min={0} max={10} onChange={setMe} />
        <NumField label="TE %" value={te} min={0} max={20} onChange={setTe} />

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">建筑</span>
          <Select value={facilityTypeId} onValueChange={setFacilityTypeId}>
            <SelectTrigger size="sm" className="h-8 w-[170px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(facilityQuery.data ?? []).map((item) => (
                <SelectItem key={item.typeId} value={String(item.typeId)}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">成本指数</span>
          <Input
            type="number"
            step={0.01}
            min={0}
            value={costIndex}
            onChange={(event) => setCostIndex(Number(event.target.value) || 0)}
            className="h-8 w-24 text-xs tabular-nums"
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">设施税 %</span>
          <Input
            type="number"
            step={0.1}
            min={0}
            value={facilityTax}
            onChange={(event) => setFacilityTax(Number(event.target.value) || 0)}
            className="h-8 w-24 text-xs tabular-nums"
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">蓝图成本</span>
          <Select
            value={bpMode}
            onValueChange={(value) => setBpMode(value as typeof bpMode)}
          >
            <SelectTrigger size="sm" className="h-8 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不计入</SelectItem>
              <SelectItem value="bpo">市场原图分摊</SelectItem>
              <SelectItem value="copy">拷贝每流程</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {bpMode !== "none" && (
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">
              {bpMode === "bpo" ? "原图价格 ISK" : "拷贝单价 ISK"}
            </span>
            <Input
              type="number"
              min={0}
              value={bpPrice}
              onChange={(event) => setBpPrice(Number(event.target.value) || 0)}
              className="h-8 w-28 text-xs tabular-nums"
            />
          </label>
        )}

        {bpMode === "bpo" && (
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">
              分摊流程数
            </span>
            <Input
              type="number"
              min={1}
              value={bpRuns}
              onChange={(event) =>
                setBpRuns(Math.max(1, Number(event.target.value) || 1))
              }
              className="h-8 w-24 text-xs tabular-nums"
            />
          </label>
        )}
      </section>

      {!recipe && !recipeQuery.isError && (
        <p className="text-[11px] text-muted-foreground/60">
          选择产品后显示成本、材料与多级 BOM。
        </p>
      )}

      {recipeQuery.isError && (
        <p className="text-[11px] text-rose-400">
          读取配方失败：
          {recipeQuery.error instanceof Error
            ? recipeQuery.error.message
            : String(recipeQuery.error)}
        </p>
      )}

      {job && recipe && (
        <>
          {/* 汇总 */}
          <section className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
            <Stat label="材料成本" value={isk(job.materialCost)} />
            <Stat label="安装费" value={isk(job.installFee)} />
            <Stat label="税费" value={isk(job.taxes)} />
            <Stat label="蓝图分摊" value={isk(bpTotal)} />
            <Stat label="总成本" value={isk(adjustedCost)} tone="rose" />
            <Stat label="收入" value={isk(job.revenue)} />
            <Stat
              label="利润"
              value={isk(adjustedProfit)}
              tone={(adjustedProfit ?? 0) >= 0 ? "emerald" : "rose"}
            />
            <Stat
              label="利润率"
              value={
                job.revenue === null || job.revenue === 0
                  ? "—"
                  : `${(((adjustedProfit ?? 0) / job.revenue) * 100).toFixed(1)}%`
              }
              tone={(adjustedProfit ?? 0) >= 0 ? "emerald" : "rose"}
            />
          </section>

          <section className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/70 bg-card/40 px-3 py-2 text-[11px]">
            <span className="font-medium text-foreground/90">
              {recipe.productName}
            </span>
            <span className="text-muted-foreground">
              产出 {job.outputQty}
            </span>
            <span className="text-muted-foreground">
              单次 {duration(job.seconds)}
            </span>
            <span className="text-muted-foreground">
              {recipe.activity === "reaction" ? "反应" : "制造"}
            </span>
            <span className="text-cyan-300/90">
              每小时 {isk(job.perHourProfit)}
            </span>
            {job.missingPrice.length > 0 && (
              <span className="text-amber-300/90">
                {job.missingPrice.length} 种材料缺价
              </span>
            )}
          </section>

          {/* 材料表 */}
          <section className="rounded-lg border border-border/70 bg-card/40 p-3">
            <div className="grid grid-cols-[minmax(0,1fr)_70px_70px_90px_90px_60px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
              <span>材料</span>
              <span className="text-right">基础量</span>
              <span className="text-right">ME 后</span>
              <span className="text-right">单价</span>
              <span className="text-right">小计</span>
              <span className="text-center">自制</span>
            </div>

            {job.materials.map((item) => {
              const name = recipe.materials.find(
                (material) => material.typeId === item.typeId,
              )?.name;

              return (
                <div
                  key={item.typeId}
                  className="grid grid-cols-[minmax(0,1fr)_70px_70px_90px_90px_60px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
                >
                  <span className="min-w-0 truncate" title={name}>
                    {name ?? `#${item.typeId}`}
                  </span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">
                    {item.totalBase.toLocaleString("zh-CN")}
                  </span>
                  <span className="text-right font-mono tabular-nums text-emerald-300/90">
                    {item.quantity.toLocaleString("zh-CN")}
                  </span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">
                    {isk(item.unitPrice)}
                  </span>
                  <span className="text-right font-mono tabular-nums">
                    {isk(item.subtotal)}
                  </span>
                  <span className="flex justify-center">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-cyan-400"
                      checked={buildSet.includes(item.typeId)}
                      onChange={() => toggleBuild(item.typeId)}
                      title="勾选后按自制展开（需要该材料也有配方）"
                    />
                  </span>
                </div>
              );
            })}
          </section>

          {/* BOM */}
          {bomQuery.data && buildSet.length > 0 && (
            <BomPanel result={bomQuery.data} />
          )}

          {/* 发明 */}
          {inventionQuery.data && (
            <section className="rounded-lg border border-border/70 bg-card/40 p-3">
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-[11px] font-medium text-foreground/80">
                  发明（T1 → T2）
                </h3>
                <span className="text-[10px] text-muted-foreground/60">
                  基础成功率 {(inventionQuery.data.baseProbability * 100).toFixed(0)}%
                </span>
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_70px_60px_90px_90px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
                <span>解码器</span>
                <span className="text-right">成功率</span>
                <span className="text-right">流程</span>
                <span className="text-right">单次尝试</span>
                <span className="text-right">每流程</span>
              </div>

              {inventionQuery.data.options.map((option) => (
                <div
                  key={option.decryptorId ?? "none"}
                  className="grid grid-cols-[minmax(0,1fr)_70px_60px_90px_90px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
                >
                  <span className="min-w-0 truncate">
                    {option.decryptorName}
                  </span>
                  <span className="text-right font-mono text-cyan-300/90">
                    {(option.probability * 100).toFixed(1)}%
                  </span>
                  <span className="text-right font-mono text-muted-foreground">
                    {option.runs}
                  </span>
                  <span className="text-right font-mono">
                    {isk(option.attemptCost)}
                  </span>
                  <span className="text-right font-mono text-amber-300/90">
                    {isk(option.perRunCost)}
                  </span>
                </div>
              ))}
            </section>
          )}

          {/* ME 影响表 */}
          {meTableQuery.data && meTableQuery.data.length > 0 && (
            <section className="rounded-lg border border-border/70 bg-card/40 p-3">
              <h3 className="mb-1 text-[11px] font-medium text-foreground/80">
                ME 0~10 影响（当前 ME {me}）
              </h3>

              <div className="grid grid-cols-11 gap-1">
                {meTableQuery.data.map((row) => {
                  const current =
                    meTableQuery.data?.find((item) => item.me === me) ?? null;
                  const saving = current ? current.cost - row.cost : 0;

                  return (
                    <div
                      key={row.me}
                      className={cn(
                        "flex flex-col gap-0.5 rounded border px-1 py-1 text-center",
                        row.me === me
                          ? "border-cyan-400/50 bg-cyan-400/10"
                          : "border-border/50",
                      )}
                    >
                      <span className="text-[10px] text-muted-foreground">
                        ME{row.me}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-foreground/80">
                        {isk(row.cost)}
                      </span>
                      <span
                        className={cn(
                          "font-mono text-[9px] tabular-nums",
                          saving > 0
                            ? "text-emerald-300/80"
                            : "text-muted-foreground/50",
                        )}
                      >
                        {saving > 0 ? `-${isk(saving)}` : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 研究与拷贝 */}
          {researchQuery.data && (
            <section className="rounded-lg border border-border/70 bg-card/40 p-3">
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-[11px] font-medium text-foreground/80">
                  研究与拷贝
                </h3>
                <span className="text-[10px] text-muted-foreground/60">
                  单次拷贝 {duration(researchQuery.data.copyTime)} / 流程
                </span>
              </div>

              <div className="grid gap-2 lg:grid-cols-2">
                {(
                  [
                    ["ME 研究", researchQuery.data.meLevels],
                    ["TE 研究", researchQuery.data.teLevels],
                  ] as const
                ).map(([title, levels]) => (
                  <div key={title} className="flex flex-col">
                    <div className="grid grid-cols-[50px_minmax(0,1fr)_90px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
                      <span>{title}</span>
                      <span className="text-right">耗时</span>
                      <span className="text-right">费用</span>
                    </div>

                    {levels.length === 0 && (
                      <p className="py-2 text-[10px] text-muted-foreground/50">
                        已到上限
                      </p>
                    )}

                    {levels.map((level) => (
                      <div
                        key={level.target}
                        className="grid grid-cols-[50px_minmax(0,1fr)_90px] items-center gap-2 border-b border-border/20 py-0.5 text-[11px] last:border-b-0"
                      >
                        <span className="font-mono text-muted-foreground">
                          {level.target}
                        </span>
                        <span className="text-right font-mono text-muted-foreground">
                          {duration(level.seconds)}
                        </span>
                        <span className="text-right font-mono text-amber-300/90">
                          {isk(level.cost)}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 制造地点 */}
          {locationQuery.data && locationQuery.data.length > 0 && (
            <section className="rounded-lg border border-border/70 bg-card/40 p-3">
              <h3 className="mb-1 text-[11px] font-medium text-foreground/80">
                作业费最便宜的星系
              </h3>

              <div className="grid grid-cols-[minmax(0,1fr)_70px_80px_90px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
                <span>星系</span>
                <span className="text-right">安等</span>
                <span className="text-right">成本指数</span>
                <span className="text-right">作业费</span>
              </div>

              {locationQuery.data.map((item) => (
                <div
                  key={item.solarSystemId}
                  className="grid grid-cols-[minmax(0,1fr)_70px_80px_90px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
                >
                  <span className="truncate">{item.name}</span>
                  <span className="text-right font-mono text-muted-foreground">
                    {item.security.toFixed(2)}
                  </span>
                  <span className="text-right font-mono text-muted-foreground">
                    {(item.costIndex * 100).toFixed(2)}%
                  </span>
                  <span className="text-right font-mono text-cyan-300/90">
                    {isk(item.jobCost)}
                  </span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** BOM 树 + 采购清单 */
function BomPanel({ result }: { result: MfgBomResult }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium text-foreground/80">
          多级 BOM（自制 {result.buildCount} 项）
        </h3>
        {result.depthLimited && (
          <span className="text-[10px] text-amber-300/80">
            已达 8 层上限，更深的层级按外购计
          </span>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        {result.raw.map((item) => (
          <div
            key={item.typeId}
            className="flex items-center gap-2 text-[11px]"
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.name}
            </span>
            <span className="w-20 text-right font-mono tabular-nums text-cyan-300/90">
              {item.quantity.toLocaleString("zh-CN")}
            </span>
            <span className="w-20 text-right font-mono tabular-nums text-muted-foreground">
              {isk(item.subtotal)}
            </span>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground/50">
        以上为最底层采购清单（自制件已展开，重复项已汇总）。
      </p>
    </section>
  );
}

