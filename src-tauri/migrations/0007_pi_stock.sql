-- ============================================================
-- 行星工业库存快照
--
-- 从 ESI 读取角色资产后，把行星工业物资（P0~P4）的数量存下来，
-- 下次打开应用无需重新请求 ESI 即可继续试算成本与可合成数量。
-- 只保留最近一次读取的结果（读取时整表替换）。
-- ============================================================

CREATE TABLE pi_stock (
  type_id      INTEGER PRIMARY KEY,
  quantity     INTEGER NOT NULL,
  character_id INTEGER,
  updated_at   INTEGER NOT NULL
);
