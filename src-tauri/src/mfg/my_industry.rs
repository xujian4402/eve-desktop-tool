//! 我的工业：蓝图与工业任务的同步、查询。

use std::collections::HashMap;

use serde::Serialize;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use tauri::State;

use super::calc::{calculate, CalcContext, Recipe};
use super::pricing;

/// 同步结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCount {
    pub synced: usize,
}

/// 我的蓝图（带利润估算）
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MyBlueprintView {
    pub item_id: i64,
    pub type_id: i64,
    /// 产物 type_id（由蓝图反查，找不到时为 0）
    pub product_type_id: i64,
    pub name: String,
    pub location_id: i64,
    pub quantity: i64,
    pub material_efficiency: i64,
    pub time_efficiency: i64,
    pub runs: i64,
    /// BPO 为 true
    pub is_bpo: bool,
    /// 每小时利润（缺价时为 null）
    pub per_hour: Option<f64>,
    pub profit: Option<f64>,
}

/// 我的工业任务
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MyJobView {
    pub job_id: i64,
    pub activity_id: i64,
    pub product_type_id: i64,
    pub blueprint_type_id: i64,
    pub name: String,
    pub runs: i64,
    pub status: String,
    pub start_date: String,
    pub end_date: String,
    /// 剩余秒数（已结束为 0）
    pub remaining: i64,
    /// 进度 0~1
    pub progress: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MyIndustryView {
    pub blueprints: Vec<MyBlueprintView>,
    pub jobs: Vec<MyJobView>,
}

/* ============================================================
   同步
   ============================================================ */

#[tauri::command]
pub async fn mfg_sync_my_blueprints(
    pool: State<'_, SqlitePool>,
    character_id: i64,
) -> Result<SyncCount, String> {
    let rows = crate::esi_industry::fetch_blueprints(pool.inner(), character_id).await?;
    let now = now_seconds();

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|e| format!("开启事务失败：{e}"))?;

    for chunk in rows.chunks(200) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_my_blueprint
             (item_id, character_id, type_id, location_id, location_flag, quantity,
              material_efficiency, time_efficiency, runs, synced_at) ",
        );

        qb.push_values(chunk, |mut builder, row| {
            builder
                .push_bind(row.item_id)
                .push_bind(character_id)
                .push_bind(row.type_id)
                .push_bind(row.location_id)
                .push_bind(&row.location_flag)
                .push_bind(row.quantity)
                .push_bind(row.material_efficiency)
                .push_bind(row.time_efficiency)
                .push_bind(row.runs)
                .push_bind(now);
        });

        qb.build()
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("写入蓝图失败：{e}"))?;
    }

    // 清掉本次未出现（已卖掉 / 已用掉）的旧记录
    sqlx::query("DELETE FROM mfg_my_blueprint WHERE character_id = ?1 AND synced_at < ?2")
        .bind(character_id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清理旧蓝图失败：{e}"))?;

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败：{e}"))?;

    Ok(SyncCount {
        synced: rows.len(),
    })
}

#[tauri::command]
pub async fn mfg_sync_my_jobs(
    pool: State<'_, SqlitePool>,
    character_id: i64,
    corporation_id: Option<i64>,
) -> Result<SyncCount, String> {
    let (rows, owner_id, owner_kind) = match corporation_id {
        Some(corp) => (
            crate::esi_industry::fetch_corporation_jobs(pool.inner(), character_id, corp).await?,
            corp,
            "corporation",
        ),
        None => (
            crate::esi_industry::fetch_character_jobs(pool.inner(), character_id).await?,
            character_id,
            "character",
        ),
    };

    let now = now_seconds();

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|e| format!("开启事务失败：{e}"))?;

    for chunk in rows.chunks(200) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_my_job
             (job_id, owner_id, owner_kind, installer_id, activity_id, blueprint_type_id,
              product_type_id, facility_id, runs, licensed_runs, cost, probability,
              status, start_date, end_date, synced_at) ",
        );

        qb.push_values(chunk, |mut builder, row| {
            builder
                .push_bind(row.job_id)
                .push_bind(owner_id)
                .push_bind(owner_kind)
                .push_bind(row.installer_id)
                .push_bind(row.activity_id)
                .push_bind(row.blueprint_type_id)
                .push_bind(row.product_type_id)
                .push_bind(row.facility_id)
                .push_bind(row.runs)
                .push_bind(row.licensed_runs)
                .push_bind(row.cost)
                .push_bind(row.probability)
                .push_bind(&row.status)
                .push_bind(&row.start_date)
                .push_bind(&row.end_date)
                .push_bind(now);
        });

        qb.build()
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("写入任务失败：{e}"))?;
    }

    sqlx::query(
        "DELETE FROM mfg_my_job WHERE owner_id = ?1 AND owner_kind = ?2 AND synced_at < ?3",
    )
    .bind(owner_id)
    .bind(owner_kind)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("清理旧任务失败：{e}"))?;

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败：{e}"))?;

    Ok(SyncCount {
        synced: rows.len(),
    })
}

