-- 制造业 v2：按参考项目（eve-market-tool）的数据模型重建。
-- 分为三类表：
--   1. SDE 静态表（由 scripts/build-mfg-sde.mjs 生成、mfg_sync_sde 导入）
--   2. 运行时表（我的蓝图 / 工业任务 / 我的建筑）
--   3. 元信息表（SDE 版本）

/* ============================================================
   1. SDE 静态表
   ============================================================ */

-- 蓝图：以「产品 type_id」为主键，一份产品只对应一张可制造蓝图
CREATE TABLE IF NOT EXISTS mfg_blueprint (
  product_type_id   INTEGER PRIMARY KEY,
  blueprint_type_id INTEGER NOT NULL,
  output_qty        INTEGER NOT NULL,
  base_time         INTEGER NOT NULL,
  -- 'manufacturing' | 'reaction'
  activity          TEXT    NOT NULL,
  max_runs          INTEGER NOT NULL DEFAULT 1,
  -- 1 = NPC 军团有售（可直接买原图）
  npc_sold          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mfg_blueprint_bp ON mfg_blueprint (blueprint_type_id);
CREATE INDEX IF NOT EXISTS idx_mfg_blueprint_activity ON mfg_blueprint (activity);

-- 材料（含反应配方）
CREATE TABLE IF NOT EXISTS mfg_material (
  product_type_id  INTEGER NOT NULL,
  material_type_id INTEGER NOT NULL,
  quantity         INTEGER NOT NULL,
  PRIMARY KEY (product_type_id, material_type_id)
);

-- 制造 / 反应所需技能等级
CREATE TABLE IF NOT EXISTS mfg_skill_req (
  product_type_id INTEGER NOT NULL,
  skill_type_id   INTEGER NOT NULL,
  level           INTEGER NOT NULL,
  PRIMARY KEY (product_type_id, skill_type_id)
);

-- 发明：T1 蓝图 → T2 蓝图
CREATE TABLE IF NOT EXISTS mfg_invention (
  t2_blueprint_id INTEGER PRIMARY KEY,
  t1_blueprint_id INTEGER NOT NULL,
  base_probability REAL   NOT NULL,
  runs_per_copy    INTEGER NOT NULL DEFAULT 1,
  base_time        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfg_invention_t1 ON mfg_invention (t1_blueprint_id);

-- 发明材料（数据核心，偶尔含 T1 蓝图本身）
CREATE TABLE IF NOT EXISTS mfg_invention_material (
  t2_blueprint_id INTEGER NOT NULL,
  type_id         INTEGER NOT NULL,
  quantity        INTEGER NOT NULL,
  PRIMARY KEY (t2_blueprint_id, type_id)
);

-- 发明技能需求
CREATE TABLE IF NOT EXISTS mfg_invention_skill (
  t2_blueprint_id INTEGER NOT NULL,
  skill_type_id   INTEGER NOT NULL,
  level           INTEGER NOT NULL,
  PRIMARY KEY (t2_blueprint_id, skill_type_id)
);

-- 解码器
CREATE TABLE IF NOT EXISTS mfg_decryptor (
  type_id  INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL,
  prob_mul REAL    NOT NULL,
  me_add   INTEGER NOT NULL,
  te_add   INTEGER NOT NULL,
  runs_add INTEGER NOT NULL
);

-- 研究 / 拷贝基础时间
CREATE TABLE IF NOT EXISTS mfg_research (
  blueprint_type_id   INTEGER PRIMARY KEY,
  me_time             INTEGER NOT NULL DEFAULT 0,
  te_time             INTEGER NOT NULL DEFAULT 0,
  copy_time_per_run   INTEGER NOT NULL DEFAULT 0
);

-- 建筑类型（工程复合体 / 精炼厂 / NPC 站）
CREATE TABLE IF NOT EXISTS mfg_facility_type (
  type_id    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  -- 'engineering' | 'refinery' | 'npc'
  category   TEXT    NOT NULL,
  me_bonus   REAL    NOT NULL DEFAULT 0,
  te_bonus   REAL    NOT NULL DEFAULT 0,
  cost_bonus REAL    NOT NULL DEFAULT 0,
  tax        REAL    NOT NULL DEFAULT 0,
  rig_slots  INTEGER NOT NULL DEFAULT 0
);

-- 改装件（rig）
CREATE TABLE IF NOT EXISTS mfg_rig (
  type_id  INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL,
  -- 适用建筑类别：'engineering' | 'refinery'
  category TEXT    NOT NULL,
  -- 'material' | 'time' | 'cost'
  effect   TEXT    NOT NULL,
  bonus    REAL    NOT NULL,
  -- 是否高安可用（部分 rig 仅低安/00 生效）
  high_sec_ok INTEGER NOT NULL DEFAULT 1
);

-- 类型名（只存制造业用到的，避免整份 types 落库）
CREATE TABLE IF NOT EXISTS mfg_type_name (
  type_id  INTEGER PRIMARY KEY,
  name_zh  TEXT,
  name_en  TEXT,
  group_id INTEGER,
  volume   REAL
);

/* ============================================================
   2. 运行时表（我的数据）
   ============================================================ */

CREATE TABLE IF NOT EXISTS mfg_my_blueprint (
  item_id             INTEGER PRIMARY KEY,
  character_id        INTEGER NOT NULL,
  type_id             INTEGER NOT NULL,
  location_id         INTEGER NOT NULL,
  location_flag       TEXT    NOT NULL,
  -- -1 = BPO
  quantity            INTEGER NOT NULL,
  material_efficiency INTEGER NOT NULL,
  time_efficiency     INTEGER NOT NULL,
  -- BPO 为 -1
  runs                INTEGER NOT NULL,
  synced_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfg_my_blueprint_char
  ON mfg_my_blueprint (character_id, type_id);

CREATE TABLE IF NOT EXISTS mfg_my_job (
  job_id            INTEGER PRIMARY KEY,
  owner_id          INTEGER NOT NULL,
  -- 'character' | 'corporation'
  owner_kind        TEXT    NOT NULL,
  installer_id      INTEGER,
  activity_id       INTEGER NOT NULL,
  blueprint_type_id INTEGER NOT NULL,
  product_type_id   INTEGER NOT NULL,
  facility_id       INTEGER,
  runs              INTEGER NOT NULL,
  licensed_runs     INTEGER,
  cost              REAL,
  probability       REAL,
  status            TEXT    NOT NULL,
  -- ISO 字符串（与 ESI 一致）
  start_date        TEXT,
  end_date          TEXT,
  synced_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfg_my_job_owner ON mfg_my_job (owner_id, status);

CREATE TABLE IF NOT EXISTS mfg_my_facility (
  facility_id      INTEGER PRIMARY KEY,
  name             TEXT,
  solar_system_id  INTEGER,
  facility_type_id INTEGER,
  -- 逗号分隔的 rig type_id
  rig_type_ids     TEXT    NOT NULL DEFAULT '',
  material_bonus   REAL    NOT NULL DEFAULT 0,
  time_bonus       REAL    NOT NULL DEFAULT 0,
  tax_rate         REAL    NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

/* ============================================================
   3. 元信息
   ============================================================ */

CREATE TABLE IF NOT EXISTS mfg_sde_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
