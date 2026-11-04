//! 本地日志实时监控。
//!
//! 数据来源（EVE 客户端自动写入，无需授权）：
//!   Documents/EVE/logs/Gamelogs/*.txt   战斗日志
//!   Documents/EVE/logs/Chatlogs/*.txt   聊天日志
//!
//! 战斗只跟随「当前正在写入的那一个」日志文件：多开角色或客户端重启时
//! 会自动切到最新文件，但只看监控启动之后写入的内容，不回放历史。
//! 空闲时轮询降速，命中延迟仍保持在 300ms 级。

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// 是否正在监控（全局只允许一个实例）
static RUNNING: AtomicBool = AtomicBool::new(false);

/// 运行代次：每次启动 +1，旧线程看到代次变化立即退出，
/// 因此「重复启动」不会留下两个线程同时推送事件。
static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn offsets() -> &'static Mutex<HashMap<PathBuf, u64>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 当前锁定的战斗日志文件
fn battle_file() -> &'static Mutex<Option<PathBuf>> {
    static FILE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    FILE.get_or_init(|| Mutex::new(None))
}

/// 监控启动时刻：用于判断新文件是否「本次会话产生的」
fn started_at() -> &'static Mutex<Option<SystemTime>> {
    static AT: OnceLock<Mutex<Option<SystemTime>>> = OnceLock::new();
    AT.get_or_init(|| Mutex::new(None))
}

/// 单轮最多处理的行数：客户端一次性 flush 大量历史时只取尾部
const MAX_LINES_PER_ROUND: usize = 500;

/// 单轮最多推送多少条聊天预览（「频道内容」面板用）
const MAX_CHAT_PREVIEW_PER_ROUND: usize = 40;

/// 启动时回放每个频道最近的多少条消息
const CHAT_REPLAY_LINES: usize = 20;

/// 聊天文件参与扫描的时间窗口：太短的窗口会让「安静频道」被漏掉
const CHAT_FILE_MAX_AGE_SECS: u64 = 3600;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorConfig {
    /// EVE 日志根目录（通常是 Documents/EVE/logs）
    pub log_dir: String,
    /// 战斗监控：目标名关键字（模糊匹配，大小写不敏感）
    pub battle_keywords: Vec<String>,
    /// 预警监控：要监听的聊天频道名（文件名前缀）
    pub chat_channels: Vec<String>,
    /// 预警监控：聊天内容里要匹配的星系名
    pub chat_keywords: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorHit {
    /// "battle" | "chat"
    pub kind: String,
    /// 日志里的时间字符串
    pub time: String,
    /// 命中的关键字
    pub keyword: String,
    /// 目标名（战斗）或频道名（聊天）
    pub target: String,
    /// 原始行（已去掉颜色标签）
    pub raw: String,
    /// 来源文件名
    pub source: String,
}

/// 自动定位 EVE 日志根目录
#[tauri::command]
pub fn resolve_eve_log_dir() -> Result<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户目录".to_string())?;

    let path = Path::new(&home).join("Documents").join("EVE").join("logs");

    if !path.exists() {
        return Err(format!("未找到 EVE 日志目录：{}", path.display()));
    }

    Ok(path.to_string_lossy().to_string())
}

/// 读取声音文件（前端用 Blob 播放，避免依赖 asset 协议）
#[tauri::command]
pub fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("读取音频失败：{e}"))
}

