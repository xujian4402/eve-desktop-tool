-- ============================================================
-- 制造业模块
--
-- 数据来源：
--   /characters/{id}/blueprints/      角色蓝图（BPO / BPC）
--   /characters/{id}/industry/jobs/   角色生产作业
--   /corporations/{id}/industry/jobs/ 军团生产作业
--
-- 建筑 rig 与结构税 ESI 不提供，单独建配置表由用户维护。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 角色拥有的蓝图
-- ------------------------------------------------------------
CREATE TABLE character_blueprint (
  item_id             INTEGER PRIMARY KEY,
  character_id        INTEGER NOT NULL,
  -- 蓝图类型 ID（对应 SDE blueprints.blueprintTypeID）
  type_id             INTEGER NOT NULL,
  location_id         INTEGER NOT NULL,
  location_flag       TEXT    NOT NULL DEFAULT '',
  -- -1 表示 BPO；BPC 为剩余流程数
  quantity            INTEGER NOT NULL DEFAULT -1,
  material_efficiency INTEGER NOT NULL DEFAULT 0,
  time_efficiency     INTEGER NOT NULL DEFAULT 0,
  -- BPO 为 -1
  runs                INTEGER NOT NULL DEFAULT -1,
  synced_at           INTEGER NOT NULL
);

CREATE INDEX idx_character_blueprint_char
  ON character_blueprint(character_id, type_id);

-- ------------------------------------------------------------
-- 2. 生产作业（角色 + 军团共用）
-- ------------------------------------------------------------
CREATE TABLE industry_job (
  job_id            INTEGER PRIMARY KEY,
  -- 角色 ID 或军团 ID
  owner_id          INTEGER NOT NULL,
  -- 'character' | 'corporation'
  owner_kind        TEXT    NOT NULL,
  -- 军团作业的发起人；角色作业为空
  installer_id      INTEGER,
  activity_id       INTEGER NOT NULL,
  blueprint_type_id INTEGER NOT NULL,
  product_type_id   INTEGER NOT NULL,
  facility_id       INTEGER NOT NULL,
  runs              INTEGER NOT NULL,
  licensed_runs     INTEGER,
  cost              REAL,
  probability       REAL,
  status            TEXT    NOT NULL,
  start_date        INTEGER NOT NULL,
  end_date          INTEGER NOT NULL,
  synced_at         INTEGER NOT NULL
);

CREATE INDEX idx_industry_job_owner
  ON industry_job(owner_id, status);

-- ------------------------------------------------------------
-- 3. 用户配置的制造建筑（加成与税率）
-- ------------------------------------------------------------
CREATE TABLE industry_facility (
  facility_id         INTEGER PRIMARY KEY,
  name                TEXT,
  solar_system_id     INTEGER,
  -- 0.01 = 减免 1%
  material_bonus      REAL NOT NULL DEFAULT 0,
  time_bonus          REAL NOT NULL DEFAULT 0,
  -- 结构税，0.01 = 1%
  tax_rate            REAL NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
);
