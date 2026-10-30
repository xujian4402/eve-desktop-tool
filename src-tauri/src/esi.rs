use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::eve_auth::{cached_access_token, chrono_now_ms, refresh_access_token};

const ESI_BASE: &str = "https://esi.evetech.net/latest";

/// 分页安全上限：100 页 ≈ 10 万条订单，避免异常建筑打爆内存
const MAX_ORDER_PAGES: usize = 100;

/// 玩家建筑 ID 下限（NPC 空间站 ID 只有几千）
const STRUCTURE_ID_MIN: i64 = 1_000_000_000_000;

/// 资产分页上限（每页 1000 条）。大号角色的资产可达数万条，
/// 超出时返回 truncated 标志，由界面提示用户结果不完整。
const MAX_ASSET_PAGES: usize = 50;

/// 单次扫描最多解析的建筑数量，避免极端情况长时间占用
const MAX_SCAN_STRUCTURES: usize = 60;

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent("eve-desktop-tool/0.1")
            .build()
            .expect("无法创建 HTTP 客户端")
    })
}

/// 取该角色可用的 access_token。
/// 数据库里的令牌就是缓存：未过期直接用，过期则用加密保存的 refresh_token 换新并写回。
async fn ensure_token(pool: &SqlitePool, character_id: i64) -> Result<String, String> {
    if let Some(token) = cached_access_token(pool, character_id).await? {
        return Ok(token);
    }

    let (access_token, _expires_at) = refresh_access_token(pool, character_id).await?;
    Ok(access_token)
}

/// ID → 名称（公开接口，失败返回 None 不阻断主流程）
async fn resolve_name(id: i64) -> Option<String> {
    let response = http()
        .post(format!("{ESI_BASE}/universe/names/"))
        .query(&[("datasource", "tranquility")])
        .json(&[id])
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let rows = response.json::<Vec<serde_json::Value>>().await.ok()?;
    rows.first()?
        .get("name")?
        .as_str()
        .map(|value| value.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureInfo {
    pub structure_id: i64,
    pub name: String,
    pub solar_system_id: Option<i64>,
    pub solar_system_name: Option<String>,
    pub type_id: Option<i64>,
    pub owner_id: Option<i64>,
    /// 是否开放市场（能读到订单列表即为 true）
    pub has_market: bool,
}

#[derive(Debug, Deserialize)]
struct EsiStructureDetail {
    name: String,
    #[serde(default)]
    solar_system_id: Option<i64>,
    #[serde(default)]
    type_id: Option<i64>,
    #[serde(default)]
    owner_id: Option<i64>,
}

async fn fetch_structure_detail(
    structure_id: i64,
    token: &str,
) -> Result<EsiStructureDetail, String> {
    let response = http()
        .get(format!("{ESI_BASE}/universe/structures/{structure_id}/"))
        .query(&[("datasource", "tranquility")])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("请求建筑信息失败：{e}"))?;

    match response.status().as_u16() {
        200 => {}
        403 => {
            return Err(
                "该角色无权访问这个建筑。需要角色在建筑所属军团拥有对接/市场权限，或该建筑对外开放了市场。"
                    .into(),
            )
        }
        404 => return Err("建筑不存在或已销毁，请确认建筑 ID".into()),
        code => return Err(format!("获取建筑信息失败（HTTP {code}）")),
    }

    response
        .json::<EsiStructureDetail>()
        .await
        .map_err(|e| format!("解析建筑信息失败：{e}"))
}

/// 解析玩家建筑：名称、所在星系、类型、所有者。
/// 能取到信息本身就说明该角色的令牌对此建筑有访问权限。
#[tauri::command]
pub async fn resolve_structure(
    structure_id: i64,
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<StructureInfo, String> {
    if structure_id < STRUCTURE_ID_MIN {
        return Err(
            "这不是玩家建筑 ID。星城、铁壁等建筑的 ID 通常是 1,000,000,000,000 以上的长数字。"
                .into(),
        );
    }

    let token = ensure_token(pool.inner(), character_id).await?;
    let detail = fetch_structure_detail(structure_id, &token).await?;

    let solar_system_name = match detail.solar_system_id {
        Some(id) => resolve_name(id).await,
        None => None,
    };

    // 录入时顺带探测市场，市场页只展示有市场的建筑
    let has_market = has_market_service(structure_id, &token).await;

    Ok(StructureInfo {
        structure_id,
        name: detail.name,
        solar_system_id: detail.solar_system_id,
        solar_system_name,
        type_id: detail.type_id,
        owner_id: detail.owner_id,
        has_market,
    })
}

/// 订单行。ESI 返回 snake_case，前端用 camelCase，故只在序列化时重命名。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct EsiOrder {
    pub order_id: i64,
    pub type_id: i64,
    #[serde(default)]
    pub is_buy_order: bool,
    pub price: f64,
    #[serde(default)]
    pub volume_remain: i64,
    #[serde(default)]
    pub volume_total: i64,
    #[serde(default)]
    pub min_volume: i64,
    #[serde(default)]
    pub duration: i64,
    #[serde(default)]
    pub issued: String,
    #[serde(default)]
    pub range: String,
    #[serde(default)]
    pub location_id: i64,
    #[serde(default)]
    pub region_id: Option<i64>,
    #[serde(default)]
    pub system_id: Option<i64>,
    #[serde(default)]
    pub escrow: Option<f64>,
    #[serde(default)]
    pub is_corporation: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdersPayload {
    pub orders: Vec<EsiOrder>,
    /// 本次拉取完成时间（unix 毫秒），前端据此标记快照
    pub fetched_at: i64,
    /// 是否因页数上限被截断
    pub truncated: bool,
}

/// 按 X-Pages 分页拉全量订单
async fn fetch_paged_orders<T>(
    url: String,
    token: &str,
    label: &str,
) -> Result<(Vec<T>, bool), String>
where
    T: serde::de::DeserializeOwned,
{
    let mut all: Vec<T> = Vec::new();
    let mut page = 1usize;
    let mut truncated = false;

    loop {
        if page > MAX_ORDER_PAGES {
            truncated = true;
            break;
        }

        let response = http()
            .get(&url)
            .query(&[
                ("datasource", "tranquility".to_string()),
                ("page", page.to_string()),
            ])
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("{label}：第 {page} 页请求失败（{e}）"))?;

        let status = response.status().as_u16();
        match status {
            200 => {}
            403 => return Err(format!("{label}：该角色没有读取权限")),
            404 => return Err(format!("{label}：目标不存在或角色无权访问")),
            420 | 429 => {
                return Err(format!("{label}：{}", RATE_LIMIT_HINT));
            }
            _ => return Err(format!("{label}：第 {page} 页请求失败（HTTP {status}）")),
        }

        let total_pages = response
            .headers()
            .get("x-pages")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1);

        // 先取原文再解析：一是不让空响应直接报解码错误，
        // 二是解析失败时能把响应片段带进错误里，便于定位字段不匹配。
        let body = response
            .text()
            .await
            .map_err(|e| format!("{label}：第 {page} 页读取失败（{e}）"))?;

        if body.trim().is_empty() {
            // ESI 对「没有数据」偶尔返回空 body 而不是 []
            break;
        }

        let rows = serde_json::from_str::<Vec<T>>(&body).map_err(|e| {
            let snippet: String = body.chars().take(300).collect();
            format!("{label}：第 {page} 页解析失败（{e}）；响应片段：{snippet}")
        })?;

        all.extend(rows);

        if page >= total_pages {
            break;
        }
        page += 1;
    }

    Ok((all, truncated))
}

