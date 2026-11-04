import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  resolveLogDir,
  splitKeywords,
  startMonitor,
  stopMonitor,
  type ChatLine,
  type MonitorHit,
} from "@/lib/monitor/api";
import {
  playAlert,
  playBeep,
  preloadAlertSound,
  speakQueued,
  stopAlert,
  stopAllSounds,
} from "@/lib/monitor/audio";
import {
  buildAlertSpeech,
  isAlertThrottled,
} from "@/lib/monitor/alert-runtime";
import { createBattleSpeechAggregator } from "@/lib/monitor/battle-runtime";

const CONFIG_KEY = "monitor-config-v1";
/** 命中记录上限，避免长时间运行把内存吃满 */
const MAX_HITS = 300;

export interface MonitorConfigState {
  /** EVE 日志根目录 */
  logDir: string;
  /** 战斗监控：目标名关键字（逗号或换行分隔） */
  battleKeywords: string;
  /** 语音播报语速 */
  battleSpeechRate: number;
  /** 是否循环朗读 */
  battleSpeechLoop: boolean;
  /** 警报关键字（命中时播报「警告，命中 X」） */
  battlePriorityKeyword: string;
  /** 预警监控：聊天频道名（逗号分隔） */
  chatChannels: string;
  /** 预警监控：消息里要匹配的星系名 */
  chatKeywords: string;
  /** 预警提醒音 */
  chatSound: string;
  /** 预警提醒方式：音频文件 / 语音播报 */
  chatAlertMode: "sound" | "tts";
  /** 预警语音语速 */
  chatSpeechRate: number;
  /** 预警语音是否循环朗读 */
  chatSpeechLoop: boolean;
  /** 预警警报星系（命中时播「警告，X 出现在 Y」） */
  chatPriorityKeyword: string;
}

interface MonitorStore extends MonitorConfigState {
  /** 任一模块在运行即为 true（用于顶部状态显示） */
  running: boolean;
  /** 战斗监控是否开启 */
  battleRunning: boolean;
  /** 预警监控是否开启 */
  chatRunning: boolean;
  hits: MonitorHit[];
  /** 频道内容预览（最近若干条聊天，不管是否命中） */
  chatLines: ChatLine[];
  /** 通用错误（保留给外壳使用） */
  lastError: string | null;
  /** 战斗监控的启动错误 */
  battleError: string | null;
  /** 预警监控的启动错误 */
  chatError: string | null;
  /** 是否有提醒正在播放（重复 / 循环模式需要「确认」按钮） */
  alertActive: boolean;
  /**
   * 战斗匹配是否已暂停。
   *
   * 触发一次战斗警告后暂停匹配，直到用户点「确认」才恢复，
   * 避免战斗中不停被打断。
   */
  battlePaused: boolean;

  /** 应用启动时调用一次：恢复配置并注册全局事件监听 */
  init: () => void;
  setConfig: (patch: Partial<MonitorConfigState>) => void;
  /** 开启战斗监控（保留预警的开关状态） */
  startBattle: () => Promise<void>;
  /** 关闭战斗监控（预警仍在运行时继续） */
  stopBattle: () => Promise<void>;
  /** 开启预警监控（保留战斗的开关状态） */
  startChat: () => Promise<void>;
  /** 关闭预警监控（战斗仍在运行时继续） */
  stopChat: () => Promise<void>;
  /** 全部停止 */
  stop: () => Promise<void>;
  clearHits: () => void;
  /** 确认当前提醒，停止响铃 */
  acknowledge: () => void;
}

