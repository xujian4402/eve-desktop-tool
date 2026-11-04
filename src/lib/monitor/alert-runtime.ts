/**
 * 预警监控的纯逻辑：播报文本构造与节流判断。
 */

/** 同一预警的最小间隔，避免同一批消息刷屏 */
export const ALERT_COOLDOWN = 3000;

export interface AlertSpeechPayload {
  text: string;
  urgent: boolean;
  /** 语速增量（警报目标更急促） */
  rateDelta: number;
}

/**
 * 构造预警播报文本。
 *
 * - 普通：`X 出现敌对玩家，注意`
 * - 警报星系：`警告，X 出现敌对玩家，注意`
 *
 * `hit.keyword` 是命中的星系名，`hit.target` 是频道名；
 * 频道名不朗读，避免长频道名拖慢提醒。
 */
export function buildAlertSpeech(
  hit: { target: string; keyword: string },
  priorityKeyword: string,
): AlertSpeechPayload {
  const priority = priorityKeyword.trim();
  const urgent = priority.length > 0 && hit.keyword === priority;
  const body = `${hit.keyword} 出现敌对玩家，注意`;

  return {
    text: urgent ? `警告，${body}` : body,
    urgent,
    rateDelta: urgent ? 0.2 : 0,
  };
}

/** 是否仍在节流窗口内 */
export function isAlertThrottled(
  lastAt: number | undefined,
  now: number,
  cooldown = ALERT_COOLDOWN,
): boolean {
  return now - (lastAt ?? 0) < cooldown;
}
