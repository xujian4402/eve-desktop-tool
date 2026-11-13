-- 制造业 v2 补全：NPC 蓝图、军团、星系、成本指数

CREATE TABLE IF NOT EXISTS mfg_npc_blueprint (
  bp_type_id INTEGER PRIMARY KEY,
  price      REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS mfg_npc_blueprint_corp (
  bp_type_id     INTEGER NOT NULL,
  corporation_id INTEGER NOT NULL,
  PRIMARY KEY (bp_type_id, corporation_id)
);

CREATE INDEX IF NOT EXISTS idx_mfg_npc_bp_corp ON mfg_npc_blueprint_corp (corporation_id);

CREATE TABLE IF NOT EXISTS mfg_npc_corp (
  corporation_id  INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,
  faction_id      INTEGER NOT NULL DEFAULT 0,
  solar_system_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mfg_solar_system (
  solar_system_id INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,
  security        REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mfg_solar_system_sec ON mfg_solar_system (security);

-- 成本指数（ESI /industry/systems/）
CREATE TABLE IF NOT EXISTS mfg_cost_index (
  solar_system_id INTEGER PRIMARY KEY,
  manufacturing   REAL    NOT NULL DEFAULT 0,
  reaction        REAL    NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

-- 价格快照（ESI /markets/prices/ 的 adjusted_price，供后端排行使用）
CREATE TABLE IF NOT EXISTS mfg_price_cache (
  type_id    INTEGER PRIMARY KEY,
  adjusted   REAL    NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
