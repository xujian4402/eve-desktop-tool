use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use tauri::Manager;

/// 主密钥长度
const KEY_LEN: usize = 32;
/// 密钥文件名（与 eve.db 同目录）
const KEY_FILE_NAME: &str = "secret.key";

/// 密钥文件路径，由 `init` 在应用启动时写入
static KEY_FILE: OnceLock<PathBuf> = OnceLock::new();
/// 主密钥进程内缓存
static MASTER_KEY: OnceLock<[u8; KEY_LEN]> = OnceLock::new();

/// 初始化密钥文件位置。必须在使用任何加解密之前调用。
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位应用配置目录：{e}"))?;

    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;

    KEY_FILE
        .set(dir.join(KEY_FILE_NAME))
        .map_err(|_| "密钥模块重复初始化".to_string())?;

    Ok(())
}

fn key_path() -> Result<&'static Path, String> {
    KEY_FILE
        .get()
        .map(|path| path.as_path())
        .ok_or_else(|| "密钥模块未初始化".to_string())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> std::io::Result<()> {
    // Windows 下 %APPDATA% 默认仅当前用户可访问，不需要额外设置 ACL
    Ok(())
}

/// 读取或生成主密钥。
///
/// 刻意不使用系统凭据库（Keychain / Credential Manager）：
/// 开发模式下二进制签名每次构建都会变化，macOS 会把它当成不同的应用，
/// 反复弹出「想要使用钥匙串中的机密信息」并要求输入系统密码。
/// 改为同目录下的 0600 权限文件，换取无打扰的使用体验。
fn master_key() -> Result<[u8; KEY_LEN], String> {
    if let Some(key) = MASTER_KEY.get() {
        return Ok(*key);
    }

    let path = key_path()?;

    let key = if path.exists() {
        let encoded = std::fs::read_to_string(path).map_err(|e| format!("读取密钥文件失败：{e}"))?;
        let bytes = STANDARD
            .decode(encoded.trim().as_bytes())
            .map_err(|e| format!("密钥文件内容损坏：{e}"))?;

        if bytes.len() != KEY_LEN {
            return Err(format!(
                "密钥文件长度异常（{} 字节，应为 {KEY_LEN}）。删除 {} 后重新授权即可。",
                bytes.len(),
                path.display()
            ));
        }

        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&bytes);
        key
    } else {
        let mut key = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut key);

        std::fs::write(path, STANDARD.encode(key))
            .map_err(|e| format!("写入密钥文件失败：{e}"))?;
        restrict_permissions(path).map_err(|e| format!("设置密钥文件权限失败：{e}"))?;

        key
    };

    let _ = MASTER_KEY.set(key);
    Ok(*MASTER_KEY.get().unwrap_or(&key))
}

/// AES-256-GCM 加密，输出 `base64(nonce).base64(ciphertext)`
pub fn encrypt(plaintext: &str) -> Result<String, String> {
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("初始化加密器失败：{e}"))?;

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "加密失败".to_string())?;

    Ok(format!(
        "{}.{}",
        STANDARD.encode(nonce_bytes),
        STANDARD.encode(ciphertext)
    ))
}

/// 解密 `base64(nonce).base64(ciphertext)`
pub fn decrypt(payload: &str) -> Result<String, String> {
    let (nonce_b64, ciphertext_b64) = payload
        .split_once('.')
        .ok_or_else(|| "密文格式非法，应为 nonce.ciphertext".to_string())?;

    let nonce_bytes = STANDARD
        .decode(nonce_b64.as_bytes())
        .map_err(|e| format!("nonce 解码失败：{e}"))?;

    if nonce_bytes.len() != 12 {
        return Err("nonce 长度异常".into());
    }

    let ciphertext = STANDARD
        .decode(ciphertext_b64.as_bytes())
        .map_err(|e| format!("密文解码失败：{e}"))?;

    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("初始化加密器失败：{e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "解密失败：密钥不匹配或数据已损坏".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("明文不是合法 UTF-8：{e}"))
}