const RATE_LIMIT_HINT: &str = "ESI 限流（错误预算耗尽），请等待一分钟后再试";

/// 同步某建筑的全部市场订单
#[tauri::command]
pub async fn sync_structure_orders(
    structure_id: i64,
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<OrdersPayload, String> {
    let token = ensure_token(pool.inner(), character_id).await?;

    let url = format!("{ESI_BASE}/markets/structures/{structure_id}/");
    let (orders, truncated) = fetch_paged_orders::<EsiOrder>(url, &token, "拉取建筑订单").await?;

    Ok(OrdersPayload {
        orders,
        fetched_at: chrono_now_ms(),
        truncated,
    })
}

/// 同步某角色自己挂出的全部订单
#[tauri::command]
pub async fn sync_character_orders(
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<OrdersPayload, String> {
    let token = ensure_token(pool.inner(), character_id).await?;

    let url = format!("{ESI_BASE}/characters/{character_id}/orders/");
    let (orders, truncated) = fetch_paged_orders::<EsiOrder>(url, &token, "拉取角色订单").await?;

    Ok(OrdersPayload {
        orders,
        fetched_at: chrono_now_ms(),
        truncated,
    })
}

/* ============================================================
   从角色资产中发现星城
   ============================================================ */

#[derive(Debug, Deserialize)]
struct EsiAsset {
    item_id: i64,
    location_id: i64,
    location_type: String,
    #[serde(default)]
    type_id: i64,
    #[serde(default)]
    quantity: i64,
    #[serde(default)]
    location_flag: String,
    #[serde(default)]
    is_blueprint_copy: bool,
    /// 已组装/单个物品。ESI 对这种条目返回的 quantity 可能是 -1，不能直接累加
    #[serde(default)]
    is_singleton: bool,
}

/// 拉取分页资产列表。返回 (资产列表, 是否因页数上限被截断)
async fn fetch_asset_pages(
    url: String,
    token: &str,
    label: &str,
) -> Result<(Vec<EsiAsset>, bool), String> {
    let mut all: Vec<EsiAsset> = Vec::new();
    let mut page = 1usize;
    let mut truncated = false;

    loop {
        if page > MAX_ASSET_PAGES {
            truncated = true;
            break;
        }

        let response = http()
            .get(&url)
            .query(&[
                ("datasource", "tranquility".to_string()),
                ("page", page.to_string()),
            ])
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("拉取{label}失败（第 {page} 页）：{e}"))?;

        let status = response.status().as_u16();
        match status {
            200 => {}
            403 => {
                return Err(format!(
                    "{label}：该角色没有读取权限，请确认授权包含资产作用域。"
                ))
            }
            404 => return Err(format!("{label}：目标不存在")),
            420 | 429 => return Err(format!("拉取{label}：{}", RATE_LIMIT_HINT)),
            _ => return Err(format!("拉取{label}失败（HTTP {status}，第 {page} 页）")),
        }

        let total_pages = response
            .headers()
            .get("x-pages")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1);

        let rows = response
            .json::<Vec<EsiAsset>>()
            .await
            .map_err(|e| format!("解析{label}失败（第 {page} 页）：{e}"))?;

        all.extend(rows);

        if page >= total_pages {
            break;
        }
        page += 1;
    }

    Ok((all, truncated))
}

