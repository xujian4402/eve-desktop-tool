//! 制造业相关的 ESI 调用。
//!
//! 覆盖：角色蓝图、角色/军团生产作业、星系成本指数、全局参考价。
//! 与 esi.rs 共用 http 客户端、令牌刷新与分页器。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::eve_auth::chrono_now_ms;
use crate::esi::{ensure_token, fetch_paged_orders, http};

const ESI_BASE: &str = "https://esi.evetech.net/latest";
const RATE_LIMIT_HINT: &str = "请求过于频繁，请稍后重试";

/*
 * 时间字段原样返回 ISO 字符串，由前端 Date.parse 处理：
 * 避免在 Rust 侧引入时间库，也避免时区解析差异。
 */

/* ============================================================
   角色蓝图
   ============================================================ */

#[derive(Debug, Deserialize)]
struct EsiBlueprint {
    #[serde(default)]
    item_id: Option<i64>,
    #[serde(default)]
    type_id: Option<i64>,
    #[serde(default)]
    location_id: Option<i64>,
    #[serde(default)]
    location_flag: Option<String>,
    #[serde(default)]
    quantity: Option<i64>,
    #[serde(default)]
    material_efficiency: Option<i64>,
    #[serde(default)]
    time_efficiency: Option<i64>,
    #[serde(default)]
    runs: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintView {
    pub item_id: i64,
    pub type_id: i64,
    pub location_id: i64,
    pub location_flag: String,
    /// -1 表示 BPO
    pub quantity: i64,
    pub material_efficiency: i64,
    pub time_efficiency: i64,
    /// BPO 为 -1，BPC 为剩余流程
    pub runs: i64,
}

/// 拉取角色名下全部蓝图（BPO / BPC）
#[tauri::command]
pub async fn fetch_character_blueprints(
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<Vec<BlueprintView>, String> {
    let token = ensure_token(pool.inner(), character_id).await?;

    let url = format!("{ESI_BASE}/characters/{character_id}/blueprints/");
    let (rows, _truncated, _cache) =
        fetch_paged_orders::<EsiBlueprint>(url, &token, "拉取角色蓝图").await?;

    Ok(rows
        .into_iter()
        .filter_map(|row| {
            // item_id 与 type_id 是必需字段，缺失说明结构不符，直接跳过
            let item_id = row.item_id?;
            let type_id = row.type_id?;

            Some(BlueprintView {
                item_id,
                type_id,
                location_id: row.location_id.unwrap_or(0),
                location_flag: row.location_flag.unwrap_or_default(),
                quantity: row.quantity.unwrap_or(-1),
                material_efficiency: row.material_efficiency.unwrap_or(0),
                time_efficiency: row.time_efficiency.unwrap_or(0),
                runs: row.runs.unwrap_or(-1),
            })
        })
        .collect())
}

/* ============================================================
   生产作业
   ============================================================ */

#[derive(Debug, Deserialize)]
struct EsiIndustryJob {
    #[serde(default)]
    job_id: Option<i64>,
    #[serde(default)]
    activity_id: Option<i64>,
    #[serde(default)]
    blueprint_type_id: Option<i64>,
    #[serde(default)]
    product_type_id: Option<i64>,
    #[serde(default)]
    facility_id: Option<i64>,
    #[serde(default)]
    installer_id: Option<i64>,
    #[serde(default)]
    runs: Option<i64>,
    #[serde(default)]
    licensed_runs: Option<i64>,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default)]
    probability: Option<f64>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    start_date: Option<String>,
    #[serde(default)]
    end_date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub job_id: i64,
    pub activity_id: i64,
    pub blueprint_type_id: i64,
    pub product_type_id: i64,
    pub facility_id: i64,
    pub installer_id: Option<i64>,
    pub runs: i64,
    pub licensed_runs: Option<i64>,
    pub cost: Option<f64>,
    pub probability: Option<f64>,
    pub status: String,
    /// ISO 时间字符串，前端自行解析
    pub start_date: String,
    pub end_date: String,
}

fn to_job_views(rows: Vec<EsiIndustryJob>) -> Vec<JobView> {
    rows.into_iter()
        .filter_map(|row| {
            let job_id = row.job_id?;

            Some(JobView {
                job_id,
                activity_id: row.activity_id.unwrap_or(1),
                blueprint_type_id: row.blueprint_type_id.unwrap_or(0),
                product_type_id: row.product_type_id.unwrap_or(0),
                facility_id: row.facility_id.unwrap_or(0),
                installer_id: row.installer_id,
                runs: row.runs.unwrap_or(0),
                licensed_runs: row.licensed_runs,
                cost: row.cost,
                probability: row.probability,
                status: row.status.unwrap_or_default(),
                start_date: row.start_date.unwrap_or_default(),
                end_date: row.end_date.unwrap_or_default(),
            })
        })
        .collect()
}

