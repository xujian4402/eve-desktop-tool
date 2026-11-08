//! 视觉预警：截取屏幕指定区域，检测「深红色」像素（EVE 总览里的敌对标记）。
//!
//! 参考 EVEAntiCollision 的实现：纯外部工具，只读取屏幕像素，不碰游戏内存。
//! 与它的差异：
//! - 区域、最小像素数、轮询间隔都可配
//! - 命中后带冷却，避免连续响铃
//! - 通过 Tauri 事件把结果推给前端，由前端播报

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// 预警线程运行标记
static RUNNING: AtomicBool = AtomicBool::new(false);
/// 代次：切换开关时递增，旧线程立即退出
static EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionConfig {
    /// 区域左上角屏幕坐标
    pub x: i32,
    pub y: i32,
    /// 区域宽高
    pub width: i32,
    pub height: i32,
    /// 至少多少个红色像素才算命中（抗噪点）
    pub min_pixels: u32,
    /// 轮询间隔（毫秒）
    pub interval_ms: u64,
    /// 命中后的冷却时间（毫秒），冷却期内不重复报警
    pub cooldown_ms: u64,
}

impl Default for VisionConfig {
    fn default() -> Self {
        Self {
            x: 200,
            y: 300,
            width: 100,
            height: 700,
            min_pixels: 12,
            interval_ms: 600,
            cooldown_ms: 3000,
        }
    }
}

/// 一次检测的结果
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VisionProbe {
    pub red_pixels: u32,
    pub total_pixels: u32,
    /// 是否达到 min_pixels 阈值
    pub hit: bool,
    /// 宽度或高度无效、截屏失败时为 false
    pub captured: bool,
    /// 区域预览（data:image/png;base64,...），截屏失败时为 None
    pub preview: Option<String>,
}

/// 命中事件
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VisionAlert {
    pub red_pixels: u32,
    /// 命中时间（unix 毫秒）
    pub at: i64,
}

/// 一台显示器在虚拟桌面中的位置
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// 显示器序号（0 起）
    pub index: usize,
    /// 设备名，如 DISPLAY1
    pub name: String,
    /// 虚拟桌面坐标（左上角，可能为负）
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// 是否主显示器
    pub primary: bool,
}

