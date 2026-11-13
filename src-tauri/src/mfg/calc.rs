//! 制造业纯计算层：无 IO、无状态，全部可单测。
//!
//! 公式口径与参考项目（eve-market-tool）一致，全部为**乘法链**：
//! 材料 / 时间 / 作业费 / 税费彼此独立，不再做「百分比相加」。

use super::pricing::PriceBook;

/// 一处设施 + 技能 + 星系的完整计算上下文
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcContext {
    /// 建筑材料减免（百分比，1 = 1%）
    pub facility_me: f64,
    /// 建筑时间减免（百分比）
    pub facility_te: f64,
    /// 建筑成本减免（百分比）
    pub facility_cost: f64,
    /// 改装件材料减免（百分比，已含安全等级放大）
    pub rig_me: f64,
    /// 改装件时间减免（百分比）
    pub rig_te: f64,
    /// 星系成本指数
    pub system_cost_index: f64,
    /// 设施税（百分比）
    pub facility_tax: f64,
    /// 技能带来的时间倍率（0.79 = 减免 21%）
    pub skill_time_mul: f64,
}

/// SCC 附加费，单位与 `facility_tax` 一致：百分比（4 = 4%）
pub const SCC_SURCHARGE: f64 = 4.0;

impl Default for CalcContext {
    fn default() -> Self {
        Self {
            facility_me: 0.0,
            facility_te: 0.0,
            facility_cost: 0.0,
            rig_me: 0.0,
            rig_te: 0.0,
            system_cost_index: 0.05,
            facility_tax: 0.0,
            // 1.0 = 无技能减免；0.0 会让时间变成 0，默认值必须显式给
            skill_time_mul: 1.0,
        }
    }
}

impl CalcContext {
    /// 材料综合效率（0~1）
    fn material_efficiency(&self, me: f64) -> f64 {
        let me_ratio = clamp(1.0 - me / 100.0, 0.0, 1.0);
        let facility = clamp(1.0 - self.facility_me / 100.0, 0.0, 1.0);
        let rig = clamp(1.0 - self.rig_me / 100.0, 0.0, 1.0);
        me_ratio * facility * rig
    }

