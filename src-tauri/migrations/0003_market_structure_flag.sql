-- ============================================================
-- 建筑是否开放市场
--
-- 判定方式：能读到 /markets/structures/{id}/ 的订单列表（哪怕为空）即为有市场，
-- 403/404 说明该建筑没有市场服务或当前角色无权访问。
--
-- 市场页「建筑订单」只展示有市场的建筑；
-- 「建筑管理」里仍能看到全部已发现建筑（含无市场的），便于后续观察其市场是否开通。
-- ============================================================

ALTER TABLE market_structure ADD COLUMN has_market INTEGER NOT NULL DEFAULT 0;

-- 迁移前入库的建筑都是通过市场页入口添加的（当时只用于同步订单），
-- 一律视为有市场，避免升级后列表变空；下次同步会按实际探测结果修正。
UPDATE market_structure SET has_market = 1;

CREATE INDEX IF NOT EXISTS idx_market_structure_has_market
  ON market_structure(has_market);
