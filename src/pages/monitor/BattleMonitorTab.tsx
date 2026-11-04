import { Play, Square } from "lucide-react";

import { MonitorHitList } from "@/pages/monitor/MonitorHitList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { speakQueued } from "@/lib/monitor/audio";
import { cn } from "@/lib/utils";
import { useMonitorStore } from "@/stores/monitor-store";

import "./BattleMonitorTab.css";

/**
 * 战斗监控：当自己对指定目标名（模糊匹配）造成伤害时语音播报。
 *
 * 数据来自 Gamelogs 中 `(combat) ... 对 <目标> - <武器> - 命中` 的行，
 * 只处理「对」方向，即你打别人；被别人打不会触发。
 *
 * 提醒方式固定为语音播报：800ms 内的多条命中会合并成一句。
 */
export default function BattleMonitorTab() {
  const battleKeywords = useMonitorStore((state) => state.battleKeywords);
  const speechRate = useMonitorStore((state) => state.battleSpeechRate);
  const speechLoop = useMonitorStore((state) => state.battleSpeechLoop);
  const priorityKeyword = useMonitorStore(
    (state) => state.battlePriorityKeyword,
  );
  const setConfig = useMonitorStore((state) => state.setConfig);
  const hits = useMonitorStore((state) => state.hits);
  const battleRunning = useMonitorStore((state) => state.battleRunning);
  const startBattle = useMonitorStore((state) => state.startBattle);
  const stopBattle = useMonitorStore((state) => state.stopBattle);
  const battlePaused = useMonitorStore((state) => state.battlePaused);
  const battleError = useMonitorStore((state) => state.battleError);

  const handlePreview = () => {
    speakQueued(
      priorityKeyword
        ? `警告，命中 ${priorityKeyword}`
        : "命中 测试目标",
      speechRate,
    );
  };

  return (
    <div className="monitor-battle-tab">
      <div className="monitor-battle-tab__panel">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={battleRunning ? "outline" : "default"}
            className="h-8 justify-start text-xs"
            onClick={() =>
              battleRunning ? void stopBattle() : void startBattle()
            }
          >
            {battleRunning ? (
              <>
                <Square className="size-3.5" />
                停止战斗监控
              </>
            ) : (
              <>
                <Play className="size-3.5" />
                启动战斗监控
              </>
            )}
          </Button>

          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                battleRunning ? "bg-emerald-400" : "bg-muted-foreground/40",
              )}
            />
            {battleRunning ? "战斗监控中" : "战斗监控已停止"}
          </span>
        </div>

        <div className="monitor-battle-tab__field">
          <span className="monitor-battle-tab__label">
            目标名关键字（模糊匹配，多个用逗号或换行分隔）
          </span>
          <Textarea
            value={battleKeywords}
            onChange={(event) =>
              setConfig({ battleKeywords: event.target.value })
            }
            placeholder={"例如：\n森塔提斯\nCentatis\n泰坦"}
            disabled={battleRunning}
            className="min-h-24 w-full max-w-[320px] text-xs disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div className="monitor-battle-tab__field">
          <span className="monitor-battle-tab__label">
            警报关键字（命中时播报「警告，命中 X」，其余只播「命中 X」）
          </span>
          <Input
            value={priorityKeyword}
            onChange={(event) =>
              setConfig({ battlePriorityKeyword: event.target.value })
            }
            placeholder="例如：旗舰"
            disabled={battleRunning}
            className="h-8 w-full max-w-[320px] text-xs disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div className="monitor-battle-tab__field">
          <span className="monitor-battle-tab__label">语速</span>
          <Select
            value={String(speechRate)}
            onValueChange={(value) =>
              setConfig({ battleSpeechRate: Number(value) })
            }
          >
            <SelectTrigger
              size="sm"
              disabled={battleRunning}
              className="h-8 w-full max-w-[320px] text-xs disabled:cursor-not-allowed disabled:opacity-60"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0.8, 1, 1.2, 1.5].map((rate) => (
                <SelectItem key={rate} value={String(rate)}>
                  {rate.toFixed(1)} 倍
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="monitor-battle-tab__field">
          <span className="monitor-battle-tab__label">循环朗读</span>
          <Button
            size="sm"
            variant={speechLoop ? "default" : "outline"}
            className="h-8 justify-start text-xs"
            disabled={battleRunning}
            onClick={() => setConfig({ battleSpeechLoop: !speechLoop })}
            title="开启后读完立即重读，直到点顶部「确认」"
          >
            {speechLoop ? "已开启：重复朗读" : "关闭：只播一次"}
          </Button>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={handlePreview}
        >
          试听语音
        </Button>

        {battleError && (
          <p className="text-[11px] text-rose-400">启动失败：{battleError}</p>
        )}

        <p className="monitor-battle-tab__hint">
          {speechLoop
            ? "循环朗读：读完立即重读，必须点顶部「确认」或重新命中其它目标才会停。"
            : "语音播报：800ms 内的多条命中会合并成一句，多条时播报「命中 X 等 N 个目标」。"}
          {battlePaused &&
            " 已触发警告：战斗匹配暂停中，点顶部「确认并继续」恢复。"}
          {battleRunning
            ? " 监控运行中，配置已锁定；需要修改请先停止监控。"
            : " 战斗监控未启动，填写完成后点上方的「启动战斗监控」。"}
        </p>
      </div>

      <MonitorHitList
        hits={hits.filter((hit) => hit.kind === "battle")}
        emptyText="还没有命中记录。启动监控后，对匹配目标造成伤害时会出现在这里。"
      />
    </div>
  );
}