/// 列出所有显示器及其虚拟桌面坐标。
///
/// 多显示器时左边/上边的屏幕坐标可能为负，用户需要正确的绝对坐标才能框准区域。
#[tauri::command]
pub fn list_monitors() -> Vec<MonitorInfo> {
    #[cfg(windows)]
    {
        enumerate_monitors()
    }

    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

const MAX_SIDE: i32 = 4000;

fn validate(config: &VisionConfig) -> Result<(), String> {
    if config.width <= 0 || config.height <= 0 {
        return Err("截屏区域的宽高必须大于 0".to_string());
    }
    if config.width > MAX_SIDE || config.height > MAX_SIDE {
        return Err(format!("截屏区域过大（单边上限 {MAX_SIDE} 像素）"));
    }
    if config.interval_ms < 100 {
        return Err("轮询间隔不能小于 100ms".to_string());
    }
    Ok(())
}

/// 单次检测：截屏 + 统计红色像素 + 返回区域预览
#[tauri::command]
pub fn probe_vision_region(config: VisionConfig) -> Result<VisionProbe, String> {
    validate(&config)?;

    let Some(pixels) = capture_region(config.x, config.y, config.width, config.height) else {
        return Ok(VisionProbe {
            red_pixels: 0,
            total_pixels: 0,
            hit: false,
            captured: false,
            preview: None,
        });
    };

    let total = (config.width * config.height) as u32;
    let red = count_red(&pixels);
    let preview = make_preview(&pixels, config.width as usize, config.height as usize);

    Ok(VisionProbe {
        red_pixels: red,
        total_pixels: total,
        hit: red >= config.min_pixels,
        captured: true,
        preview,
    })
}

/// 启动视觉预警：后台线程按间隔截屏，命中即推送 `vision-alert`
#[tauri::command]
pub fn start_vision_watch(app: AppHandle, config: VisionConfig) -> Result<(), String> {
    validate(&config)?;

    RUNNING.store(false, Ordering::SeqCst);
    let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::sleep(Duration::from_millis(80));

    RUNNING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        // 红点消失后等待多久才判定「解除」，避免一帧抖动就停掉声音
        let clear_grace = Duration::from_millis(config.cooldown_ms.max(300));

        let mut alerting = false;
        let mut clear_since: Option<std::time::Instant> = None;

        while RUNNING.load(Ordering::SeqCst) && EPOCH.load(Ordering::SeqCst) == epoch {
            if let Some(pixels) = capture_region(config.x, config.y, config.width, config.height) {
                let red = count_red(&pixels);
                let hit = red >= config.min_pixels;

                if hit {
                    clear_since = None;

                    // 只在「进入告警」这一刻推一次，前端据此开始循环播放
                    if !alerting {
                        alerting = true;
                        let _ = app.emit(
                            "vision-alert",
                            VisionAlert {
                                red_pixels: red,
                                at: unix_millis(),
                            },
                        );
                    }
                } else if alerting {
                    // 红点消失：等一小段时间确认，避免抖动导致声音断续
                    match clear_since {
                        None => clear_since = Some(std::time::Instant::now()),
                        Some(since) if since.elapsed() >= clear_grace => {
                            alerting = false;
                            clear_since = None;
                            let _ = app.emit("vision-clear", ());
                        }
                        _ => {}
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(config.interval_ms));
        }

        // 线程退出（停止监控）时也通知前端静音
        if alerting {
            let _ = app.emit("vision-clear", ());
        }
    });

    Ok(())
}

/// 停止视觉预警
#[tauri::command]
pub fn stop_vision_watch() {
    RUNNING.store(false, Ordering::SeqCst);
    EPOCH.fetch_add(1, Ordering::SeqCst);
}

/// 视觉预警线程是否在运行（前端切菜单回来后用它校正开关状态）
#[tauri::command]
pub fn vision_watch_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// 预览最长边（像素）：区域再大也缩到这个尺寸，避免 IPC 传大图
const PREVIEW_MAX_SIDE: usize = 320;

/// 把 BGRA 截屏结果缩成 PNG data URL，供界面预览。
///
/// 用最近邻采样：预览只为「确认区域对准了」，不需要平滑插值。
fn make_preview(bgra: &[u8], width: usize, height: usize) -> Option<String> {
    use base64::Engine;
    use image::codecs::png::PngEncoder;
    use image::ImageEncoder;

    if width == 0 || height == 0 {
        return None;
    }

    let scale = (PREVIEW_MAX_SIDE as f32 / width.max(height) as f32).min(1.0);
    let out_w = ((width as f32 * scale).round() as usize).max(1);
    let out_h = ((height as f32 * scale).round() as usize).max(1);

    let mut rgba = vec![0u8; out_w * out_h * 4];

    for oy in 0..out_h {
        let sy = ((oy as f32 / scale) as usize).min(height - 1);

        for ox in 0..out_w {
            let sx = ((ox as f32 / scale) as usize).min(width - 1);

            let src = (sy * width + sx) * 4;
            let dst = (oy * out_w + ox) * 4;

            rgba[dst] = bgra[src + 2];
            rgba[dst + 1] = bgra[src + 1];
            rgba[dst + 2] = bgra[src];
            rgba[dst + 3] = 255;
        }
    }

    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            &rgba,
            out_w as u32,
            out_h as u32,
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
    Some(format!("data:image/png;base64,{encoded}"))
}

/// 统计深红色像素数量。
///
/// EVE 总览的敌对标记约 RGB(149, 18, 23)，这里用相对判定：
/// 红通道明显高于绿/蓝，且绿蓝都在低位。
fn count_red(pixels: &[u8]) -> u32 {
    let mut count = 0u32;

    for chunk in pixels.chunks_exact(4) {
        // GetDIBits 返回 BGRA
        let b = chunk[0];
        let g = chunk[1];
        let r = chunk[2];

        if r > 110 && g < 60 && b < 60 && r as i32 - g as i32 > 70 && r as i32 - b as i32 > 70 {
            count += 1;
        }
    }

    count
}

/* ============================================================
   Windows GDI 截屏
   ============================================================ */

#[cfg(windows)]
fn capture_region(x: i32, y: i32, width: i32, height: i32) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };

    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return None;
        }

        let mem = CreateCompatibleDC(screen);
        if mem.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen);
            return None;
        }

        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if bitmap.is_null() {
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            return None;
        }

        let old = SelectObject(mem, bitmap);

        // 目标区域可能部分在屏幕外：BitBlt 失败时返回 0，但仍继续读取（内容为空）
        let blt = BitBlt(mem, 0, 0, width, height, screen, x, y, SRCCOPY);

        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        // 负高度 = 自顶向下，避免图像上下颠倒
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;

        let mut buffer = vec![0u8; (width * height * 4) as usize];

        let copied = GetDIBits(
            mem,
            bitmap,
            0,
            height as u32,
            buffer.as_mut_ptr() as *mut c_void,
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(mem, old);
        DeleteObject(bitmap);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);

        if blt == 0 || copied == 0 {
            return None;
        }

        Some(buffer)
    }
}

#[cfg(not(windows))]
fn capture_region(_x: i32, _y: i32, _width: i32, _height: i32) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn enumerate_monitors() -> Vec<MonitorInfo> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
    };

    /// MONITORINFOF_PRIMARY，windows-sys 未导出该常量
    const MONITORINFOF_PRIMARY_DW: u32 = 1;

    unsafe extern "system" fn callback(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> i32 {
        unsafe {
            let list = &mut *(lparam as *mut Vec<MonitorInfo>);

            let mut info: MONITORINFOEXW = std::mem::zeroed();
            info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;

            if GetMonitorInfoW(monitor, &mut info as *mut _ as *mut MONITORINFO) != 0 {
                let rect = info.monitorInfo.rcMonitor;

                let device: String = info
                    .szDevice
                    .iter()
                    .take_while(|code| **code != 0)
                    .map(|code| *code as u8 as char)
                    .collect();

                list.push(MonitorInfo {
                    index: list.len(),
                    // 去掉 Win32 的 `\\.\` 前缀
                    name: device.replace("\\\\.\\", ""),
                    x: rect.left,
                    y: rect.top,
                    width: rect.right - rect.left,
                    height: rect.bottom - rect.top,
                    primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY_DW != 0,
                });
            }
        }

        1
    }

    let mut list: Vec<MonitorInfo> = Vec::new();

    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(callback),
            &mut list as *mut _ as LPARAM,
        );
    }

    // 主屏优先，其余按横向坐标排序
    list.sort_by(|a, b| b.primary.cmp(&a.primary).then(a.x.cmp(&b.x)));

    for (index, item) in list.iter_mut().enumerate() {
        item.index = index;
    }

    list
}
