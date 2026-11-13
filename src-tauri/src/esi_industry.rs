//! 工业相关的 ESI 读取（蓝图、工业任务、成本指数、技能）。
//!
//! 只负责「拉数据」，落库由 `mfg::command` 完成。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::esi::{ensure_token, http, ESI_BASE};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintView {
    pub item_id: i64,
    pub type_id: i64,
    pub location_id: i64,
    pub location_flag: String,
    /// -1 = BPO
    pub quantity: i64,
    pub material_efficiency: i64,
    pub time_efficiency: i64,
    /// BPO 为 -1
    pub runs: i64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndustryJobView {
    pub job_id: i64,
    pub installer_id: i64,
    pub activity_id: i64,
    pub blueprint_type_id: i64,
    pub product_type_id: i64,
    pub facility_id: i64,
    pub runs: i64,
    pub licensed_runs: i64,
    pub cost: Option<f64>,
    pub probability: Option<f64>,
    pub status: String,
    pub start_date: String,
    pub end_date: String,
}

/// 星系成本指数
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndustrySystemView {
    pub solar_system_id: i64,
    pub manufacturing: f64,
    pub reaction: f64,
}

/// 角色蓝图
pub async fn fetch_blueprints(
    pool: &SqlitePool,
    character_id: i64,
) -> Result<Vec<BlueprintView>, String> {
    let token = ensure_token(pool, character_id).await?;

    let response = http()
        .get(format!("{ESI_BASE}/characters/{character_id}/blueprints/"))
        .query(&[("datasource", "tranquility")])
        .header("Accept-Language", "zh")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("请求失败（{e}）"))?;

    match response.status().as_u16() {
        200 => response
            .json::<Vec<BlueprintView>>()
            .await
            .map_err(|e| format!("解析失败（{e}）")),
        403 => Err("缺少蓝图授权（esi-characters.read_blueprints.v1）".to_string()),
        420 | 429 => Err(crate::esi::RATE_LIMIT_HINT.to_string()),
        status => Err(format!("HTTP {status}")),
    }
}

/// 角色工业任务
pub async fn fetch_character_jobs(
    pool: &SqlitePool,
    character_id: i64,
) -> Result<Vec<IndustryJobView>, String> {
    let token = ensure_token(pool, character_id).await?;

    let response = http()
        .get(format!(
            "{ESI_BASE}/characters/{character_id}/industry/jobs/"
        ))
        .query(&[("datasource", "tranquility"), ("include_completed", "true")])
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("请求失败（{e}）"))?;

    match response.status().as_u16() {
        200 => response
            .json::<Vec<IndustryJobView>>()
            .await
            .map_err(|e| format!("解析失败（{e}）")),
        403 => Err("缺少工业任务授权（esi-industry.read_character_jobs.v1）".to_string()),
        420 | 429 => Err(crate::esi::RATE_LIMIT_HINT.to_string()),
        status => Err(format!("HTTP {status}")),
    }
}

/// 军团工业任务
pub async fn fetch_corporation_jobs(
    pool: &SqlitePool,
    character_id: i64,
    corporation_id: i64,
) -> Result<Vec<IndustryJobView>, String> {
    let token = ensure_token(pool, character_id).await?;

    let response = http()
        .get(format!(
            "{ESI_BASE}/corporations/{corporation_id}/industry/jobs/"
        ))
        .query(&[("datasource", "tranquility"), ("include_completed", "true")])
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("请求失败（{e}）"))?;

    match response.status().as_u16() {
        200 => response
            .json::<Vec<IndustryJobView>>()
            .await
            .map_err(|e| format!("解析失败（{e}）")),
        403 => Err("缺少军团工业任务授权（esi-industry.read_corporation_jobs.v1）".to_string()),
        420 | 429 => Err(crate::esi::RATE_LIMIT_HINT.to_string()),
        status => Err(format!("HTTP {status}")),
    }
}

/// 全星系成本指数
pub async fn fetch_industry_systems() -> Result<Vec<IndustrySystemView>, String> {
    let response = http()
        .get(format!("{ESI_BASE}/industry/systems/"))
        .query(&[("datasource", "tranquility")])
        .send()
        .await
        .map_err(|e| format!("请求失败（{e}）"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let rows: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("解析失败（{e}）"))?;

    let mut result: Vec<IndustrySystemView> = Vec::new();

    for row in rows {
        let Some(system_id) = row["solar_system_id"].as_i64() else {
            continue;
        };

        let mut manufacturing = 0.0;
        let mut reaction = 0.0;

        if let Some(indices) = row["cost_indices"].as_array() {
            for item in indices {
                let activity = item["activity"].as_str().unwrap_or("");
                let value = item["cost_index"].as_f64().unwrap_or(0.0);

                match activity {
                    "manufacturing" => manufacturing = value,
                    "reaction" => reaction = value,
                    _ => {}
                }
            }
        }

        result.push(IndustrySystemView {
            solar_system_id: system_id,
            manufacturing,
            reaction,
        });
    }

    Ok(result)
}

/// 角色技能等级（只取制造业相关技能）
pub async fn fetch_industry_skills(
    pool: &SqlitePool,
    character_id: i64,
) -> Result<HashMap<String, i64>, String> {
    /// 工业理论 / 高级工业 / 反应学 / 会计学 / 中介关系学 / 科学类
    const WANTED: [i64; 8] = [3380, 3388, 45746, 16622, 3446, 3402, 3403, 3409];

    let token = ensure_token(pool, character_id).await?;

    let response = http()
        .get(format!("{ESI_BASE}/characters/{character_id}/skills/"))
        .query(&[("datasource", "tranquility")])
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("请求失败（{e}）"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析失败（{e}）"))?;

    let mut map = HashMap::new();

    if let Some(skills) = value["skills"].as_array() {
        for skill in skills {
            let Some(id) = skill["skill_id"].as_i64() else {
                continue;
            };
            if !WANTED.contains(&id) {
                continue;
            }

            let active = skill["active_skill_level"].as_i64().unwrap_or(0);
            map.insert(id.to_string(), active);
        }
    }

    Ok(map)
}
