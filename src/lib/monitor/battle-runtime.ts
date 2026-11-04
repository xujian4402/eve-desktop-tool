/**
 * 战斗监控的纯逻辑：命中聚合与播报文本构造。
 *
 * 与 UI、store 解耦，方便单测；store 只负责把结果交给播放器。
 */

/** 聚合窗口：这段时间内的多条命中合并成一句话播报 */
export const BATTLE_SPEECH_WINDOW = 800;

export interface BattleSpeechPayload {
  /** 已经拼好的播报文本 */
  text: string;
  /** 是否包含警报关键字 */
  urgent: boolean;
  /** 本批去重后的目标名 */
  targets: string[];
}

export interface BattleSpeechAggregator {
  /** 收到一条命中 */
  push: (target: string, urgent: boolean) => void;
  /** 立即结算（一般不用调用，窗口到期会自动结算） */
  flush: () => void;
  /** 清空缓冲与定时器（停止监控时调用） */
  reset: () => void;
  /** 是否有待结算的内容 */
  hasPending: () => boolean;
}

/**
 * 构造播报文本。
 *
 * - 单个目标：`命中 X`
 * - 多个目标：`命中 X 等 N 个目标`
 * - 含警报目标：前缀改为 `警告，命中`
 */
export function buildBattleSpeech(targets: string[], urgent: boolean): string {
  if (targets.length === 0) return "";

  if (targets.length === 1) {
    return `${urgent ? "警告，命中" : "命中"} ${targets[0]}`;
  }

  return `命中 ${targets[0]} 等 ${targets.length} 个目标${
    urgent ? "，注意警报目标" : ""
  }`;
}

/** 创建聚合器：窗口内的命中合并为一次回调 */
export function createBattleSpeechAggregator({
  onFlush,
  windowMs = BATTLE_SPEECH_WINDOW,
}: {
  onFlush: (payload: BattleSpeechPayload) => void;
  windowMs?: number;
}): BattleSpeechAggregator {
  let buffer: Array<{ target: string; urgent: boolean }> = [];
  let timer: number | null = null;

  const flush = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }

    const items = buffer;
    buffer = [];
    if (items.length === 0) return;

    const targets = [...new Set(items.map((item) => item.target))];
    const urgent = items.some((item) => item.urgent);

    onFlush({ text: buildBattleSpeech(targets, urgent), urgent, targets });
  };

  return {
    push: (target, urgent) => {
      buffer.push({ target, urgent });

      if (timer === null) {
        timer = window.setTimeout(flush, windowMs);
      }
    },
    flush,
    reset: () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      buffer = [];
    },
    hasPending: () => buffer.length > 0,
  };
}
