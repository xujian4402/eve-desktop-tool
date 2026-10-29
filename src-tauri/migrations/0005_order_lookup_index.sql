-- ============================================================
-- 物品分类页的订单查询优化
--
-- 「物品分类」选中某物品时，会按「建筑 + 物品」查该建筑内的买卖单：
--   SELECT ... FROM market_structure_order
--    WHERE structure_id = ? AND type_id = ?
--
-- 原有 structure_id / type_id 两个单列索引只能命中其一，
-- 单个建筑动辄数万行订单时仍需回表逐行比较。复合索引可直接定位。
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_market_structure_order_lookup
  ON market_structure_order(structure_id, type_id);
