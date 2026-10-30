use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto;

/// EVE 开发者门户注册的 Native App client_id（公开值，非机密）
pub const DEFAULT_CLIENT_ID: &str = "81b94b8e47a14c21b7d55af79d556782";

/// 本地回调端口。必须与门户注册的 Callback URL 完全一致（含端口）。
pub const CALLBACK_PORT: u16 = 38472;

/// 授权等待上限。用户中途关掉浏览器时 EVE 不会回调，只能靠超时结束等待。
const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);

/// 用户在应用内主动取消授权时置位，等待循环据此立即退出
static LOGIN_CANCELLED: AtomicBool = AtomicBool::new(false);

const AUTHORIZE_ENDPOINT: &str = "https://login.eveonline.com/v2/oauth/authorize";
const TOKEN_ENDPOINT: &str = "https://login.eveonline.com/v2/oauth/token";
const ESI_BASE: &str = "https://esi.evetech.net/latest";

/// 申请的作用域：当前申请 ESI 全部权限，避免后续加功能时反复要求用户重新授权。
///
/// 列表 = ESI 规范(openapi.json 的 securitySchemes.flows.*.scopes) 与
/// eve-faceless-next 生产验证过的列表的交集：70 个 ESI 作用域 + publicData。
///
/// 刻意排除了规范里出现、但 EVE SSO 不接受的条目：
///   esi-activity.char:read / esi-cosmetic.char:read
/// 实测请求它们会返回：
///   {"error":"invalid_scope","error_description":"The requested ... scope is not valid."}
/// 且整个授权会失败（SSO 对 scope 是全有或全无）。
///
/// 注意：只要有一个作用域名称无效，EVE SSO 会整体拒绝授权，
/// 表现为浏览器里直接显示错误页。新增作用域前务必先小范围验证。
pub const SCOPES: &[&str] = &[
    "publicData",
    "esi-access.read_lists.v1",
    "esi-activities.read_character.v1",
    "esi-alliances.read_contacts.v1",
    "esi-assets.read_assets.v1",
    "esi-assets.read_corporation_assets.v1",
    "esi-calendar.read_calendar_events.v1",
    "esi-calendar.respond_calendar_events.v1",
    "esi-characters.read_agents_research.v1",
    "esi-characters.read_blueprints.v1",
    "esi-characters.read_contacts.v1",
    "esi-characters.read_corporation_roles.v1",
    "esi-characters.read_fatigue.v1",
    "esi-characters.read_freelance_jobs.v1",
    "esi-characters.read_fw_stats.v1",
    "esi-characters.read_loyalty.v1",
    "esi-characters.read_medals.v1",
    "esi-characters.read_notifications.v1",
    "esi-characters.read_standings.v1",
    "esi-characters.read_titles.v1",
    "esi-characters.write_contacts.v1",
    "esi-clones.read_clones.v1",
    "esi-clones.read_implants.v1",
    "esi-contracts.read_character_contracts.v1",
    "esi-contracts.read_corporation_contracts.v1",
    "esi-corporations.read_blueprints.v1",
    "esi-corporations.read_contacts.v1",
    "esi-corporations.read_container_logs.v1",
    "esi-corporations.read_corporation_membership.v1",
    "esi-corporations.read_divisions.v1",
    "esi-corporations.read_facilities.v1",
    "esi-corporations.read_freelance_jobs.v1",
    "esi-corporations.read_fw_stats.v1",
    "esi-corporations.read_medals.v1",
    "esi-corporations.read_projects.v1",
    "esi-corporations.read_standings.v1",
    "esi-corporations.read_starbases.v1",
    "esi-corporations.read_structures.v1",
    "esi-corporations.read_titles.v1",
    "esi-corporations.track_members.v1",
    "esi-fittings.read_fittings.v1",
    "esi-fittings.write_fittings.v1",
    "esi-fleets.read_fleet.v1",
    "esi-fleets.write_fleet.v1",
    "esi-industry.read_character_jobs.v1",
    "esi-industry.read_character_mining.v1",
    "esi-industry.read_corporation_jobs.v1",
    "esi-industry.read_corporation_mining.v1",
    "esi-killmails.read_corporation_killmails.v1",
    "esi-killmails.read_killmails.v1",
    "esi-location.read_location.v1",
    "esi-location.read_online.v1",
    "esi-location.read_ship_type.v1",
    "esi-mail.organize_mail.v1",
    "esi-mail.read_mail.v1",
    "esi-mail.send_mail.v1",
    "esi-markets.read_character_orders.v1",
    "esi-markets.read_corporation_orders.v1",
    "esi-markets.structure_markets.v1",
    "esi-planets.manage_planets.v1",
    "esi-planets.read_customs_offices.v1",
    "esi-search.search_structures.v1",
    "esi-skills.read_skillqueue.v1",
    "esi-skills.read_skills.v1",
    "esi-structures.read_character.v1",
    "esi-structures.read_corporation.v1",
    "esi-ui.open_window.v1",
    "esi-ui.write_waypoint.v1",
    "esi-universe.read_structures.v1",
    "esi-wallet.read_character_wallet.v1",
    "esi-wallet.read_corporation_wallets.v1",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub character_id: i64,
    pub name: String,
    pub corporation_id: Option<i64>,
    pub corporation_name: Option<String>,
    pub alliance_id: Option<i64>,
    pub alliance_name: Option<String>,
    pub birthday: Option<String>,
    pub security_status: Option<f64>,
    pub scopes: Vec<String>,
    /// access_token 过期时间（unix 毫秒）
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CharacterPublicInfo {
    name: String,
    #[serde(default)]
    corporation_id: Option<i64>,
    #[serde(default)]
    alliance_id: Option<i64>,
    #[serde(default)]
    birthday: Option<String>,
    #[serde(default)]
    security_status: Option<f64>,
}

/// 生成 PKCE verifier（43~128 字符，取自 RFC 7636 允许的字符集）
fn generate_verifier() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// S256 challenge = BASE64URL-NOPAD(SHA256(verifier))
fn challenge_from_verifier(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn build_authorize_url(client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> String {
    let scope = SCOPES.join(" ");
    format!(
        "{AUTHORIZE_ENDPOINT}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(&scope),
        urlencoding::encode(state),
        urlencoding::encode(challenge),
    )
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut iter = pair.splitn(2, '=');
        let key = iter.next().unwrap_or("");
        let value = iter.next().unwrap_or("");
        let key = urlencoding::decode(key)
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| key.to_string());
        let value = urlencoding::decode(value)
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| value.to_string());
        map.insert(key, value);
    }
    map
}

