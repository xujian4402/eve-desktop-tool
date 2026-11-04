import { readAudioFile } from "@/lib/monitor/api";

/** 警告模式 */
export type AlertMode = "single" | "burst" | "repeat" | "loop" | "tts";

export interface AlertOptions {
  mode: AlertMode;
  /** 本地音频绝对路径；为空时用内置蜂鸣 */
  filePath: string | null;
  /** 音量 0~100 */
  volume: number;
  /** 重复模式间隔（秒） */
  repeatSeconds: number;
  /** 重复模式最多重复次数 */
  repeatLimit: number;
  /** 语音语速 */
  speechRate: number;
  /** 语音播报内容 */
  speechText: string;
  /** 语音模式下是否循环播报（直到确认） */
  speechLoop?: boolean;
}

/** 已加载音频的 Blob URL 缓存，避免每次命中都重新读文件 */
const urlCache = new Map<string, string>();

/** 当前正在进行的提醒（重复 / 循环模式需要能停下来） */
let stopCurrent: (() => void) | null = null;

/**
 * 语音是否已被强制停止。
 *
 * WebView2 的 speechSynthesis.cancel() 存在异步滞后：调用后仍可能触发一次
 * onend，进而让「循环朗读」的链式回调再读一句。用这个标记做兜底。
 */
let speechStopped = false;

/** 彻底中断语音队列（cancel 后补 pause/resume，清掉个别平台残留的排队项） */
function cancelSpeech(): void {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.pause();
    window.speechSynthesis.resume();
  } catch {
    // 忽略
  }
}

/** 所有仍在播放的音频元素，用于「停止监控」时强制静音 */
const activeAudios = new Set<HTMLAudioElement>();
/** 仍在运行的 Web Audio 上下文（内置蜂鸣） */
const activeContexts = new Set<AudioContext>();

/** 停止当前提醒 */
export function stopAlert(): void {
  speechStopped = true;
  stopCurrent?.();
  stopCurrent = null;
  speechQueue.length = 0;
  speechBusy = false;
  cancelSpeech();
}

/**
 * 强制关闭所有声音。
 *
 * 「停止监控」时调用：除了停止当前提醒，还要清理可能残留的音频元素、
 * Web Audio 上下文与语音合成队列，确保彻底静音。
 */
export function stopAllSounds(): void {
  speechStopped = true;
  stopCurrent?.();
  stopCurrent = null;
  speechQueue.length = 0;
  speechBusy = false;

  for (const audio of activeAudios) {
    audio.pause();
    audio.loop = false;
    audio.src = "";
  }
  activeAudios.clear();

  for (const ctx of activeContexts) {
    void ctx.close().catch(() => undefined);
  }
  activeContexts.clear();

  cancelSpeech();
}

/** 预加载音频文件，命中时即可立即出声 */
export async function preloadAlertSound(path: string | null): Promise<void> {
  if (!path || urlCache.has(path)) return;

  try {
    const bytes = await readAudioFile(path);
    const blob = new Blob([new Uint8Array(bytes)]);
    urlCache.set(path, URL.createObjectURL(blob));
  } catch {
    // 预加载失败不影响后续播放（会走回退提示音）
  }
}

async function ensureUrl(path: string): Promise<string | null> {
  const cached = urlCache.get(path);
  if (cached) return cached;

  try {
    const bytes = await readAudioFile(path);
    const blob = new Blob([new Uint8Array(bytes)]);
    const url = URL.createObjectURL(blob);
    urlCache.set(path, url);
    return url;
  } catch {
    return null;
  }
}

/** 内置提示音：两声短促蜂鸣 */
export function playBeep(volume = 0.8): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    activeContexts.add(ctx);

    // WebView2 里新建的 AudioContext 可能是 suspended，需要显式唤醒
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }

    const now = ctx.currentTime;

    [960, 720].forEach((freq, index) => {
      const start = now + index * 0.2;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18 * volume, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });

    setTimeout(() => {
      activeContexts.delete(ctx);
      void ctx.close().catch(() => undefined);
    }, 800);
  } catch {
    // 浏览器限制自动播放时忽略
  }
}

/** 语音播报队列：多条命中排队朗读，不互相打断 */
const speechQueue: Array<{
  text: string;
  rate: number;
  onIdle?: () => void;
}> = [];
let speechBusy = false;

/**
 * 把一段话加入播报队列。
 *
 * 与 `playAlert({ mode: "tts" })` 的区别：这里不打断正在朗读的内容，
 * 逐条排队播完。队列上限 3 条，超出时丢弃最旧的，避免积压。
 *
 * `onIdle` 在队列彻底读完后调用，用于收起「确认」按钮。
 */
