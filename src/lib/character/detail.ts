import { invoke } from "@tauri-apps/api/core";

/** 技能训练队列中的一项 */
export interface SkillQueueItem {
  queuePosition: number;
  skillId: number;
  /** 技能名（本地中文名优先） */
  skillName: string | null;
  finishedLevel: number;
  /** 开始训练时间（ISO） */
  startDate: string | null;
  /** 完成时间（ISO），为空表示已暂停 */
  finishDate: string | null;
}

/** 角色详情（后端一次聚合返回） */
/** 合同 */
export interface ContractItem {
  contractId: number;
  /** item_exchange / courier / auction / loan */
  contractType: string;
  status: string;
  title: string | null;
  price: number | null;
  volume: number | null;
  dateIssued: string | null;
  dateExpired: string | null;
  forCorporation: boolean;
}

/** 邮件 */
export interface MailItem {
  mailId: number;
  subject: string | null;
  fromName: string | null;
  timestamp: string | null;
  isRead: boolean;
}

/** 装配里的一件物品 */
export interface FittingSlotItem {
  typeId: number;
  typeName: string | null;
  /** HiSlot0 / MedSlot1 / LoSlot2 / RigSlot0 / Cargo / DroneBay ... */
  flag: string;
  quantity: number;
}

/** 装配方案 */
export interface FittingItem {
  fittingId: number;
  name: string;
  shipTypeId: number;
  shipTypeName: string | null;
  itemCount: number;
  items: FittingSlotItem[];
}

/** 舰队 */
export interface FleetInfo {
  fleetId: number;
  role: string;
  wingId: number | null;
  squadId: number | null;
}

export interface CharacterDetail {
  characterId: number;
  name: string;
  birthday: string | null;
  securityStatus: number | null;
  description: string | null;

  corporationId: number | null;
  corporationName: string | null;
  corporationTicker: string | null;
  corporationMemberCount: number | null;
  /** 0.1 = 10% */
  corporationTaxRate: number | null;
  corporationCeoId: number | null;

  allianceId: number | null;
  allianceName: string | null;
  allianceTicker: string | null;

  walletBalance: number | null;
  totalSp: number | null;
  unallocatedSp: number | null;
  skillQueue: SkillQueueItem[];

  contracts: ContractItem[];
  mails: MailItem[];
  unreadMailCount: number;
  fittings: FittingItem[];
  fleet: FleetInfo | null;

  solarSystemId: number | null;
  solarSystemName: string | null;
  stationId: number | null;
  stationName: string | null;
  structureId: number | null;
  /** 玩家建筑名 */
  structureName: string | null;
  shipTypeId: number | null;
  shipTypeName: string | null;
  shipName: string | null;

  /** 未成功加载的模块说明 */
  warnings: string[];
}

export async function fetchCharacterDetail(
  characterId: number,
): Promise<CharacterDetail> {
  return invoke<CharacterDetail>("fetch_character_detail", { characterId });
}

/**
 * 解码 EVE 客户端写入的文本。
 *
 * 客户端是 Python 实现的，部分字段（角色简介、舰船名等）会把字符串按
 * Python repr 存进日志/接口，实际形状是 `u'\u98ce\u4e2d\u5fc3'`。
 * 这里统一还原成正常文本，顺带还原 HTML 实体。
 */
export function decodeEveText(raw: string): string {
  let text = raw.trim();

  // 1. 去掉 Python repr 的外层引号与转义
  const repr = /^u?'([\s\S]*)'$/.exec(text) ?? /^u?"([\s\S]*)"$/.exec(text);
  if (repr) {
    text = repr[1]
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  // 2. 解码字面 unicode 转义（只处理真正的 \uXXXX 字面量）
  text = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  text = text.replace(/\\n/g, "\n").replace(/\\t/g, "  ");

  // 3. HTML 实体
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

  return text.trim();
}

/**
 * 清洗角色简介。
 *
 * 除了 `decodeEveText` 处理的 repr / 转义 / 实体，
 * 简介本身是 CCP 富文本，还要剥掉 `<font>`、`<a href="sharedSetting:...">` 等标签。
 */
export function cleanCharacterBio(raw: string): string {
  let text = decodeEveText(raw);

  // 块级标签转成换行，其余标签直接去掉
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(div|p|font|span|a)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");

  // 压缩空白
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 技能点简写：1.2M / 350K */
export function formatSp(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("zh-CN");
}

/** 剩余时长：2天3小时 / 45分 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "已完成";

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分`;
}

/** ISK 简写：1.23B / 456.7M */
export function formatIsk(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
