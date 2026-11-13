-- 旧的制造业模块已整体移除，接下来会按参考项目（eve-market-tool）的方案重建。
-- 0008 保留在迁移序列里，保证老用户升级路径连续；这里只做清理。
DROP TABLE IF EXISTS character_blueprint;
DROP TABLE IF EXISTS industry_job;
DROP TABLE IF EXISTS industry_facility;
