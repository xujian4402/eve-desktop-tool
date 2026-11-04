import { invoke } from "@tauri-apps/api/core";

/** 一次命中事件（Rust 端 monitor.rs 推送） */
export interface MonitorHit {
  /** "battle" | "chat" */
  kind: "battle" | "chat";
  /** 日志时间 */
  time: string;
  /** 命中的关键字 */
  keyword: string;
  /** 目标名（战斗）或频道名（聊天） */
  target: string;
  /** 原始行（已去颜色标签） */
  raw: string;
  /** 来源文件名 */
  source: string;
  /** 前端合并后的同批次计数（Rust 不下发） */
  count?: number;
}

/** 频道内容预览行（不管是否命中关键字都会推送） */
export interface ChatLine {
  /** 频道名 */
  channel: string;
  /** 日志时间 */
  time: string;
  /** 发送者 */
  speaker: string;
  /** 消息正文 */
  message: string;
  /** 去标签后的整行 */
  raw: string;
}

export interface MonitorConfig {
  logDir: string;
  battleKeywords: string[];
  chatChannels: string[];
  chatKeywords: string[];
}

/** 自动定位 EVE 日志根目录（Documents/EVE/logs） */
export async function resolveLogDir(): Promise<string> {
  return invoke<string>("resolve_eve_log_dir");
}

export async function startMonitor(config: MonitorConfig): Promise<void> {
  await invoke("start_monitor", { config });
}

export async function stopMonitor(): Promise<void> {
  await invoke("stop_monitor");
}

/** 读取本地音频文件（前端转 Blob 播放） */
export async function readAudioFile(path: string): Promise<number[]> {
  return invoke<number[]>("read_audio_file", { path });
}

/** 一次只读扫描的单个文件结果 */
export interface ChatScanFile {
  file: string;
  channel: string;
  /** 频道名是否匹配配置 */
  matchedChannel: boolean;
  /** 是否在时间窗口内 */
  inWindow: boolean;
  /** 实际读取并参与匹配的行数 */
  linesScanned: number;
  /** 成功按 ` > ` 拆出消息的行数 */
  linesParsed: number;
  /** 最后 50 行里命中条数 */
  hitCount: number;
  /** 命中样例（最多 3 条） */
  samples: string[];
  /** 未命中时的消息样本，用于确认解析是否正常 */
  preview: string[];
  /** 最后一行原文（截断 200 字符） */
  rawSample: string;
  /** 最后一行是否成功解析 */
  lastParsed: boolean;
  lastTime: string;
  lastSpeaker: string;
  lastMessage: string;
}

export interface ChatScanReport {
  logDir: string;
  /** 本次扫描实际使用的频道配置 */
  channels: string[];
  /** 本次扫描实际使用的关键字配置 */
  keywords: string[];
  files: ChatScanFile[];
  totalHits: number;
}

/** 诊断：立即扫描一次聊天日志（不改动运行中的读取位置） */
export async function scanChatOnce(
  config: MonitorConfig,
): Promise<ChatScanReport> {
  return invoke<ChatScanReport>("scan_chat_once", { config });
}

/** 把逗号 / 换行分隔的文本拆成关键字数组 */
export function splitKeywords(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
