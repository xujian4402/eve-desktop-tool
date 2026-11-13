//! 制造业命令层：把库里的配方与价格组合成前端需要的结果。

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use super::calc::{calculate, invention, CalcContext, JobOutput, MaterialLine, Recipe};
use super::pricing::{self, PriceBook};

/* ============================================================
   库读取
   ============================================================ */

/// 一次把所有配方读进内存（5000 条配方 + 2.5 万材料，约 20ms）
async fn load_recipes(pool: &SqlitePool) -> Result<HashMap<i64, Recipe>, String> {
    let heads: Vec<(i64, i64, i64, i64, String, i64)> = sqlx::query_as(
        "SELECT product_type_id, blueprint_type_id, output_qty, base_time, activity, max_runs
         FROM mfg_blueprint",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取配方失败：{e}"))?;

    let mats: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT product_type_id, material_type_id, quantity FROM mfg_material",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取材料失败：{e}"))?;

    let skills: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT product_type_id, skill_type_id, level FROM mfg_skill_req",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取技能失败：{e}"))?;

    let mut materials: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    for (product, material, qty) in mats {
        materials.entry(product).or_default().push((material, qty));
    }

    let mut skill_map: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    for (product, skill, level) in skills {
        skill_map.entry(product).or_default().push((skill, level));
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
                skills: skill_map.remove(&product).unwrap_or_default(),
            },
        );
    }

    Ok(map)
}

