//! 价格服务：本地订单快照优先，ESI adjusted 兜底。
//!
//! 价格只用于「估算成本与收入」，不参与库存、订单等其它业务。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sqlx::SqlitePool;

/// adjusted 价缓存（10 分钟）
static ADJUSTED: Mutex<Option<(Instant, HashMap<i64, f64>)>> = Mutex::new(None);

const ADJUSTED_TTL: Duration = Duration::from_secs(600);

/// 一组价格视图
#[derive(Debug, Default, Clone)]
pub struct PriceBook {
    /// 最低卖价（买材料用）
    pub sell: HashMap<i64, f64>,
    /// 最高收单价
    pub buy: HashMap<i64, f64>,
    /// ESI 全服 adjusted 价
    pub adjusted: HashMap<i64, f64>,
}

#[allow(dead_code)]
impl PriceBook {
    /// 买入单价：最低卖价 → 最高收单 → adjusted
    pub fn cost(&self, type_id: i64) -> Option<f64> {
        self.sell
            .get(&type_id)
            .copied()
            .or_else(|| self.buy.get(&type_id).copied())
            .or_else(|| self.adjusted.get(&type_id).copied())
    }

    /// 卖出单价：最低卖价 → adjusted
    pub fn revenue(&self, type_id: i64) -> Option<f64> {
        self.sell
            .get(&type_id)
            .copied()
            .or_else(|| self.adjusted.get(&type_id).copied())
    }

    /// 是否为真实市场价（本地订单快照有数据）
    pub fn is_market(&self, type_id: i64) -> bool {
        self.sell.contains_key(&type_id)
    }
}

/// 加载价格：本地订单聚合 + ESI adjusted
pub async fn load(pool: &SqlitePool, type_ids: &[i64]) -> PriceBook {
    let mut book = PriceBook::default();

    if !type_ids.is_empty() {
        for chunk in type_ids.chunks(400) {
            let placeholders = (1..=chunk.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(", ");

            let sql = format!(
                "SELECT type_id,
                        MAX(CASE WHEN is_buy_order = 1 THEN price END) AS best_buy,
                        MIN(CASE WHEN is_buy_order = 0 THEN price END) AS best_sell
                 FROM market_structure_order
                 WHERE type_id IN ({placeholders})
                 GROUP BY type_id"
            );

            let mut query = sqlx::query_as::<_, (i64, Option<f64>, Option<f64>)>(&sql);
            for id in chunk {
                query = query.bind(*id);
            }

            if let Ok(rows) = query.fetch_all(pool).await {
                for (type_id, best_buy, best_sell) in rows {
                    if let Some(price) = best_sell {
                        book.sell.insert(type_id, price);
                    }
                    if let Some(price) = best_buy {
                        book.buy.insert(type_id, price);
                    }
                }
            }
        }
    }

    book.adjusted = adjusted_map(pool).await;

    book
}

/// ESI adjusted 价（带内存缓存与库内快照）
async fn adjusted_map(pool: &SqlitePool) -> HashMap<i64, f64> {
    if let Ok(guard) = ADJUSTED.lock() {
        if let Some((at, map)) = guard.as_ref() {
            if at.elapsed() < ADJUSTED_TTL {
                return map.clone();
            }
        }
    }

    // 先拉 ESI；失败则回退库里的旧快照
    let fresh = match crate::esi::fetch_market_prices().await {
        Ok(map) => map,
        Err(_) => HashMap::new(),
    };

    let mut parsed: HashMap<i64, f64> = HashMap::new();

    for (key, value) in fresh {
        if let Ok(id) = key.parse::<i64>() {
            parsed.insert(id, value);
        }
    }

    if parsed.is_empty() {
        // 回退：读上次落库的快照
        if let Ok(rows) = sqlx::query_as::<_, (i64, f64)>(
            "SELECT type_id, adjusted FROM mfg_price_cache",
        )
        .fetch_all(pool)
        .await
        {
            return rows.into_iter().collect();
        }

        return HashMap::new();
    }

    // 落库（覆盖式，量不大）
    let _ = sqlx::query("DELETE FROM mfg_price_cache").execute(pool).await;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);

    let rows: Vec<(i64, f64)> = parsed.iter().map(|(id, price)| (*id, *price)).collect();

    for chunk in rows.chunks(400) {
        let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "INSERT OR REPLACE INTO mfg_price_cache (type_id, adjusted, updated_at) ",
        );
        qb.push_values(chunk, |mut builder, (id, price)| {
            builder.push_bind(*id).push_bind(*price).push_bind(now);
        });

        if qb.build().execute(pool).await.is_err() {
            break;
        }
    }

    if let Ok(mut guard) = ADJUSTED.lock() {
        *guard = Some((Instant::now(), parsed.clone()));
    }

    parsed
}