/// 角色个人资产
async fn fetch_character_asset_pages(
    character_id: i64,
    token: &str,
) -> Result<(Vec<EsiAsset>, bool), String> {
    fetch_asset_pages(
        format!("{ESI_BASE}/characters/{character_id}/assets/"),
        token,
        "角色资产",
    )
    .await
}


/// 把资产的位置向上追溯到「非容器」的位置。
///
/// ESI 的资产可能放在集装箱/货柜里，此时 location_type = "item"，
/// location_id 指向容器本身而非建筑，需要沿着 item_id → location_id 逐层上溯。
fn resolve_root_location(
    asset: &EsiAsset,
    index: &HashMap<i64, (i64, String)>,
) -> Option<(i64, String)> {
    let mut location_id = asset.location_id;
    let mut location_type = asset.location_type.clone();
    let mut depth = 0;

    while location_type == "item" && depth < 16 {
        match index.get(&location_id) {
            Some((next_id, next_type)) => {
                location_id = *next_id;
                location_type = next_type.clone();
                depth += 1;
            }
            // 容器不在资产列表里：它多半就是玩家建筑本身。
            // 建筑在 ESI 里是 item 类型，但建筑不是角色资产，所以查不到——
            // 之前这里直接返回 None，导致放在星城/铁壁机库里的物品全部丢失。
            None => {
                if location_id >= STRUCTURE_ID_MIN {
                    return Some((location_id, "structure".to_string()));
                }
                return None;
            }
        }
    }

    if location_type == "item" {
        // 层数耗尽仍在 item 里，视为循环引用，放弃这条资产
        return None;
    }

    Some((location_id, location_type))
}

