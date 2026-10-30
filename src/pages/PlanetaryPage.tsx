import { PiPlanPanel } from "@/components/pi/pi-plan-panel";
import { PiSchematicsPanel } from "@/components/pi/pi-schematics-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * 行星工业页。
 *
 * 两块功能共用一个菜单，数据全部来自内置 SDE 静态数据（src/data/pi）：
 *   1. 配方与收益：P0~P4 物资清单与行情/库存，下半部分给出各等级合成结果
 *   2. 行星方案：多选目标产物的采集/加工行星分工
 */
export default function PlanetaryPage() {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-1 flex-col">
      <Tabs defaultValue="schematics" className="min-h-0 flex-1">
        <TabsList className="shrink-0">
          <TabsTrigger value="schematics">配方与收益</TabsTrigger>
          <TabsTrigger value="plan">行星方案</TabsTrigger>
        </TabsList>

        {/* 给 TabsContent 加 display 类时要显式藏掉未激活面板，
            因为 display 工具类会覆盖 UA 的 [hidden]{display:none} */}
        <TabsContent
          value="schematics"
          className="mt-4 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <PiSchematicsPanel />
        </TabsContent>

        <TabsContent
          value="plan"
          className="mt-4 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <PiPlanPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
