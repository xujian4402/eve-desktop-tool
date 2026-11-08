import { useEffect } from "react";
import { BellRing, Square } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMonitorStore } from "@/stores/monitor-store";

import AlertMonitorTab from "./monitor/AlertMonitorTab";
import BattleMonitorTab from "./monitor/BattleMonitorTab";
import VisionMonitorTab from "./monitor/VisionMonitorTab";
import "./MonitorPage.css";

/**
 * 监控系统。
 *
 * 两大模块共用同一份日志目录与运行状态：
 * - 战斗监控：对指定目标名造成伤害时提醒
 * - 预警监控：指定聊天频道出现指定星系名时提醒
 *
 * 监听与定时逻辑放在 store 里，切到别的菜单也能持续提醒。
 */
export default function MonitorPage() {
  const init = useMonitorStore((state) => state.init);
  const running = useMonitorStore((state) => state.running);
  const logDir = useMonitorStore((state) => state.logDir);
  const setConfig = useMonitorStore((state) => state.setConfig);
  const stop = useMonitorStore((state) => state.stop);
  const alertActive = useMonitorStore((state) => state.alertActive);
  const battlePaused = useMonitorStore((state) => state.battlePaused);
  const acknowledge = useMonitorStore((state) => state.acknowledge);

  useEffect(() => {
    init();
  }, [init]);

  const handleStop = async () => {
    await stop();
    toast.success("已停止全部监控");
  };

  return (
    <div className="monitor-page">
      <Tabs defaultValue="battle" className="monitor-page__tabs">
        {/* 标签单独一行，工具条另起一行，避免两者混排把内容顶下去 */}
        <TabsList className="monitor-page__tabslist">
          <TabsTrigger value="battle">战斗监控</TabsTrigger>
          <TabsTrigger value="alert">预警监控</TabsTrigger>
          <TabsTrigger value="vision">视觉预警</TabsTrigger>
        </TabsList>

        <div className="monitor-page__bar">
          <div className="monitor-page__dir">
            <Input
              value={logDir}
              onChange={(event) => setConfig({ logDir: event.target.value })}
              placeholder="EVE 日志目录，例如 C:\Users\你\Documents\EVE\logs"
              disabled={running}
              className="h-8 text-xs disabled:cursor-not-allowed disabled:opacity-60"
              title={
                running
                  ? "监控运行中，修改日志目录请先停止监控"
                  : "EVE 日志根目录，其下应有 Gamelogs 与 Chatlogs 两个子目录"
              }
            />
          </div>

          {(alertActive || battlePaused) && (
            <Button
              size="sm"
              variant="destructive"
              className="h-8 gap-1 text-xs"
              onClick={() => acknowledge()}
              title={
                battlePaused
                  ? "确认并恢复战斗匹配"
                  : "停止当前提醒（重复 / 循环模式必须手动确认）"
              }
            >
              <BellRing className="size-3.5" />
              {battlePaused ? "确认并继续" : "确认"}
            </Button>
          )}

          {battlePaused && (
            <span className="text-[11px] text-amber-300/90">
              战斗匹配已暂停
            </span>
          )}

          {running && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => void handleStop()}
            >
              <Square className="size-3.5" />
              全部停止
            </Button>
          )}
        </div>

        <TabsContent
          value="battle"
          className="monitor-page__content data-[state=inactive]:hidden"
        >
          <BattleMonitorTab />
        </TabsContent>

        <TabsContent
          value="alert"
          className="monitor-page__content data-[state=inactive]:hidden"
        >
          <AlertMonitorTab />
        </TabsContent>

        {/* forceMount：切到别的标签时不卸载，后台截屏与循环报警继续运行 */}
        <TabsContent
          forceMount
          value="vision"
          className="monitor-page__content data-[state=inactive]:hidden"
        >
          <VisionMonitorTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
