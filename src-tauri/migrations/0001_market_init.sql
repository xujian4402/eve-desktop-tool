-- ============================================================
-- 市场模块初始表结构（SQLite）
--
-- 约定：
--   * 时间统一存 unix 毫秒（INTEGER），避免时区问题
--   * 布尔存 INTEGER 0/1
--   * EVE 的 int64 ID：character/type/system/structure/order_id
--     均在 JS Safe Integer（2^53）范围内，可直接用 JS number
--   * 单机单用户，不再保留 created_by / updated_by 审计字段
-- ============================================================

-- ------------------------------------------------------------
-- 1. EVE 角色（授权后保存，支持多角色切换）
-- ------------------------------------------------------------
CREATE TABLE eve_character (
  character_id      INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  corporation_id    INTEGER,
  corporation_name  TEXT,
  alliance_id       INTEGER,
  alliance_name     TEXT,
  birthday          TEXT,
  security_status   REAL,
  portrait_url      TEXT,
  -- 当前选中的角色（全表至多一行为 1，由应用层保证）
  is_active         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX uq_eve_character_active
  ON eve_character(is_active) WHERE is_active = 1;

-- ------------------------------------------------------------
-- 2. 角色令牌（refresh_token 不放这里，存系统钥匙串）
--    keyring service = "eve-desktop-tool"
--    keyring account = "refresh_token:<character_id>"
-- ------------------------------------------------------------
CREATE TABLE eve_token (
  character_id  INTEGER PRIMARY KEY
                  REFERENCES eve_character(character_id) ON DELETE CASCADE,
  access_token  TEXT,
  scopes        TEXT    NOT NULL DEFAULT '[]',
  token_type    TEXT    NOT NULL DEFAULT 'Bearer',
  expires_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ------------------------------------------------------------
-- 3. 星城/玩家建筑（同步目标）
-- ------------------------------------------------------------
CREATE TABLE market_structure (
  structure_id        INTEGER PRIMARY KEY,
  name                TEXT,
  solar_system_id     INTEGER,
  solar_system_name   TEXT,
  region_id           INTEGER,
  type_id             INTEGER,
  owner_id            INTEGER,
  -- 解析状态：ok | unauthorized | not_found | pending
  resolve_status      TEXT    NOT NULL DEFAULT 'pending',
  resolve_error       TEXT,
  -- 用哪个角色去同步该建筑订单
  auth_character_id   INTEGER,
  -- 定时同步配置
  sync_enabled        INTEGER NOT NULL DEFAULT 0,
  sync_interval_min   INTEGER NOT NULL DEFAULT 60,
  -- 同步结果
  last_synced_at      INTEGER,
  last_sync_status    TEXT,
  last_sync_error     TEXT,
  order_count         INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_market_structure_sync
  ON market_structure(sync_enabled, last_synced_at);

-- ------------------------------------------------------------
-- 4. 建筑订单快照（整体替换式同步）
-- ------------------------------------------------------------
CREATE TABLE market_structure_order (
  order_id        INTEGER PRIMARY KEY,
  structure_id    INTEGER NOT NULL,
  type_id         INTEGER NOT NULL,
  is_buy_order    INTEGER NOT NULL,
  price           REAL    NOT NULL,
  volume_remain   INTEGER NOT NULL,
  volume_total    INTEGER NOT NULL,
  min_volume      INTEGER NOT NULL,
  duration        INTEGER NOT NULL,
  issued_at       INTEGER NOT NULL,
  range           TEXT    NOT NULL,
  location_id     INTEGER NOT NULL,
  synced_at       INTEGER NOT NULL
);

CREATE INDEX idx_market_structure_order_structure
  ON market_structure_order(structure_id, type_id, is_buy_order);

CREATE INDEX idx_market_structure_order_type
  ON market_structure_order(type_id, structure_id);

-- ------------------------------------------------------------
-- 5. 角色自己的订单
-- ------------------------------------------------------------
CREATE TABLE character_order (
  order_id        INTEGER PRIMARY KEY,
  character_id    INTEGER NOT NULL,
  type_id         INTEGER NOT NULL,
  location_id     INTEGER NOT NULL,
  region_id       INTEGER NOT NULL,
  is_buy_order    INTEGER NOT NULL,
  price           REAL    NOT NULL,
  volume_remain   INTEGER NOT NULL,
  volume_total    INTEGER NOT NULL,
  min_volume      INTEGER NOT NULL,
  duration        INTEGER NOT NULL,
  issued_at       INTEGER NOT NULL,
  range           TEXT    NOT NULL,
  escrow          REAL,
  is_corporation  INTEGER NOT NULL DEFAULT 0,
  synced_at       INTEGER NOT NULL
);

CREATE INDEX idx_character_order_character
  ON character_order(character_id, is_buy_order);

CREATE INDEX idx_character_order_type
  ON character_order(type_id);

-- ------------------------------------------------------------
-- 6. 定时任务配置
-- ------------------------------------------------------------
CREATE TABLE sync_task (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- structure_orders | character_orders
  task_type     TEXT    NOT NULL,
  target_id     INTEGER NOT NULL,
  character_id  INTEGER,
  interval_min  INTEGER NOT NULL DEFAULT 60,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,
  next_run_at   INTEGER,
  last_status   TEXT,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX uq_sync_task_target
  ON sync_task(task_type, target_id);

CREATE INDEX idx_sync_task_due
  ON sync_task(enabled, next_run_at);

-- ------------------------------------------------------------
-- 7. 物品类型字典（ESID/SDE 导入，用于展示名称）
-- ------------------------------------------------------------
CREATE TABLE eve_type (
  type_id         INTEGER PRIMARY KEY,
  name_en         TEXT,
  name_zh         TEXT,
  group_id        INTEGER,
  category_id     INTEGER,
  volume          REAL,
  market_group_id INTEGER
);

CREATE INDEX idx_eve_type_name_zh ON eve_type(name_zh);
CREATE INDEX idx_eve_type_name_en ON eve_type(name_en);

-- ------------------------------------------------------------
-- 8. 应用配置（client_id / 默认项等键值对）
-- ------------------------------------------------------------
CREATE TABLE app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
