//! 角色详情：公开资料 + 军团 / 联盟 + 钱包 + 技能 + 位置。
//!
//! 一次调用聚合返回，缺授权的模块只记录 `warnings`，不影响其它字段。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::esi::{ensure_token, http, resolve_name, resolve_names_bulk, ESI_BASE};

/// 技能训练队列中的一项
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillQueueItem {
    pub queue_position: i64,
    pub skill_id: i64,
    /// 技能名（本地中文名优先，缺省时回退 ESI 英文名）
    pub skill_name: Option<String>,
    pub finished_level: i64,
    /// 开始训练时间（ISO，可能为空 = 队列未启动）
    pub start_date: Option<String>,
    /// 完成时间（ISO，可能为空 = 已暂停）
    pub finish_date: Option<String>,
}

/// 合同
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractItem {
    pub contract_id: i64,
    /// item_exchange / courier / auction / loan ...
    pub contract_type: String,
    pub status: String,
    pub title: Option<String>,
    pub price: Option<f64>,
    pub volume: Option<f64>,
    pub date_issued: Option<String>,
    pub date_expired: Option<String>,
    pub for_corporation: bool,
}

/// 邮件
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailItem {
    pub mail_id: i64,
    pub subject: Option<String>,
    /// 发件人名称（角色名或系统）
    pub from_name: Option<String>,
    pub timestamp: Option<String>,
    pub is_read: bool,
}

/// 装配里的一件物品
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FittingSlotItem {
    pub type_id: i64,
    pub type_name: Option<String>,
    /// ESI flag：HiSlot0 / MedSlot1 / LoSlot2 / RigSlot0 / Cargo / DroneBay ...
    pub flag: String,
    pub quantity: i64,
}

/// 装配方案
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FittingItem {
    pub fitting_id: i64,
    pub name: String,
    pub ship_type_id: i64,
    pub ship_type_name: Option<String>,
    /// 装配物品数（含船体）
    pub item_count: usize,
    /// 全部物品明细，前端按 flag 分槽位展示
    pub items: Vec<FittingSlotItem>,
}

