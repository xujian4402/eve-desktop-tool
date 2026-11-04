import type { MfgActivity } from "@/lib/manufacturing/data";

/**
 * 制造业相关技能。
 *
 * 技能只影响**时间**，不影响材料：材料消耗由蓝图 ME 与建筑 rig 决定，
 * 旧版的「材料效率」技能已从游戏中移除。
 *
 * typeID 来自 SDE types.jsonl 实测查询。
 */
export const SKILL_INDUSTRY = 3380; // 工业理论：制造时间 -4%/级
export const SKILL_ADVANCED_INDUSTRY = 3388; // 高级工业理论：制造时间 -3%/级
export const SKILL_REACTIONS = 45746; // 反应理论：反应时间 -4%/级

export interface MfgSkillBonus {
  /** 时间减免（0.35 = 减少 35%） */
  timeBonus: number;
  /** 参与计算的技能明细，用于界面提示 */
  parts: Array<{ name: string; level: number; perLevel: number }>;
}

/**
 * 按技能等级算时间减免。
 *
 * @param levels skillId → 有效等级
 * @param activity 制造走工业理论 + 高级工业理论，反应只走反应理论
 */
export function calcSkillBonus(
  levels: Record<string, number>,
  activity: MfgActivity,
): MfgSkillBonus {
  const parts: Array<{ name: string; level: number; perLevel: number }> = [];

  const push = (skillId: number, name: string, perLevel: number) => {
    const level = levels[String(skillId)] ?? 0;
    if (level > 0) parts.push({ name, level, perLevel });
  };

  if (activity === "reaction") {
    push(SKILL_REACTIONS, "反应理论", 0.04);
  } else {
    push(SKILL_INDUSTRY, "工业理论", 0.04);
    push(SKILL_ADVANCED_INDUSTRY, "高级工业理论", 0.03);
  }

  const timeBonus = parts.reduce(
    (sum, part) => sum + part.level * part.perLevel,
    0,
  );

  // 游戏里时间减免总上限远达不到 100%，这里只做安全兜底
  return { timeBonus: Math.min(0.9, timeBonus), parts };
}
