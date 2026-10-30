/**
 * ESI 资产槽位（location_flag）中文对照表。
 *
 * 来源：ESI /characters/{id}/assets/ 返回的 location_flag 字段。
 * 带数字的槽位（HiSlot0、RigSlot2 等）由 formatLocationFlag 统一加前缀，
 * 未收录的值原样返回，不会变成空白。
 */

/** 固定槽位名 */
export const LOCATION_FLAG_LABEL: Record<string, string> = {
  Hangar: "机库",
  HangarAll: "全部机库",
  ShipHangar: "舰船机库",
  SecondaryHangar: "次级机库",
  Cargo: "货舱",
  Deliveries: "快递箱",
  CorporationGoalDeliveries: "军团目标快递",
  CorpDeliveries: "军团快递箱",
  AssetSafety: "资产安全",
  Unlocked: "未锁定",
  Locked: "已锁定",
  OfficeFolder: "办公室",
  Impounded: "扣押",
  Industry: "工业设施",
  DroneBay: "无人机舱",
  FighterBay: "铁骑舰载机舱",
  BoosterBay: "增效剂舱",
  QuantumCoreRoom: "量子核心室",
  StructureFuel: "燃料舱",
  MoonMaterialBay: "月矿舱",
  QuafeBay: "酷菲舱",
  HiddenModifiers: "隐藏改装",
  CrateLoot: "箱子战利品",
  AutoFit: "自动装配",
  Skill: "技能",
  Wardrobe: "衣柜",
  Wallet: "钱包",
  Pilot: "飞行员",
  PlanetSurface: "行星表面",
};

/** 带数字的槽位前缀：HiSlot0 → 高槽 1 */
export const SLOT_PREFIX: Record<string, string> = {
  HiSlot: "高槽",
  MedSlot: "中槽",
  LoSlot: "低槽",
  RigSlot: "改装槽",
  SubSystem: "子系统槽",
  FighterTube: "铁骑发射管",
};

/** 把 ESI 的 location_flag 转成中文说明 */
export function formatLocationFlag(flag: string): string {
  if (LOCATION_FLAG_LABEL[flag]) return LOCATION_FLAG_LABEL[flag];

  const slot = /^(HiSlot|MedSlot|LoSlot|RigSlot|SubSystem|FighterTube)(\d)$/.exec(
    flag,
  );
  if (slot) {
    // ESI 的槽位从 0 开始编号，展示时 +1 更符合游戏内习惯
    return `${SLOT_PREFIX[slot[1]]} ${Number(slot[2]) + 1}`;
  }

  // 军团安全资产 CorpSAG1 ~ CorpSAG7
  const sag = /^CorpSAG(\d)$/.exec(flag);
  if (sag) return `军团安全资产 ${sag[1]}`;

  // 其它 Corp* 前缀：先看去掉前缀后是否还有对应中文
  if (flag.startsWith("Corp")) {
    const rest = flag.slice(4);
    const mapped = LOCATION_FLAG_LABEL[rest];
    return mapped ? `军团${mapped}` : `军团${rest}`;
  }

  return flag;
}

/** 位置类型（玩家建筑 / NPC 空间站 / 太空）中文名 */
export const LOCATION_KIND_LABEL: Record<string, string> = {
  structure: "玩家建筑",
  station: "NPC 空间站",
  system: "太空",
};
