import { useCallback, useEffect, useRef, useState } from "react";
import { Play, ScanLine, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { playAssetSound } from "@/lib/monitor/audio";
import {
  listMonitors,
  probeVisionRegion,
  startVisionWatch,
  stopVisionWatch,
  visionWatchRunning,
  type MonitorInfo,
  type VisionAlert,
  type VisionConfig,
  type VisionProbe,
} from "@/lib/monitor/api";
import {
  getVisionAlerts,
  silenceVision,
  subscribeVisionAlerts,
  VISION_SOUND,
} from "@/lib/monitor/vision-runtime";
import { cn } from "@/lib/utils";

const CONFIG_KEY = "vision-watch-config-v1";
const MAX_LOG = 100;

const DEFAULT_CONFIG: VisionConfig = {
  x: 200,
  y: 300,
  width: 100,
  height: 700,
  minPixels: 12,
  intervalMs: 600,
  cooldownMs: 3000,
};

function readConfig(): VisionConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<VisionConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 时间戳 → HH:mm:ss */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 视觉预警：截取屏幕指定区域，检测 EVE 总览里的深红色敌对标记。
 *
 * 参考 EVEAntiCollision 的做法：纯外部工具，只读屏幕像素。
 * 区域需要手动对齐游戏内的总览面板。
 */
export default function VisionMonitorTab() {
  const [config, setConfig] = useState<VisionConfig>(readConfig);
  const [running, setRunning] = useState(false);
  const [probe, setProbe] = useState<VisionProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 从全局运行时恢复日志：切菜单回来还能看到之前的记录
  const [alerts, setAlerts] = useState<VisionAlert[]>(() => getVisionAlerts());
  /** 命中次数（含未写入日志的） */
  const alertCount = useRef(0);
  /** 显示器列表与当前选择（多显示器时用来快速定位坐标） */
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [monitorIndex, setMonitorIndex] = useState("0");

  useEffect(() => {
    void listMonitors()
      .then((list) => {
        setMonitors(list);
        // 默认选主屏
        const primary = list.find((item) => item.primary);
        if (primary) setMonitorIndex(String(primary.index));
      })
      .catch(() => setMonitors([]));
  }, []);

  // 切菜单回来时校正开关状态：后端线程可能仍在跑
  useEffect(() => {
    void visionWatchRunning()
      .then((active) => setRunning(active))
      .catch(() => undefined);
  }, []);



  /** 更新并持久化配置 */
  const patch = useCallback((next: Partial<VisionConfig>) => {
    setConfig((current) => {
      const merged = { ...current, ...next };
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
      } catch {
        // 存储不可用时忽略
      }
      return merged;
    });
  }, []);

  // 命中事件由全局运行时统一处理（含循环播放），这里只订阅日志
  useEffect(() => {
    return subscribeVisionAlerts((alert) => {
      alertCount.current += 1;
      setAlerts((current) => [alert, ...current].slice(0, MAX_LOG));
    });
  }, []);

  /**
   * 截一次图并更新预览。
   *
   * `silent = true` 用于运行中的自动刷新：不切换按钮文案，
   * 否则每 1.5 秒「测试一次 ↔ 检测中…」来回跳，看起来像在闪。
   */
  const handleProbe = async (silent = false) => {
    if (!silent) {
      setProbing(true);
      setError(null);
    }

    try {
      const result = await probeVisionRegion(config);

      setProbe((previous) => {
        // 静默刷新偶发失败时保留上一帧画面，避免预览区闪成占位
        if (silent && !result.preview && previous?.preview) {
          return {
            ...previous,
            redPixels: result.redPixels,
            totalPixels: result.totalPixels,
            hit: result.hit,
          };
        }

        return result;
      });
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!silent) setProbing(false);
    }
  };

  const handleToggle = async () => {
    setError(null);

    try {
      if (running) {
        await stopVisionWatch();
        // 停止监控必须立刻静音，不等后端事件
        silenceVision();
        setRunning(false);
        return;
      }

      await startVisionWatch(config);
      setRunning(true);
      setAlerts([]);
      alertCount.current = 0;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };



  // 运行中定时刷新预览，方便随时确认区域是否还对得准
  useEffect(() => {
    if (!running) return;

    // 静默刷新：不触发按钮的「检测中…」状态，避免闪烁
    void handleProbe(true);
    const timer = window.setInterval(() => void handleProbe(true), 1500);
    return () => window.clearInterval(timer);
    // config 在运行中不可修改，因此只依赖 running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  /** 把区域直接对齐到所选显示器（用户再手动缩小到总览区域） */
  const applyMonitor = () => {
    const monitor = monitors.find(
      (item) => String(item.index) === monitorIndex,
    );
    if (!monitor) return;

    patch({
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
    });
  };

  type Field = {
    key: keyof VisionConfig;
    label: string;
    min: number;
    step?: number;
  };

  /** 按 2 / 2 / 3 分三行：区域坐标 → 区域尺寸 → 检测参数 */
  const fieldRows: Field[][] = [
    [
      { key: "x", label: "左上角 X", min: 0 },
      { key: "y", label: "左上角 Y", min: 0 },
    ],
    [
      { key: "width", label: "宽度", min: 1 },
      { key: "height", label: "高度", min: 1 },
    ],
    [
      { key: "minPixels", label: "最小红点像素", min: 1 },
      { key: "intervalMs", label: "间隔 (ms)", min: 100, step: 100 },
      { key: "cooldownMs", label: "停止延迟 (ms)", min: 300, step: 100 },
    ],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 状态条 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={running ? "outline" : "default"}
          className="h-8 gap-1 text-xs"
          onClick={() => void handleToggle()}
        >
          {running ? (
            <>
              <Square className="size-3.5" />
              停止视觉预警
            </>
          ) : (
            <>
              <Play className="size-3.5" />
              启动视觉预警
            </>
          )}
        </Button>

        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              running ? "bg-emerald-400" : "bg-muted-foreground/40",
            )}
          />
          {running ? "视觉预警中" : "视觉预警已停止"}
        </span>

        <span className="ml-auto text-[11px] text-muted-foreground">
          命中 {alerts.length} 次
        </span>
      </div>

      {/* 区域与参数 + 预览 */}
      <div className="flex flex-wrap items-stretch gap-3 rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* 多显示器：显示各屏坐标，一键对齐 */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">显示器</span>
              <Select
                value={monitorIndex}
                onValueChange={setMonitorIndex}
                disabled={running || monitors.length === 0}
              >
                <SelectTrigger
                  size="sm"
                  className="h-7 w-[240px] text-xs disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <SelectValue placeholder="未检测到显示器" />
                </SelectTrigger>
                <SelectContent>
                  {monitors.map((monitor) => (
                    <SelectItem
                      key={monitor.index}
                      value={String(monitor.index)}
                    >
                      {monitor.name} · {monitor.width}×{monitor.height} @ (
                      {monitor.x}, {monitor.y})
                      {monitor.primary ? " · 主屏" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={running || monitors.length === 0}
              onClick={applyMonitor}
              title="把区域设为该显示器的完整范围，再手动缩小到总览区域"
            >
              对齐到该显示器
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => playAssetSound(VISION_SOUND, 0.95)}
              title="试听警报音 sound.wav"
            >
              试听警报音
            </Button>
          </div>

          {/* 输入框按 2 / 2 / 3 三行排列 */}
          <div className="flex flex-col gap-2">
            {fieldRows.map((row, rowIndex) => (
              <div key={rowIndex} className="flex flex-wrap items-end gap-2">
                {row.map((field) => (
                  <label key={field.key} className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground">
                      {field.label}
                    </span>
                    <Input
                      type="number"
                      value={config[field.key]}
                      min={field.min}
                      step={field.step}
                      disabled={running}
                      onChange={(event) =>
                        patch({
                          [field.key]: Number(event.target.value) || 0,
                        } as Partial<VisionConfig>)
                      }
                      className="h-7 w-24 text-xs tabular-nums"
                    />
                  </label>
                ))}

                {/* 「测试一次」跟在第三行末尾 */}
                {rowIndex === fieldRows.length - 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    disabled={probing}
                    onClick={() => void handleProbe()}
                  >
                    <ScanLine className="size-3.5" />
                    {probing ? "检测中…" : "测试一次"}
                  </Button>
                )}
              </div>
            ))}
          </div>

        {probe && (
          <p
            className={cn(
              "text-[11px]",
              !probe.captured
                ? "text-rose-300"
                : probe.hit
                  ? "text-emerald-300"
                  : "text-muted-foreground",
            )}
          >
            {probe.captured
              ? `红色像素 ${probe.redPixels} / 共 ${probe.totalPixels} · ${
                  probe.hit ? "达到阈值，会报警" : "未达到阈值"
                }`
              : "截屏失败：区域可能超出屏幕范围"}
          </p>
        )}

        {error && <p className="text-[11px] text-rose-400">{error}</p>}

          <p className="text-[10px] text-muted-foreground/60">
            把区域对准游戏内总览面板的敌对标记列；先用「测试一次」确认红色像素数，
            再调整「最小红点像素」避免误报。运行中配置锁定，需先停止。
          </p>
        </div>

        {/* 区域预览：高度撑满参数区，宽度按截图比例自适应 */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            区域预览{running ? "（1.5 秒刷新）" : ""}
          </span>

          <div
            className={cn(
              "flex min-h-[160px] flex-1 items-center justify-center overflow-hidden rounded border border-border/60 bg-black/50",
              // 有画面时容器宽度贴合图片，避免两侧留黑边
              probe?.preview ? "w-fit" : "min-w-[120px]",
            )}
          >
            {probe?.preview ? (
              <img
                src={probe.preview}
                alt="截屏区域预览"
                className="h-full w-auto max-h-full max-w-full"
                style={{ imageRendering: "pixelated" }}
              />
            ) : (
              <span className="px-2 text-center text-[10px] leading-relaxed text-muted-foreground/50">
                点「测试一次」
                <br />
                查看区域内容
              </span>
            )}
          </div>

          {probe?.captured && (
            <span className="text-center text-[10px] text-muted-foreground/60">
              {config.width} × {config.height}
            </span>
          )}
        </div>
      </div>

      {/* 预警日志 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/40">
        <div className="flex shrink-0 items-center justify-between border-b border-border/40 px-3 py-1.5">
          <span className="text-[11px] text-foreground/80">预警日志</span>
          <button
            type="button"
            className="text-[10px] text-muted-foreground/60 hover:text-foreground"
            onClick={() => setAlerts([])}
          >
            清空
          </button>
        </div>

        {alerts.length === 0 ? (
          <p className="flex flex-1 items-center justify-center px-3 py-6 text-center text-[11px] text-muted-foreground/60">
            还没有预警记录。启动后检测到深红色标记时会出现在这里。
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {alerts.map((alert, index) => (
              <div
                key={`${alert.at}-${index}`}
                className="flex items-center gap-2 border-b border-border/20 px-3 py-1 text-[11px] last:border-b-0"
              >
                <span className="font-mono tabular-nums text-muted-foreground/70">
                  {clock(alert.at)}
                </span>
                <span className="text-rose-300">来红！</span>
                <span className="ml-auto font-mono tabular-nums text-muted-foreground/60">
                  {alert.redPixels} px
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
