# 制造业模块重构技术报告

| 项 | 内容 |
|---|---|
| 报告日期 | 2026-11-12 |
| 参考基线 | `D:\xujian\eve-market-tool\eve-overview-clone`（`industry.js` 1367 行 + `ind-plan.js` 733 行） |
| 当前状态 | 旧制造业代码已全部删除，将从零按参考项目方案重建 |
| 目标形态 | Tauri 2 + React 19 + TypeScript + Rust + SQLite |
| 交付口径 | 以参考项目能力为准，超出部分不做（见 2.2） |

---

## 目录

1. [清除执行结果](#一清除执行结果)
2. [目标基线](#二目标基线参考项目能力)
3. [从零架构设计](#三从零架构设计)
4. [数据层设计](#四数据层设计)
5. [计算规范](#五计算规范重构唯一真值)
6. [接口契约](#六接口契约)
7. [分阶段实施计划](#七分阶段实施计划)
8. [风险与验收](#八风险与验收)
9. [重建必须避开的旧坑](#九重建时必须避开的旧坑)
10. [第一步行动清单](#十当前可立即启动的第一步)

---

## 一、清除执行结果

### 1.1 已删除

| 类别 | 路径 | 规模 |
|---|---|---|
| 前端页面 | `src/pages/ManufacturingPage.tsx` + `.css` | 172 行 |
| 前端 Tab | `src/pages/manufacturing/`（`MfgBlueprintTab` / `MfgCalculatorTab` / `MfgFacilityTab` / `MfgJobsTab` + 4 个 CSS） | 1364 行 |
| 前端逻辑 | `src/lib/manufacturing/`（`api.ts` / `calc.ts` / `data.ts` / `skills.ts`） | — |
| 静态数据 | `src/data/manufacturing/blueprints.json` | 1.89 MB |
| 生成脚本 | `scripts/build-manufacturing-sde.mjs` | — |
| 后端模块 | `src-tauri/src/esi_industry.rs` | 397 行 |
| 后端命令 | `esi::fetch_manufacturing_structures` + `ManufacturingStructureView` | 64 行 |
| 数据访问 | `db.ts` 制造业段（蓝图 / 作业 / 建筑共 8 个函数） | 242 行 |
| 旧文档 | `docs/manufacturing-technical-report.md`（路径引用已失效） | 19.2 KB |

### 1.2 连带清理

| 位置 | 改动 |
|---|---|
| `src/App.tsx` | 移除 `ManufacturingPage` 导入、菜单项、`renderContent` 分支、`MENU_ICONS` 中的 `Factory`、`content--fill` 判断里的 `manufacturing` |
| `src/lib/nav.ts` | `MenuKey` 去掉 `"manufacturing"` |
| `src-tauri/src/lib.rs` | 移除 `mod esi_industry;`、7 个命令注册 |
| 数据库 | 新增 `0009_drop_manufacturing.sql` |

### 1.3 关键决策：不删 `0008` 迁移

```
0008_manufacturing.sql        保留（已应用，删掉会断裂老用户升级路径）
0009_drop_manufacturing.sql   新增（DROP TABLE IF EXISTS × 3）
```

新装用户会「先建表再删表」，多一次 IO，但保证迁移序列连续、不出现版本空洞。

```sql
-- 0009_drop_manufacturing.sql
DROP TABLE IF EXISTS character_blueprint;
DROP TABLE IF EXISTS industry_job;
DROP TABLE IF EXISTS industry_facility;
```

### 1.4 保留未动（跨模块共用）

| 资产 | 原因 |
|---|---|
| `esi::resolve_structure` / `discover_structure_ids` | 市场模块订单同步、建筑录入在用 |
| `fetch_structure_detail` | 建筑解析通用能力 |
| `eve_type` / `market_structure` / `market_structure_order` | 市场模块核心表 |
| `pi_stock` + `src/data/pi` | 行星工业模块 |

### 1.5 验证

| 检查 | 结果 |
|---|---|
| `cargo check` | `Finished dev profile`（无警告） |
| `pnpm exec tsc --noEmit` | `exit=0` |
| `pnpm build` | 成功 |
| 全库 grep（`esi_industry` / `BlueprintRow` / `MfgData` / `ManufacturingPage` / 「制造业」） | 0 命中 |

清除后目录状态：

```
src/pages        AccountPage / MarketPage / MonitorPage / PlanetaryPage
src/lib          character / market / monitor / orders / pi
src/data         pi / pi-schematics.json / pi-systems.json
scripts          build-pi-sde.mjs / build-sde.mjs
```

---

## 二、目标基线（参考项目能力）

### 2.1 功能清单（6 个页面）

| # | 页面 | 核心能力 |
|---|---|---|
| 1 | 制造计算器 | 产品搜索、单件成本、材料表（逐行切自制）、发明卡、蓝图卡、解码器对比、ME 0–10 影响表、研究与拷贝、去哪造最省钱、购物清单 |
| 2 | 制造规划 | 多产品批量、库存抵扣（ESI 资产 / 粘贴）、组件自制 chip、发明进度、产线甘特图、启动清单、购物清单 |
| 3 | 利润排行 | 全服扫描 + Top30 实时精算、综合评分、筛选项（技能够造 / 我有蓝图 / 排除我的挂单） |
| 4 | 制造地点 | 星系成本指数排行、范围 / 跳数 / 安等筛选、反应限非高安 |
| 5 | NPC 蓝图 | 军团售价、势力 / 星域 / 空间站数 |
| 6 | 我的工业 | ESI 工业任务 + 我的蓝图、按自身 ME/TE 算每小时利润 |

### 2.2 明确不做（参考项目也没有）

- 矿物压缩（compression）
- BOM 展开到 P0–P4 行星材料（PI 是独立模块）
- 燃料块单独建模
- T3 逆向工程专用流程
- 多角色技能矩阵
- 工业任务创建 / 取消（只读不写）

### 2.3 数据规模基准

| 数据 | 规模 |
|---|---|
| 蓝图 | 4,148 张 |
| 物品 | 9,001 个 |
| 参考项目 `industry-data.json` | 1.43 MB |
| 旧实现 `blueprints.json` | 1.89 MB |

---

## 三、从零架构设计

```
┌──────────────────────────────────────────────────────────────┐
│ UI 层  React                                                 │
│  ManufacturingPage                                          │
│   ├─ MfgCalculatorPage   单件计算 + 多级 BOM + 购物清单        │
│   ├─ MfgPlanPage         多产品规划 + 库存 + 甘特              │
│   ├─ MfgRankPage         利润排行（后端分页）                  │
│   ├─ MfgLocationPage     制造地点排行                         │
│   ├─ MfgNpcBpPage        NPC 蓝图                            │
│   └─ MfgMyIndustryPage   我的工业（任务 + 蓝图）               │
├──────────────────────────────────────────────────────────────┤
│ 命令层  Rust #[tauri::command]（薄，只做参数校验与取数）         │
├──────────────────────────────────────────────────────────────┤
│ 计算层  Rust 纯函数（无 IO、可 cargo test）                    │
│   job()         单件：材料 / EIV / 作业费 / 税费 / 时间         │
│   invention()   发明：成功率 / 数据核心 / 解码器 / 每流程分摊    │
│   expand_bom()  多级展开（DFS + visiting 环检测）              │
│   plan()        多产品规划（层级拓扑 + 库存抵扣）               │
├──────────────────────────────────────────────────────────────┤
│ 数据层  SQLite（SDE 导入）+ 复用现有行情表                      │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 为什么计算必须在 Rust

| 理由 | 说明 |
|---|---|
| 排行扫描 | 4,148 产品 × 逐层材料，JS 主线程必然卡死 |
| 规划计算 | 多产品 + 库存抵扣 + 拓扑排序，数据量大 |
| 可测试 | `cargo test` 直接断言「与游戏内数字一致」 |
| 前端瘦身 | 不再在运行时解析 1.89 MB JSON |

### 3.2 蓝图数据结构（参考项目原样映射）

参考项目：

```js
bp[产品ID] = [蓝图ID, 每流程产量, 基础时间秒, [[材料ID,数量]...],
              最大流程, "m"|"r", [[技能ID,等级]...], 蓝图是否NPC有售]
```

Rust 对应：

```rust
struct BlueprintRec {
    blueprint_type_id: i64,
    output_qty: i64,
    base_time: i64,
    materials: Vec<(i64, i64)>,      // 内联，避免 join
    max_runs: i64,
    activity: Activity,             // Manufacturing | Reaction
    skills: Vec<(i64, u8)>,
    npc_sold: bool,
}
```

要点：以**产品 ID 为主键**，材料内联成扁平数组，枚举用单字符/小枚举 —— 序列化与解析成本最低。

---

## 四、数据层设计

### 4.1 新增 SDE 表（10 张）

| 表 | 主键 | 关键字段 | 行数量级 |
|---|---|---|---|
| `mfg_blueprint` | `product_type_id` | `blueprint_type_id`、`output_qty`、`base_time`、`activity`、`max_runs`、`npc_sold` | ~4,200 |
| `mfg_material` | (`product_type_id`, `material_type_id`) | `quantity` | ~25,000 |
| `mfg_skill_req` | (`product_type_id`, `skill_type_id`) | `level` | ~8,000 |
| `mfg_invention` | `t2_blueprint_id` | `t1_blueprint_id`、`base_probability`、`runs_per_copy`、`base_time` | ~600 |
| `mfg_invention_material` | (`t2_blueprint_id`, `type_id`) | `quantity`（数据核心） | ~1,200 |
| `mfg_invention_skill` | (`t2_blueprint_id`, `skill_type_id`) | `level` | ~2,000 |
| `mfg_decryptor` | `type_id` | `prob_mul`、`me_add`、`te_add`、`runs_add` | 8 |
| `mfg_research` | `blueprint_type_id` | `me_time`、`te_time`、`copy_time_per_run` | ~4,200 |
| `mfg_facility_type` | `type_id` | `name`、`me_bonus`、`te_bonus`、`cost_bonus`、`tax`、`category`、`rig_slots` | ~12 |
| `mfg_rig` | `type_id` | `me_bonus`、`te_bonus`、`cost_bonus`、`applicable_category` | ~40 |

### 4.2 运行时表（3 张，替代旧的三张）

| 表 | 用途 |
|---|---|
| `mfg_my_blueprint` | 角色蓝图（原 `character_blueprint`，字段沿用，补 `type_id` 索引） |
| `mfg_my_job` | 工业任务（原 `industry_job`，`start_date` / `end_date` 改 `TEXT` 存 ISO） |
| `mfg_my_facility` | 我的建筑（引用 `mfg_facility_type`，只存 `rig_ids` + 税 + 备注） |

> 旧表 `industry_job.start_date` 声明 `INTEGER` 却存 ISO 文本，重建时直接改 `TEXT`，不重复这个坑。

### 4.3 导入链路

```
scripts/build-mfg-sde.mjs
  ├─ 读 eve-online-static-data/blueprints.jsonl
  │    activities.manufacturing / reaction / invention / copying
  │    research_material / research_time
  ├─ 读 types.jsonl（typeMaterials、dogma attributes）
  └─ 输出 SQLite（.db）或分批 JSON

启动时 mfg_sync_sde()
  ├─ 比对 app_setting.sde_version
  ├─ 事务内 DELETE + INSERT（分块 500）
  └─ 成功后更新 sde_version
```

### 4.4 迁移规划

| 版本 | 内容 |
|---|---|
| `0008` | 旧制造业三表（保留，不再使用） |
| `0009` | DROP 旧三表 |
| `0010` | 新建 10 张 SDE 表 + 3 张运行时表 |

---

## 五、计算规范（重构唯一真值）

### 5.1 材料

```
eff = (1 − me/100) × (1 − structureME/100) × (1 − rigME × secMul/100)
qty = max(runs, ceil(round(base × runs × eff × 100) / 100))
```

`secMul`：安等 ≥ 0.45 → 1.0；低安 → 1.9；00 / 虫洞 → 2.1

> 旧实现用 `floor` 且减免为**加法叠加**，两处都会低估材料；新实现必须乘法链 + `ceil`。

### 5.2 时间

```
secs = baseTime × runs
     × (1 − te/100)
     × (1 − structureTE/100)
     × (1 − rigTE × secMul/100)
     × (1 − 0.04 × 工业理论) × (1 − 0.03 × 高级工业)
```

反应：技能项换成 `(1 − 0.04 × 反应学)`

### 5.3 作业费

```
EIV     = Σ(baseQty × runs × adjustedPrice)      // 按基础量，与 ME 无关
gross   = EIV × systemCostIndex × (1 − structureCostBonus/100)
taxes   = EIV × (facilityTax + 0.04) / 100       // SCC 固定 4%
jobCost = gross + taxes
```

### 5.4 发明

```
prob    = min(1, base × (1 + Σ科学技能/30 + 加密学/40) × decryptor.probMul)
runs    = runsPerCopy + decryptor.runsAdd
attempt = datacoreCost + decryptorCost + installCost
perRun  = attempt / (prob × runs)
输出 ME = 2 + decryptor.meAdd，TE = 4 + decryptor.teAdd
```

### 5.5 研究与拷贝

```
LEVEL_MUL = [0, 105, 250, 595, 1414, 3360, 8000, 19000, 45255, 107700, 256000]

time = base × (LEVEL_MUL[target] − LEVEL_MUL[current]) / 105
     × (1 − 0.05 × 研究) × (1 − 0.03 × 高级工业) × (1 − structureTE)

cost = EIV × 0.02 × 倍数 × (index × (1 − 结构减免) + (税 + 0.04) / 100)
```

### 5.6 BOM 展开

```
DFS 求每个节点深度（visiting 集合检测环，命中直接报错）
→ 按深度降序回填需求
→ 自制节点 runs = ceil(need / output_qty)，多余产出记 extra
→ 终端原料不展开，按采购计价
```

> 参考项目只有 `depth < 6` 上限，**没有环检测**；重建必须补 `visiting`，否则 SDE 异常数据会死循环。

### 5.7 税 / 费（函数化，不写死）

```
salesTax()  = 7.5 × (1 − 0.11 × 会计学)
brokerFee() = max(0, 3 − 0.3 × 中介关系学)
facTax(activity)
secMul(security)
lvl(skillId)   // ESI 实读 或 固定 5 级（用于「假设全 5 级」对比）
```

### 5.8 价格取值口径

```
买入侧：sell（最低卖价）→ 缺失 fallback buy → 缺失 fallback ESI adjusted
卖出侧：sell × (1 − 销售税[− 中介费])
数量阈值：≤200 id 走实时订单（5 分钟 TTL），更多走快照（≤1 小时）
```

---

## 六、接口契约

| 命令 | 入参 | 出参 |
|---|---|---|
| `mfg_calculate` | `productId, runs, me, te, ctx` | `JobResult { materials[], eiv, jobCost, revenue, profit, secs }` |
| `mfg_expand_bom` | `productId, units, buildSet[], ctx` | `BomTree + rawMaterials[]` |
| `mfg_plan` | `items[{productId,runs,me,te}], inventory[]` | `plan[] + schedule[] + shoppingList[]` |
| `mfg_rank` | `filters, page, size` | 分页排行 |
| `mfg_locations` | `productId, filters` | 星系排行 |
| `mfg_npc_blueprints` | — | NPC 蓝图 + 军团价 |
| `mfg_my_industry` | `characterId` | 任务 + 蓝图 + 每小时利润 |
| `mfg_sync_sde` | — | 版本号 + 导入行数 |
| `mfg_sync_blueprints` | `characterId` | 写入行数 |
| `mfg_sync_jobs` | `characterId` / `corporationId` | 写入行数 |

共享入参结构：

```rust
struct CalcContext {
    facility_type_id: Option<i64>,
    rig_type_ids: Vec<i64>,
    system_cost_index: f64,
    facility_tax: f64,
    security: f64,
    skills: HashMap<i64, u8>,   // 空 = 全 0 级
}
```

---

## 七、分阶段实施计划

| 阶段 | 内容 | 交付物 | 估算 |
|---|---|---|---|
| **P0 骨架** | 迁移 `0010` 建 13 张表、`build-mfg-sde.mjs`、`mfg_sync_sde`、菜单与空页面 | 数据可导入，页面可进 | 3 天 |
| **P1 计算核心** | `job()` + `calcMaterialQuantity` + `calcDuration` + `cargo test`（3 个游戏内样本） | 单件计算与游戏一致 | 3 天 |
| **P2 计算器 UI** | 产品搜索、材料表、汇总条、蓝图 / 发明卡、价格接入 | 可用的计算器 | 4 天 |
| **P3 多级 BOM** | `expand_bom`、自制集合、买 / 造对比、购物清单导出 | 全链路成本 | 3 天 |
| **P4 发明链** | 发明公式、解码器对比、ME 影响表、研究 / 拷贝 | T2 制造可用 | 3 天 |
| **P5 规划与排行** | `plan()`、库存抵扣、甘特、利润排行、制造地点 | 决策级功能 | 5 天 |
| **P6 我的工业** | 同步蓝图 / 任务、按时长排序、预计产出 | 收尾 | 2 天 |

合计约 **23 人日**。建议 P0 → P1 → P2 分三次交付，每次可独立验证。

---

## 八、风险与验收

| 风险 | 应对 |
|---|---|
| 公式与游戏不一致 | P1 用 3 个固定样本（基础护卫、T2 护卫、反应配方）写 `cargo test` 断言，误差 > 0 视为失败 |
| SDE 版本漂移 | `app_setting.sde_version` + 启动比对，过期提示重新导入 |
| ESI 限流 | 价格批量 200/批、并发 6（沿用 `fetch_region_best_sell` 策略） |
| BOM 性能 | Rust 内存缓存 + 拓扑序一次算完；前端只传参数 |
| 循环依赖 | `visiting` 集合显式报错，不依赖深度上限 |
| 迁移断裂 | `0008` 保留、`0009` 只 DROP；新表从 `0010` 开始 |

**P1 验收标准**：任一产品的「材料数量 / 时间 / 作业费」三项与游戏内蓝图信息页完全一致（时间允许 ±1 秒）。

---

## 九、重建必须避开的旧坑

| 旧问题 | 重建对策 |
|---|---|
| 减免**加法**叠加 | 乘法链，单测固定期望值 |
| 材料 `floor` | `ceil(round2)` |
| ME / TE 硬编码 10 / 20 | 从「我的蓝图」带入，或显式输入 |
| 反应配方被 UI 过滤 | `activity` 进数据表，UI 不过滤 |
| `industry_job.start_date` 类型错 | 新表直接 `TEXT` |
| 同步无事务 | 分批 upsert 包在一个事务里 |
| 蓝图 / 作业全量 `map` 渲染 | 虚拟滚动 + 后端分页 |
| 1 秒 `setInterval` 整表重渲染 | 只在进行中刷新，且只更新进度条节点 |
| 计算常量写死 | `CalcContext` 承载全部可变参数 |
| 页面间零联动 | 蓝图「用此蓝图计算」→ 路由带 `productId / me / te` |
| 单级 BOM | 多级展开 + 环检测 |
| 位置名逐个解析（上限 20） | 批量解析 + 持久化缓存 |

---

## 十、当前可立即启动的第一步

```
1. 新建 src-tauri/migrations/0010_manufacturing_v2.sql
     - 10 张 SDE 表 + 3 张运行时表
2. 新建 scripts/build-mfg-sde.mjs
     - 对齐参考项目 build_industry.mjs 的 8 类数据
     - 输出 SQLite 或分批 JSON
3. 新建 src-tauri/src/mfg/{mod.rs, model.rs, sync.rs, calc.rs}
4. cargo test 先跑通单个产品的 job()，再逐步叠加 UI
```

完成 P0 后的验收：`mfg_sync_sde` 能导入 4,000+ 蓝图，`SELECT COUNT(*) FROM mfg_blueprint` 与 SDE 版本一致；空页面可通过菜单进入。
