// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod crypto;
mod db;
mod esi;
mod eve_auth;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// 托盘是否创建成功。失败时不能拦截关闭，否则窗口被隐藏后将无法恢复。
static TRAY_READY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "market_init",
            sql: include_str!("../migrations/0001_market_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "token_store",
            sql: include_str!("../migrations/0002_token_store.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "market_structure_flag",
            sql: include_str!("../migrations/0003_market_structure_flag.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "market_groups",
            sql: include_str!("../migrations/0004_market_groups.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "order_lookup_index",
            sql: include_str!("../migrations/0005_order_lookup_index.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        // 单实例插件必须最先注册：重复启动时聚焦已有窗口，
        // 避免 Windows 上多次双击导致端口占用 / SQLite 并发写冲突。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:eve.db", migrations)
                .build(),
        )
        .setup(|app| {
            // 密钥文件位置必须在使用任何加解密之前确定
            crypto::init(app.handle()).map_err(std::io::Error::other)?;

            // Rust 侧连接池：与前端 tauri-plugin-sql 共用同一个 eve.db，
            // 用于把加密后的令牌存进本地数据库。
            let pool = tauri::async_runtime::block_on(db::connect(app.handle()))
                .map_err(std::io::Error::other)?;
            app.manage(pool);

            TRAY_READY.store(tray::create(app.handle()), Ordering::SeqCst);
            Ok(())
        })
        // 关闭按钮最小化到托盘：拦截主窗口关闭，改为隐藏。
        // 真正退出走托盘菜单的「退出」，它调用 app.exit() 不会经过这里。
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 托盘不可用时放行关闭，避免窗口藏起来后无法找回
                if TRAY_READY.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            eve_auth::eve_login,
            eve_auth::eve_cancel_login,
            eve_auth::eve_logout,
            esi::resolve_structure,
            esi::sync_structure_orders,
            esi::sync_character_orders,
            esi::sync_character_structures,
            esi::fetch_character_assets,
            esi::fetch_region_type_orders,
            esi::sync_market_groups,
            esi::seed_market_groups
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // macOS：窗口隐藏后点击 Dock 图标应恢复窗口
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show_main_window(_app_handle);
            }
        });
}
