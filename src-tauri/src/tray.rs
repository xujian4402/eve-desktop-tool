use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// 显示并聚焦主窗口（从托盘 / Dock 恢复）
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 创建托盘图标。返回是否创建成功——调用方据此决定能否拦截窗口关闭。
pub fn create(app: &AppHandle) -> bool {
    match build_tray(app) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("[tray] 托盘图标创建失败：{error}");
            false
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("EVE 工业助手")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            // 走 exit 而不是关闭窗口，避免被 CloseRequested 拦截成"隐藏"
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // macOS 菜单栏图标的惯例是左键直接展开菜单；
    // Windows 托盘区惯例是左键唤起窗口、右键出菜单。
    #[cfg(target_os = "macos")]
    {
        builder = builder.show_menu_on_left_click(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.show_menu_on_left_click(false);
    }

    // 优先用窗口图标；取不到时回退到编译期嵌入的 png，
    // 否则托盘在 Windows 上会是一个空白占位，用户根本找不到入口。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    } else if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")) {
        builder = builder.icon(icon);
    } else {
        return Err(tauri::Error::AssetNotFound(
            "托盘图标缺失（icons/32x32.png）".into(),
        ));
    }

    builder.build(app)?;

    Ok(())
}