fn write_response(stream: &mut std::net::TcpStream, title: &str, message: &str) {
    let body = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
         <title>{title}</title><style>\
         body{{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;\
         background:#0b1017;color:#d7e3f4;font-family:-apple-system,\"PingFang SC\",sans-serif}}\
         .box{{text-align:center;padding:40px 48px;border:1px solid #23324a;border-radius:12px;\
         background:#111a25}}h1{{font-size:18px;margin:0 0 10px;color:#4ea3ff}}\
         p{{margin:0;font-size:14px;color:#8ba3bf}}</style></head>\
         <body><div class=\"box\"><h1>{title}</h1><p>{message}</p></div></body></html>"
    );

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// 阻塞等待本地回调，返回授权码
fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;

    loop {
        if LOGIN_CANCELLED.load(Ordering::SeqCst) {
            return Err("已取消授权".to_string());
        }

        if Instant::now() > deadline {
            return Err(
                "授权超时：未在 120 秒内完成登录。若已关闭浏览器页面，请重新点击「添加角色」。"
                    .into(),
            );
        }

        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = [0u8; 8192];
                let read = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..read]).to_string();

                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();

                // 浏览器会顺带请求 /favicon.ico，忽略即可
                let Some(query) = target.split_once('?').map(|(_, q)| q) else {
                    write_response(&mut stream, "等待授权", "请在弹出的页面完成 EVE 登录。");
                    continue;
                };

                let params = parse_query(query);

                if let Some(error) = params.get("error") {
                    let detail = params
                        .get("error_description")
                        .cloned()
                        .unwrap_or_else(|| error.clone());
                    write_response(&mut stream, "授权失败", &detail);
                    return Err(format!("EVE 授权被拒绝：{detail}"));
                }

                if let (Some(code), Some(state)) = (params.get("code"), params.get("state")) {
                    if state != expected_state {
                        write_response(&mut stream, "授权失败", "state 校验未通过。");
                        return Err("state 校验未通过，可能存在跨站请求伪造".into());
                    }
                    write_response(
                        &mut stream,
                        "授权成功",
                        "可以关闭此页面，返回桌面应用。",
                    );
                    return Ok(code.clone());
                }

                write_response(&mut stream, "等待授权", "请在弹出的页面完成 EVE 登录。");
            }
            Err(ref err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(err) => return Err(format!("接收回调失败：{err}")),
        }
    }
}

async fn exchange_code(
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;

    let response = client
        .post(TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|e| format!("请求令牌失败：{e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let hint = if status.as_u16() == 400 && detail.contains("invalid_grant") {
            "（授权码已失效或已被使用，请重新授权）"
        } else {
            ""
        };
        return Err(format!(
            "令牌交换失败（HTTP {}）：{}{}",
            status.as_u16(),
            detail.chars().take(200).collect::<String>(),
            hint
        ));
    }

    response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("解析令牌响应失败：{e}"))
}

/// 从 access_token（JWT）中解析角色 ID / 名称 / 作用域
fn parse_jwt_claims(access_token: &str) -> Result<(i64, String, Vec<String>), String> {
    let payload = access_token
        .split('.')
        .nth(1)
        .ok_or_else(|| "access_token 不是合法的 JWT".to_string())?;

    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .map_err(|e| format!("JWT 载荷解码失败：{e}"))?;

    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("JWT 载荷解析失败：{e}"))?;

    let subject = value
        .get("sub")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "JWT 缺少 sub 声明".to_string())?;

    let character_id = subject
        .strip_prefix("CHARACTER:EVE:")
        .and_then(|raw| raw.parse::<i64>().ok())
        .ok_or_else(|| format!("无法从 sub 解析角色 ID：{subject}"))?;

    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let scopes = match value.get("scp") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(|s| s.to_string()))
            .collect(),
        Some(serde_json::Value::String(raw)) => {
            raw.split_whitespace().map(|s| s.to_string()).collect()
        }
        _ => Vec::new(),
    };

    Ok((character_id, name, scopes))
}