/// 启动监控。
///
/// 幂等：若已有线程在跑（例如前端热更新后状态丢了），先让它退出再重新启动，
/// 不会报「已在运行」，也不会出现两个线程同时推送事件。
#[tauri::command]
pub fn start_monitor(app: AppHandle, config: MonitorConfig) -> Result<(), String> {
    if config.battle_keywords.is_empty() && config.chat_keywords.is_empty() {
        return Err("请至少填写一个监控关键字".to_string());
    }

    // 预警频道先校验：填错频道名时直接告诉用户当前日志里有哪些频道
    if !config.chat_keywords.is_empty() {
        validate_channels(&config.log_dir, &config.chat_channels)?;
    }

    // 让旧线程退出：RUNNING 置 false + 代次 +1
    RUNNING.store(false, Ordering::SeqCst);
    let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;

    // 给旧线程一个调度窗口，避免新旧线程短暂并存
    std::thread::sleep(Duration::from_millis(150));

    // 重置状态：上一次运行的偏移与文件锁全部作废
    offsets().lock().unwrap().clear();
    *battle_file().lock().unwrap() = None;
    *started_at().lock().unwrap() = Some(SystemTime::now());

    // 聊天日志「从末尾开始」：命中只针对启动后的新消息
    prime_chat_offsets(&config.log_dir);

    // 启动瞬间把最近几条聊天推给「频道内容」面板（仅展示，不触发提醒）
    emit_chat_preview(&app, &config);

    RUNNING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        let mut idle_rounds: u32 = 0;

        while RUNNING.load(Ordering::SeqCst) && EPOCH.load(Ordering::SeqCst) == epoch {
            let active = tick(&app, &config);

            if active {
                idle_rounds = 0;
            } else {
                idle_rounds = idle_rounds.saturating_add(1);
            }

            // 有新增行时 150ms 极速响应；连续约 2 秒无新行才降到 400ms，
            // 保证聊天消息也能在 0.5 秒内触发
            let delay = if idle_rounds > 12 { 400 } else { 150 };
            std::thread::sleep(Duration::from_millis(delay));
        }
    });

    Ok(())
}

/// 停止监控：置停止标记并推进代次，让线程立刻退出（不必等本轮 sleep 结束）
#[tauri::command]
pub fn stop_monitor() {
    RUNNING.store(false, Ordering::SeqCst);
    EPOCH.fetch_add(1, Ordering::SeqCst);
}

/* ============================================================
   内部实现
   ============================================================ */

/// 列出 Chatlogs 目录里出现过的频道名（文件名第一个下划线之前的部分）
fn available_channels(log_dir: &str) -> Vec<String> {
    let dir = Path::new(log_dir).join("Chatlogs");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut set = std::collections::BTreeSet::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".txt") {
            continue;
        }
        let channel = channel_of(&name);
        if !channel.is_empty() {
            set.insert(channel);
        }
    }

    set.into_iter().collect()
}

/// 从文件名里取出频道名。
///
/// 文件名格式：`{频道名}_{YYYYMMDD}_{HHMMSS}[_{角色ID}].txt`
/// 频道名本身可能带下划线（如「D.C FAX_后勤航」），所以从右往左剥时间戳。
fn channel_of(file_name: &str) -> String {
    let stem = file_name.trim_end_matches(".txt");
    let parts: Vec<&str> = stem.split('_').collect();
    let mut end = parts.len();

    let is_digits = |value: &str| {
        !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
    };

    // 可选的角色 ID
    if end > 0 && is_digits(parts[end - 1]) && parts[end - 1].len() >= 6 {
        end -= 1;
    }
    // HHMMSS
    if end > 0 && parts[end - 1].len() == 6 && is_digits(parts[end - 1]) {
        end -= 1;
    }
    // YYYYMMDD
    if end > 0 && parts[end - 1].len() == 8 && is_digits(parts[end - 1]) {
        end -= 1;
    }

    parts[..end].join("_")
}

/// 校验配置的频道名是否存在于日志中；不存在时返回可用频道列表
fn validate_channels(log_dir: &str, channels: &[String]) -> Result<(), String> {
    let available = available_channels(log_dir);
    if available.is_empty() {
        return Err(format!(
            "未找到聊天日志目录或目录为空：{}",
            Path::new(log_dir).join("Chatlogs").display()
        ));
    }

    let missing: Vec<String> = channels
        .iter()
        .filter(|channel| {
            let target = channel.to_lowercase();
            !available
                .iter()
                .any(|item| item.to_lowercase() == target)
        })
        .cloned()
        .collect();

    if missing.is_empty() {
        return Ok(());
    }

    let preview: Vec<String> = available.iter().take(12).cloned().collect();

    Err(format!(
        "未找到聊天频道「{}」；当前日志中的频道有：{}（共 {} 个）",
        missing.join("、"),
        preview.join("、"),
        available.len()
    ))
}

/// 聊天日志：把已有文件的读取位置设到末尾。
///
/// 这样命中只针对「启动之后」的新消息，不会因为回放历史而误报。
/// 启动瞬间想看到最近内容，由 `emit_chat_preview` 单独推送（不参与命中）。
fn prime_chat_offsets(log_dir: &str) {
    let dir = Path::new(log_dir).join("Chatlogs");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };

    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            offsets().lock().unwrap().insert(entry.path(), meta.len());
        }
    }
}