/// 同步全星系成本指数
#[tauri::command]
pub async fn mfg_cost_index_sync(pool: State<'_, SqlitePool>) -> Result<SyncCount, String> {
    let rows = crate::esi_industry::fetch_industry_systems().await?;
    let now = now_seconds();

    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|e| format!("开启事务失败：{e}"))?;

    for chunk in rows.chunks(200) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_cost_index
             (solar_system_id, manufacturing, reaction, updated_at) ",
        );

        qb.push_values(chunk, |mut builder, row| {
            builder
                .push_bind(row.solar_system_id)
                .push_bind(row.manufacturing)
                .push_bind(row.reaction)
                .push_bind(now);
        });

        qb.build()
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("写入成本指数失败：{e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败：{e}"))?;

    Ok(SyncCount {
        synced: rows.len(),
    })
}

/* ============================================================
   查询
   ============================================================ */

#[tauri::command]
pub async fn mfg_my_industry(
    pool: State<'_, SqlitePool>,
    character_id: i64,
) -> Result<MyIndustryView, String> {
    // 1. 蓝图
    let blueprints: Vec<(i64, i64, i64, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT item_id, type_id, location_id, quantity, material_efficiency, time_efficiency, runs, 0
         FROM mfg_my_blueprint WHERE character_id = ?1",
    )
    .bind(character_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("读取蓝图失败：{e}"))?;

    // 2. 任务
    let jobs: Vec<(i64, i64, i64, i64, i64, String, String, String)> = sqlx::query_as(
        "SELECT job_id, activity_id, product_type_id, blueprint_type_id, runs,
                status, COALESCE(start_date, ''), COALESCE(end_date, '')
         FROM mfg_my_job
         WHERE owner_id = ?1
         ORDER BY end_date ASC",
    )
    .bind(character_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("读取任务失败：{e}"))?;

    // 3. 配方与名称
    let recipes = load_recipes(pool.inner()).await?;
    let by_blueprint: HashMap<i64, i64> = recipes
        .values()
        .map(|recipe| (recipe.blueprint_type_id, recipe.product_type_id))
        .collect();

    let mut type_ids: Vec<i64> = Vec::new();
    type_ids.extend(blueprints.iter().map(|row| row.1));
    type_ids.extend(jobs.iter().map(|row| row.2));
    type_ids.extend(recipes.values().flat_map(|recipe| {
        std::iter::once(recipe.product_type_id)
            .chain(recipe.materials.iter().map(|item| item.0))
            .collect::<Vec<_>>()
    }));

    let book = pricing::load(pool.inner(), &type_ids).await;
    let names = type_names(pool.inner(), &type_ids).await?;
    let ctx = CalcContext::default();

    let mut bp_views: Vec<MyBlueprintView> = Vec::new();

    for (item_id, type_id, location_id, quantity, me, te, runs, _) in blueprints {
        let product = by_blueprint.get(&type_id).copied().unwrap_or(0);

        let (profit, per_hour) = match recipes.get(&product) {
            Some(recipe) => {
                let job = calculate(recipe, 1, me as f64, te as f64, &ctx, &book);
                (job.profit, job.per_hour_profit)
            }
            None => (None, None),
        };

        bp_views.push(MyBlueprintView {
            item_id,
            type_id,
            product_type_id: product,
            name: names
                .get(&product)
                .or_else(|| names.get(&type_id))
                .cloned()
                .unwrap_or_else(|| format!("#{type_id}")),
            location_id,
            quantity,
            material_efficiency: me,
            time_efficiency: te,
            runs,
            is_bpo: quantity == -1,
            per_hour,
            profit,
        });
    }

    let now = now_seconds() * 1000;
    let mut job_views: Vec<MyJobView> = Vec::new();

    for (job_id, activity_id, product, blueprint, runs, status, start, end) in jobs {
        let start_ms = parse_iso_millis(&start);
        let end_ms = parse_iso_millis(&end);

        let remaining = match end_ms {
            Some(value) => (value - now).max(0) / 1000,
            None => 0,
        };

        let progress = match (start_ms, end_ms) {
            (Some(s), Some(e)) if e > s => {
                ((now - s) as f64 / (e - s) as f64).clamp(0.0, 1.0)
            }
            _ => 0.0,
        };

        job_views.push(MyJobView {
            job_id,
            activity_id,
            product_type_id: product,
            blueprint_type_id: blueprint,
            name: names
                .get(&product)
                .cloned()
                .unwrap_or_else(|| format!("#{product}")),
            runs,
            status,
            start_date: start,
            end_date: end,
            remaining,
            progress,
        });
    }

    Ok(MyIndustryView {
        blueprints: bp_views,
        jobs: job_views,
    })
}