/// 该建筑是否开放市场：能读到订单列表（哪怕为空）即视为有市场服务，
/// 403/404 说明没有市场或该角色无权访问，两种情况都不可同步。
async fn has_market_service(structure_id: i64, token: &str) -> bool {
    match http()
        .get(format!("{ESI_BASE}/markets/structures/{structure_id}/"))
        .query(&[("datasource", "tranquility"), ("page", "1")])
        .bearer_auth(token)
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredStructure {
    pub structure_id: i64,
    /// 解析失败（无访问权限）时为 None
    pub name: Option<String>,
    pub solar_system_id: Option<i64>,
    pub solar_system_name: Option<String>,
    pub type_id: Option<i64>,
    pub owner_id: Option<i64>,
    /// 由哪些来源发现：挂单 / 资产 / 合同 / 所在 / 军团
    pub sources: Vec<String>,
    /// 是否开放市场（能读到订单列表即视为有市场）
    pub has_market: bool,
    /// 当前角色能否解析到建筑信息（等价于有停靠 / 访问权限）
    pub accessible: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureSyncResult {
    pub structures: Vec<DiscoveredStructure>,
    /// 各来源不可用时的说明
    pub notes: Vec<String>,
    /// 去重后的候选建筑总数
    pub candidate_count: usize,
    /// 是否因数量上限被截断
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
struct EsiContract {
    #[serde(default)]
    start_location_id: Option<i64>,
    #[serde(default)]
    end_location_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct EsiLocationInfo {
    #[serde(default)]
    structure_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct EsiCorporationStructure {
    structure_id: i64,
}

/// 记录一个玩家建筑 ID 及其来源（同一来源不重复）
fn push_structure_id(found: &mut HashMap<i64, Vec<String>>, id: Option<i64>, source: &str) {
    let Some(id) = id else { return };
    if id < STRUCTURE_ID_MIN {
        return;
    }

    let entry = found.entry(id).or_default();
    if !entry.iter().any(|existing| existing == source) {
        entry.push(source.to_string());
    }
}

/// 五源汇总发现角色可访问的玩家建筑：
/// 挂单 + 资产 + 合同 + 当前位置 + 军团名下建筑。
///
/// ESI 没有「列出角色可访问建筑」的接口，只能把这五个留下过痕迹的来源汇总去重。
/// 任一来源失败不影响其余来源，失败原因汇总到 notes。
async fn discover_structure_ids(
    character_id: i64,
    corporation_id: Option<i64>,
    token: &str,
) -> (HashMap<i64, Vec<String>>, Vec<String>) {
    let mut found: HashMap<i64, Vec<String>> = HashMap::new();
    let mut notes: Vec<String> = Vec::new();

    // 来源 1：角色挂单
    let orders_url = format!("{ESI_BASE}/characters/{character_id}/orders/");
    match fetch_paged_orders::<EsiOrder>(orders_url, token, "角色挂单").await {
        Ok((orders, _)) => {
            for order in &orders {
                push_structure_id(&mut found, Some(order.location_id), "挂单");
            }
        }
        Err(err) => notes.push(format!("挂单来源不可用：{err}")),
    }

    // 来源 2：资产（需要容器上溯到所在建筑）
    match fetch_character_asset_pages(character_id, token).await {
        Ok((assets, _)) => {
            let index: HashMap<i64, (i64, String)> = assets
                .iter()
                .map(|asset| {
                    (
                        asset.item_id,
                        (asset.location_id, asset.location_type.clone()),
                    )
                })
                .collect();

            for asset in &assets {
                if let Some((root, _)) = resolve_root_location(asset, &index) {
                    push_structure_id(&mut found, Some(root), "资产");
                }
            }
        }
        Err(err) => notes.push(format!("资产来源不可用：{err}")),
    }

    // 来源 3：合同起止地点
    let contracts_url = format!("{ESI_BASE}/characters/{character_id}/contracts/");
    match fetch_paged_orders::<EsiContract>(contracts_url, token, "角色合同").await {
        Ok((contracts, _)) => {
            for contract in &contracts {
                push_structure_id(&mut found, contract.start_location_id, "合同");
                push_structure_id(&mut found, contract.end_location_id, "合同");
            }
        }
        Err(err) => notes.push(format!("合同来源不可用：{err}")),
    }

    // 来源 4：角色当前所在建筑
    let location_response = http()
        .get(format!("{ESI_BASE}/characters/{character_id}/location/"))
        .query(&[("datasource", "tranquility")])
        .bearer_auth(token)
        .send()
        .await;

    match location_response {
        Ok(response) if response.status().is_success() => {
            if let Ok(info) = response.json::<EsiLocationInfo>().await {
                push_structure_id(&mut found, info.structure_id, "所在");
            }
        }
        Ok(response) => notes.push(format!(
            "当前位置来源不可用（HTTP {}）",
            response.status().as_u16()
        )),
        Err(err) => notes.push(format!("当前位置来源不可用：{err}")),
    }

    // 来源 5：军团名下建筑（需要军团建筑管理权限）
    match corporation_id {
        Some(corp_id) => {
            let url = format!("{ESI_BASE}/corporations/{corp_id}/structures/");
            match fetch_paged_orders::<EsiCorporationStructure>(url, token, "军团建筑").await {
                Ok((structures, _)) => {
                    for structure in &structures {
                        push_structure_id(&mut found, Some(structure.structure_id), "军团");
                    }
                }
                Err(err) => notes.push(format!("军团建筑来源不可用：{err}")),
            }
        }
        None => notes.push("未记录该角色的军团信息，跳过军团建筑来源".to_string()),
    }

    (found, notes)
}

/// 「同步建筑」：五源汇总发现角色可访问的玩家建筑，逐个解析名称与星系。
///
/// 无访问权限的建筑也会返回（accessible=false），让用户知道它存在但读不到详情。
#[tauri::command]
pub async fn sync_character_structures(
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<StructureSyncResult, String> {
    let token = ensure_token(pool.inner(), character_id).await?;
    let corporation_id = character_corporation_id(pool.inner(), character_id).await;

    let (found, notes) = discover_structure_ids(character_id, corporation_id, &token).await;

    let candidate_count = found.len();
    let mut candidates: Vec<(i64, Vec<String>)> = found.into_iter().collect();
    // 来源越多越可能是常用建筑，优先解析
    candidates.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

    let truncated = candidates.len() > MAX_SCAN_STRUCTURES;
    candidates.truncate(MAX_SCAN_STRUCTURES);

    let mut structures: Vec<DiscoveredStructure> = Vec::new();

    for (structure_id, sources) in candidates {
        match fetch_structure_detail(structure_id, &token).await {
            Ok(detail) => {
                let solar_system_name = match detail.solar_system_id {
                    Some(id) => resolve_name(id).await,
                    None => None,
                };
                let has_market = has_market_service(structure_id, &token).await;

                structures.push(DiscoveredStructure {
                    structure_id,
                    name: Some(detail.name),
                    solar_system_id: detail.solar_system_id,
                    solar_system_name,
                    type_id: detail.type_id,
                    owner_id: detail.owner_id,
                    sources,
                    has_market,
                    accessible: true,
                });
            }
            // 无权访问：仍然返回，让用户知道该建筑存在但拿不到详情
            Err(_) => structures.push(DiscoveredStructure {
                structure_id,
                name: None,
                solar_system_id: None,
                solar_system_name: None,
                type_id: None,
                owner_id: None,
                sources,
                has_market: false,
                accessible: false,
            }),
        }
    }

    // 有市场的、可访问的、来源多的排前面
    structures.sort_by(|a, b| {
        b.has_market
            .cmp(&a.has_market)
            .then_with(|| b.accessible.cmp(&a.accessible))
            .then_with(|| b.sources.len().cmp(&a.sources.len()))
    });

    Ok(StructureSyncResult {
        structures,
        notes,
        candidate_count,
        truncated,
    })
}

/* ============================================================
   资产列表（按建筑分组）
   ============================================================ */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetItem {
    pub type_id: i64,
    pub type_name: Option<String>,
    pub quantity: i64,
    pub location_flag: String,
    pub is_blueprint_copy: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetGroup {
    pub location_id: i64,
    /// structure（玩家建筑） | station（NPC 空间站） | system（停在太空）
    pub location_kind: String,
    pub location_name: String,
    pub items: Vec<AssetItem>,
    pub total_quantity: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsPayload {
    pub groups: Vec<AssetGroup>,
    pub asset_count: usize,
    /// 是否因页数上限被截断（大号角色资产可能达数万条）
    pub truncated: bool,
}

/// 批量解析 ID → 名称。单批失败只丢该批，不影响整体。
/// 批量解析名称：本地 eve_type 的中文名优先，缺失的再走 ESI。
///
/// ESI 的 /universe/names/ 只返回英文，直接用它会让资产、订单里的物品名
/// 全变成英文；本地 SDE 已经导入了 5 万多条中文名，先查本地又快又准。
async fn resolve_names_bulk(
    pool: &SqlitePool,
    ids: &[i64],
) -> HashMap<i64, String> {
    let mut names: HashMap<i64, String> = HashMap::new();

    // 1. 本地中文名
    for chunk in ids.chunks(500) {
        let mut builder = sqlx::QueryBuilder::new(
            "SELECT type_id, COALESCE(name_zh, name_en) AS name FROM eve_type WHERE type_id IN (",
        );

        let mut separated = builder.separated(", ");
        for id in chunk {
            separated.push_bind(*id);
        }
        separated.push_unseparated(")");

        let rows = builder
            .build_query_as::<(i64, Option<String>)>()
            .fetch_all(pool)
            .await;

        if let Ok(rows) = rows {
            for (id, name) in rows {
                if let Some(name) = name {
                    if !name.is_empty() {
                        names.insert(id, name);
                    }
                }
            }
        }
    }

    // 2. 本地没有的再问 ESI（英文兜底）
    let missing: Vec<i64> = ids
        .iter()
        .copied()
        .filter(|id| !names.contains_key(id))
        .collect();

    if missing.is_empty() {
        return names;
    }

    for batch in missing.chunks(1000) {
        let response = http()
            .post(format!("{ESI_BASE}/universe/names/"))
            .query(&[("datasource", "tranquility")])
            .json(&batch.to_vec())
            .send()
            .await;

        let Ok(response) = response else { continue };
        if !response.status().is_success() {
            continue;
        }

        let Ok(rows) = response.json::<Vec<serde_json::Value>>().await else {
            continue;
        };

        for row in rows {
            let id = row.get("id").and_then(|value| value.as_i64());
            let name = row.get("name").and_then(|value| value.as_str());
            if let (Some(id), Some(name)) = (id, name) {
                names.insert(id, name.to_string());
            }
        }
    }

    names
}

async fn resolve_location_name(location_id: i64, _location_type: &str, token: &str) -> String {
    if location_id >= STRUCTURE_ID_MIN {
        return match fetch_structure_detail(location_id, token).await {
            Ok(detail) => detail.name,
            Err(_) => format!("#{location_id}"),
        };
    }

    resolve_name(location_id)
        .await
        .unwrap_or_else(|| format!("#{location_id}"))
}

/// 读取该角色所属军团 ID（来自前端写入的 eve_character 表）
async fn character_corporation_id(pool: &SqlitePool, character_id: i64) -> Option<i64> {
    sqlx::query_scalar::<_, Option<i64>>(
        "SELECT corporation_id FROM eve_character WHERE character_id = ?1",
    )
    .bind(character_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .flatten()
}

/// 拉取角色个人资产，按所在建筑 / NPC 空间站 / 星系分组。
///
/// 只取 /characters/{id}/assets/，不合并军团资产——
/// 军团机库里的物品不属于该角色，混进来会干扰个人资产盘点。
#[tauri::command]
pub async fn fetch_character_assets(
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<AssetsPayload, String> {
    let token = ensure_token(pool.inner(), character_id).await?;
    let (assets, truncated) = fetch_character_asset_pages(character_id, &token).await?;

    // item_id → (所在位置 ID, 位置类型)，用于容器上溯
    let index: HashMap<i64, (i64, String)> = assets
        .iter()
        .map(|asset| {
            (
                asset.item_id,
                (asset.location_id, asset.location_type.clone()),
            )
        })
        .collect();

    let mut buckets: HashMap<i64, (String, Vec<&EsiAsset>)> = HashMap::new();

    for asset in &assets {
        if let Some((root, root_type)) = resolve_root_location(asset, &index) {
            buckets
                .entry(root)
                .or_insert_with(|| (root_type, Vec::new()))
                .1
                .push(asset);
        }
    }

    // 物品名称：一次批量解析，避免逐条请求
    let type_ids: Vec<i64> = {
        let mut ids: Vec<i64> = assets.iter().map(|asset| asset.type_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let type_names = resolve_names_bulk(pool.inner(), &type_ids).await;

    let mut groups: Vec<AssetGroup> = Vec::new();

    for (location_id, (location_type, items)) in buckets {
        let location_name = resolve_location_name(location_id, &location_type, &token).await;

        // 同一建筑里同一种物品可能拆成多条记录，按「类型 + 槽位 + 蓝图拷贝」合并。
        // 单件物品（已组装 / 蓝图拷贝）的数量一律按 1 计：
        // ESI 对这类条目的 quantity 可能返回 -1，直接累加会把总数算错。
        let mut merged: HashMap<(i64, String, bool), i64> = HashMap::new();

        for asset in items.iter() {
            if asset.type_id <= 0 {
                continue;
            }

            let quantity = if asset.is_singleton || asset.is_blueprint_copy {
                1
            } else {
                asset.quantity.max(0)
            };

            let key = (
                asset.type_id,
                asset.location_flag.clone(),
                asset.is_blueprint_copy,
            );

            *merged.entry(key).or_insert(0) += quantity;
        }

        let mut asset_items: Vec<AssetItem> = merged
            .into_iter()
            .map(|((type_id, location_flag, is_blueprint_copy), quantity)| AssetItem {
                type_id,
                type_name: type_names.get(&type_id).cloned(),
                quantity,
                location_flag,
                is_blueprint_copy,
            })
            .collect();

        asset_items.sort_by(|a, b| a.type_id.cmp(&b.type_id));

        let total_quantity = asset_items.iter().map(|item| item.quantity).sum();

        let location_kind = if location_id >= STRUCTURE_ID_MIN {
            "structure"
        } else if location_type == "station" {
            "station"
        } else {
            "system"
        };

        groups.push(AssetGroup {
            location_id,
            location_kind: location_kind.to_string(),
            location_name,
            items: asset_items,
            total_quantity,
        });
    }

    // 玩家建筑优先展示，其次按物品种类数降序
    groups.sort_by(|a, b| {
        let rank = |kind: &str| if kind == "structure" { 0 } else { 1 };
        rank(&a.location_kind)
            .cmp(&rank(&b.location_kind))
            .then_with(|| b.items.len().cmp(&a.items.len()))
    });

    Ok(AssetsPayload {
        groups,
        asset_count: assets.len(),
        truncated,
    })
}

/* ============================================================
   EVE 市场物品分类（market groups）
   ============================================================ */

/// 分类详情拉取的并发度。2100+ 个分组串行拉会非常慢，
/// 并发 12 既能压到几十秒，又不至于触发 ESI 限流。
const MARKET_GROUP_CONCURRENCY: usize = 12;

#[derive(Debug, Deserialize)]
struct EsiMarketGroup {
    market_group_id: i64,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    parent_group_id: Option<i64>,
    #[serde(default)]
    types: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketGroupSyncResult {
    /// ESI 返回的分组 ID 总数
    pub total_ids: usize,
    /// 成功拉取并写入的分组数
    pub synced: usize,
    /// 拉取失败的分组数
    pub failed: usize,
    /// 清理掉的失效分组数
    pub removed: usize,
    /// 顺带写入 eve_type 的物品名称条数
    pub type_names: usize,
}

async fn fetch_market_group(id: i64) -> Result<EsiMarketGroup, String> {
    let response = http()
        .get(format!("{ESI_BASE}/markets/groups/{id}/"))
        .query(&[("datasource", "tranquility"), ("language", "zh")])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    response
        .json::<EsiMarketGroup>()
        .await
        .map_err(|e| e.to_string())
}

/// 同步市场物品分类树。公开接口，不需要角色授权。
#[tauri::command]
pub async fn sync_market_groups(
    pool: tauri::State<'_, SqlitePool>,
) -> Result<MarketGroupSyncResult, String> {
    // 1. 全部分组 ID
    let ids_response = http()
        .get(format!("{ESI_BASE}/markets/groups/"))
        .query(&[("datasource", "tranquility")])
        .send()
        .await
        .map_err(|e| format!("获取分组清单失败：{e}"))?;

    if !ids_response.status().is_success() {
        return Err(format!(
            "获取分组清单失败（HTTP {}）",
            ids_response.status().as_u16()
        ));
    }

    let ids: Vec<i64> = ids_response
        .json()
        .await
        .map_err(|e| format!("解析分组清单失败：{e}"))?;

    let total_ids = ids.len();

    // 2. 分批并发拉详情
    let mut details: Vec<EsiMarketGroup> = Vec::with_capacity(ids.len());
    let mut failed = 0usize;

    for chunk in ids.chunks(MARKET_GROUP_CONCURRENCY) {
        let tasks = chunk.iter().map(|id| fetch_market_group(*id));
        for result in futures::future::join_all(tasks).await {
            match result {
                Ok(detail) => details.push(detail),
                Err(_) => failed += 1,
            }
        }
    }

    let synced = details.len();
    let now = chrono_now_ms();

    // 3. 写入分类表
    for batch in details.chunks(200) {
        let mut builder = sqlx::QueryBuilder::new(
            "INSERT INTO market_group (market_group_id, name, description, parent_group_id, types, synced_at) ",
        );

        builder.push_values(batch, |mut row, group| {
            row.push_bind(group.market_group_id)
                .push_bind(group.name.clone())
                .push_bind(group.description.clone())
                .push_bind(group.parent_group_id)
                .push_bind(
                    serde_json::to_string(&group.types).unwrap_or_else(|_| "[]".to_string()),
                )
                .push_bind(now);
        });

        builder.push(
            " ON CONFLICT(market_group_id) DO UPDATE SET \
             name = excluded.name, description = excluded.description, \
             parent_group_id = excluded.parent_group_id, types = excluded.types, \
             synced_at = excluded.synced_at",
        );

        builder
            .build()
            .execute(pool.inner())
            .await
            .map_err(|e| format!("写入分组失败：{e}"))?;
    }

    // 4. 清理失效分组。仅在成功拉到大部分时才清，
    //    避免网络异常导致刚删光本地数据。
    let mut removed = 0usize;
    if synced > 0 && synced * 2 > total_ids {
        let result = sqlx::query("DELETE FROM market_group WHERE synced_at < ?1")
            .bind(now)
            .execute(pool.inner())
            .await
            .map_err(|e| format!("清理失效分组失败：{e}"))?;
        removed = result.rows_affected() as usize;
    }

    // 5. 商品目录：与分类一起刷新，供「只搜商品」使用
    let market_types: Vec<(i64, i64)> = details
        .iter()
        .flat_map(|group| {
            group
                .types
                .iter()
                .map(move |type_id| (*type_id, group.market_group_id))
        })
        .collect();

    for batch in market_types.chunks(300) {
        let mut builder = sqlx::QueryBuilder::new(
            "INSERT INTO market_type (type_id, market_group_id) ",
        );

        builder.push_values(batch, |mut row, (type_id, group_id)| {
            row.push_bind(*type_id).push_bind(*group_id);
        });

        builder.push(" ON CONFLICT(type_id) DO NOTHING");

        builder
            .build()
            .execute(pool.inner())
            .await
            .map_err(|e| format!("写入商品目录失败：{e}"))?;
    }

    // 6. 顺带把分类里的物品名解析出来写入 eve_type，
    //    这样分类页和订单页都能显示名称而不是裸 type_id。
    let type_ids: Vec<i64> = {
        let mut all: Vec<i64> = details
            .iter()
            .flat_map(|group| group.types.iter().copied())
            .collect();
        all.sort_unstable();
        all.dedup();
        all
    };

    let names = resolve_names_bulk(pool.inner(), &type_ids).await;
    let type_names = names.len();
    let entries: Vec<(i64, String)> = names.into_iter().collect();

    for batch in entries.chunks(200) {
        let mut builder = sqlx::QueryBuilder::new("INSERT INTO eve_type (type_id, name_en) ");

        builder.push_values(batch, |mut row, (id, name)| {
            row.push_bind(*id).push_bind(name.clone());
        });

        builder.push(" ON CONFLICT(type_id) DO UPDATE SET name_en = excluded.name_en");

        builder
            .build()
            .execute(pool.inner())
            .await
            .map_err(|e| format!("写入物品名称失败：{e}"))?;
    }

    Ok(MarketGroupSyncResult {
        total_ids,
        synced,
        failed,
        removed,
        type_names,
    })
}

/* ============================================================
   内置 SDE 静态分类数据
   ============================================================ */

/// 由 scripts/build-sde.mjs 从官方 SDE 提取，编译进二进制
const SDE_MARKET_GROUPS_JSON: &str = include_str!("../resources/sde-market-groups.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SdePayload {
    generated_at: String,
    groups: Vec<SdeGroup>,
    /// type_id（字符串键） → 物品名称
    types: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SdeGroup {
    id: i64,
    name: String,
    #[serde(default)]
    name_en: Option<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    parent_id: Option<i64>,
    #[serde(default)]
    types: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedResult {
    /// 本次是否真的导入了数据（已有数据时直接跳过）
    pub seeded: bool,
    pub groups: usize,
    pub types: usize,
    /// 静态数据生成日期
    pub generated_at: String,
}

/// 把内置 SDE 分类数据导入本地库。
///
/// 幂等：库里已有分类时直接跳过，返回 seeded = false。
/// 需要最新数据时可以再点「重新同步」从 ESI 拉取。
#[tauri::command]
pub async fn seed_market_groups(
    pool: tauri::State<'_, SqlitePool>,
) -> Result<SeedResult, String> {
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM market_group")
        .fetch_one(pool.inner())
        .await
        .map_err(|e| format!("读取本地分类数量失败：{e}"))?;

    if existing > 0 {
        return Ok(SeedResult {
            seeded: false,
            groups: existing as usize,
            types: 0,
            generated_at: String::new(),
        });
    }

    let payload: SdePayload = serde_json::from_str(SDE_MARKET_GROUPS_JSON)
        .map_err(|e| format!("解析内置分类数据失败：{e}"))?;

    let now = chrono_now_ms();
    let group_count = payload.groups.len();

    // 单事务写入：5 万多条物品名逐条提交会慢一个数量级
    let mut tx = pool
        .inner()
        .begin()
        .await
        .map_err(|e| format!("开启事务失败：{e}"))?;

    for batch in payload.groups.chunks(200) {
        let mut builder = sqlx::QueryBuilder::new(
            "INSERT INTO market_group (market_group_id, name, name_en, description, parent_group_id, types, synced_at) ",
        );

        builder.push_values(batch, |mut row, group| {
            row.push_bind(group.id)
                .push_bind(group.name.clone())
                .push_bind(group.name_en.clone())
                .push_bind(group.description.clone())
                .push_bind(group.parent_id)
                .push_bind(
                    serde_json::to_string(&group.types).unwrap_or_else(|_| "[]".to_string()),
                )
                .push_bind(now);
        });

        builder.push(
            " ON CONFLICT(market_group_id) DO UPDATE SET \
             name = excluded.name, name_en = excluded.name_en, \
             description = excluded.description, parent_group_id = excluded.parent_group_id, \
             types = excluded.types, synced_at = excluded.synced_at",
        );

        builder
            .build()
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("写入分类失败：{e}"))?;
    }

    let type_entries: Vec<(i64, String)> = payload
        .types
        .iter()
        .filter_map(|(key, name)| key.parse::<i64>().ok().map(|id| (id, name.clone())))
        .collect();

    let type_count = type_entries.len();

    for batch in type_entries.chunks(300) {
        let mut builder =
            sqlx::QueryBuilder::new("INSERT INTO eve_type (type_id, name_zh, name_en) ");

        builder.push_values(batch, |mut row, (id, name)| {
            row.push_bind(*id).push_bind(name.clone()).push_bind(name.clone());
        });

        builder.push(
            " ON CONFLICT(type_id) DO UPDATE SET \
             name_zh = COALESCE(eve_type.name_zh, excluded.name_zh), \
             name_en = COALESCE(eve_type.name_en, excluded.name_en)",
        );

        builder
            .build()
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("写入物品名称失败：{e}"))?;
    }

    // 商品目录：把分组里的类型展开成关联表，供「只搜商品」使用
    let market_types: Vec<(i64, i64)> = payload
        .groups
        .iter()
        .flat_map(|group| group.types.iter().map(move |type_id| (*type_id, group.id)))
        .collect();

    for batch in market_types.chunks(300) {
        let mut builder = sqlx::QueryBuilder::new(
            "INSERT INTO market_type (type_id, market_group_id) ",
        );

        builder.push_values(batch, |mut row, (type_id, group_id)| {
            row.push_bind(*type_id).push_bind(*group_id);
        });

        builder.push(" ON CONFLICT(type_id) DO NOTHING");

        builder
            .build()
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("写入商品目录失败：{e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败：{e}"))?;

    Ok(SeedResult {
        seeded: true,
        groups: group_count,
        types: type_count,
        generated_at: payload.generated_at,
    })
}

/* ============================================================
   星域订单（Jita 等 NPC 贸易枢纽）
   ============================================================ */

/// 单个物品在星域内的订单分页上限（一般 2~5 页就够）
const MAX_REGION_ORDER_PAGES: usize = 20;

#[derive(Debug, Deserialize)]
struct EsiRegionOrder {
    order_id: i64,
    #[serde(default)]
    is_buy_order: bool,
    price: f64,
    volume_remain: i64,
    volume_total: i64,
    #[serde(default)]
    min_volume: i64,
    #[serde(default)]
    range: String,
    #[serde(default)]
    issued: String,
    #[serde(default)]
    location_id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionOrder {
    pub order_id: i64,
    pub is_buy_order: bool,
    pub price: f64,
    pub volume_remain: i64,
    pub volume_total: i64,
    pub min_volume: i64,
    pub range: String,
    /// 原始 ISO 时间，由前端解析成本地时间
    pub issued: String,
    pub location_id: i64,
}

/// 拉取某星域中某个物品的全部订单。公开接口，不需要角色授权。
///
/// 星域全量订单有几十万条，按 type_id 过滤后通常只有几十到几千条，
/// 因此这里只按需拉单个物品，不做全量镜像。
#[tauri::command]
pub async fn fetch_region_type_orders(
    region_id: i64,
    type_id: i64,
) -> Result<Vec<RegionOrder>, String> {
    let mut all: Vec<RegionOrder> = Vec::new();
    let mut page = 1usize;

    loop {
        if page > MAX_REGION_ORDER_PAGES {
            break;
        }

        let response = http()
            .get(format!("{ESI_BASE}/markets/{region_id}/orders/"))
            .query(&[
                ("datasource", "tranquility"),
                ("type_id", &type_id.to_string()),
                ("order_type", "all"),
                ("page", &page.to_string()),
            ])
            .send()
            .await
            .map_err(|e| format!("拉取星域订单失败：{e}"))?;

        let status = response.status().as_u16();
        if status == 420 || status == 429 {
            return Err(format!("拉取星域订单：{RATE_LIMIT_HINT}"));
        }
        if status != 200 {
            return Err(format!("拉取星域订单失败（HTTP {status}）"));
        }

        let total_pages = response
            .headers()
            .get("x-pages")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1);

        let rows = response
            .json::<Vec<EsiRegionOrder>>()
            .await
            .map_err(|e| format!("解析星域订单失败（第 {page} 页）：{e}"))?;

        for row in rows {
            all.push(RegionOrder {
                order_id: row.order_id,
                is_buy_order: row.is_buy_order,
                price: row.price,
                volume_remain: row.volume_remain,
                volume_total: row.volume_total,
                min_volume: row.min_volume,
                range: row.range,
                issued: row.issued,
                location_id: row.location_id,
            });
        }

        if page >= total_pages {
            break;
        }
        page += 1;
    }

    Ok(all)
}