async fn fetch_character_info(
    client: &reqwest::Client,
    character_id: i64,
) -> Result<CharacterPublicInfo, String> {
    let response = client
        .get(format!("{ESI_BASE}/characters/{character_id}/"))
        .query(&[("datasource", "tranquility")])
        .send()
        .await
        .map_err(|e| format!("获取角色信息失败：{e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "获取角色信息失败（HTTP {}）",
            response.status().as_u16()
        ));
    }

    response
        .json::<CharacterPublicInfo>()
        .await
        .map_err(|e| format!("解析角色信息失败：{e}"))
}

/// 批量解析 ID → 名称（军团 / 联盟），公开接口无需鉴权
async fn resolve_names(client: &reqwest::Client, ids: &[i64]) -> Vec<(i64, String)> {
    if ids.is_empty() {
        return Vec::new();
    }

    let response = client
        .post(format!("{ESI_BASE}/universe/names/"))
        .query(&[("datasource", "tranquility")])
        .json(&ids)
        .send()
        .await;

    match response {
        Ok(resp) if resp.status().is_success() => resp
            .json::<Vec<serde_json::Value>>()
            .await
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let id = row.get("id")?.as_i64()?;
                        let name = row.get("name")?.as_str()?.to_string();
                        Some((id, name))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/* ============================================================
   令牌持久化：加密后写入本地数据库的 eve_token 表
   ============================================================ */

#[derive(Debug, Clone)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub scopes: Vec<String>,
    pub expires_at: i64,
}

/// 写入/覆盖该角色的令牌。明文只存在于内存，落库前一律加密。
pub(crate) async fn save_tokens(
    pool: &sqlx::SqlitePool,
    character_id: i64,
    access_token: &str,
    refresh_token: &str,
    scopes: &[String],
    expires_at: i64,
) -> Result<(), String> {
    if refresh_token.is_empty() {
        return Err("EVE 返回的 refresh_token 为空".into());
    }

    let access_enc = crypto::encrypt(access_token)?;
    let refresh_enc = crypto::encrypt(refresh_token)?;
    let scopes_json = serde_json::to_string(scopes).unwrap_or_else(|_| "[]".to_string());
    let now = chrono_now_ms();

    sqlx::query(
        "INSERT INTO eve_token
           (character_id, access_token, refresh_token_enc, scopes, token_type,
            expires_at, refreshed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'Bearer', ?5, ?6, ?6)
         ON CONFLICT(character_id) DO UPDATE SET
           access_token      = excluded.access_token,
           refresh_token_enc = excluded.refresh_token_enc,
           scopes            = excluded.scopes,
           token_type        = excluded.token_type,
           expires_at        = excluded.expires_at,
           refreshed_at      = excluded.refreshed_at,
           updated_at        = excluded.updated_at",
    )
    .bind(character_id)
    .bind(access_enc)
    .bind(refresh_enc)
    .bind(scopes_json)
    .bind(expires_at)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| format!("保存令牌到本地数据库失败：{e}"))?;

    Ok(())
}