/* ============================================================
   内部
   ============================================================ */

async fn load_recipes(pool: &SqlitePool) -> Result<HashMap<i64, Recipe>, String> {
    let heads: Vec<(i64, i64, i64, i64, String, i64)> = sqlx::query_as(
        "SELECT product_type_id, blueprint_type_id, output_qty, base_time, activity, max_runs
         FROM mfg_blueprint",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取配方失败：{e}"))?;

    let mats: Vec<(i64, i64, i64)> =
        sqlx::query_as("SELECT product_type_id, material_type_id, quantity FROM mfg_material")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("读取材料失败：{e}"))?;

    let mut materials: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    for (product, material, qty) in mats {
        materials.entry(product).or_default().push((material, qty));
    }

    let mut map: HashMap<i64, Recipe> = HashMap::new();

    for (product, blueprint, output, time, activity, max_runs) in heads {
        map.insert(
            product,
            Recipe {
                product_type_id: product,
                blueprint_type_id: blueprint,
                output_qty: output,
                base_time: time,
                activity,
                max_runs,
                materials: materials.remove(&product).unwrap_or_default(),
                skills: Vec::new(),
            },
        );
    }

    Ok(map)
}

async fn type_names(
    pool: &SqlitePool,
    ids: &[i64],
) -> Result<HashMap<i64, String>, String> {
    let mut map = HashMap::new();

    for chunk in ids.chunks(400) {
        let placeholders = (1..=chunk.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");

        let sql = format!(
            "SELECT type_id, COALESCE(name_zh, name_en, '#' || type_id)
             FROM mfg_type_name WHERE type_id IN ({placeholders})"
        );

        let mut query = sqlx::query_as::<_, (i64, String)>(&sql);
        for id in chunk {
            query = query.bind(*id);
        }

        if let Ok(rows) = query.fetch_all(pool).await {
            for (id, name) in rows {
                map.insert(id, name);
            }
        }
    }

    Ok(map)
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

/// ISO 8601 → 毫秒时间戳（解析失败返回 None）
fn parse_iso_millis(text: &str) -> Option<i64> {
    if text.is_empty() {
        return None;
    }

    // 形如 2026-11-12T10:00:00Z
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }

    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;

    Some(ymdhms_to_millis(year, month, day, hour, minute, second))
}

/// 公历日期 → 毫秒（Howard Hinnant 的 days_from_civil 算法）
fn ymdhms_to_millis(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    ((days * 86_400) + hour * 3_600 + minute * 60 + second) * 1_000
}

/// 角色的制造业相关技能等级（技能 id → 等级）
///
/// 用于计算制造 / 反应的时间减免：
/// - 3380 工业理论（4%/级）
/// - 3388 高级工业（3%/级）
/// - 45746 反应学（4%/级）
#[tauri::command]
pub async fn mfg_character_skills(
    pool: State<'_, SqlitePool>,
    character_id: i64,
) -> Result<std::collections::HashMap<String, i64>, String> {
    crate::esi_industry::fetch_industry_skills(pool.inner(), character_id).await
}