/// 启动时把最近若干条聊天推给「频道内容」面板。
///
/// 只做展示，不判断关键字，也不推进读取偏移，因此不会造成历史误报。
fn emit_chat_preview(app: &AppHandle, config: &MonitorConfig) {
    if config.chat_channels.is_empty() {
        return;
    }

    let dir = Path::new(&config.log_dir).join("Chatlogs");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };

    let now = SystemTime::now();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("txt") {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let lower_name = name.to_lowercase();

        let Some(channel) = config.chat_channels.iter().find(|channel| {
            lower_name.starts_with(&format!("{}_", channel.to_lowercase()))
        }) else {
            continue;
        };

        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };

        if now.duration_since(modified).unwrap_or_default()
            > Duration::from_secs(CHAT_FILE_MAX_AGE_SECS)
        {
            continue;
        }

        for line in tail_lines(&path, CHAT_REPLAY_LINES) {
            let plain = strip_tags(&line);
            let Some((head, message)) = plain.split_once(" > ") else {
                continue;
            };

            let speaker = head.split(" ] ").nth(1).unwrap_or("").trim().to_string();

            let _ = app.emit(
                "chat-line",
                ChatLine {
                    channel: channel.clone(),
                    time: parse_time(&plain),
                    speaker,
                    message: message.trim().to_string(),
                    raw: plain,
                },
            );
        }
    }
}

/// 跑一轮扫描，返回是否有新行被读取
fn tick(app: &AppHandle, config: &MonitorConfig) -> bool {
    let root = Path::new(&config.log_dir);
    let mut active = false;

    if !config.battle_keywords.is_empty()
        && scan_battle(app, &root.join("Gamelogs"), config)
    {
        active = true;
    }

    if !config.chat_keywords.is_empty()
        && !config.chat_channels.is_empty()
        && scan_chat(app, &root.join("Chatlogs"), config)
    {
        active = true;
    }

    active
}

/// 目录内最近修改的 txt 文件（最多 8 个，按修改时间倒序）
fn recent_files(dir: &Path, max_age: Duration) -> Vec<(PathBuf, String)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let now = SystemTime::now();
    let mut files: Vec<(PathBuf, SystemTime)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("txt") {
            continue;
        }

        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };

        if now.duration_since(modified).unwrap_or_default() > max_age {
            continue;
        }

        files.push((path, modified));
    }

    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(8);

    files
        .into_iter()
        .map(|(path, _)| {
            let name = path
                .file_name()
                .map(|item| item.to_string_lossy().to_string())
                .unwrap_or_default();
            (path, name)
        })
        .collect()
}

/* ---------------- 战斗：只跟随最新文件 ---------------- */

fn scan_battle(app: &AppHandle, dir: &Path, config: &MonitorConfig) -> bool {
    let Some(path) = pick_battle_file(dir) else {
        return false;
    };

    let source = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();

    let lines = read_new_lines(&path);
    if lines.is_empty() {
        return false;
    }

    for line in &lines {
        handle_battle_line(app, line, &source, config);
    }

    true
}

/// 选出当前正在写入的战斗日志，并在必要时切换跟踪目标。
///
/// 切换判定：目录里出现 mtime 更新的文件。
/// 新文件若是监控启动之后创建的，从头读（抓住刚进战斗的记录）；
/// 否则跳到末尾（老会话的历史不重复）。
fn pick_battle_file(dir: &Path) -> Option<PathBuf> {
    // 快速路径：当前文件 30 秒内仍在写入，直接复用，省掉每轮目录遍历
    {
        let current = battle_file().lock().unwrap();
        if let Some(path) = current.as_ref() {
            if let Ok(meta) = fs::metadata(path) {
                if let Ok(modified) = meta.modified() {
                    if modified.elapsed().unwrap_or_default() < Duration::from_secs(30) {
                        return Some(path.clone());
                    }
                }
            }
        }
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };

    let mut latest: Option<(PathBuf, SystemTime)> = None;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("txt") {
            continue;
        }

        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };

        let newer = latest
            .as_ref()
            .map(|(_, best)| modified > *best)
            .unwrap_or(true);

        if newer {
            latest = Some((path, modified));
        }
    }

    let (path, _) = latest?;

    let mut current = battle_file().lock().unwrap();
    if current.as_ref() == Some(&path) {
        return Some(path);
    }

    // 判断是不是本次监控期间新建的会话文件
    let fresh = fs::metadata(&path)
        .and_then(|meta| meta.created())
        .map(|created| {
            started_at()
                .lock()
                .unwrap()
                .map(|start| created >= start)
                .unwrap_or(false)
        })
        .unwrap_or(false);

    let initial_offset = if fresh {
        0
    } else {
        fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0)
    };

    {
        // 只更新战斗文件的偏移；聊天文件的偏移必须保留，
        // 否则会被当成「新文件」从头读或跳过内容
        let mut map = offsets().lock().unwrap();
        map.insert(path.clone(), initial_offset);
    }

    *current = Some(path.clone());
    Some(path)
}