    /// 时间综合效率（0~1）
    fn time_efficiency(&self, te: f64) -> f64 {
        let te_ratio = clamp(1.0 - te / 100.0, 0.0, 1.0);
        let facility = clamp(1.0 - self.facility_te / 100.0, 0.0, 1.0);
        let rig = clamp(1.0 - self.rig_te / 100.0, 0.0, 1.0);
        let skill = clamp(self.skill_time_mul, 0.0, 1.0);

        te_ratio * facility * rig * skill
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// 单流程材料数量（已按游戏口径：保留两位小数后向上取整，且不少于流程数）
pub fn material_quantity(base_quantity: i64, runs: i64, me: f64, ctx: &CalcContext) -> i64 {
    if base_quantity <= 0 || runs <= 0 {
        return 0;
    }

    let raw = base_quantity as f64 * runs as f64 * ctx.material_efficiency(me);
    let rounded = (raw * 100.0).round() / 100.0;

    (rounded.ceil() as i64).max(runs)
}

/// 作业耗时（秒）
pub fn duration_seconds(base_time: i64, runs: i64, te: f64, ctx: &CalcContext) -> i64 {
    if base_time <= 0 || runs <= 0 {
        return 0;
    }

    let seconds = base_time as f64 * runs as f64 * ctx.time_efficiency(te);
    seconds.round().max(0.0) as i64
}

/// 作业费：估算物品价值 × 成本指数 × 建筑减免 + 税费
///
/// `estimated_item_value` 按**基础材料量**（与 ME 无关）计算。
pub fn job_cost(estimated_item_value: f64, ctx: &CalcContext) -> f64 {
    let gross = estimated_item_value
        * ctx.system_cost_index
        * clamp(1.0 - ctx.facility_cost / 100.0, 0.0, 1.0);

    let taxes = estimated_item_value * (ctx.facility_tax + SCC_SURCHARGE) / 100.0;

    gross + taxes
}

/// 安全等级对改装件的放大系数
///
/// 高安（≥ 0.45）用满额；低安 ×1.9；00 / 虫洞 ×2.1。
///
/// P2 接入改装件选择后由前端 / 命令层调用。
#[allow(dead_code)]
pub fn security_multiplier(security: f64) -> f64 {
    if security >= 0.45 {
        1.0
    } else if security > 0.0 {
        1.9
    } else {
        2.1
    }
}

/* ============================================================
   预览命令（P0：让前端能直接验证公式，P1 再接入真实配方）
   ============================================================ */

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcPreviewInput {
    pub runs: i64,
    pub me: f64,
    pub te: f64,
    pub base_time: i64,
    /// 基础材料量（单流程，未乘 runs）
    pub materials: Vec<CalcPreviewMaterial>,
    /// 估算物品价值；不传按 0 处理
    pub estimated_item_value: Option<f64>,
    pub context: CalcContext,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcPreviewMaterial {
    pub type_id: i64,
    pub base_quantity: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcPreviewMaterialOut {
    pub type_id: i64,
    pub base_quantity: i64,
    pub quantity: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcPreviewOutput {
    pub materials: Vec<CalcPreviewMaterialOut>,
    pub seconds: i64,
    pub job_cost: f64,
}

/// 按给定参数试算材料 / 时间 / 作业费（纯计算，不查库）
#[tauri::command]
pub fn mfg_calc_preview(input: CalcPreviewInput) -> CalcPreviewOutput {
    let materials = input
        .materials
        .iter()
        .map(|item| CalcPreviewMaterialOut {
            type_id: item.type_id,
            base_quantity: item.base_quantity,
            quantity: material_quantity(item.base_quantity, input.runs, input.me, &input.context),
        })
        .collect();

    CalcPreviewOutput {
        materials,
        seconds: duration_seconds(input.base_time, input.runs, input.te, &input.context),
        job_cost: job_cost(input.estimated_item_value.unwrap_or(0.0), &input.context),
    }
}

/* ============================================================
   完整计算（材料成本 / 作业费 / 收入 / 利润）
   ============================================================ */

/// 一份配方（从库读出后的内存结构）
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Recipe {
    pub product_type_id: i64,
    pub blueprint_type_id: i64,
    pub output_qty: i64,
    pub base_time: i64,
    /// "manufacturing" | "reaction"
    pub activity: String,
    pub max_runs: i64,
    /// (材料 type_id, 单流程基础数量)
    pub materials: Vec<(i64, i64)>,
    /// (技能 type_id, 等级)
    pub skills: Vec<(i64, i64)>,
}

/// 一行材料结果
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaterialLine {
    pub type_id: i64,
    /// 单流程基础数量
    pub base_quantity: i64,
    /// 乘流程数后的基础总量
    pub total_base: i64,
    /// ME 与建筑减免后的数量
    pub quantity: i64,
    pub unit_price: Option<f64>,
    pub subtotal: Option<f64>,
    pub missing_price: bool,
}

/// 一次作业的完整结果
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JobOutput {
    pub product_type_id: i64,
    pub blueprint_type_id: i64,
    pub activity: String,
    pub runs: i64,
    pub output_qty: i64,
    pub seconds: i64,

    pub materials: Vec<MaterialLine>,
    /// 估算物品价值（按基础量 × adjusted）
    pub estimated_item_value: f64,
    /// 安装费（成本指数部分）
    pub install_fee: f64,
    /// 税费（设施税 + SCC）
    pub taxes: f64,
    pub job_cost: f64,
    /// 材料买入成本
    pub material_cost: f64,
    /// 材料 + 作业费
    pub total_cost: f64,

    pub product_price: Option<f64>,
    pub revenue: Option<f64>,
    pub profit: Option<f64>,
    pub margin: Option<f64>,
    /// 每小时利润
    pub per_hour_profit: Option<f64>,
    /// 缺价材料
    pub missing_price: Vec<i64>,
}

/// 按配方算一次作业
pub fn calculate(
    recipe: &Recipe,
    runs: i64,
    me: f64,
    te: f64,
    ctx: &CalcContext,
    book: &PriceBook,
) -> JobOutput {
    let runs = runs.max(1);

    let mut materials: Vec<MaterialLine> = Vec::new();
    let mut material_cost = 0.0;
    let mut estimated_item_value = 0.0;
    let mut missing: Vec<i64> = Vec::new();

    for (type_id, base) in &recipe.materials {
        let total_base = base * runs;
        let quantity = material_quantity(*base, runs, me, ctx);

        let unit = book.cost(*type_id);
        let adjusted = book
            .adjusted
            .get(type_id)
            .copied()
            .unwrap_or(unit.unwrap_or(0.0));

        // EIV 按基础量 × adjusted 计算（与 ME 无关）
        estimated_item_value += *base as f64 * runs as f64 * adjusted;

        let subtotal = unit.map(|price| price * quantity as f64);

        if unit.is_none() {
            missing.push(*type_id);
        } else {
            material_cost += subtotal.unwrap_or(0.0);
        }

        materials.push(MaterialLine {
            type_id: *type_id,
            base_quantity: *base,
            total_base,
            quantity,
            unit_price: unit,
            subtotal,
            missing_price: unit.is_none(),
        });
    }

    let install_fee = estimated_item_value
        * ctx.system_cost_index
        * clamp(1.0 - ctx.facility_cost / 100.0, 0.0, 1.0);
    let taxes = estimated_item_value * (ctx.facility_tax + SCC_SURCHARGE) / 100.0;
    let job_cost = install_fee + taxes;

    let output_qty = recipe.output_qty * runs;
    let product_price = book.revenue(recipe.product_type_id);

    // 收入按卖价，扣销售税（默认 3.6%）
    let revenue = product_price.map(|price| price * output_qty as f64 * (1.0 - 0.036));

    let total_cost = material_cost + job_cost;
    let profit = revenue.map(|value| value - total_cost);
    let margin = match (profit, revenue) {
        (Some(p), Some(r)) if r > 0.0 => Some(p / r),
        _ => None,
    };

    let seconds = duration_seconds(recipe.base_time, runs, te, ctx);
    let per_hour_profit = match (profit, seconds) {
        (Some(p), s) if s > 0 => Some(p / (s as f64 / 3600.0)),
        _ => None,
    };

    JobOutput {
        product_type_id: recipe.product_type_id,
        blueprint_type_id: recipe.blueprint_type_id,
        activity: recipe.activity.clone(),
        runs,
        output_qty,
        seconds,
        materials,
        estimated_item_value,
        install_fee,
        taxes,
        job_cost,
        material_cost,
        total_cost,
        product_price,
        revenue,
        profit,
        margin,
        per_hour_profit,
        missing_price: missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> CalcContext {
        CalcContext {
            facility_me: 1.0,
            facility_te: 20.0,
            facility_cost: 4.0,
            rig_me: 2.0,
            rig_te: 20.0,
            system_cost_index: 0.05,
            facility_tax: 0.5,
            skill_time_mul: 0.79,
        }
    }

    #[test]
    fn material_uses_multiplicative_bonus() {
        // 24000 × 0.9 × 0.99 × 0.98 = 20956.32 → 向上取整 20957
        assert_eq!(material_quantity(24000, 1, 10.0, &ctx()), 20_957);
    }

    #[test]
    fn material_never_below_runs() {
        // 基础 1 个材料、10 流程，取整后仍不能少于 runs
        assert_eq!(material_quantity(1, 10, 10.0, &ctx()), 10);
    }

    #[test]
    fn duration_uses_multiplicative_bonus() {
        // 6000 × 0.8 × 0.8 × 0.8 × 0.79 = 2426.88 → 2427
        assert_eq!(duration_seconds(6000, 1, 20.0, &ctx()), 2_427);
    }

    #[test]
    fn job_cost_splits_install_and_tax() {
        // 1000 万 EIV：安装费 1e7×0.05×0.96 = 480000，税 1e7×0.045 = 450000
        let cost = job_cost(10_000_000.0, &ctx());
        assert!((cost - 930_000.0).abs() < 1.0, "实际 {cost}");
    }

    #[test]
    fn security_multiplier_buckets() {
        assert_eq!(security_multiplier(0.5), 1.0);
        assert_eq!(security_multiplier(0.1), 1.9);
        assert_eq!(security_multiplier(-0.2), 2.1);
    }
}

/* ============================================================
   发明
   ============================================================ */

/// 发明结果
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InventionOutput {
    /// 最终成功率（0~1）
    pub probability: f64,
    /// 每次成功的拷贝流程数
    pub runs: i64,
    pub datacore_cost: f64,
    pub decryptor_cost: f64,
    pub install_cost: f64,
    /// 单次尝试成本
    pub attempt_cost: f64,
    /// 分摊到每个流程的成本
    pub per_run_cost: f64,
    /// 产出蓝图的 ME / TE
    pub me: i64,
    pub te: i64,
}

/// 发明成本分摊
///
/// `prob = min(1, base × (1 + 科学技能加成) × 解码器系数)`
#[allow(clippy::too_many_arguments)]
pub fn invention(
    base_probability: f64,
    runs_per_copy: i64,
    skill_bonus: f64,
    prob_mul: f64,
    me_add: i64,
    te_add: i64,
    runs_add: i64,
    datacore_cost: f64,
    decryptor_cost: f64,
    install_cost: f64,
) -> InventionOutput {
    let probability = (base_probability * (1.0 + skill_bonus) * prob_mul).min(1.0);
    let runs = (runs_per_copy + runs_add).max(1);
    let attempt_cost = datacore_cost + decryptor_cost + install_cost;
    let per_run_cost = if probability > 0.0 {
        attempt_cost / (probability * runs as f64)
    } else {
        f64::INFINITY
    };

    InventionOutput {
        probability,
        runs,
        datacore_cost,
        decryptor_cost,
        install_cost,
        attempt_cost,
        per_run_cost,
        me: 2 + me_add,
        te: 4 + te_add,
    }
}

#[cfg(test)]
mod job_tests {
    use super::*;
    use std::collections::HashMap;

    fn recipe() -> Recipe {
        Recipe {
            product_type_id: 582,
            blueprint_type_id: 683,
            output_qty: 1,
            base_time: 6000,
            activity: "manufacturing".to_string(),
            max_runs: 30,
            materials: vec![(34, 24000), (35, 4500)],
            skills: vec![(3380, 1)],
        }
    }

    fn book() -> PriceBook {
        let mut sell = HashMap::new();
        sell.insert(34, 5.0);
        sell.insert(35, 20.0);
        sell.insert(582, 500_000.0);

        let mut adjusted = HashMap::new();
        adjusted.insert(34, 6.0);
        adjusted.insert(35, 18.0);

        PriceBook {
            sell,
            buy: HashMap::new(),
            adjusted,
        }
    }

    #[test]
    fn calculate_returns_full_cost() {
        let ctx = CalcContext {
            facility_me: 1.0,
            facility_te: 20.0,
            facility_cost: 4.0,
            rig_me: 2.0,
            rig_te: 20.0,
            system_cost_index: 0.05,
            facility_tax: 0.5,
            skill_time_mul: 0.79,
        };

        let out = calculate(&recipe(), 1, 10.0, 20.0, &ctx, &book());

        // 34：24000 × 0.9 × 0.99 × 0.98 = 20956.32 → 20957
        assert_eq!(out.materials[0].quantity, 20_957);
        assert!(out.material_cost > 0.0);
        // EIV 用 adjusted：24000×6 + 4500×18 = 225000
        assert!((out.estimated_item_value - 225_000.0).abs() < 1.0);
        assert!(out.job_cost > 0.0);
        assert!(out.profit.is_some());
        assert!(out.missing_price.is_empty());
    }

    #[test]
    fn missing_price_is_reported() {
        let mut book = book();
        // 本地价与 adjusted 都缺失才算「缺价」
        book.sell.remove(&35);
        book.adjusted.remove(&35);

        let out = calculate(&recipe(), 1, 10.0, 20.0, &CalcContext::default(), &book);
        assert_eq!(out.missing_price, vec![35]);
    }

    #[test]
    fn invention_probability_capped() {
        let out = invention(0.3, 1, 0.5, 1.2, 2, 4, 1, 1000.0, 500.0, 200.0);
        assert!((out.probability - 0.54).abs() < 1e-9);
        assert_eq!(out.runs, 2);
        assert_eq!(out.me, 4);
        assert_eq!(out.te, 8);
    }
}