export function speakQueued(
  text: string,
  rate = 1,
  onIdle?: () => void,
): void {
  if (!text) return;

  if (speechQueue.length >= 3) speechQueue.shift();
  speechQueue.push({ text, rate, onIdle });
  speechStopped = false;
  pumpSpeech();
}

function pumpSpeech(): void {
  if (speechBusy || speechStopped || speechQueue.length === 0) return;

  const job = speechQueue.shift();
  if (!job) return;

  speechBusy = true;
  speak(job.text, job.rate, () => {
    speechBusy = false;
    if (speechStopped) return;

    if (speechQueue.length === 0) {
      // 队列读完：通知调用方（收起确认按钮）
      job.onIdle?.();
      return;
    }

    pumpSpeech();
  });
}

/**
 * 语音播报（WebView2 自带 speechSynthesis，无需额外依赖）。
 *
 * onEnd 用于「一直不停」模式：读完一条立即接上下一条。
 */
function speak(text: string, rate: number, onEnd?: () => void): void {
  if (!("speechSynthesis" in window)) {
    playBeep();
    onEnd?.();
    return;
  }

  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = rate;

    if (onEnd) {
      // 正常读完与被打断都要回调，否则「不停」模式会卡住
      utterance.onend = () => onEnd();
      utterance.onerror = () => onEnd();
    }

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {
    playBeep();
    onEnd?.();
  }
}

/**
 * 按指定模式播放提醒。
 *
 * 每次调用都会先停掉上一条提醒，因此「重复模式下遇到新目标」天然是重置计时。
 * 结束（次数用尽 / 用户确认）时回调 onFinish。
 */
export function playAlert(options: AlertOptions, onFinish?: () => void): void {
  // 新一轮提醒：解除「已停止」状态
  stopCurrent?.();
  stopCurrent = null;
  speechStopped = false;

  const volume = Math.min(1, Math.max(0, options.volume / 100));
  const timers: number[] = [];
  const audios: HTMLAudioElement[] = [];

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onFinish?.();
  };

  const cleanup = () => {
    timers.forEach((timer) => window.clearTimeout(timer));
    timers.length = 0;

    audios.forEach((audio) => {
      audio.pause();
      audio.src = "";
      activeAudios.delete(audio);
    });
    audios.length = 0;

    if (options.mode === "tts" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    stopCurrent = null;
    finish();
  };

  stopCurrent = cleanup;

  /** 播一次（语音模式直接朗读） */
  const playOnce = async (): Promise<void> => {
    if (finished || speechStopped) return;

    if (options.mode === "tts") {
      speak(options.speechText, options.speechRate);
      return;
    }

    if (!options.filePath) {
      playBeep(volume);
      return;
    }

    const url = await ensureUrl(options.filePath);
    if (!url) {
      playBeep(volume);
      return;
    }

    const audio = new Audio(url);
    audio.volume = volume;
    audio.loop = options.mode === "loop";
    audios.push(audio);
    activeAudios.add(audio);
    void audio.play().catch(() => playBeep(volume));
  };

  switch (options.mode) {
    case "single": {
      void playOnce();
      timers.push(window.setTimeout(cleanup, 1500));
      break;
    }

    case "burst": {
      // 连响 3 次，间隔 220ms
      for (let index = 0; index < 3; index += 1) {
        timers.push(
          window.setTimeout(() => {
            void playOnce();
          }, index * 220),
        );
      }
      timers.push(window.setTimeout(cleanup, 2000));
      break;
    }

    case "repeat": {
      const limit = Math.max(1, options.repeatLimit);
      const interval = Math.max(2, options.repeatSeconds) * 1000;

      // 立即响第一声，之后按间隔重复，直到次数用尽
      void playOnce();

      for (let index = 1; index < limit; index += 1) {
        timers.push(
          window.setTimeout(() => {
            void playOnce();
          }, interval * index),
        );
      }

      timers.push(window.setTimeout(cleanup, interval * limit));
      break;
    }

    case "loop": {
      // 循环播放，只能由用户点「确认」或停止监控结束
      void playOnce();
      break;
    }

    case "tts": {
      if (options.speechLoop) {
        // 循环朗读：读完一条立即接下一条，直到确认或重新命中
        const chain = () => {
          if (finished || speechStopped) return;
          speak(options.speechText, options.speechRate, () => {
            if (!finished && !speechStopped) chain();
          });
        };
        chain();
        break;
      }

      // 单次朗读：留出朗读时间后自动结束
      void playOnce();
      timers.push(window.setTimeout(cleanup, 4000));
      break;
    }
  }
}
