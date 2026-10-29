-- ============================================================
-- EVE 市场物品分类（market groups）
--
-- 数据来源（公开接口，无需角色授权）：
--   GET /markets/groups/              分组 ID 清单（约 2100 个）
--   GET /markets/groups/{id}/?language=zh   分组详情
--
-- 结构：自引用树。parent_group_id 为空表示顶层分组。
-- types 存该分组「直属」物品类型 ID 的 JSON 数组，
-- 子分组的物品不重复包含，由前端递归汇总。
-- ============================================================

CREATE TABLE market_group (
  market_group_id INTEGER PRIMARY KEY,
  -- 官方中文名（language=zh 拉取）
  name            TEXT    NOT NULL,
  -- 英文名（可选，后续补拉时写入）
  name_en         TEXT,
  description     TEXT    NOT NULL DEFAULT '',
  -- 父分组 ID，NULL 表示顶层
  parent_group_id INTEGER,
  -- 直属物品类型 ID（JSON 数组）
  types           TEXT    NOT NULL DEFAULT '[]',
  synced_at       INTEGER NOT NULL
);

CREATE INDEX idx_market_group_parent ON market_group(parent_group_id);
CREATE INDEX idx_market_group_name ON market_group(name);