/// 舰队
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetInfo {
    pub fleet_id: i64,
    /// fleet_commander / wing_commander / squad_commander / squad_member
    pub role: String,
    pub wing_id: Option<i64>,
    pub squad_id: Option<i64>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDetail {
    pub character_id: i64,
    /// 角色名
    pub name: String,
    /// 创建时间（ISO）
    pub birthday: Option<String>,
    /// 安全等级
    pub security_status: Option<f64>,
    /// 角色简介（可能为空）
    pub description: Option<String>,

    /* 军团 */
    pub corporation_id: Option<i64>,
    pub corporation_name: Option<String>,
    pub corporation_ticker: Option<String>,
    pub corporation_member_count: Option<i64>,
    /// 军团税率（0.1 = 10%）
    pub corporation_tax_rate: Option<f64>,
    pub corporation_ceo_id: Option<i64>,

    /* 联盟 */
    pub alliance_id: Option<i64>,
    pub alliance_name: Option<String>,
    pub alliance_ticker: Option<String>,

    /* 钱包（需 esi-wallet.read_character_wallet.v1） */
    pub wallet_balance: Option<f64>,

    /* 技能（需 esi-skills.read_skills.v1） */
    pub total_sp: Option<i64>,
    pub unallocated_sp: Option<i64>,
    /// 技能训练队列（需 esi-skills.read_skillqueue.v1）
    pub skill_queue: Vec<SkillQueueItem>,

    /* 合同（需 esi-contracts.read_character_contracts.v1） */
    pub contracts: Vec<ContractItem>,

    /* 邮件（需 esi-mail.read_mail.v1） */
    pub mails: Vec<MailItem>,
    /// 未读邮件数（本页统计）
    pub unread_mail_count: usize,

    /* 装配（需 esi-fittings.read_fittings.v1） */
    pub fittings: Vec<FittingItem>,

    /* 舰队（需 esi-fleets.read_fleet.v1）；不在舰队时为 None */
    pub fleet: Option<FleetInfo>,

    /* 位置（需 esi-location.read_location.v1 / read_ship_type.v1） */
    pub solar_system_id: Option<i64>,
    pub solar_system_name: Option<String>,
    pub station_id: Option<i64>,
    pub station_name: Option<String>,
    pub structure_id: Option<i64>,
    /// 玩家建筑名（需 esi-universe.read_structures.v1）
    pub structure_name: Option<String>,
    pub ship_type_id: Option<i64>,
    pub ship_type_name: Option<String>,
    pub ship_name: Option<String>,

    /// 未成功加载的模块说明
    pub warnings: Vec<String>,
}

/// 拉取角色详情（公开资料 + 军团/联盟 + 钱包 + 技能 + 位置）。
#[tauri::command]
pub async fn fetch_character_detail(
    character_id: i64,
    pool: tauri::State<'_, SqlitePool>,
) -> Result<CharacterDetail, String> {
    let mut detail = CharacterDetail {
        character_id,
        ..Default::default()
    };
    let mut warnings: Vec<String> = Vec::new();

    // ---------- 1. 公开资料 ----------
    let public = http()
        .get(format!("{ESI_BASE}/characters/{character_id}/"))
        .query(&[("datasource", "tranquility")])
        .send()
        .await
        .map_err(|e| format!("拉取角色资料失败：{e}"))?;

    let status = public.status().as_u16();
    if status == 420 || status == 429 {
        return Err(crate::esi::RATE_LIMIT_HINT.to_string());
    }
    if status != 200 {
        return Err(format!("拉取角色资料失败（HTTP {status}）"));
    }

    let public: serde_json::Value = public
        .json()
        .await
        .map_err(|e| format!("解析角色资料失败：{e}"))?;

    detail.name = public["name"].as_str().unwrap_or_default().to_string();
    detail.birthday = public["birthday"].as_str().map(|s| s.to_string());
    detail.security_status = public["security_status"].as_f64();
    detail.description = public["description"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty());
    detail.corporation_id = public["corporation_id"].as_i64();
    detail.alliance_id = public["alliance_id"].as_i64();

    // ---------- 2. 军团 ----------
    if let Some(corp_id) = detail.corporation_id {
        match public_json(&format!("/corporations/{corp_id}/")).await {
            Some(corp) => {
                detail.corporation_name = corp["name"].as_str().map(|s| s.to_string());
                detail.corporation_ticker = corp["ticker"].as_str().map(|s| s.to_string());
                detail.corporation_member_count = corp["member_count"].as_i64();
                detail.corporation_tax_rate = corp["tax_rate"].as_f64();
                detail.corporation_ceo_id = corp["ceo_id"].as_i64();
            }
            None => warnings.push("军团信息暂不可用".to_string()),
        }
    }

    // ---------- 3. 联盟 ----------
    if let Some(alliance_id) = detail.alliance_id {
        match public_json(&format!("/alliances/{alliance_id}/")).await {
            Some(alliance) => {
                detail.alliance_name = alliance["name"].as_str().map(|s| s.to_string());
                detail.alliance_ticker = alliance["ticker"].as_str().map(|s| s.to_string());
            }
            None => warnings.push("联盟信息暂不可用".to_string()),
        }
    }

    // ---------- 4. 需要授权的部分 ----------
    let token = match ensure_token(pool.inner(), character_id).await {
        Ok(token) => Some(token),
        Err(error) => {
            warnings.push(format!("未读取到授权令牌：{error}"));
            None
        }
    };

    if let Some(token) = token {
        // 钱包
        match authed_json(&format!("/characters/{character_id}/wallet/"), &token).await {
            Ok(value) => detail.wallet_balance = value.as_f64(),
            Err(reason) => warnings.push(format!("钱包：{reason}")),
        }

        // 技能
        match authed_json(&format!("/characters/{character_id}/skills/"), &token).await {
            Ok(value) => {
                detail.total_sp = value["total_sp"].as_i64();
                detail.unallocated_sp = value["unallocated_sp"].as_i64();
            }
            Err(reason) => warnings.push(format!("技能：{reason}")),
        }

        // 技能训练队列
        match authed_json(&format!("/characters/{character_id}/skillqueue/"), &token).await
        {
            Ok(value) => {
                let mut rows: Vec<(i64, i64, i64, Option<String>, Option<String>)> =
                    Vec::new();

                if let Some(items) = value.as_array() {
                    for item in items {
                        rows.push((
                            item["queue_position"].as_i64().unwrap_or(0),
                            item["skill_id"].as_i64().unwrap_or(0),
                            item["finished_level"].as_i64().unwrap_or(0),
                            item["start_date"].as_str().map(|s| s.to_string()),
                            item["finish_date"].as_str().map(|s| s.to_string()),
                        ));
                    }
                }

                let skill_ids: Vec<i64> = rows.iter().map(|row| row.1).collect();
                let names = resolve_names_bulk(pool.inner(), &skill_ids).await;

                detail.skill_queue = rows
                    .into_iter()
                    .map(|(position, skill_id, level, start, finish)| SkillQueueItem {
                        queue_position: position,
                        skill_id,
                        skill_name: names.get(&skill_id).cloned(),
                        finished_level: level,
                        start_date: start,
                        finish_date: finish,
                    })
                    .collect();
            }
            Err(reason) => warnings.push(format!("技能队列：{reason}")),
        }

        // 位置
        match authed_json(&format!("/characters/{character_id}/location/"), &token).await {
            Ok(value) => {
                detail.solar_system_id = value["solar_system_id"].as_i64();
                detail.station_id = value["station_id"].as_i64();
                detail.structure_id = value["structure_id"].as_i64();

                if let Some(id) = detail.solar_system_id {
                    detail.solar_system_name = resolve_name(id).await;
                }
                if let Some(id) = detail.station_id {
                    detail.station_name = resolve_name(id).await;
                }

                // 玩家建筑不在 /universe/names/ 支持范围内，需要单独查
                if let Some(id) = detail.structure_id {
                    if let Ok(Some(value)) =
                        authed_json_opt(&format!("/universe/structures/{id}/"), &token).await
                    {
                        detail.structure_name =
                            value["name"].as_str().map(|s| s.to_string());
                    }
                }
            }
            Err(reason) => warnings.push(format!("位置：{reason}")),
        }

        // 合同（只取第一页，50 条）
        match authed_json(
            &format!("/characters/{character_id}/contracts/?page=1"),
            &token,
        )
        .await
        {
            Ok(value) => {
                if let Some(items) = value.as_array() {
                    for item in items {
                        detail.contracts.push(ContractItem {
                            contract_id: item["contract_id"].as_i64().unwrap_or(0),
                            contract_type: item["type"]
                                .as_str()
                                .unwrap_or("unknown")
                                .to_string(),
                            status: item["status"].as_str().unwrap_or("").to_string(),
                            title: item["title"].as_str().map(|s| s.to_string()),
                            price: item["price"].as_f64(),
                            volume: item["volume"].as_f64(),
                            date_issued: item["date_issued"].as_str().map(|s| s.to_string()),
                            date_expired: item["date_expired"]
                                .as_str()
                                .map(|s| s.to_string()),
                            for_corporation: item["for_corporation"]
                                .as_bool()
                                .unwrap_or(false),
                        });
                    }
                }
            }
            Err(reason) => warnings.push(format!("合同：{reason}")),
        }

        // 邮件（只取第一页，50 条）
        match authed_json(&format!("/characters/{character_id}/mail/?page=1"), &token).await
        {
            Ok(value) => {
                if let Some(items) = value.as_array() {
                    let mut sender_ids: Vec<i64> = Vec::new();
                    let mut raw: Vec<(i64, Option<String>, i64, Option<String>, bool)> =
                        Vec::new();

                    for item in items {
                        let from = item["from"].as_i64();
                        if let Some(id) = from {
                            sender_ids.push(id);
                        }

                        raw.push((
                            item["mail_id"].as_i64().unwrap_or(0),
                            item["subject"].as_str().map(|s| s.to_string()),
                            from.unwrap_or(0),
                            item["timestamp"].as_str().map(|s| s.to_string()),
                            item["is_read"].as_bool().unwrap_or(false),
                        ));
                    }

                    let names = resolve_names_bulk(pool.inner(), &sender_ids).await;

                    for (mail_id, subject, from, timestamp, is_read) in raw {
                        if !is_read {
                            detail.unread_mail_count += 1;
                        }

                        detail.mails.push(MailItem {
                            mail_id,
                            subject,
                            from_name: names.get(&from).cloned(),
                            timestamp,
                            is_read,
                        });
                    }
                }
            }
            Err(reason) => warnings.push(format!("邮件：{reason}")),
        }

        // 装配
        match authed_json(&format!("/characters/{character_id}/fittings/"), &token).await {
            Ok(value) => {
                if let Some(list) = value.as_array() {
                    // 先收集所有需要解析的 type_id（船体 + 每件物品）
                    let mut type_ids: Vec<i64> = Vec::new();

                    for fitting in list {
                        if let Some(id) = fitting["ship_type_id"].as_i64() {
                            type_ids.push(id);
                        }
                        if let Some(items) = fitting["items"].as_array() {
                            for item in items {
                                if let Some(id) = item["type_id"].as_i64() {
                                    type_ids.push(id);
                                }
                            }
                        }
                    }

                    let names = resolve_names_bulk(pool.inner(), &type_ids).await;

                    for fitting in list {
                        let ship_type_id = fitting["ship_type_id"].as_i64().unwrap_or(0);

                        let mut items: Vec<FittingSlotItem> = Vec::new();
                        if let Some(slots) = fitting["items"].as_array() {
                            for slot in slots {
                                let type_id = slot["type_id"].as_i64().unwrap_or(0);
                                items.push(FittingSlotItem {
                                    type_id,
                                    type_name: names.get(&type_id).cloned(),
                                    flag: slot["flag"]
                                        .as_str()
                                        .unwrap_or("Cargo")
                                        .to_string(),
                                    quantity: slot["quantity"].as_i64().unwrap_or(1),
                                });
                            }
                        }

                        detail.fittings.push(FittingItem {
                            fitting_id: fitting["fitting_id"].as_i64().unwrap_or(0),
                            name: fitting["name"].as_str().unwrap_or("未命名").to_string(),
                            ship_type_id,
                            ship_type_name: names.get(&ship_type_id).cloned(),
                            item_count: items.len() + 1,
                            items,
                        });
                    }
                }
            }
            Err(reason) => warnings.push(format!("装配：{reason}")),
        }

        // 舰队（404 = 不在舰队，属于正常情况）
        match authed_json_opt(&format!("/characters/{character_id}/fleet/"), &token).await {
            Ok(Some(value)) => {
                detail.fleet = Some(FleetInfo {
                    fleet_id: value["fleet_id"].as_i64().unwrap_or(0),
                    role: value["role"].as_str().unwrap_or("").to_string(),
                    wing_id: value["wing_id"].as_i64(),
                    squad_id: value["squad_id"].as_i64(),
                });
            }
            Ok(None) => {}
            Err(reason) => warnings.push(format!("舰队：{reason}")),
        }

        // 舰船
        match authed_json(&format!("/characters/{character_id}/ship/"), &token).await {
            Ok(value) => {
                detail.ship_type_id = value["ship_type_id"].as_i64();
                detail.ship_name = value["ship_name"].as_str().map(|s| s.to_string());

                // 舰船类型名走本地 SDE 的中文名，比 /universe/names/ 的英文更准
                if let Some(id) = detail.ship_type_id {
                    let names = resolve_names_bulk(pool.inner(), &[id]).await;
                    detail.ship_type_name = names.get(&id).cloned();
                }
            }
            Err(reason) => warnings.push(format!("舰船：{reason}")),
        }
    }

    detail.warnings = warnings;
    Ok(detail)
}

/* ============================================================
   内部工具
   ============================================================ */

/// 公开接口 GET → JSON
async fn public_json(path: &str) -> Option<serde_json::Value> {
    let response = http()
        .get(format!("{ESI_BASE}{path}"))
        .query(&[("datasource", "tranquility")])
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    response.json().await.ok()
}

/// 带令牌 GET → JSON；404 视为「无数据」返回 None（如不在舰队）
async fn authed_json_opt(
    path: &str,
    token: &str,
) -> Result<Option<serde_json::Value>, String> {
    let response = http()
        .get(format!("{ESI_BASE}{path}"))
        .query(&[("datasource", "tranquility")])
        .header("Accept-Language", "zh")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("请求失败（{e}）"))?;

    match response.status().as_u16() {
        200 => response
            .json()
            .await
            .map(Some)
            .map_err(|e| format!("解析失败（{e}）")),
        404 => Ok(None),
        403 => Err("缺少对应授权，请重新授权角色".to_string()),
        420 | 429 => Err(crate::esi::RATE_LIMIT_HINT.to_string()),
        status => Err(format!("HTTP {status}")),
    }
}

/// 带令牌 GET → JSON；失败时返回中文原因
async fn authed_json(
    path: &str,
    token: &str,
) -> Result<serde_json::Value, String> {
    let response = http()
        .get(format!("{ESI_BASE}{path}"))
        .query(&[("datasource", "tranquility")])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("请求失败（{e}）"))?;

    match response.status().as_u16() {
        200 => response
            .json()
            .await
            .map_err(|e| format!("解析失败（{e}）")),
        403 => Err("缺少对应授权，请重新授权角色".to_string()),
        420 | 429 => Err(crate::esi::RATE_LIMIT_HINT.to_string()),
        status => Err(format!("HTTP {status}")),
    }
}