/* ---------------- 预警：按频道跟随 ---------------- */

fn scan_chat(app: &AppHandle, dir: &Path, config: &MonitorConfig) -> bool {
    let mut active = false;

    for (path, source) in recent_files(dir, Duration::from_secs(CHAT_FILE_MAX_AGE_SECS)) {
        // 频道文件名格式：频道名_日期_时间_角色ID.txt
        // 比较时忽略大小写：Windows 文件名本身不区分大小写，配置里手打的大小写不应影响匹配
        let lower_source = source.to_lowercase();
        let Some(channel) = config.chat_channels.iter().find(|channel| {
            lower_source.starts_with(&format!("{}_", channel.to_lowercase()))
        }) else {
            continue;
        };

        // 每轮最多推送 40 条预览，避免启动瞬间把历史刷给前端
        let mut preview_budget = MAX_CHAT_PREVIEW_PER_ROUND;

        for line in read_new_lines(&path) {
            handle_chat_line(app, &line, &source, channel, config, &mut preview_budget);
            active = true;
        }
    }

    active
}

/// 日志文件的文本编码。
///
/// EVE 大部分日志是 UTF-8（带 BOM），但**部分频道**（如新建的私人频道）
/// 会写成 UTF-16LE，按 UTF-8 读会得到带 `\0` 的乱码，`> ` 分隔符永远匹配不上。
#[derive(Clone, Copy, PartialEq)]
enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

/// 读取文件头判断编码；读不到时按 UTF-8 处理
fn detect_encoding(path: &Path) -> TextEncoding {
    let mut head = [0u8; 2];
    let Ok(mut file) = File::open(path) else {
        return TextEncoding::Utf8;
    };
    if file.read_exact(&mut head).is_err() {
        return TextEncoding::Utf8;
    }

    if head == [0xFF, 0xFE] {
        TextEncoding::Utf16Le
    } else if head == [0xFE, 0xFF] {
        TextEncoding::Utf16Be
    } else {
        TextEncoding::Utf8
    }
}

/// 按指定编码解码字节
fn decode_bytes(bytes: &[u8], encoding: TextEncoding) -> String {
    match encoding {
        TextEncoding::Utf8 => String::from_utf8_lossy(bytes).to_string(),
        TextEncoding::Utf16Le => {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        }
        TextEncoding::Utf16Be => {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        }
    }
}

/// 找到「最后一个完整行」结束的字节位置
fn last_line_end(bytes: &[u8], encoding: TextEncoding) -> Option<usize> {
    match encoding {
        TextEncoding::Utf8 => bytes.iter().rposition(|&byte| byte == b'\n').map(|i| i + 1),
        TextEncoding::Utf16Le => {
            let mut end = None;
            let mut index = 0;
            while index + 1 < bytes.len() {
                if bytes[index] == 0x0A && bytes[index + 1] == 0x00 {
                    end = Some(index + 2);
                }
                index += 2;
            }
            end
        }
        TextEncoding::Utf16Be => {
            let mut end = None;
            let mut index = 0;
            while index + 1 < bytes.len() {
                if bytes[index] == 0x00 && bytes[index + 1] == 0x0A {
                    end = Some(index + 2);
                }
                index += 2;
            }
            end
        }
    }
}

