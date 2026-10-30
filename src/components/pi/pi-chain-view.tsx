import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PLANET_FACILITY_HINT } from "@/lib/pi/planet-types";
import type { PiChainPlan } from "@/lib/pi/types";
import type { PiPlanetType } from "@/lib/pi/types";

/** 生产链展示：外购清单 + 各步骤周期 + 行星建议 */
export function PiChainView({ plan }: { plan: PiChainPlan }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{plan.rootName}</span>
        <Badge variant="secondary">P{plan.rootTier}</Badge>
        <span className="text-muted-foreground">
          1 条产线 · {plan.cycles} 个周期/小时 · 占用产线{" "}
          {(plan.cycleSecondsPerHour / 60).toFixed(0)} 分钟
        </span>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-medium text-foreground/85">
          外购原料（P0）
        </h3>
        {plan.purchases.length === 0 ? (
          <p className="text-xs text-muted-foreground">无需外购原料。</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>原料</TableHead>
                  <TableHead className="text-right">每小时需求</TableHead>
                  <TableHead>可采行星</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.purchases.map((item) => (
                  <TableRow key={item.typeId}>
                    <TableCell>
                      <span className="block">{item.name}</span>
                      <span className="block font-mono text-[10px] text-muted-foreground/60">
                        {item.typeId}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.quantity.toLocaleString()}
                    </TableCell>
                    <TableCell className="max-w-72 truncate text-xs text-muted-foreground">
                      {plan.harvestPlanets.length > 0 &&
                      plan.purchases.length === 1
                        ? plan.harvestPlanets.join(" / ")
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-foreground/85">
          生产步骤（中间品默认自制）
        </h3>
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>等级</TableHead>
                <TableHead>产物</TableHead>
                <TableHead className="text-right">周期</TableHead>
                <TableHead className="text-right">总产出</TableHead>
                <TableHead>投入</TableHead>
                <TableHead>设施</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.steps.map((step) => (
                <TableRow key={step.schematicId}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      P{step.tier}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="block">{step.name}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground/60">
                      {step.outputTypeId}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {step.cycles} × {step.cycleTime}s
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {step.totalOutput.toLocaleString()}
                  </TableCell>
                  <TableCell className="max-w-80 text-xs text-muted-foreground">
                    {step.inputs
                      .map((input) => `${input.name} ×${input.quantity}`)
                      .join("，")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {step.facility}
                    <span className="block text-[10px] text-muted-foreground/60">
                      {step.planetTypes.join(" / ") || "—"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <div>
          <span className="text-foreground/80">采集行星：</span>
          {plan.harvestPlanets.join(" / ") || "—"}
        </div>
        <div>
          <span className="text-foreground/80">加工行星：</span>
          {plan.processingPlanets.join(" / ") || "—"}
        </div>
        <div>
          <span className="text-foreground/80">单星跑全链：</span>
          {plan.sharedPlanets.length > 0
            ? plan.sharedPlanets
                .map(
                  (planet) =>
                    `${planet}（${PLANET_FACILITY_HINT[planet as PiPlanetType]}）`,
                )
                .join(" / ")
            : "需要多颗行星分工"}
        </div>
      </section>

      <p className="text-[11px] text-muted-foreground/70">{plan.note}</p>
    </div>
  );
}