/// 拉取角色的生产作业队列
#[tauri::command]
pub async fn fetch_character_industry_jobs(
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<Vec<JobView>, String> {
    let token = ensure_token(pool.inner(), character_id).await?;

    let url = format!("{ESI_BASE}/characters/{character_id}/industry/jobs/");
    let (rows, _truncated, _cache) =
        fetch_paged_orders::<EsiIndustryJob>(url, &token, "拉取角色生产作业").await?;

    Ok(to_job_views(rows))
}

/// 拉取军团的生产作业队列（需要工厂经理角色与对应 scope）
#[tauri::command]
pub async fn fetch_corporation_industry_jobs(
    corporation_id: i64,
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<Vec<JobView>, String> {
    // 令牌是角色维度的，军团接口也用它鉴权
    let token = ensure_token(pool.inner(), character_id).await?;

    let url = format!("{ESI_BASE}/corporations/{corporation_id}/industry/jobs/");
    let (rows, _truncated, _cache) =
        fetch_paged_orders::<EsiIndustryJob>(url, &token, "拉取军团生产作业").await?;

    Ok(to_job_views(rows))
}

/* ============================================================
   星系成本指数
   ============================================================ */

#[derive(Debug, Deserialize)]
struct EsiCostIndex {
    #[serde(default)]
    activity: Option<String>,
    #[serde(default)]
    cost_index: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct EsiIndustrySystem {
    #[serde(default)]
    solar_system_id: Option<i64>,
    #[serde(default)]
    cost_indices: Vec<EsiCostIndex>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndustrySystemView {
    pub solar_system_id: i64,
    /// 制造成本指数
    pub manufacturing: Option<f64>,
    /// 反应成本指数
    pub reaction: Option<f64>,
    pub fetched_at: i64,
}

/// 拉取全星系的制造成本指数（公开接口，约 1 小时缓存）
#[tauri::command]
pub async fn fetch_industry_systems() -> Result<Vec<IndustrySystemView>, String> {
    let response = http()
        .get(format!("{ESI_BASE}/industry/systems/"))
        .query(&[("datasource", "tranquility")])
        .send()
        .await
        .map_err(|e| format!("拉取成本指数失败：{e}"))?;

    let status = response.status().as_u16();
    match status {
        200 => {}
        420 | 429 => return Err(format!("拉取成本指数：{RATE_LIMIT_HINT}")),
        _ => return Err(format!("拉取成本指数失败（HTTP {status}）")),
    }

    let rows: Vec<EsiIndustrySystem> = response
        .json()
        .await
        .map_err(|e| format!("解析成本指数失败：{e}"))?;

    let now = chrono_now_ms();

    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let solar_system_id = row.solar_system_id?;

            let mut manufacturing = None;
            let mut reaction = None;

            for index in row.cost_indices {
                match index.activity.as_deref() {
                    Some("manufacturing") => manufacturing = index.cost_index,
                    Some("reaction") => reaction = index.cost_index,
                    _ => {}
                }
            }

            Some(IndustrySystemView {
                solar_system_id,
                manufacturing,
                reaction,
                fetched_at: now,
            })
        })
        .collect())
}

/* ============================================================
   角色技能
   ============================================================ */

#[derive(Debug, Deserialize)]
struct EsiSkill {
    #[serde(default)]
    skill_id: Option<i64>,
    #[serde(default)]
    active_skill_level: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct EsiSkillsResponse {
    #[serde(default)]
    skills: Vec<EsiSkill>,
}

/// 拉取角色技能等级：返回 skillId → 有效等级（0 表示未训练）
///
/// 只保留制造业会用到的技能，避免把几百条技能塞给前端。
#[tauri::command]
pub async fn fetch_character_skills(
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<HashMap<String, i64>, String> {
    let token = ensure_token(pool.inner(), character_id).await?;

    let response = http()
        .get(format!("{ESI_BASE}/characters/{character_id}/skills/"))
        .query(&[("datasource", "tranquility")])
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("拉取角色技能失败：{e}"))?;

    let status = response.status().as_u16();
    match status {
        200 => {}
        403 => return Err("拉取角色技能：缺少 esi-skills.read_skills.v1 授权".to_string()),
        420 | 429 => return Err(format!("拉取角色技能：{RATE_LIMIT_HINT}")),
        _ => return Err(format!("拉取角色技能失败（HTTP {status}）")),
    }

    let body: EsiSkillsResponse = response
        .json()
        .await
        .map_err(|e| format!("解析角色技能失败：{e}"))?;

    /// 制造业用到的技能：工业理论 / 高级工业理论 / 反应理论
    const INDUSTRY_SKILLS: [i64; 3] = [3380, 3388, 45746];

    let mut levels = HashMap::new();
    for skill in body.skills {
        let Some(skill_id) = skill.skill_id else { continue };
        if !INDUSTRY_SKILLS.contains(&skill_id) {
            continue;
        }
        levels.insert(skill_id.to_string(), skill.active_skill_level.unwrap_or(0));
    }

    Ok(levels)
}

/* ============================================================
   全局参考价
   ============================================================ */

#[derive(Debug, Deserialize)]
struct EsiMarketPrice {
    #[serde(default)]
    type_id: Option<i64>,
    #[serde(default)]
    adjusted_price: Option<f64>,
    #[serde(default)]
    average_price: Option<f64>,
}

/// 拉取全局参考价：返回 typeId → adjusted_price（缺失回退 average_price）
#[tauri::command]
pub async fn fetch_market_prices() -> Result<HashMap<String, f64>, String> {
    let response = http()
        .get(format!("{ESI_BASE}/markets/prices/"))
        .query(&[("datasource", "tranquility")])
        .send()
        .await
        .map_err(|e| format!("拉取参考价失败：{e}"))?;

    let status = response.status().as_u16();
    match status {
        200 => {}
        420 | 429 => return Err(format!("拉取参考价：{RATE_LIMIT_HINT}")),
        _ => return Err(format!("拉取参考价失败（HTTP {status}）")),
    }

    let rows: Vec<EsiMarketPrice> = response
        .json()
        .await
        .map_err(|e| format!("解析参考价失败：{e}"))?;

    let mut prices = HashMap::new();

    for row in rows {
        let Some(type_id) = row.type_id else { continue };
        let value = row.adjusted_price.or(row.average_price);
        if let Some(price) = value {
            if price > 0.0 {
                prices.insert(type_id.to_string(), price);
            }
        }
    }

    Ok(prices)
}
