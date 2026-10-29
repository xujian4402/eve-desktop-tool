-- ============================================================
-- 令牌落库：把 refresh_token 从系统凭据库迁移到本地数据库
--
-- 加密策略（参考 eve-faceless-next 的 sys_user_character_token）：
--   * access_token / refresh_token 均以 AES-256-GCM 加密后存储
--   * 主密钥由应用随机生成，保存于系统凭据库（macOS Keychain /
--     Windows Credential Manager），不落数据库、不进配置文件
--   * 密文格式：base64(nonce).base64(ciphertext)
--
-- 因此数据库文件被拷走也无法直接使用其中的令牌。
-- ============================================================

-- refresh_token 密文
ALTER TABLE eve_token ADD COLUMN refresh_token_enc TEXT;

-- 令牌最近一次成功刷新的时间
ALTER TABLE eve_token ADD COLUMN refreshed_at INTEGER;

-- 按角色查令牌
CREATE INDEX IF NOT EXISTS idx_eve_token_expires
  ON eve_token(expires_at);
