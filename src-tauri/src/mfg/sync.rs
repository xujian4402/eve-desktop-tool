//! SDE 导入：把 `resources/mfg-sde.json` 写进 SQLite。
//!
//! 设计要点：
//! - 编译期内嵌（`include_str!`），离线可用，不依赖用户机器上的 SDE 目录
//! - 版本一致时直接跳过，避免每次启动都重写 4 万行
//! - 整份导入在一个事务里完成，中途失败不会留下半份数据

use std::time::Instant;

use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use tauri::State;

use super::model::{
    MfgFacilityTypeView, MfgRigView, MfgSde, MfgSdeStatus, MfgSyncResult, SdeBlueprint,
    SdeInvention, SdeResearch,
};

/// 随应用打包的 SDE 数据
const MFG_SDE_JSON: &str = include_str!("../../resources/mfg-sde.json");

/// 每批插入行数（SQLite 变量数限制内）
const CHUNK: usize = 200;

/// 需要清空后再导入的表
const SDE_TABLES: [&str; 12] = [
    "mfg_blueprint",
    "mfg_material",
    "mfg_skill_req",
    "mfg_invention",
    "mfg_invention_material",
    "mfg_invention_skill",
    "mfg_research",
    "mfg_type_name",
    "mfg_npc_blueprint",
    "mfg_npc_blueprint_corp",
    "mfg_npc_corp",
    "mfg_solar_system",
];

/// 导入 SDE（`force = true` 时即使版本一致也重写）
#[tauri::command]
pub async fn mfg_sync_sde(
    pool: State<'_, SqlitePool>,
    force: Option<bool>,
) -> Result<MfgSyncResult, String> {
    sync_sde(pool.inner(), force.unwrap_or(false)).await
}

/// 查询当前库里的 SDE 状态
#[tauri::command]
pub async fn mfg_sde_status(pool: State<'_, SqlitePool>) -> Result<MfgSdeStatus, String> {
    let bundled = bundled_generated_at()?;

    let stored: Option<(String,)> =
        sqlx::query_as("SELECT value FROM mfg_sde_meta WHERE key = 'generated_at'")
            .fetch_optional(pool.inner())
            .await
            .map_err(|e| format!("读取 SDE 版本失败：{e}"))?;

    let blueprints = count_rows(pool.inner(), "mfg_blueprint").await;
    let inventions = count_rows(pool.inner(), "mfg_invention").await;
    let types = count_rows(pool.inner(), "mfg_type_name").await;

    Ok(MfgSdeStatus {
        ready: blueprints > 0,
        generated_at: stored.map(|(value,)| value),
        bundled_at: bundled,
        blueprints,
        inventions,
        types,
    })
}