/// 读取并解密该角色的令牌
pub(crate) async fn load_tokens(
    pool: &sqlx::SqlitePool,
    character_id: i64,
) -> Result<Option<StoredTokens>, String> {
    let row = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, i64)>(
        "SELECT access_token, refresh_token_enc, scopes, expires_at
           FROM eve_token WHERE character_id = ?1",
    )
    .bind(character_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("读取本地令牌失败：{e}"))?;

    let Some((access_enc, refresh_enc, scopes_json, expires_at)) = row else {
        return Ok(None);
    };

    // 老数据（只有 scopes 没有令牌）视为未授权
    let (Some(access_enc), Some(refresh_enc)) = (access_enc, refresh_enc) else {
        return Ok(None);
    };

    let scopes: Vec<String> = scopes_json
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    // 密钥变更（例如删掉了 secret.key）后旧密文无法解开。
    // 这种情况按「未授权」处理，引导用户重新授权，而不是抛错卡住主流程。
    let (Ok(access_token), Ok(refresh_token)) =
        (crypto::decrypt(&access_enc), crypto::decrypt(&refresh_enc))
    else {
        return Ok(None);
    };

    Ok(Some(StoredTokens {
        access_token,
        refresh_token,
        scopes,
        expires_at,
    }))
}

/// 删除该角色的令牌记录
pub(crate) async fn delete_tokens(
    pool: &sqlx::SqlitePool,
    character_id: i64,
) -> Result<(), String> {
    sqlx::query("DELETE FROM eve_token WHERE character_id = ?1")
        .bind(character_id)
        .execute(pool)
        .await
        .map_err(|e| format!("删除本地令牌失败：{e}"))?;

    Ok(())
}

/// 仍然有效的 access_token（预留 60 秒余量），否则返回 None
pub(crate) async fn cached_access_token(
    pool: &sqlx::SqlitePool,
    character_id: i64,
) -> Result<Option<String>, String> {
    match load_tokens(pool, character_id).await? {
        Some(tokens) if tokens.expires_at > chrono_now_ms() + 60_000 => {
            Ok(Some(tokens.access_token))
        }
        _ => Ok(None),
    }
}

/// 绑定本地回调端口。上一轮的监听器可能尚未释放，因此重试若干次。
fn bind_callback_port() -> Result<TcpListener, String> {
    let mut last_error = String::new();

    for attempt in 0..6 {
        match TcpListener::bind(("127.0.0.1", CALLBACK_PORT)) {
            Ok(listener) => return Ok(listener),
            Err(err) => {
                last_error = err.to_string();
                if attempt < 5 {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }
    }

    Err(format!(
        "无法监听本地端口 {CALLBACK_PORT}（{last_error}）。\
         若之前的浏览器授权页仍开着，请先关闭它再重试。"
    ))
}

/// 用系统默认浏览器打开授权页。
///
/// 不用 `open` crate：它在 Windows 上先试 powershell.exe、再回退 explorer.exe，
/// 而本次申请 70+ 作用域拼出的授权地址超过 4 KB，explorer 分支会直接返回
/// ExitStatus(1)，表现为“无法打开系统浏览器”。
/// ShellExecuteW 不经过命令行解析，既不受长度限制，也不会被 `&`、`%` 等字符干扰。
fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        fn wide(value: &str) -> Vec<u16> {
            std::ffi::OsStr::new(value)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        }

        let operation = wide("open");
        let target = wide(url);

        // SAFETY: 两个宽字符串均以 NUL 结尾，且在整个调用期间保持存活；
        // 其余参数传空指针是 ShellExecuteW 允许的用法。
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };

        // ShellExecuteW 约定：返回值 > 32 才表示成功，<= 32 是错误码
        let code = result as isize;
        if code <= 32 {
            return Err(format!(
                "无法打开系统浏览器（ShellExecuteW 返回码 {code}）。可手动复制授权地址访问：{url}"
            ));
        }

        Ok(())
    }

    #[cfg(not(windows))]
    {
        open::that(url).map_err(|e| format!("无法打开系统浏览器：{e}"))
    }
}

/// 取消正在进行的授权等待。用户在浏览器里关掉页面时，由前端调用。
#[tauri::command]
pub fn eve_cancel_login() {
    LOGIN_CANCELLED.store(true, Ordering::SeqCst);
}

