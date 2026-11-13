//! 制造业的数据结构。
//!
//! 两类：
//! - `Sde*`：与 `resources/mfg-sde.json` 一一对应，只在导入时使用
//! - `*View`：返回给前端的结果，字段用 camelCase

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/* ============================================================
   SDE（导入用）
   ============================================================ */

/// 整份 SDE 数据
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgSde {
    pub generated_at: String,
    pub blueprints: Vec<SdeBlueprint>,
    pub inventions: Vec<SdeInvention>,
    pub research: Vec<SdeResearch>,
    /// type_id → [中文名, 英文名, 分组, 体积]
    pub types: HashMap<String, SdeTypeName>,
    pub decryptors: Vec<SdeDecryptor>,
    pub facilities: Vec<SdeFacility>,
    pub rigs: Vec<SdeRig>,
    /// 蓝图 type_id → NPC 售价与售卖军团
    #[serde(default)]
    pub npc_blueprints: HashMap<String, SdeNpcBlueprint>,
    /// 军团 id → [名称, 势力 id, 星系 id]
    #[serde(default)]
    pub npc_corps: HashMap<String, SdeNpcCorp>,
    /// 星系 id → [名称, 安全等级]
    #[serde(default)]
    pub solar_systems: HashMap<String, SdeSolarSystem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeNpcBlueprint {
    pub price: f64,
    pub corps: Vec<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SdeNpcCorp(pub String, pub i64, pub i64);

#[derive(Debug, Deserialize)]
pub struct SdeSolarSystem(pub String, pub f64);

/// 制造 / 反应配方
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeBlueprint {
    /// 产品 type_id
    pub p: i64,
    /// 蓝图 type_id
    pub bp: i64,
    /// 每流程产量
    pub q: i64,
    /// 基础时间（秒）
    pub t: i64,
    /// "manufacturing" | "reaction"
    pub act: String,
    pub max_runs: i64,
    /// [[材料 id, 数量]]
    pub mats: Vec<[i64; 2]>,
    /// [[技能 id, 等级]]
    pub skills: Vec<[i64; 2]>,
}

/// 发明：T1 蓝图 → T2 蓝图
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeInvention {
    /// T2 蓝图 type_id
    pub t2: i64,
    /// T1 蓝图 type_id
    pub t1: i64,
    /// 基础成功率（0~1）
    pub prob: f64,
    /// 每份拷贝流程数
    pub runs: i64,
    /// 基础时间（秒）
    pub t: i64,
    pub mats: Vec<[i64; 2]>,
    pub skills: Vec<[i64; 2]>,
}

/// 研究 / 拷贝基础时间
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeResearch {
    pub bp: i64,
    pub me: i64,
    pub te: i64,
    pub copy: i64,
}

/// 类型名：[中文, 英文, 分组, 体积]
#[derive(Debug, Deserialize)]
pub struct SdeTypeName(pub String, pub String, pub i64, pub f64);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeDecryptor {
    pub type_id: i64,
    pub name: String,
    pub prob: f64,
    pub me: i64,
    pub te: i64,
    pub runs: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeFacility {
    pub type_id: i64,
    pub name: String,
    pub category: String,
    pub me: f64,
    pub te: f64,
    pub cost: f64,
    pub tax: f64,
    pub rig_slots: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeRig {
    pub type_id: i64,
    pub name: String,
    pub category: String,
    pub effect: String,
    pub bonus: f64,
    pub high_sec_ok: i64,
}

/* ============================================================
   返回给前端
   ============================================================ */

/// SDE 导入结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgSyncResult {
    /// 本次是否真的写库（false = 版本一致已跳过）
    pub imported: bool,
    pub generated_at: String,
    pub blueprints: usize,
    pub inventions: usize,
    pub research: usize,
    pub types: usize,
    pub decryptors: usize,
    pub facilities: usize,
    pub rigs: usize,
    /// 耗时（毫秒）
    pub elapsed_ms: u64,
}

/// 当前库里的 SDE 状态
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgSdeStatus {
    /// 是否已导入
    pub ready: bool,
    /// 库中记录的生成日期
    pub generated_at: Option<String>,
    /// 随应用打包的生成日期
    pub bundled_at: String,
    pub blueprints: i64,
    pub inventions: i64,
    pub types: i64,
}

/// 蓝图搜索结果（用于产品搜索）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgProductView {
    pub product_type_id: i64,
    pub blueprint_type_id: i64,
    pub name: String,
    pub name_en: String,
    pub group_id: i64,
    pub activity: String,
    pub output_qty: i64,
    pub base_time: i64,
}

/// 配方详情
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgRecipeView {
    pub product_type_id: i64,
    pub blueprint_type_id: i64,
    pub product_name: String,
    pub output_qty: i64,
    pub base_time: i64,
    pub activity: String,
    pub max_runs: i64,
    pub materials: Vec<MfgMaterialView>,
    pub skills: Vec<MfgSkillView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgMaterialView {
    pub type_id: i64,
    pub name: String,
    pub quantity: i64,
    pub volume: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgSkillView {
    pub type_id: i64,
    pub name: String,
    pub level: i64,
}

/// 建筑类型 / 改装件（前端下拉用）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgFacilityTypeView {
    pub type_id: i64,
    pub name: String,
    pub category: String,
    pub me_bonus: f64,
    pub te_bonus: f64,
    pub cost_bonus: f64,
    pub tax: f64,
    pub rig_slots: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfgRigView {
    pub type_id: i64,
    pub name: String,
    pub category: String,
    pub effect: String,
    pub bonus: f64,
}