/// 建筑类型列表（前端下拉）
#[tauri::command]
pub async fn mfg_facility_types(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<MfgFacilityTypeView>, String> {
    sqlx::query_as::<_, (i64, String, String, f64, f64, f64, f64, i64)>(
        "SELECT type_id, name, category, me_bonus, te_bonus, cost_bonus, tax, rig_slots
         FROM mfg_facility_type ORDER BY type_id",
    )
    .fetch_all(pool.inner())
    .await
    .map(|rows| {
        rows.into_iter()
            .map(
                |(type_id, name, category, me, te, cost, tax, rig_slots)| MfgFacilityTypeView {
                    type_id,
                    name,
                    category,
                    me_bonus: me,
                    te_bonus: te,
                    cost_bonus: cost,
                    tax,
                    rig_slots,
                },
            )
            .collect()
    })
    .map_err(|e| format!("读取建筑类型失败：{e}"))
}

/// 改装件列表
#[tauri::command]
pub async fn mfg_rigs(pool: State<'_, SqlitePool>) -> Result<Vec<MfgRigView>, String> {
    sqlx::query_as::<_, (i64, String, String, String, f64)>(
        "SELECT type_id, name, category, effect, bonus FROM mfg_rig ORDER BY type_id",
    )
    .fetch_all(pool.inner())
    .await
    .map(|rows| {
        rows.into_iter()
            .map(|(type_id, name, category, effect, bonus)| MfgRigView {
                type_id,
                name,
                category,
                effect,
                bonus,
            })
            .collect()
    })
    .map_err(|e| format!("读取改装件失败：{e}"))
}

/* ============================================================
   内部实现
   ============================================================ */

async fn count_rows(pool: &SqlitePool, table: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    sqlx::query_scalar::<_, i64>(&sql)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
}

/// 读取内嵌 JSON 的生成日期
fn bundled_generated_at() -> Result<String, String> {
    let sde: MfgSde =
        serde_json::from_str(MFG_SDE_JSON).map_err(|e| format!("解析内嵌 SDE 失败：{e}"))?;
    Ok(sde.generated_at)
}

async fn sync_sde(pool: &SqlitePool, force: bool) -> Result<MfgSyncResult, String> {
    let started = Instant::now();

    let sde: MfgSde =
        serde_json::from_str(MFG_SDE_JSON).map_err(|e| format!("解析内嵌 SDE 失败：{e}"))?;

    // 版本一致且库里有数据 → 跳过
    if !force {
        let stored: Option<(String,)> =
            sqlx::query_as("SELECT value FROM mfg_sde_meta WHERE key = 'generated_at'")
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("读取 SDE 版本失败：{e}"))?;

        let has_data = count_rows(pool, "mfg_blueprint").await > 0;

        if has_data && stored.as_ref().map(|(value,)| value.as_str()) == Some(&sde.generated_at) {
            return Ok(MfgSyncResult {
                imported: false,
                generated_at: sde.generated_at.clone(),
                blueprints: sde.blueprints.len(),
                inventions: sde.inventions.len(),
                research: sde.research.len(),
                types: sde.types.len(),
                decryptors: sde.decryptors.len(),
                facilities: sde.facilities.len(),
                rigs: sde.rigs.len(),
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败：{e}"))?;

    // 清空静态表
    for table in SDE_TABLES {
        let sql = format!("DELETE FROM {table}");
        sqlx::query(&sql)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("清空 {table} 失败：{e}"))?;
    }

    insert_blueprints(&mut tx, &sde.blueprints).await?;
    insert_inventions(&mut tx, &sde.inventions).await?;
    insert_research(&mut tx, &sde.research).await?;
    insert_types(&mut tx, &sde.types).await?;
    insert_mechanic_tables(&mut tx, &sde).await?;
    insert_npc_and_systems(&mut tx, &sde).await?;

    // 记录版本
    sqlx::query(
        "INSERT INTO mfg_sde_meta (key, value) VALUES ('generated_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(&sde.generated_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("写入 SDE 版本失败：{e}"))?;

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败：{e}"))?;

    Ok(MfgSyncResult {
        imported: true,
        generated_at: sde.generated_at.clone(),
        blueprints: sde.blueprints.len(),
        inventions: sde.inventions.len(),
        research: sde.research.len(),
        types: sde.types.len(),
        decryptors: sde.decryptors.len(),
        facilities: sde.facilities.len(),
        rigs: sde.rigs.len(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

type Tx<'a> = sqlx::Transaction<'a, Sqlite>;

async fn insert_blueprints(tx: &mut Tx<'_>, rows: &[SdeBlueprint]) -> Result<(), String> {
    for chunk in rows.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_blueprint
             (product_type_id, blueprint_type_id, output_qty, base_time, activity, max_runs, npc_sold) ",
        );

        qb.push_values(chunk, |mut b, row| {
            b.push_bind(row.p)
                .push_bind(row.bp)
                .push_bind(row.q)
                .push_bind(row.t)
                .push_bind(&row.act)
                .push_bind(row.max_runs)
                .push_bind(0i64);
        });

        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入蓝图失败：{e}"))?;
    }

    // 材料与技能（从蓝图里展开）
    let materials: Vec<(i64, i64, i64)> = rows
        .iter()
        .flat_map(|row| {
            row.mats
                .iter()
                .map(move |[id, qty]| (row.p, *id, *qty))
                .collect::<Vec<_>>()
        })
        .collect();

    for chunk in materials.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_material (product_type_id, material_type_id, quantity) ",
        );
        qb.push_values(chunk, |mut b, (product, material, qty)| {
            b.push_bind(*product).push_bind(*material).push_bind(*qty);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入材料失败：{e}"))?;
    }

    let skills: Vec<(i64, i64, i64)> = rows
        .iter()
        .flat_map(|row| {
            row.skills
                .iter()
                .map(move |[id, level]| (row.p, *id, *level))
                .collect::<Vec<_>>()
        })
        .collect();

    for chunk in skills.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_skill_req (product_type_id, skill_type_id, level) ",
        );
        qb.push_values(chunk, |mut b, (product, skill, level)| {
            b.push_bind(*product).push_bind(*skill).push_bind(*level);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入技能需求失败：{e}"))?;
    }

    Ok(())
}

async fn insert_inventions(tx: &mut Tx<'_>, rows: &[SdeInvention]) -> Result<(), String> {
    for chunk in rows.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_invention
             (t2_blueprint_id, t1_blueprint_id, base_probability, runs_per_copy, base_time) ",
        );
        qb.push_values(chunk, |mut b, row| {
            b.push_bind(row.t2)
                .push_bind(row.t1)
                .push_bind(row.prob)
                .push_bind(row.runs)
                .push_bind(row.t);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入发明失败：{e}"))?;
    }

    let materials: Vec<(i64, i64, i64)> = rows
        .iter()
        .flat_map(|row| {
            row.mats
                .iter()
                .map(move |[id, qty]| (row.t2, *id, *qty))
                .collect::<Vec<_>>()
        })
        .collect();

    for chunk in materials.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_invention_material (t2_blueprint_id, type_id, quantity) ",
        );
        qb.push_values(chunk, |mut b, (t2, id, qty)| {
            b.push_bind(*t2).push_bind(*id).push_bind(*qty);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入发明材料失败：{e}"))?;
    }

    let skills: Vec<(i64, i64, i64)> = rows
        .iter()
        .flat_map(|row| {
            row.skills
                .iter()
                .map(move |[id, level]| (row.t2, *id, *level))
                .collect::<Vec<_>>()
        })
        .collect();

    for chunk in skills.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_invention_skill (t2_blueprint_id, skill_type_id, level) ",
        );
        qb.push_values(chunk, |mut b, (t2, skill, level)| {
            b.push_bind(*t2).push_bind(*skill).push_bind(*level);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入发明技能失败：{e}"))?;
    }

    Ok(())
}

async fn insert_research(tx: &mut Tx<'_>, rows: &[SdeResearch]) -> Result<(), String> {
    for chunk in rows.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_research
             (blueprint_type_id, me_time, te_time, copy_time_per_run) ",
        );
        qb.push_values(chunk, |mut b, row| {
            b.push_bind(row.bp)
                .push_bind(row.me)
                .push_bind(row.te)
                .push_bind(row.copy);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入研究数据失败：{e}"))?;
    }

    Ok(())
}

async fn insert_types(
    tx: &mut Tx<'_>,
    types: &std::collections::HashMap<String, super::model::SdeTypeName>,
) -> Result<(), String> {
    let rows: Vec<(i64, String, String, i64, f64)> = types
        .iter()
        .filter_map(|(key, value)| {
            key.parse::<i64>()
                .ok()
                .map(|id| (id, value.0.clone(), value.1.clone(), value.2, value.3))
        })
        .collect();

    for chunk in rows.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_type_name (type_id, name_zh, name_en, group_id, volume) ",
        );
        qb.push_values(chunk, |mut b, (id, zh, en, group, volume)| {
            b.push_bind(*id)
                .push_bind(zh)
                .push_bind(en)
                .push_bind(*group)
                .push_bind(*volume);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入类型名失败：{e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// 用内存库跑一遍完整导入，验证内嵌 JSON 能被正确解析与写入
    #[tokio::test]
    async fn imports_bundled_sde() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("打开内存库失败");

        sqlx::raw_sql(include_str!("../../migrations/0010_manufacturing_v2.sql"))
            .execute(&pool)
            .await
            .expect("建表失败");

        sqlx::raw_sql(include_str!("../../migrations/0011_manufacturing_full.sql"))
            .execute(&pool)
            .await
            .expect("建表失败");

        let first = sync_sde(&pool, true).await.expect("首次导入失败");
        assert!(first.imported);
        assert!(first.blueprints > 4_000, "蓝图数量异常：{}", first.blueprints);
        assert!(first.inventions > 500, "发明数量异常：{}", first.inventions);

        let blueprints = count_rows(&pool, "mfg_blueprint").await;
        let materials = count_rows(&pool, "mfg_material").await;
        let types = count_rows(&pool, "mfg_type_name").await;

        assert_eq!(blueprints as usize, first.blueprints);
        assert!(materials > 10_000, "材料数量异常：{materials}");
        assert!(types > 5_000, "类型数量异常：{types}");

        // 第二次应因版本一致而跳过
        let second = sync_sde(&pool, false).await.expect("第二次调用失败");
        assert!(!second.imported, "版本未变时应跳过");
    }
}

/// 解码器 / 建筑类型 / 改装件：数量少，直接逐条写
async fn insert_mechanic_tables(tx: &mut Tx<'_>, sde: &MfgSde) -> Result<(), String> {
    for table in ["mfg_decryptor", "mfg_facility_type", "mfg_rig"] {
        let sql = format!("DELETE FROM {table}");
        sqlx::query(&sql)
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("清空 {table} 失败：{e}"))?;
    }

    for item in &sde.decryptors {
        sqlx::query(
            "INSERT INTO mfg_decryptor (type_id, name, prob_mul, me_add, te_add, runs_add)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(item.type_id)
        .bind(&item.name)
        .bind(item.prob)
        .bind(item.me)
        .bind(item.te)
        .bind(item.runs)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("写入解码器失败：{e}"))?;
    }

    for item in &sde.facilities {
        sqlx::query(
            "INSERT INTO mfg_facility_type
             (type_id, name, category, me_bonus, te_bonus, cost_bonus, tax, rig_slots)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(item.type_id)
        .bind(&item.name)
        .bind(&item.category)
        .bind(item.me)
        .bind(item.te)
        .bind(item.cost)
        .bind(item.tax)
        .bind(item.rig_slots)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("写入建筑类型失败：{e}"))?;
    }

    for item in &sde.rigs {
        sqlx::query(
            "INSERT INTO mfg_rig (type_id, name, category, effect, bonus, high_sec_ok)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(item.type_id)
        .bind(&item.name)
        .bind(&item.category)
        .bind(&item.effect)
        .bind(item.bonus)
        .bind(item.high_sec_ok)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("写入改装件失败：{e}"))?;
    }

    Ok(())
}

/// NPC 蓝图、军团、星系
async fn insert_npc_and_systems(tx: &mut Tx<'_>, sde: &MfgSde) -> Result<(), String> {
    // NPC 蓝图售价
    let npc: Vec<(i64, f64)> = sde
        .npc_blueprints
        .iter()
        .filter_map(|(key, value)| key.parse::<i64>().ok().map(|id| (id, value.price)))
        .collect();

    for chunk in npc.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_npc_blueprint (bp_type_id, price) ",
        );
        qb.push_values(chunk, |mut b, (id, price)| {
            b.push_bind(*id).push_bind(*price);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入 NPC 蓝图失败：{e}"))?;
    }

    // 售卖军团
    let links: Vec<(i64, i64)> = sde
        .npc_blueprints
        .iter()
        .filter_map(|(key, value)| {
            key.parse::<i64>()
                .ok()
                .map(|id| value.corps.iter().map(move |corp| (id, *corp)).collect::<Vec<_>>())
        })
        .flatten()
        .collect();

    for chunk in links.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_npc_blueprint_corp (bp_type_id, corporation_id) ",
        );
        qb.push_values(chunk, |mut b, (bp, corp)| {
            b.push_bind(*bp).push_bind(*corp);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入 NPC 蓝图军团失败：{e}"))?;
    }

    // 军团
    let corps: Vec<(i64, String, i64, i64)> = sde
        .npc_corps
        .iter()
        .filter_map(|(key, value)| {
            key.parse::<i64>()
                .ok()
                .map(|id| (id, value.0.clone(), value.1, value.2))
        })
        .collect();

    for chunk in corps.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_npc_corp
             (corporation_id, name, faction_id, solar_system_id) ",
        );
        qb.push_values(chunk, |mut b, (id, name, faction, system)| {
            b.push_bind(*id)
                .push_bind(name)
                .push_bind(*faction)
                .push_bind(*system);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入 NPC 军团失败：{e}"))?;
    }

    // 星系
    let systems: Vec<(i64, String, f64)> = sde
        .solar_systems
        .iter()
        .filter_map(|(key, value)| {
            key.parse::<i64>()
                .ok()
                .map(|id| (id, value.0.clone(), value.1))
        })
        .collect();

    for chunk in systems.chunks(CHUNK) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_solar_system (solar_system_id, name, security) ",
        );
        qb.push_values(chunk, |mut b, (id, name, security)| {
            b.push_bind(*id).push_bind(name).push_bind(*security);
        });
        qb.build()
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("写入星系失败：{e}"))?;
    }

    Ok(())
}