/// 读取文件新增的完整行；末尾不完整的行留到下一轮。
///
/// 未登记的文件从 0 开始读：启动时已由 `prime_chat_offsets` 把当时的文件
/// 登记为末尾，因此「未登记」只可能是启动后新建的会话文件，必须从头读，
/// 否则会把新会话的第一批消息整段跳过。
fn read_new_lines(path: &Path) -> Vec<String> {
    let Ok(meta) = fs::metadata(path) else {
        return Vec::new();
    };
    let len = meta.len();
    let encoding = detect_encoding(path);

    let mut map = offsets().lock().unwrap();
    let entry = map.entry(path.to_path_buf()).or_insert(0);

    // 文件被截断（客户端重启新建同名文件）
    if len < *entry {
        *entry = 0;
    }

    // UTF-16 的偏移必须落在双字节边界上
    if encoding != TextEncoding::Utf8 && *entry % 2 != 0 {
        *entry -= 1;
    }

    if len == *entry {
        return Vec::new();
    }

    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    if file.seek(SeekFrom::Start(*entry)).is_err() {
        return Vec::new();
    }

    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return Vec::new();
    }

    // 只消费到最后一个换行，避免把写到一半的行当成完整行
    let Some(complete_len) = last_line_end(&buffer, encoding) else {
        return Vec::new();
    };

    *entry += complete_len as u64;

    let text = decode_bytes(&buffer[..complete_len], encoding);
    let mut lines: Vec<String> = text
        .lines()
        .map(|line| line.to_string())
        .filter(|line| !line.trim().is_empty())
        .collect();

    // 兜底：单轮只处理尾部若干行，防止一次 flush 把历史全部推给前端
    if lines.len() > MAX_LINES_PER_ROUND {
        lines = lines.split_off(lines.len() - MAX_LINES_PER_ROUND);
    }

    lines
}

/// 去掉 EVE 日志里的颜色 / 字号标签
fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;

    for ch in input.chars() {
        match ch {
            // EVE 客户端会在部分行首写入 BOM，留着会让时间解析失败
            '\u{feff}' => {}
            '<' => in_tag = true,
            // 只有在标签内部时 `>` 才是结束符；聊天行里的 `发送者 > 消息`
            // 那个 `>` 必须原样保留，否则整行无法按 ` > ` 拆分
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }

    out
}

