use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use tauri::Manager;

/// 打开与前端 tauri-plugin-sql 共用的本地数据库文件。
///
/// 路径必须与插件一致：插件使用 `app_config_dir()/eve.db`，
/// 两边指向同一个文件才能共享数据。
pub async fn connect(app: &tauri::AppHandle) -> Result<SqlitePool, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位应用配置目录：{e}"))?;

    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;

    let file = dir.join("eve.db");

    let options = SqliteConnectOptions::new()
        .filename(&file)
        .create_if_missing(true)
        // 前端是单连接、Rust 侧是连接池，WAL 能显著降低 "database is locked"
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(10))
        // 刻意不开启外键：授权流程中令牌先落库、角色记录随后由前端写入，
        // 若开启 eve_token → eve_character 的外键会直接失败。
        // 解绑时前端先调 eve_logout 删令牌，再删角色，不依赖级联。
        .foreign_keys(false);

    SqlitePoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(options)
        .await
        .map_err(|e| format!("打开本地数据库失败：{e}"))
}