/// 批量取名
async fn type_names(
    pool: &SqlitePool,
    ids: &[i64],
) -> Result<HashMap<i64, String>, String> {
    let mut map = HashMap::new();
    let unique: Vec<i64> = {
        let mut set = HashSet::new();
        ids.iter().copied().filter(|id| set.insert(*id)).collect()
    };

    for chunk in unique.chunks(400) {
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

/* ============================================================
   单件计算
   ============================================================ */

#[tauri::command]
pub async fn mfg_calculate(
    pool: State<'_, SqlitePool>,
    product_id: i64,
    runs: Option<i64>,
    me: Option<f64>,
    te: Option<f64>,
    context: Option<CalcContext>,
) -> Result<JobOutput, String> {
    let recipes = load_recipes(pool.inner()).await?;
    let recipe = recipes
        .get(&product_id)
        .ok_or_else(|| format!("没有找到产品 {product_id} 的配方"))?;

    let type_ids: Vec<i64> = recipe
        .materials
        .iter()
        .map(|item| item.0)
        .chain(std::iter::once(recipe.product_type_id))
        .collect();

    let book = pricing::load(pool.inner(), &type_ids).await;
    let ctx = context.unwrap_or_default();

    Ok(calculate(
        recipe,
        runs.unwrap_or(1),
        me.unwrap_or(0.0),
        te.unwrap_or(0.0),
        &ctx,
        &book,
    ))
}

/* ============================================================
   多级 BOM
   ============================================================ */

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BomLine {
    pub type_id: i64,
    pub name: String,
    pub quantity: i64,
    pub unit_price: Option<f64>,
    pub subtotal: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BomNode {
    pub product_id: i64,
    pub name: String,
    /// 该层需要的数量
    pub units: i64,
    /// 实际开工流程数
    pub runs: i64,
    pub output_qty: i64,
    pub build: bool,
    pub job_cost: f64,
    pub material_cost: f64,
    pub total_cost: f64,
    /// 自制件：子节点；外购件：材料行
    pub children: Vec<BomNode>,
    pub materials: Vec<BomLine>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BomResult {
    pub root: BomNode,
    /// 最底层需要采购的清单（已汇总、向上取整）
    pub raw: Vec<BomLine>,
    /// 自制件数量
    pub build_count: usize,
    /// 是否触发深度上限
    pub depth_limited: bool,
}

const MAX_DEPTH: usize = 8;

#[tauri::command]
pub async fn mfg_bom(
    pool: State<'_, SqlitePool>,
    product_id: i64,
    units: Option<i64>,
    me: Option<f64>,
    te: Option<f64>,
    build_set: Option<Vec<i64>>,
    context: Option<CalcContext>,
) -> Result<BomResult, String> {
    let recipes = load_recipes(pool.inner()).await?;

    if !recipes.contains_key(&product_id) {
        return Err(format!("没有找到产品 {product_id} 的配方"));
    }

    let units = units.unwrap_or(1).max(1);
    let me = me.unwrap_or(0.0);
    let te = te.unwrap_or(0.0);
    let ctx = context.unwrap_or_default();
    let build_set: HashSet<i64> = build_set.unwrap_or_default().into_iter().collect();

    // 收集所有可能用到的 type_id 一次性取价
    let mut type_ids: Vec<i64> = Vec::new();
    for recipe in recipes.values() {
        type_ids.push(recipe.product_type_id);
        type_ids.extend(recipe.materials.iter().map(|item| item.0));
    }

    let book = pricing::load(pool.inner(), &type_ids).await;
    let names = type_names(pool.inner(), &type_ids).await?;

    let mut raw: HashMap<i64, (i64, Option<f64>)> = HashMap::new();
    let mut visiting: HashSet<i64> = HashSet::new();
    let mut depth_limited = false;

    let root = build_node(
        &recipes,
        &book,
        &names,
        product_id,
        units,
        me,
        te,
        &ctx,
        &build_set,
        &mut raw,
        &mut visiting,
        0,
        &mut depth_limited,
    );

    let raw_lines: Vec<BomLine> = raw
        .into_iter()
        .map(|(type_id, (quantity, price))| BomLine {
            type_id,
            name: names
                .get(&type_id)
                .cloned()
                .unwrap_or_else(|| format!("#{type_id}")),
            quantity,
            unit_price: price,
            subtotal: price.map(|unit| unit * quantity as f64),
        })
        .collect();

    let build_count = visiting.len();

    Ok(BomResult {
        root,
        raw: raw_lines,
        build_count,
        depth_limited,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_node(
    recipes: &HashMap<i64, Recipe>,
    book: &PriceBook,
    names: &HashMap<i64, String>,
    product_id: i64,
    units: i64,
    me: f64,
    te: f64,
    ctx: &CalcContext,
    build_set: &HashSet<i64>,
    raw: &mut HashMap<i64, (i64, Option<f64>)>,
    visiting: &mut HashSet<i64>,
    depth: usize,
    depth_limited: &mut bool,
) -> BomNode {
    let name = names
        .get(&product_id)
        .cloned()
        .unwrap_or_else(|| format!("#{product_id}"));

    let Some(recipe) = recipes.get(&product_id) else {
        // 没有配方：纯采购
        let price = book.cost(product_id);
        let entry = raw.entry(product_id).or_insert((0, price));
        entry.0 += units;

        return BomNode {
            product_id,
            name,
            units,
            runs: 0,
            output_qty: 0,
            build: false,
            job_cost: 0.0,
            material_cost: price.map(|unit| unit * units as f64).unwrap_or(0.0),
            total_cost: price.map(|unit| unit * units as f64).unwrap_or(0.0),
            children: Vec::new(),
            materials: Vec::new(),
        };
    };

    let should_build = build_set.contains(&product_id) && depth < MAX_DEPTH;

    if !should_build || depth >= MAX_DEPTH {
        if depth >= MAX_DEPTH && build_set.contains(&product_id) {
            *depth_limited = true;
        }

        let price = book.cost(product_id);
        let entry = raw.entry(product_id).or_insert((0, price));
        entry.0 += units;

        return BomNode {
            product_id,
            name,
            units,
            runs: 0,
            output_qty: 0,
            build: false,
            job_cost: 0.0,
            material_cost: price.map(|unit| unit * units as f64).unwrap_or(0.0),
            total_cost: price.map(|unit| unit * units as f64).unwrap_or(0.0),
            children: Vec::new(),
            materials: Vec::new(),
        };
    }

    // 环检测
    if !visiting.insert(product_id) {
        let price = book.cost(product_id);
        return BomNode {
            product_id,
            name,
            units,
            runs: 0,
            output_qty: 0,
            build: false,
            job_cost: 0.0,
            material_cost: 0.0,
            total_cost: price.map(|unit| unit * units as f64).unwrap_or(0.0),
            children: Vec::new(),
            materials: Vec::new(),
        };
    }

    let output = recipe.output_qty.max(1);
    let runs = ((units + output - 1) / output).max(1);

    // 先算这一层的作业费（用完整 JobOutput 里的材料数量与 EIV）
    let job = calculate(recipe, runs, me, te, ctx, book);

    let mut children: Vec<BomNode> = Vec::new();
    let mut materials: Vec<BomLine> = Vec::new();
    let mut material_cost = 0.0;

    for (material_id, base) in &recipe.materials {
        let quantity = super::calc::material_quantity(*base, runs, me, ctx);

        if build_set.contains(material_id) && recipes.contains_key(material_id) {
            let child = build_node(
                recipes,
                book,
                names,
                *material_id,
                quantity,
                me,
                te,
                ctx,
                build_set,
                raw,
                visiting,
                depth + 1,
                depth_limited,
            );
            material_cost += child.total_cost;
            children.push(child);
        } else {
            let price = book.cost(*material_id);
            let subtotal = price.map(|unit| unit * quantity as f64);

            raw.entry(*material_id)
                .and_modify(|entry| entry.0 += quantity)
                .or_insert((quantity, price));

            if let Some(value) = subtotal {
                material_cost += value;
            }

            materials.push(BomLine {
                type_id: *material_id,
                name: names
                    .get(material_id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{material_id}")),
                quantity,
                unit_price: price,
                subtotal,
            });
        }
    }

    visiting.remove(&product_id);

    BomNode {
        product_id,
        name,
        units,
        runs,
        output_qty: output,
        build: true,
        job_cost: job.job_cost,
        material_cost,
        total_cost: material_cost + job.job_cost,
        children,
        materials,
    }
}

/* ============================================================
   利润排行
   ============================================================ */

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RankItem {
    pub product_id: i64,
    pub blueprint_id: i64,
    pub name: String,
    pub activity: String,
    pub material_cost: f64,
    pub job_cost: f64,
    pub total_cost: f64,
    pub revenue: f64,
    pub profit: f64,
    pub margin: f64,
    pub seconds: i64,
    pub per_hour: f64,
}

#[tauri::command]
pub async fn mfg_rank(
    pool: State<'_, SqlitePool>,
    me: Option<f64>,
    te: Option<f64>,
    activity: Option<String>,
    min_margin: Option<f64>,
    limit: Option<i64>,
) -> Result<Vec<RankItem>, String> {
    let recipes = load_recipes(pool.inner()).await?;

    let mut type_ids: Vec<i64> = Vec::new();
    for recipe in recipes.values() {
        type_ids.push(recipe.product_type_id);
        type_ids.extend(recipe.materials.iter().map(|item| item.0));
    }

    let book = pricing::load(pool.inner(), &type_ids).await;
    let names = type_names(pool.inner(), &type_ids).await?;

    let ctx = CalcContext::default();
    let me = me.unwrap_or(10.0);
    let te = te.unwrap_or(20.0);
    let min_margin = min_margin.unwrap_or(-10.0);
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let only = activity.filter(|value| !value.is_empty());

    let mut items: Vec<RankItem> = Vec::new();

    for recipe in recipes.values() {
        if let Some(activity) = &only {
            if &recipe.activity != activity {
                continue;
            }
        }

        // 必须有产品价，否则无从判断利润
        let Some(product_price) = book.revenue(recipe.product_type_id) else {
            continue;
        };

        let job = calculate(recipe, 1, me, te, &ctx, &book);

        // 材料缺价时跳过，避免虚假利润
        if !job.missing_price.is_empty() {
            continue;
        }

        let revenue = product_price * job.output_qty as f64 * (1.0 - 0.036);
        let profit = revenue - job.total_cost;
        let margin = if revenue > 0.0 { profit / revenue } else { 0.0 };

        if margin < min_margin {
            continue;
        }

        let per_hour = if job.seconds > 0 {
            profit / (job.seconds as f64 / 3600.0)
        } else {
            0.0
        };

        items.push(RankItem {
            product_id: recipe.product_type_id,
            blueprint_id: recipe.blueprint_type_id,
            name: names
                .get(&recipe.product_type_id)
                .cloned()
                .unwrap_or_else(|| format!("#{}", recipe.product_type_id)),
            activity: recipe.activity.clone(),
            material_cost: job.material_cost,
            job_cost: job.job_cost,
            total_cost: job.total_cost,
            revenue,
            profit,
            margin,
            seconds: job.seconds,
            per_hour,
        });
    }

    items.sort_by(|a, b| {
        b.per_hour
            .partial_cmp(&a.per_hour)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    items.truncate(limit as usize);

    Ok(items)
}

/* ============================================================
   制造地点
   ============================================================ */

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocationItem {
    pub solar_system_id: i64,
    pub name: String,
    pub security: f64,
    pub cost_index: f64,
    pub job_cost: f64,
}

#[tauri::command]
pub async fn mfg_locations(
    pool: State<'_, SqlitePool>,
    product_id: i64,
    me: Option<f64>,
    te: Option<f64>,
    min_security: Option<f64>,
    limit: Option<i64>,
) -> Result<Vec<LocationItem>, String> {
    let recipes = load_recipes(pool.inner()).await?;
    let recipe = recipes
        .get(&product_id)
        .ok_or_else(|| format!("没有找到产品 {product_id} 的配方"))?;

    let type_ids: Vec<i64> = recipe
        .materials
        .iter()
        .map(|item| item.0)
        .chain(std::iter::once(recipe.product_type_id))
        .collect();

    let book = pricing::load(pool.inner(), &type_ids).await;
    let ctx = CalcContext::default();

    let me = me.unwrap_or(10.0);
    let te = te.unwrap_or(20.0);
    let min_security = min_security.unwrap_or(0.45);
    let limit = limit.unwrap_or(50).clamp(1, 300);

    let column = if recipe.activity == "reaction" {
        "reaction"
    } else {
        "manufacturing"
    };

    let sql = format!(
        "SELECT c.solar_system_id, s.name, s.security, c.{column}
         FROM mfg_cost_index c
         JOIN mfg_solar_system s ON s.solar_system_id = c.solar_system_id
         WHERE s.security >= ?1
         ORDER BY c.{column} ASC
         LIMIT ?2"
    );

    let rows: Vec<(i64, String, f64, f64)> = sqlx::query_as(&sql)
        .bind(min_security)
        .bind(limit)
        .fetch_all(pool.inner())
        .await
        .map_err(|e| format!("读取成本指数失败：{e}（请先同步成本指数）"))?;

    let mut items: Vec<LocationItem> = Vec::new();

    for (system_id, name, security, index) in rows {
        let mut system_ctx = ctx.clone();
        system_ctx.system_cost_index = index;

        let job = calculate(recipe, 1, me, te, &system_ctx, &book);

        items.push(LocationItem {
            solar_system_id: system_id,
            name,
            security,
            cost_index: index,
            job_cost: job.job_cost,
        });
    }

    Ok(items)
}

/* ============================================================
   NPC 蓝图
   ============================================================ */

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NpcBlueprintView {
    pub bp_type_id: i64,
    pub name: String,
    pub price: f64,
    pub corp_count: i64,
}

#[tauri::command]
pub async fn mfg_npc_blueprints(
    pool: State<'_, SqlitePool>,
    keyword: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<NpcBlueprintView>, String> {
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let pattern = format!("%{}%", keyword.unwrap_or_default().trim());

    let rows: Vec<(i64, Option<String>, f64, i64)> = sqlx::query_as(
        "SELECT b.bp_type_id, t.name_zh, b.price,
                (SELECT COUNT(*) FROM mfg_npc_blueprint_corp c WHERE c.bp_type_id = b.bp_type_id)
         FROM mfg_npc_blueprint b
         LEFT JOIN mfg_type_name t ON t.type_id = b.bp_type_id
         WHERE ?1 = '%%' OR t.name_zh LIKE ?1
         ORDER BY b.price ASC
         LIMIT ?2",
    )
    .bind(pattern)
    .bind(limit)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("读取 NPC 蓝图失败：{e}"))?;

    Ok(rows
        .into_iter()
        .map(|(bp, name, price, count)| NpcBlueprintView {
            bp_type_id: bp,
            name: name.unwrap_or_else(|| format!("#{bp}")),
            price,
            corp_count: count,
        })
        .collect())
}

/* ============================================================
   解码器
   ============================================================ */

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DecryptorView {
    pub type_id: i64,
    pub name: String,
    pub prob_mul: f64,
    pub me_add: i64,
    pub te_add: i64,
    pub runs_add: i64,
}

#[tauri::command]
pub async fn mfg_decryptors(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<DecryptorView>, String> {
    let rows: Vec<(i64, String, f64, i64, i64, i64)> = sqlx::query_as(
        "SELECT type_id, name, prob_mul, me_add, te_add, runs_add FROM mfg_decryptor",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("读取解码器失败：{e}"))?;

    Ok(rows
        .into_iter()
        .map(
            |(type_id, name, prob_mul, me_add, te_add, runs_add)| DecryptorView {
                type_id,
                name,
                prob_mul,
                me_add,
                te_add,
                runs_add,
            },
        )
        .collect())
}

/* ============================================================
   发明对比
   ============================================================ */

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InventionOption {
    pub decryptor_id: Option<i64>,
    pub decryptor_name: String,
    pub probability: f64,
    pub runs: i64,
    pub attempt_cost: f64,
    pub per_run_cost: f64,
    pub me: i64,
    pub te: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InventionPlan {
    pub t2_blueprint_id: i64,
    pub t1_blueprint_id: i64,
    pub base_probability: f64,
    pub base_time: i64,
    pub product_name: String,
    /// 数据核心成本
    pub datacore_cost: f64,
    /// 安装费
    pub install_cost: f64,
    pub options: Vec<InventionOption>,
}

#[tauri::command]
pub async fn mfg_invention_plan(
    pool: State<'_, SqlitePool>,
    t2_blueprint_id: i64,
    skill_bonus: Option<f64>,
    context: Option<CalcContext>,
) -> Result<InventionPlan, String> {
    let head: Option<(i64, f64, i64, i64)> = sqlx::query_as(
        "SELECT t1_blueprint_id, base_probability, runs_per_copy, base_time
         FROM mfg_invention WHERE t2_blueprint_id = ?1",
    )
    .bind(t2_blueprint_id)
    .fetch_optional(pool.inner())
    .await
    .map_err(|e| format!("读取发明数据失败：{e}"))?;

    let Some((t1, base_prob, runs_per_copy, base_time)) = head else {
        return Err(format!("蓝图 {t2_blueprint_id} 没有发明配方"));
    };

    let mats: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT type_id, quantity FROM mfg_invention_material WHERE t2_blueprint_id = ?1",
    )
    .bind(t2_blueprint_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| format!("读取发明材料失败：{e}"))?;

    let mat_ids: Vec<i64> = mats.iter().map(|item| item.0).collect();
    let book = pricing::load(pool.inner(), &mat_ids).await;

    let datacore_cost: f64 = mats
        .iter()
        .map(|(id, qty)| book.cost(*id).unwrap_or(0.0) * *qty as f64)
        .sum();

    // 安装费：按数据核心价值估算
    let ctx = context.unwrap_or_default();
    let install_cost = datacore_cost
        * ctx.system_cost_index
        * (1.0 - ctx.facility_cost / 100.0)
        + datacore_cost * (ctx.facility_tax + 4.0) / 100.0;

    let decryptors: Vec<(i64, String, f64, i64, i64, i64)> = sqlx::query_as(
        "SELECT type_id, name, prob_mul, me_add, te_add, runs_add FROM mfg_decryptor",
    )
    .fetch_all(pool.inner())
    .await
    .unwrap_or_default();

    let mut options: Vec<InventionOption> = Vec::new();

    // 不用解码器
    let plain = invention(
        base_prob, runs_per_copy, skill_bonus.unwrap_or(0.0), 1.0, 0, 0, 0, datacore_cost, 0.0, install_cost,
    );
    options.push(InventionOption {
        decryptor_id: None,
        decryptor_name: "不用解码器".to_string(),
        probability: plain.probability,
        runs: plain.runs,
        attempt_cost: plain.attempt_cost,
        per_run_cost: plain.per_run_cost,
        me: plain.me,
        te: plain.te,
    });

    for (type_id, name, prob_mul, me_add, te_add, runs_add) in decryptors {
        let price = book.cost(type_id).unwrap_or(0.0);
        let result = invention(
            base_prob,
            runs_per_copy,
            0.0,
            prob_mul,
            me_add,
            te_add,
            runs_add,
            datacore_cost,
            price,
            install_cost,
        );

        options.push(InventionOption {
            decryptor_id: Some(type_id),
            decryptor_name: name,
            probability: result.probability,
            runs: result.runs,
            attempt_cost: result.attempt_cost,
            per_run_cost: result.per_run_cost,
            me: result.me,
            te: result.te,
        });
    }

    // 按每流程成本排序，最优在前
    options.sort_by(|a, b| {
        a.per_run_cost
            .partial_cmp(&b.per_run_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let names = type_names(pool.inner(), &[t2_blueprint_id]).await?;

    Ok(InventionPlan {
        t2_blueprint_id,
        t1_blueprint_id: t1,
        base_probability: base_prob,
        base_time,
        product_name: names
            .get(&t2_blueprint_id)
            .cloned()
            .unwrap_or_else(|| format!("#{t2_blueprint_id}")),
        datacore_cost,
        install_cost,
        options,
    })
}

/* ============================================================
   辅助
   ============================================================ */

/// 供内部使用的材料行转换（保留给后续规划页）
#[allow(dead_code)]
fn to_lines(materials: &[MaterialLine]) -> Vec<BomLine> {
    materials
        .iter()
        .map(|item| BomLine {
            type_id: item.type_id,
            name: String::new(),
            quantity: item.quantity,
            unit_price: item.unit_price,
            subtotal: item.subtotal,
        })
        .collect()
}

/* ============================================================
   研究 / 拷贝
   ============================================================ */

/// 研究等级倍数表（ME 0~10 / TE 0~20 通用）
const RESEARCH_MUL: [f64; 21] = [
    0.0, 105.0, 250.0, 595.0, 1414.0, 3360.0, 8000.0, 19000.0, 45255.0, 107700.0, 256000.0,
    608600.0, 1447600.0, 3442500.0, 8187500.0, 19475000.0, 46310000.0, 110120000.0,
    261840000.0, 622600000.0, 1480300000.0,
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResearchLevel {
    pub target: i64,
    pub seconds: i64,
    pub cost: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResearchInfo {
    pub blueprint_type_id: i64,
    /// ME 研究基础时间
    pub me_time: i64,
    /// TE 研究基础时间
    pub te_time: i64,
    /// 单次拷贝基础时间（每流程）
    pub copy_time: i64,
    pub me_levels: Vec<ResearchLevel>,
    pub te_levels: Vec<ResearchLevel>,
}

/// 研究 / 拷贝时间与费用
///
/// `current_me` / `current_te` 为蓝图当前等级，`eiv` 用于估算费用。
#[tauri::command]
pub async fn mfg_research_info(
    pool: State<'_, SqlitePool>,
    blueprint_type_id: i64,
    current_me: Option<i64>,
    current_te: Option<i64>,
    eiv: Option<f64>,
    context: Option<CalcContext>,
) -> Result<ResearchInfo, String> {
    let row: Option<(i64, i64, i64)> = sqlx::query_as(
        "SELECT me_time, te_time, copy_time_per_run FROM mfg_research
         WHERE blueprint_type_id = ?1",
    )
    .bind(blueprint_type_id)
    .fetch_optional(pool.inner())
    .await
    .map_err(|e| format!("读取研究数据失败：{e}"))?;

    let Some((me_time, te_time, copy_time)) = row else {
        return Err(format!("蓝图 {blueprint_type_id} 没有研究数据"));
    };

    let ctx = context.unwrap_or_default();
    let eiv = eiv.unwrap_or(0.0);

    // 费用倍率：成本指数 × 建筑减免 + 设施税 + SCC
    let fee_ratio = ctx.system_cost_index * (1.0 - ctx.facility_cost / 100.0)
        + (ctx.facility_tax + 4.0) / 100.0;

    let time_mul = (1.0 - ctx.facility_te / 100.0).max(0.0);
    let current_me = current_me.unwrap_or(0).clamp(0, 10);
    let current_te = current_te.unwrap_or(0).clamp(0, 20);

    let build_levels = |base: i64, current: i64, max: i64| -> Vec<ResearchLevel> {
        let mut list = Vec::new();

        for target in 1..=max {
            if target <= current {
                continue;
            }

            let base_mul = RESEARCH_MUL[target as usize] - RESEARCH_MUL[current as usize];
            let factor = base_mul / 105.0;

            list.push(ResearchLevel {
                target,
                seconds: (base as f64 * factor * time_mul).round() as i64,
                cost: eiv * 0.02 * factor * fee_ratio,
            });
        }

        list
    };

    Ok(ResearchInfo {
        blueprint_type_id,
        me_time,
        te_time,
        copy_time,
        me_levels: build_levels(me_time, current_me, 10),
        te_levels: build_levels(
            te_time,
            current_te.min(20).max(0),
            20,
        ),
    })
}