/// 发起 EVE SSO 授权（PKCE），成功后返回角色信息与作用域。
/// 令牌由 Rust 侧加密写入本地数据库，不返回给前端。
#[tauri::command]
pub async fn eve_login(
    pool: tauri::State<'_, sqlx::SqlitePool>,
) -> Result<LoginResult, String> {
    let client_id = DEFAULT_CLIENT_ID;
    let redirect_uri = format!("http://127.0.0.1:{CALLBACK_PORT}/callback");

    let verifier = generate_verifier();
    let challenge = challenge_from_verifier(&verifier);
    let state = uuid::Uuid::new_v4().simple().to_string();

    // 上一轮等待（超时或取消）可能还没完全退出，短暂重试几次更稳妥
    LOGIN_CANCELLED.store(false, Ordering::SeqCst);
    let listener = bind_callback_port()?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("配置本地端口失败：{e}"))?;

    let auth_url = build_authorize_url(client_id, &redirect_uri, &state, &challenge);
    open_in_browser(&auth_url)?;

    let expected_state = state.clone();
    let code = tokio::task::spawn_blocking(move || wait_for_code(listener, &expected_state))
        .await
        .map_err(|e| format!("等待授权失败：{e}"))??;

    let token = exchange_code(client_id, &code, &verifier, &redirect_uri).await?;

    let refresh_token = token
        .refresh_token
        .ok_or_else(|| "EVE 未返回 refresh_token，无法保持长期登录".to_string())?;

    let (character_id, jwt_name, scopes) = parse_jwt_claims(&token.access_token)?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;

    let info = fetch_character_info(&http, character_id).await.ok();

    let corp_id = info.as_ref().and_then(|i| i.corporation_id);
    let alliance_id = info.as_ref().and_then(|i| i.alliance_id);

    let mut ids = Vec::new();
    if let Some(id) = corp_id {
        ids.push(id);
    }
    if let Some(id) = alliance_id {
        ids.push(id);
    }
    let names = resolve_names(&http, &ids).await;

    let name_of = |target: Option<i64>| -> Option<String> {
        let id = target?;
        names
            .iter()
            .find(|(name_id, _)| *name_id == id)
            .map(|(_, name)| name.clone())
    };

    let expires_at = (chrono_now_ms()) + token.expires_in.unwrap_or(1200) * 1000;

    save_tokens(
        pool.inner(),
        character_id,
        &token.access_token,
        &refresh_token,
        &scopes,
        expires_at,
    )
    .await?;

    Ok(LoginResult {
        character_id,
        name: info
            .as_ref()
            .map(|i| i.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or(jwt_name),
        corporation_id: corp_id,
        corporation_name: name_of(corp_id),
        alliance_id,
        alliance_name: name_of(alliance_id),
        birthday: info.as_ref().and_then(|i| i.birthday.clone()),
        security_status: info.as_ref().and_then(|i| i.security_status),
        scopes,
        expires_at,
    })
}

/// 解除授权：删除本地数据库中该角色的令牌记录
#[tauri::command]
pub async fn eve_logout(
    character_id: i64,
    pool: tauri::State<'_, sqlx::SqlitePool>,
) -> Result<(), String> {
    delete_tokens(pool.inner(), character_id).await
}

pub(crate) fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 用 refresh_token 换取新的 access_token，返回 (access_token, 过期时间毫秒)。
///
/// EVE 在刷新时会轮换 refresh_token，旧值随即失效，因此必须把新值写回凭据存储，
/// 否则下次刷新会拿到 invalid_grant。
pub(crate) async fn refresh_access_token(
    pool: &sqlx::SqlitePool,
    character_id: i64,
) -> Result<(String, i64), String> {
    let stored = load_tokens(pool, character_id)
        .await?
        .ok_or_else(|| "本地没有该角色的授权记录，请到个人中心重新授权".to_string())?;

    let refresh_token = stored.refresh_token.clone();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;

    let response = client
        .post(TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", DEFAULT_CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|e| format!("刷新令牌请求失败：{e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "刷新令牌失败（HTTP {}）：{}。请到个人中心重新授权该角色。",
            status.as_u16(),
            detail.chars().take(200).collect::<String>()
        ));
    }

    let token = response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("解析令牌响应失败：{e}"))?;

    // EVE 请求刷新时可能轮换 refresh_token，未返回新值则沿用旧值
    let new_refresh_token = token
        .refresh_token
        .clone()
        .unwrap_or_else(|| stored.refresh_token.clone());

    let expires_at = chrono_now_ms() + token.expires_in.unwrap_or(1200) * 1000;

    save_tokens(
        pool,
        character_id,
        &token.access_token,
        &new_refresh_token,
        &stored.scopes,
        expires_at,
    )
    .await?;

    Ok((token.access_token, expires_at))
}