/// 从 `[ 2026.11.04 09:03:22 ]` 里取时间
fn parse_time(plain: &str) -> String {
    plain
        .strip_prefix("[ ")
        .and_then(|rest| rest.split(" ] ").next())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn contains_keyword(haystack: &str, keyword: &str) -> bool {
    haystack
        .to_lowercase()
        .contains(&keyword.to_lowercase())
}

/// 战斗行：只处理「对」造成的伤害（英文客户端为 to）
fn handle_battle_line(app: &AppHandle, line: &str, source: &str, config: &MonitorConfig) {
    if !line.contains("(combat)") {
        return;
    }

    let plain = strip_tags(line);

    let Some(target_part) = plain
        .split(" 对 ")
        .nth(1)
        .or_else(|| plain.split(" to ").nth(1))
    else {
        return;
    };

    // 目标段格式：`目标名 - 武器 - 命中`
    let target = target_part
        .split(" - ")
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('*')
        .to_string();

    if target.is_empty() {
        return;
    }

    let hit_keyword = config
        .battle_keywords
        .iter()
        .find(|keyword| !keyword.trim().is_empty() && contains_keyword(&target, keyword));

    let Some(keyword) = hit_keyword else { return };

    let hit = MonitorHit {
        kind: "battle".to_string(),
        time: parse_time(&plain),
        keyword: keyword.clone(),
        target,
        raw: plain,
        source: source.to_string(),
    };

    let _ = app.emit("monitor-hit", hit);
}

/// 诊断报告：一次只读扫描的结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatScanFile {
    pub file: String,
    pub channel: String,
    /// 频道名是否匹配配置
    pub matched_channel: bool,
    /// 文件是否在时间窗口内
    pub in_window: bool,
    /// 实际读取并参与匹配的行数
    pub lines_scanned: usize,
    /// 成功按 ` > ` 拆出消息的行数
    pub lines_parsed: usize,
    /// 最后 50 行里命中的条数
    pub hit_count: usize,
    /// 命中样例（最多 3 条）
    pub samples: Vec<String>,
    /// 未命中时也返回几条消息样本，用于确认解析是否正常
    pub preview: Vec<String>,
    /// 最后一行原文（截断 200 字符），用于确认分隔符
    pub raw_sample: String,
    /// 最后一行是否成功解析出「发送者 > 消息」
    pub last_parsed: bool,
    /// 最后一行解析出的时间
    pub last_time: String,
    /// 最后一行解析出的发送者
    pub last_speaker: String,
    /// 最后一行解析出的消息正文
    pub last_message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatScanReport {
    pub log_dir: String,
    /// 本次扫描实际使用的频道配置
    pub channels: Vec<String>,
    /// 本次扫描实际使用的关键字配置
    pub keywords: Vec<String>,
    pub files: Vec<ChatScanFile>,
    pub total_hits: usize,
}

/// 只读诊断：立即扫描一次聊天日志，返回「哪些文件被看到、命中几条」。
///
/// 不改动运行中的读取偏移，可随时点，用来定位「为什么没命中」。
#[tauri::command]
pub fn scan_chat_once(config: MonitorConfig) -> Result<ChatScanReport, String> {
    let dir = Path::new(&config.log_dir).join("Chatlogs");

    if !dir.exists() {
        return Err(format!("聊天日志目录不存在：{}", dir.display()));
    }

    let entries = fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{e}"))?;
    let now = SystemTime::now();

    let mut files: Vec<(PathBuf, String, String, SystemTime)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("txt") {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let channel = channel_of(&name);

        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };

        files.push((path, name, channel, modified));
    }

    // 最近修改的优先，最多看 12 个，避免报告过长
    files.sort_by(|a, b| b.3.cmp(&a.3));
    files.truncate(12);

    let mut reports = Vec::new();
    let mut total_hits = 0;

    for (path, name, channel, modified) in files {
        let in_window = now.duration_since(modified).unwrap_or_default()
            <= Duration::from_secs(CHAT_FILE_MAX_AGE_SECS);

        let matched_channel = config
            .chat_channels
            .iter()
            .any(|item| item.to_lowercase() == channel.to_lowercase());

        let mut hit_count = 0;
        let mut lines_scanned = 0;
        let mut lines_parsed = 0;
        let mut samples = Vec::new();
        let mut preview = Vec::new();
        let mut raw_sample = String::new();
        let mut last_parsed = false;
        let mut last_time = String::new();
        let mut last_speaker = String::new();
        let mut last_message = String::new();

        if matched_channel {
            for line in tail_lines(&path, 50) {
                lines_scanned += 1;
                let plain = strip_tags(&line);
                // 无论能否解析都留一份原文，方便确认分隔符是否一致
                raw_sample = plain.chars().take(200).collect();

                let Some((head, message)) = plain.split_once(" > ") else {
                    continue;
                };

                lines_parsed += 1;
                last_parsed = true;
                last_time = parse_time(&plain);
                last_speaker = head
                    .split(" ] ")
                    .nth(1)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                last_message = message.trim().to_string();

                if preview.len() < 3 {
                    preview.push(message.trim().to_string());
                }

                let hit = config.chat_keywords.iter().any(|keyword| {
                    !keyword.trim().is_empty() && contains_keyword(message, keyword)
                });

                if hit {
                    hit_count += 1;
                    if samples.len() < 3 {
                        samples.push(message.trim().to_string());
                    }
                }
            }
        }

        total_hits += hit_count;

        reports.push(ChatScanFile {
            file: name,
            channel,
            matched_channel,
            in_window,
            lines_scanned,
            lines_parsed,
            hit_count,
            samples,
            preview,
            raw_sample,
            last_parsed,
            last_time,
            last_speaker,
            last_message,
        });
    }

    Ok(ChatScanReport {
        log_dir: dir.display().to_string(),
        channels: config.chat_channels.clone(),
        keywords: config.chat_keywords.clone(),
        files: reports,
        total_hits,
    })
}

/// 读取文件最后 n 行（聊天文件很小，直接全读）
fn tail_lines(path: &Path, n: usize) -> Vec<String> {
    let Ok(content) = fs::read(path) else {
        return Vec::new();
    };

    let text = decode_bytes(&content, detect_encoding(path));
    let all: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let start = all.len().saturating_sub(n);

    all[start..].iter().map(|line| line.to_string()).collect()
}

/// 聊天预览行：不管是否命中关键字都推给前端，用于「频道内容」面板
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatLine {
    /// 频道名（文件名前缀）
    pub channel: String,
    /// 日志时间
    pub time: String,
    /// 发送者
    pub speaker: String,
    /// 消息正文
    pub message: String,
    /// 去标签后的整行
    pub raw: String,
}

