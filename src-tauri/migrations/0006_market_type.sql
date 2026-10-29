-- ============================================================
-- 商品目录：把市场分组里的类型展开成关联表
--
-- market_group.types 存的是 JSON 数组，没法直接按「这个类型是否在售」
-- 做索引查询。单独建一张表后，「对比物品」只搜真正有市场分类的物品，
-- 不会把技能书、蓝图拷贝之类搜出来。
-- ============================================================

CREATE TABLE market_type (
  type_id         INTEGER PRIMARY KEY,
  market_group_id INTEGER NOT NULL
);

CREATE INDEX idx_market_type_group ON market_type(market_group_id);

-- 从已有分组数据回填，避免迁移后搜索变空
INSERT OR IGNORE INTO market_type (type_id, market_group_id)
SELECT CAST(j.value AS INTEGER), g.market_group_id
  FROM market_group g, json_each(g.types) j
 WHERE j.value IS NOT NULL;
