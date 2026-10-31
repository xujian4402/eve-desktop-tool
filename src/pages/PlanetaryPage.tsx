import { PiColoniesPanel } from "@/components/pi/pi-colonies-panel";
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
          <TabsTrigger value="colonies">我的菜地</TabsTrigger>
        </TabsList>

        {/* forceMount：Radix 默认会卸载非激活面板，切走再回来状态就丢了；
            保持挂载后用 data-[state=inactive]:hidden 隐藏即可 */}
        <TabsContent
          value="schematics"
          forceMount
          className="mt-4 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <PiSchematicsPanel />
        </TabsContent>

        <TabsContent
          value="plan"
          forceMount
          className="mt-4 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <PiPlanPanel />
        </TabsContent>

        <TabsContent
          value="colonies"
          forceMount
          className="mt-4 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <PiColoniesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