/// 聊天行：先推送预览，再匹配消息内容里的关键字
fn handle_chat_line(
    app: &AppHandle,
    line: &str,
    source: &str,
    channel: &str,
    config: &MonitorConfig,
    preview_budget: &mut usize,
) {
    let plain = strip_tags(line);

    // `[ 时间 ] 发送者 > 消息`
    let Some((head, message)) = plain.split_once(" > ") else {
        return;
    };

    if message.trim().is_empty() {
        return;
    }

    // 预览：把频道内容实时推给前端（限流，避免一次刷太多）
    if *preview_budget > 0 {
        *preview_budget -= 1;

        // head 形如 `[ 2026.11.04 16:31:03 ] jack Hamu-kuv`
        let speaker = head
            .split(" ] ")
            .nth(1)
            .unwrap_or("")
            .trim()
            .to_string();

        let _ = app.emit(
            "chat-line",
            ChatLine {
                channel: channel.to_string(),
                time: parse_time(&plain),
                speaker,
                message: message.trim().to_string(),
                raw: plain.clone(),
            },
        );
    }

    let hit_keyword = config
        .chat_keywords
        .iter()
        .find(|keyword| !keyword.trim().is_empty() && contains_keyword(message, keyword));

    let Some(keyword) = hit_keyword else { return };

    let hit = MonitorHit {
        kind: "chat".to_string(),
        time: parse_time(&plain),
        keyword: keyword.clone(),
        target: channel.to_string(),
        raw: plain,
        source: source.to_string(),
    };

    let _ = app.emit("monitor-hit", hit);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_bom_and_color_tags() {
        let line = "\u{feff}[ 2026.11.04 16:47:26 ] <color=0xff00ffff>jack Hamu-kuv</color> > <color=0xffffffff>test monitor";
        let plain = strip_tags(line);
        assert_eq!(
            plain,
            "[ 2026.11.04 16:47:26 ] jack Hamu-kuv > test monitor"
        );
        assert_eq!(parse_time(&plain), "2026.11.04 16:47:26");

        let (_, message) = plain.split_once(" > ").expect("should split");
        assert_eq!(message, "test monitor");
        assert!(contains_keyword(message, "test monitor"));
    }

    #[test]
    fn channel_name_from_file() {
        assert_eq!(
            channel_of("军团_20261104_131004_2124109194.txt"),
            "军团"
        );
        assert_eq!(
            channel_of("southeast.imperium_20261104_131004_2124109194.txt"),
            "southeast.imperium"
        );
        assert_eq!(
            channel_of("D.C FAX_后勤航_20261104_131004_2124109194.txt"),
            "D.C FAX_后勤航"
        );
    }

    #[test]
    fn detects_keyword_case_insensitively() {
        assert!(contains_keyword("TEST MONITOR", "test monitor"));
        assert!(contains_keyword("test monitor 分析", "test monitor"));
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::*;

    #[test]
    fn decodes_utf16le_chat_line() {
        let text = "[ 2026.11.04 17:07:21 ] jack Hamu-kuv > test monitor\n";
        let mut bytes = Vec::new();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }

        let end = last_line_end(&bytes, TextEncoding::Utf16Le).expect("newline");
        assert_eq!(end, bytes.len());

        let decoded = decode_bytes(&bytes[..end], TextEncoding::Utf16Le);
        let line = decoded.lines().next().expect("line");
        let plain = strip_tags(line);
        let (_, message) = plain.split_once(" > ").expect("split");
        assert_eq!(message, "test monitor");
        assert!(contains_keyword(message, "test monitor"));
    }

    #[test]
    fn decodes_utf16be_chat_line() {
        let text = "[ 2026.11.04 17:07:21 ] jack Hamu-kuv > test monitor\n";
        let mut bytes = Vec::new();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }

        let end = last_line_end(&bytes, TextEncoding::Utf16Be).expect("newline");
        let decoded = decode_bytes(&bytes[..end], TextEncoding::Utf16Be);
        let plain = strip_tags(decoded.lines().next().expect("line"));
        let (_, message) = plain.split_once(" > ").expect("split");
        assert_eq!(message, "test monitor");
    }
}
