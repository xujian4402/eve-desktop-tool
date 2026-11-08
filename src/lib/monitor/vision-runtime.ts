import { listen } from "@tauri-apps/api/event";

import {
  playLoopingAssetSound,
  preloadAssetSound,
  stopAssetSound,
} from "@/lib/monitor/audio";
import type { VisionAlert } from "@/lib/monitor/api";

/** 警报音：public/sound.wav，随应用打包 */
export const VISION_SOUND = "/sound.wav";

/** 日志最多保留条数 */
const MAX_ALERTS = 100;

type AlertListener = (alert: VisionAlert) => void;

const subscribers = new Set<AlertListener>();
/** 全局日志：切换菜单后回来还能看到之前的记录 */
let alerts: VisionAlert[] = [];
let alerting = false;
let initialized = false;

/**
 * 初始化视觉预警的全局事件监听。
 *
 * 挂在应用级而不是组件里：切到市场、制造业等其它菜单时，
 * 截屏线程与循环报警都不应中断。
 */
export function initVisionRuntime(): void {
  if (initialized) return;
  initialized = true;

  preloadAssetSound(VISION_SOUND);

  void listen<VisionAlert>("vision-alert", (event) => {
    alerting = true;
    alerts = [event.payload, ...alerts].slice(0, MAX_ALERTS);

    // 循环播放：红点存在期间一直响
    playLoopingAssetSound(VISION_SOUND, 0.95);

    for (const fn of subscribers) fn(event.payload);
  });

  void listen("vision-clear", () => {
    alerting = false;
    stopAssetSound(VISION_SOUND);
  });
}

/** 订阅命中事件；返回取消订阅函数 */
export function subscribeVisionAlerts(fn: AlertListener): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** 取当前日志（组件重新挂载时用来恢复列表） */
export function getVisionAlerts(): VisionAlert[] {
  return alerts;
}

/** 清空日志 */
export function clearVisionAlerts(): void {
  alerts = [];
}

/** 红点是否仍在（用于判断声音是否该继续） */
export function isVisionAlerting(): boolean {
  return alerting;
}

/** 立即静音（点「停止」或卸载页面时调用） */
export function silenceVision(): void {
  alerting = false;
  stopAssetSound(VISION_SOUND);
}
