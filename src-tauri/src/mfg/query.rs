//! 制造业只读查询：产品搜索、配方详情、类型名批量解析。

use std::collections::HashMap;

use sqlx::SqlitePool;
use tauri::State;

use super::model::{MfgMaterialView, MfgProductView, MfgRecipeView, MfgSkillView};

/// 产品搜索（模糊匹配中英文名）
#[tauri::command]
pub async fn mfg_search_products(
    pool: State<'_, SqlitePool>,
    keyword: String,
    limit: Option<i64>,
) -> Result<Vec<MfgProductView>, String> {
    let limit = limit.unwrap_or(60).clamp(1, 200);
    let trimmed = keyword.trim();

    let rows: Vec<(i64, i64, Option<String>, Option<String>, Option<i64>, String, i64, i64)> =
        if trimmed.is_empty() {
            sqlx::query_as(
                "SELECT b.product_type_id, b.blueprint_type_id, t.name_zh, t.name_en,
                        t.group_id, b.activity, b.output_qty, b.base_time
                 FROM mfg_blueprint b
                 LEFT JOIN mfg_type_name t ON t.type_id = b.product_type_id
                 ORDER BY t.name_zh IS NULL, t.name_zh
                 LIMIT ?1",
            )
            .bind(limit)
            .fetch_all(pool.inner())
            .await
        } else {
            let pattern = format!("%{trimmed}%");
            sqlx::query_as(
                "SELECT b.product_type_id, b.blueprint_type_id, t.name_zh, t.name_en,
                        t.group_id, b.activity, b.output_qty, b.base_time
                 FROM mfg_blueprint b
                 LEFT JOIN mfg_type_name t ON t.type_id = b.product_type_id
                 WHERE t.name_zh LIKE ?1 OR t.name_en LIKE ?1 OR CAST(b.product_type_id AS TEXT) = ?2
                 ORDER BY t.name_zh IS NULL, t.name_zh
                 LIMIT ?3",
            )
            .bind(pattern)
            .bind(trimmed)
            .bind(limit)
            .fetch_all(pool.inner())
            .await
        }
        .map_err(|e| format!("搜索产品失败：{e}"))?;

    Ok(rows
        .into_iter()
        .map(
            |(product, blueprint, name_zh, name_en, group, activity, output, time)| {
                MfgProductView {
                    product_type_id: product,
                    blueprint_type_id: blueprint,
                    name: name_zh.unwrap_or_else(|| format!("#{product}")),
                    name_en: name_en.unwrap_or_default(),
                    group_id: group.unwrap_or(0),
                    activity,
                    output_qty: output,
                    base_time: time,
                }
            },
        )
        .collect())
}

/// 配方详情（材料 + 技能需求）
#[tauri::command]
pub async fn mfg_recipe(
    pool: State<'_, SqlitePool>,
    product_id: i64,
) -> Result<MfgRecipeView, String> {
    let head: Option<(i64, i64, i64, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT b.product_type_id, b.blueprint_type_id, b.output_qty, b.activity, b.base_time,
                t.name_zh
         FROM mfg_blueprint b
         LEFT JOIN mfg_type_name t ON t.type_id = b.product_type_id
         WHERE b.product_type_id = ?1",
    )
    .bind(product_id)
    .fetch_optional(pool.inner())
    .await
    .map_err(|e| format!("读取配方失败：{e}"))?;

    let Some((product_type_id, blueprint_type_id, output_qty, activity, base_time, name)) = head
    else {
        return Err(format!("没有找到产品 {product_id} 的配方"));
    };

    let max_runs: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(runs_per_copy), 1) FROM mfg_invention WHERE t2_blueprint_id = ?1",
    )
    .bind(blueprint_type_id)
    .fetch_optional(pool.inner())
    .await
    .ok()
    .flatten()
    .unwrap_or(1);

    let materials: Vec<(i64, Option<String>, i64, Option<f64>)> = sqlx::query_as(
        "SELECT m.material_type_id, t.name_zh, m.quantity, t.volume
         FROM mfg_material m
         LEFT JOIN mfg_type_name t ON t.type_id = m.material_type_id
         WHERE m.product_type_id = ?1
         ORDER BY m.quantity DESC",
    )
    .bind(product_type_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("读取材料失败：{e}"))?;

    let skills: Vec<(i64, Option<String>, i64)> = sqlx::query_as(
        "SELECT s.skill_type_id, t.name_zh, s.level
         FROM mfg_skill_req s
         LEFT JOIN mfg_type_name t ON t.type_id = s.skill_type_id
         WHERE s.product_type_id = ?1
         ORDER BY s.level DESC",
    )
    .bind(product_type_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("读取技能需求失败：{e}"))?;

    Ok(MfgRecipeView {
        product_type_id,
        blueprint_type_id,
        product_name: name.unwrap_or_else(|| format!("#{product_type_id}")),
        output_qty,
        base_time,
        activity,
        max_runs,
        materials: materials
            .into_iter()
            .map(|(type_id, name, quantity, volume)| MfgMaterialView {
                type_id,
                name: name.unwrap_or_else(|| format!("#{type_id}")),
                quantity,
                volume: volume.unwrap_or(0.0),
            })
            .collect(),
        skills: skills
            .into_iter()
            .map(|(type_id, name, level)| MfgSkillView {
                type_id,
                name: name.unwrap_or_else(|| format!("#{type_id}")),
                level,
            })
            .collect(),
    })
}

/// 批量取类型中文名（价格展示、BOM 展开用）
#[tauri::command]
pub async fn mfg_type_names(
    pool: State<'_, SqlitePool>,
    type_ids: Vec<i64>,
) -> Result<HashMap<i64, String>, String> {
    if type_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let ids = type_ids.into_iter().take(500).collect::<Vec<_>>();
    let placeholders = ids
        .iter()
        .enumerate()
        .map(|(index, _)| format!("?{}", index + 1))
        .collect::<Vec<_>>()
        .join(",");

    let sql = format!(
        "SELECT type_id, COALESCE(name_zh, name_en, '#' || type_id)
         FROM mfg_type_name WHERE type_id IN ({placeholders})"
    );

    let mut query = sqlx::query_as::<_, (i64, String)>(&sql);
    for id in &ids {
        query = query.bind(*id);
    }

    let rows = query
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("读取类型名失败：{e}"))?;

    Ok(rows.into_iter().collect())
}
