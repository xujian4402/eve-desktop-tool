//! 制造业模块（v2）。
//!
//! 分层：
//! - `model`：SDE 与前端契约的数据结构
//! - `sync`：SDE 导入（内嵌 JSON → SQLite）与建筑 / 改装件查询
//! - `query`：产品搜索、配方详情、类型名
//! - `calc`：纯计算层（材料 / 时间 / 作业费），无 IO，可单测

pub mod calc;
pub mod command;
pub mod my_industry;
pub mod model;
pub mod pricing;
pub mod query;
pub mod sync;
