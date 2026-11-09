import { useMemo, useState } from "react";
import { Play, Square } from "lucide-react";

import { ChatContentList } from "@/pages/monitor/ChatContentList";
import { MonitorHitList } from "@/pages/monitor/MonitorHitList";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  scanChatOnce,
  splitKeywords,
  type ChatScanReport,
} from "@/lib/monitor/api";
import {
  playAlert,
  preloadAlertSound,
  speakQueued,
} from "@/lib/monitor/audio";
import { cn } from "@/lib/utils";
import { useMonitorStore } from "@/stores/monitor-store";

import "./AlertMonitorTab.css";

/**
 * 预警监控：指定聊天频道里出现指定星系名时提醒。
 *
 * 频道按 Chatlogs 文件名前缀识别（例如「舰队_20261104_....txt」对应频道「舰队」，
 * 「southeast.imperium_...」对应频道「southeast.imperium」）。
 */
export default function AlertMonitorTab() {
  const chatChannels = useMonitorStore((state) => state.chatChannels);
  const chatKeywords = useMonitorStore((state) => state.chatKeywords);
  const chatSound = useMonitorStore((state) => state.chatSound);
  const setConfig = useMonitorStore((state) => state.setConfig);
  const hits = useMonitorStore((state) => state.hits);
  const chatRunning = useMonitorStore((state) => state.chatRunning);
  const startChat = useMonitorStore((state) => state.startChat);
  const stopChat = useMonitorStore((state) => state.stopChat);
  const chatError = useMonitorStore((state) => state.chatError);
  const chatLines = useMonitorStore((state) => state.chatLines);
  const alertMode = useMonitorStore((state) => state.chatAlertMode);
  const speechRate = useMonitorStore((state) => state.chatSpeechRate);
  const speechLoop = useMonitorStore((state) => state.chatSpeechLoop);
  const priorityKeyword = useMonitorStore(
    (state) => state.chatPriorityKeyword,
  );

  const chatHits = hits.filter((hit) => hit.kind === "chat");
  const isTts = alertMode === "tts";

  /** 诊断：立即扫描一次，看后端到底读到了什么 */
  const logDir = useMonitorStore((state) => state.logDir);
  const [scanReport, setScanReport] = useState<ChatScanReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const handleScan = async () => {
    setScanning(true);
    setScanOpen(true);

    try {
      setScanReport(
        await scanChatOnce({
          logDir,
          battleKeywords: [],
          chatChannels: splitKeywords(chatChannels),
          chatKeywords: splitKeywords(chatKeywords),
        }),
      );
    } catch {
      setScanReport({
        logDir,
        channels: [],
        keywords: [],
        files: [],
        totalHits: -1,
      });
    } finally {
      setScanning(false);
    }
  };

  /** 测试匹配：粘贴聊天内容，验证关键字是否命中 */
  const [testText, setTestText] = useState("");
  const testHit = useMemo(() => {
    const text = testText.trim();
    if (!text) return null;

    // 与后端一致：只匹配 `发送者 > 消息` 里的消息部分
    const message = text.includes(" > ")
      ? text.split(" > ").slice(1).join(" > ")
      : text;

    const keyword = splitKeywords(chatKeywords).find((item) =>
      message.toLowerCase().includes(item.toLowerCase()),
    );

    return keyword ?? "";
  }, [testText, chatKeywords]);

  const handlePreview = () => {
    if (isTts) {
      speakQueued(
        priorityKeyword
          ? `警告，${priorityKeyword} 出现敌对玩家，注意`
          : "G-JC9R 出现敌对玩家，注意",
        speechRate,
      );
      return;
    }

    void preloadAlertSound(chatSound || null);
    playAlert({
      mode: "single",
      filePath: chatSound || null,
      volume: 80,
      repeatSeconds: 10,
      repeatLimit: 1,
      speechRate: 1,
      speechText: "",
    });
  };

  return (
    <div className="alert-monitor-tab">
      {/* 状态条 */}
      <div className="alert-monitor-tab__bar">
        <Button
          size="sm"
          variant={chatRunning ? "outline" : "default"}
          className="h-8 gap-1 text-xs"
          onClick={() => (chatRunning ? void stopChat() : void startChat())}
        >
          {chatRunning ? (
            <>
              <Square className="size-3.5" />
              停止预警监控
            </>
          ) : (
            <>
              <Play className="size-3.5" />
              启动预警监控
            </>
          )}
        </Button>

        <span className="alert-monitor-tab__status">
          <span
            className={cn(
              "alert-monitor-tab__dot",
              chatRunning && "alert-monitor-tab__dot--on",
            )}
          />
          {chatRunning ? "预警监控中" : "预警监控已停止"}
        </span>

        <span className="alert-monitor-tab__count">
          命中记录 {chatHits.length} 条
        </span>
      </div>

      {/* 配置区 */}
      <div className="alert-monitor-tab__form">
        <label className="alert-monitor-tab__field">
          <span className="alert-monitor-tab__label">
            聊天频道名（多个用逗号分隔，对应 Chatlogs 文件名前缀）
          </span>
          <Textarea
            value={chatChannels}
            onChange={(event) =>
              setConfig({ chatChannels: event.target.value })
            }
            placeholder={"例如：\n军团\n舰队"}
            disabled={chatRunning}
            className="min-h-20 w-full max-w-[320px] text-xs disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <label className="alert-monitor-tab__field">
          <span className="alert-monitor-tab__label">
            星系名关键字（出现即提醒，模糊匹配）
          </span>
          <Textarea
            value={chatKeywords}
            onChange={(event) => setConfig({ chatKeywords: event.target.value })}
            placeholder={"例如：\nJita\n1-SMEB\nB-R5RB"}
            disabled={chatRunning}
            className="min-h-20 w-full max-w-[320px] text-xs disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <div className="alert-monitor-tab__field alert-monitor-tab__field--full">
          <span className="alert-monitor-tab__label">提醒方式</span>
          <div className="inline-flex overflow-hidden rounded border border-border">
            {(
              [
                ["sound", "音频文件"],
                ["tts", "语音播报"],
              ] as const
            ).map(([value, label], index) => (
              <button
                key={value}
                type="button"
                disabled={chatRunning}
                onClick={() => setConfig({ chatAlertMode: value })}
                className={cn(
                  "px-2 py-1 text-[11px] transition-colors",
                  index > 0 && "border-l border-border",
                  alertMode === value
                    ? "bg-cyan-500/20 text-cyan-300"
                    : "text-muted-foreground hover:bg-muted/60",
                  chatRunning && "cursor-not-allowed opacity-60",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {isTts ? (
          <>
            <div className="alert-monitor-tab__field">
              <span className="alert-monitor-tab__label">
                警报星系（命中时播报「警告，X 出现敌对玩家，注意」）
              </span>
              <Input
                value={priorityKeyword}
                onChange={(event) =>
                  setConfig({ chatPriorityKeyword: event.target.value })
                }
                placeholder="例如：1-SMEB"
                disabled={chatRunning}
                className="h-8 w-full max-w-[320px] text-xs disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            <div className="alert-monitor-tab__field">
              <span className="alert-monitor-tab__label">语速</span>
              <Select
                value={String(speechRate)}
                onValueChange={(value) =>
                  setConfig({ chatSpeechRate: Number(value) })
                }
              >
                <SelectTrigger
                  size="sm"
                  disabled={chatRunning}
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

            <div className="alert-monitor-tab__field">
              <span className="alert-monitor-tab__label">循环朗读</span>
              <Button
                size="sm"
                variant={speechLoop ? "default" : "outline"}
                className="h-8 justify-start text-xs"
                disabled={chatRunning}
                onClick={() => setConfig({ chatSpeechLoop: !speechLoop })}
                title="开启后读完立即重读，直到点顶部「确认」"
              >
                {speechLoop ? "已开启：重复朗读" : "关闭：只播一次"}
              </Button>
            </div>
          </>
        ) : (
          <div className="alert-monitor-tab__field alert-monitor-tab__field--full">
            <span className="alert-monitor-tab__label">
              提醒音（本地音频绝对路径，留空用内置提示音）
            </span>
            <div className="flex max-w-[420px] gap-1.5">
              <Input
                value={chatSound}
                onChange={(event) =>
                  setConfig({ chatSound: event.target.value })
                }
                placeholder="D:\sounds\alert.mp3"
                disabled={chatRunning}
                className="h-8 text-xs disabled:cursor-not-allowed disabled:opacity-60"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 text-xs"
                onClick={handlePreview}
                title="试听"
              >
                试听
              </Button>
            </div>
          </div>
        )}

        {isTts && (
          <div className="alert-monitor-tab__field alert-monitor-tab__field--full">
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-fit text-xs"
              onClick={handlePreview}
            >
              试听语音
            </Button>
          </div>
        )}

        <div className="alert-monitor-tab__field alert-monitor-tab__field--full">
          <span className="alert-monitor-tab__label">
            诊断：立即读取一次日志，看后端实际扫到哪些文件、命中几条
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-fit text-xs"
            disabled={scanning}
            onClick={() => void handleScan()}
          >
            {scanning ? "扫描中…" : "立即扫描一次"}
          </Button>
        </div>

        <div className="alert-monitor-tab__field alert-monitor-tab__field--full">
          <span className="alert-monitor-tab__label">
            测试匹配（粘贴整行或消息正文，验证星系名 / 角色名是否命中）
          </span>
          <div className="flex max-w-[520px] gap-1.5">
            <Input
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
              placeholder="G-JC9R*"
              className="h-8 text-xs"
            />
            <span
              className={cn(
                "inline-flex h-8 shrink-0 items-center rounded border px-2 text-[11px]",
                testHit === null
                  ? "border-border text-muted-foreground"
                  : testHit
                    ? "border-emerald-500/40 text-emerald-300"
                    : "border-rose-500/40 text-rose-300",
              )}
            >
              {testHit === null
                ? "待测试"
                : testHit
                  ? `命中：${testHit}`
                  : "未命中"}
            </span>
          </div>
        </div>

        {chatError && (
          <p className="alert-monitor-tab__hint text-rose-400">
            启动失败：{chatError}
          </p>
        )}

        <p className="alert-monitor-tab__hint">
          频道名与游戏内频道名一致即可（中文频道名也会匹配），留空则不会触发预警；
          消息内容包含星系名时提醒，同一星系名 3 秒内只提醒一次。
          {isTts
            ? speechLoop
              ? " 循环朗读：读完立即重读，直到点顶部「确认」。"
              : " 语音播报：多条预警排队朗读，不互相打断。"
            : " 音频模式：播放指定音频文件，留空时用内置提示音。"}
          {chatRunning
            ? " 监控运行中，配置已锁定；需要修改请先停止监控。"
            : " 预警监控未启动，填写完成后点上方「启动预警监控」。"}
        </p>
      </div>

      {/* 底部：命中记录 / 频道内容 */}
      <Tabs defaultValue="hits" className="flex min-h-0 flex-1 flex-col gap-1">
        <TabsList className="h-7 shrink-0 gap-1">
          <TabsTrigger value="hits" className="h-6 px-2 text-[11px]">
            命中记录 {chatHits.length}
          </TabsTrigger>
          <TabsTrigger value="content" className="h-6 px-2 text-[11px]">
            频道内容 {chatLines.length}
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="hits"
          className="alert-monitor-tab__list mt-0 data-[state=inactive]:hidden"
        >
          <MonitorHitList
            hits={chatHits}
            emptyText="还没有预警记录。启动监控后，指定频道出现对应星系名时会出现在这里。"
            showChannel
          />
        </TabsContent>

        <TabsContent
          value="content"
          className="alert-monitor-tab__list mt-0 data-[state=inactive]:hidden"
        >
          <ChatContentList lines={chatLines} />
        </TabsContent>
      </Tabs>

      {/* 诊断报告 */}
      <Dialog open={scanOpen} onOpenChange={setScanOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>扫描结果</DialogTitle>
            <DialogDescription>
              {scanReport === null || scanReport.totalHits === -1
                ? "扫描失败，请确认日志目录是否正确"
                : `共检查 ${scanReport.files.length} 个频道文件，命中 ${scanReport.totalHits} 条`}
            </DialogDescription>
          </DialogHeader>

          {scanReport && scanReport.totalHits !== -1 && (
            <div className="flex flex-col gap-1 rounded border border-border/60 bg-muted/20 p-2 text-[11px]">
              <span>
                <span className="text-muted-foreground">频道：</span>
                {scanReport.channels.length > 0 ? (
                  scanReport.channels.join("、")
                ) : (
                  <span className="text-rose-300">未配置（不会扫描任何频道）</span>
                )}
              </span>
              <span>
                <span className="text-muted-foreground">关键字：</span>
                {scanReport.keywords.length > 0 ? (
                  scanReport.keywords.join("、")
                ) : (
                  <span className="text-rose-300">
                    未配置（不会命中任何消息）
                  </span>
                )}
              </span>
            </div>
          )}

          <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-auto text-[11px]">
            {scanReport?.files.map((file) => (
              <div
                key={file.file}
                className="flex flex-col gap-1 rounded border border-border/60 p-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded px-1",
                      file.matchedChannel
                        ? "bg-cyan-500/15 text-cyan-300"
                        : "bg-muted/40 text-muted-foreground/70",
                    )}
                  >
                    {file.channel || "—"}
                  </span>

                  <span
                    className="min-w-0 flex-1 truncate text-muted-foreground"
                    title={file.file}
                  >
                    {file.file}
                  </span>

                  {!file.matchedChannel && (
                    <span className="shrink-0 text-rose-300/80">
                      频道不匹配
                    </span>
                  )}
                  {file.matchedChannel && !file.inWindow && (
                    <span className="shrink-0 text-amber-300/80">
                      超出时间窗
                    </span>
                  )}
                  {file.hitCount > 0 && (
                    <span className="shrink-0 text-emerald-300">
                      命中 {file.hitCount} 条
                    </span>
                  )}
                </div>

                {file.matchedChannel && (
                  <>
                    <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground/70">
                      <span>读取 {file.linesScanned} 行</span>
                      <span>解析 {file.linesParsed} 行</span>
                    </div>

                    <div className="rounded border border-border/40 bg-muted/10 p-1.5 text-[10px]">
                      <div className="mb-0.5 text-muted-foreground/70">
                        最后一行解析
                      </div>
                      {file.lastParsed ? (
                        <div className="flex flex-col gap-0.5">
                          <span>
                            <span className="text-muted-foreground">时间 </span>
                            {file.lastTime || "—"}
                          </span>
                          <span>
                            <span className="text-muted-foreground">
                              发送者{" "}
                            </span>
                            {file.lastSpeaker || "—"}
                          </span>
                          <span className="text-foreground/85">
                            <span className="text-muted-foreground">消息 </span>
                            {file.lastMessage || "—"}
                          </span>
                        </div>
                      ) : (
                        <span className="text-rose-300">
                          未能按 &quot; &gt; &quot; 拆分，原文：
                          {file.rawSample || "（空）"}
                        </span>
                      )}
                    </div>

                    {file.samples.map((sample, index) => (
                      <p
                        key={`hit-${index}`}
                        className="truncate text-[10px] text-emerald-300/90"
                        title={sample}
                      >
                        ✔ {sample}
                      </p>
                    ))}

                    {file.samples.length === 0 &&
                      file.preview.map((sample, index) => (
                        <p
                          key={`preview-${index}`}
                          className="truncate text-[10px] text-foreground/60"
                          title={sample}
                        >
                          · {sample}
                        </p>
                      ))}
                  </>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