function readConfig(): MonitorConfigState {
  const fallback: MonitorConfigState = {
    logDir: "",
    battleKeywords: "",
    battleSpeechRate: 1,
    battleSpeechLoop: false,
    battlePriorityKeyword: "",
    chatChannels: "",
    chatKeywords: "",
    chatSound: "",
    chatAlertMode: "sound",
    chatSpeechRate: 1,
    chatSpeechLoop: false,
    chatPriorityKeyword: "",
  };

  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<MonitorConfigState>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/** 同一批命中的合并窗口（毫秒）：立体炸弹一次打多个目标只占一行 */
const MERGE_WINDOW = 2000;

/**
 * 战斗语音聚合器（懒初始化）。
 *
 * 聚合逻辑在 lib/monitor/battle-runtime.ts，这里只负责把结果交给播放器。
 */
let battleAggregator: ReturnType<typeof createBattleSpeechAggregator> | null =
  null;

function handleBattleSpeech({
  text,
  urgent,
}: {
  text: string;
  urgent: boolean;
}): void {
  const state = useMonitorStore.getState();
  if (!state.running || !state.battleRunning || !text) return;

  const rate = urgent ? state.battleSpeechRate + 0.2 : state.battleSpeechRate;

  if (state.battleSpeechLoop) {
    // 循环朗读：新一批命中重置上一轮
    playAlert(
      {
        mode: "tts",
        filePath: null,
        volume: 80,
        repeatSeconds: 10,
        repeatLimit: 1,
        speechRate: rate,
        speechLoop: true,
        speechText: text,
      },
      () => useMonitorStore.setState({ alertActive: false }),
    );
    useMonitorStore.setState({ alertActive: true });
    return;
  }

  // 单次语音：排队播报，不打断正在读的内容；期间显示「确认」按钮
  speakQueued(text, rate, () => useMonitorStore.setState({ alertActive: false }));
  useMonitorStore.setState({ alertActive: true });
}

function getBattleAggregator() {
  if (!battleAggregator) {
    battleAggregator = createBattleSpeechAggregator({
      onFlush: handleBattleSpeech,
    });
  }
  return battleAggregator;
}

let initialized = false;
/** 最近一次收到命中的时间，用于合并判定 */
let lastHitAt = 0;
/** 各类提醒上次响铃时间 */
const lastSoundAt: Record<string, number> = {};

/**
 * 按模块开关重新下发给后端。
 *
 * Rust 侧是「一个线程同时扫战斗与聊天」，因此任一模块切换开关时
 * 都重新调用一次 start_monitor（幂等重启），只带上需要监听的模块配置。
 */
async function applyModules(
  set: (partial: Partial<MonitorStore>) => void,
  get: () => MonitorStore,
  patch: { battle?: boolean; chat?: boolean },
): Promise<void> {
  const state = get();
  const battleOn = patch.battle ?? state.battleRunning;
  const chatOn = patch.chat ?? state.chatRunning;

  const battle = battleOn ? splitKeywords(state.battleKeywords) : [];
  const channels = chatOn ? splitKeywords(state.chatChannels) : [];
  const systems = chatOn ? splitKeywords(state.chatKeywords) : [];

  // 只有「主动开启」某个模块时才校验它的配置，避免另一个模块的旧状态误报
  if (patch.battle === true && battle.length === 0) {
    set({ battleError: "请先填写目标名关键字", lastError: null });
    return;
  }
  if (patch.chat === true && (systems.length === 0 || channels.length === 0)) {
    set({ chatError: "请先填写频道名与星系名", lastError: null });
    return;
  }

  // 两个模块都关：直接停掉后端线程
  if (battle.length === 0 && systems.length === 0) {
    await stopMonitor().catch(() => undefined);
    set({
      battleRunning: false,
      chatRunning: false,
      running: false,
      battlePaused: false,
    });
    return;
  }

  try {
    await startMonitor({
      logDir: state.logDir,
      battleKeywords: battle,
      chatChannels: channels,
      chatKeywords: systems,
    });

    set({
      battleRunning: battle.length > 0,
      chatRunning: systems.length > 0,
      running: true,
      battleError: null,
      chatError: null,
      lastError: null,
      battlePaused: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // 后端认为已在运行时，等同启动成功（幂等重启）
    if (message.includes("已在运行")) {
      set({
        battleRunning: battle.length > 0,
        chatRunning: systems.length > 0,
        running: true,
        battleError: null,
        chatError: null,
        lastError: null,
      });
      return;
    }

    // 错误归属到发起操作的模块（按显式 patch 判断，不看合并后的运行状态）
    set(
      patch.battle !== undefined
        ? { battleError: message }
        : { chatError: message },
    );
  }
}

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  ...readConfig(),
  running: false,
  battleRunning: false,
  chatRunning: false,
  hits: [],
  chatLines: [],
  lastError: null,
  battleError: null,
  chatError: null,
  alertActive: false,
  battlePaused: false,

  init: () => {
    if (initialized) return;
    initialized = true;

    // 频道内容预览：不管是否命中关键字都收下来
    void listen<ChatLine>("chat-line", (event) => {
      if (!get().chatRunning) return;

      set((state) => ({
        chatLines: [event.payload, ...state.chatLines].slice(0, 200),
      }));
    });

    // 事件监听放模块级：切到别的菜单也能继续收提醒
    void listen<MonitorHit>("monitor-hit", (event) => {
      const hit = event.payload;
      const flags = get();

      // 模块未开启时忽略（含刚停止时后端线程尚未退出的残余事件）
      if (hit.kind === "battle" && !flags.battleRunning) return;
      if (hit.kind === "chat" && !flags.chatRunning) return;

      // 战斗警告后暂停匹配，等用户点「确认」再继续；预警不受影响
      if (hit.kind === "battle" && flags.battlePaused) return;
      const state = get();
      const {
        chatSound,
        chatAlertMode,
        chatSpeechRate,
        chatSpeechLoop,
        chatPriorityKeyword,
        battlePriorityKeyword,
      } = state;
      const now = Date.now();
      const mergeable = now - lastHitAt < MERGE_WINDOW;

      set((state) => {
        const [first, ...rest] = state.hits;

        // 同一目标 + 同一关键字在 2 秒内连续命中：合并计数，不刷屏
        if (
          mergeable &&
          first &&
          first.kind === hit.kind &&
          first.target === hit.target &&
          first.keyword === hit.keyword
        ) {
          return {
            hits: [{ ...first, count: (first.count ?? 1) + 1 }, ...rest],
          };
        }

        return {
          hits: [{ ...hit, count: 1 }, ...state.hits].slice(0, MAX_HITS),
        };
      });

      lastHitAt = now;

      if (hit.kind === "chat") {
        // 预警做 3 秒节流，避免同一批刷屏
        if (isAlertThrottled(lastSoundAt.chat, now)) return;
        lastSoundAt.chat = now;

        const speech = buildAlertSpeech(hit, chatPriorityKeyword);
        const chatRate = chatSpeechRate + speech.rateDelta;

        if (chatAlertMode === "tts") {
          if (chatSpeechLoop) {
            playAlert(
              {
                mode: "tts",
                filePath: null,
                volume: 80,
                repeatSeconds: 10,
                repeatLimit: 1,
                speechRate: chatRate,
                speechLoop: true,
                speechText: speech.text,
              },
              () => set({ alertActive: false }),
            );
            set({ alertActive: true });
          } else {
            // 排队播报，不打断正在读的内容；期间显示「确认」按钮
            speakQueued(speech.text, chatRate, () =>
              set({ alertActive: false }),
            );
            set({ alertActive: true });
          }
        } else {
          playAlert(
            {
              mode: "single",
              filePath: chatSound || null,
              volume: 80,
              repeatSeconds: 10,
              repeatLimit: 1,
              speechRate: 1,
              speechText: "",
            },
            () => set({ alertActive: false }),
          );
          set({ alertActive: true });
        }
        return;
      }

      // 战斗：按选定的模式播放
      const urgent =
        battlePriorityKeyword.trim().length > 0 &&
        hit.keyword === battlePriorityKeyword.trim();

      // 触发警告即暂停后续匹配，直到用户确认
      set({ battlePaused: true });

      // 战斗提醒统一用语音播报：按 800ms 窗口聚合，多条命中合成一句
      getBattleAggregator().push(hit.target, urgent);
    });

    // 目录为空时尝试自动定位
    if (!get().logDir) {
      void resolveLogDir()
        .then((dir) => set({ logDir: dir }))
        .catch(() => undefined);
    }
  },

  setConfig: (patch) => {
    set(patch);

    const {
      logDir,
      battleKeywords,
      battleSpeechRate,
      battleSpeechLoop,
      battlePriorityKeyword,
      chatChannels,
      chatKeywords,
      chatSound,
      chatAlertMode,
      chatSpeechRate,
      chatSpeechLoop,
      chatPriorityKeyword,
    } = get();

    try {
      localStorage.setItem(
        CONFIG_KEY,
        JSON.stringify({
          logDir,
          battleKeywords,
          battleSpeechRate,
          battleSpeechLoop,
          battlePriorityKeyword,
          chatChannels,
          chatKeywords,
          chatSound,
          chatAlertMode,
          chatSpeechRate,
          chatSpeechLoop,
          chatPriorityKeyword,
        }),
      );
    } catch {
      // 存储不可用时忽略
    }
  },

  startBattle: async () => {
    // 启动前先清一遍残留声音
    stopAllSounds();
    set({ lastError: null });
    await applyModules(set, get, { battle: true });
  },

  stopBattle: async () => {
    await applyModules(set, get, { battle: false });
    set({ battlePaused: false });
  },

  startChat: async () => {
    // 预热预警提示音，避免首次命中时才读文件解码
    void preloadAlertSound(get().chatSound || null);
    // 新一轮监控从干净的频道内容开始
    set({ lastError: null, chatLines: [] });
    await applyModules(set, get, { chat: true });
  },

  stopChat: async () => {
    await applyModules(set, get, { chat: false });
  },

  stop: async () => {
    // 清掉尚未播报的语音缓冲
    battleAggregator?.reset();

    // 停止监控必须彻底静音：当前提醒、残留音频元素、蜂鸣、语音队列
    stopAllSounds();
    try {
      await stopMonitor();
    } catch {
      // 忽略
    }
    set({
      running: false,
      battleRunning: false,
      chatRunning: false,
      alertActive: false,
      battlePaused: false,
      battleError: null,
      chatError: null,
    });
  },

  clearHits: () => set({ hits: [] }),

  acknowledge: () => {
    stopAlert();
    playBeep(0.25);
    // 确认后恢复战斗匹配
    set({ alertActive: false, battlePaused: false });
  },
}));
