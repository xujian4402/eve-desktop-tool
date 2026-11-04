# 制造业模块技术实践报告

> 项目：eve-desktop-tool（Tauri v2 + React + TypeScript + SQLite）
> 目标：把 App 左侧菜单里预留的「制造业」从占位变成可用模块
> 版本：v1 草案（对应代码基线：市场页拆分完成、行星工业已稳定）

---

## 1. 背景与目标

`src/App.tsx` 的 `MENUS` 里制造业入口目前是注释状态，`MENU_ICONS` 已配好 `Factory` 图标：

```tsx
// {
//   key: "manufacturing",
//   label: "制造业",
//   description: "制造业模块占位，后续在此展示蓝图、材料清单与生产排期。",
// },
```

本模块要解决的核心问题：

1. **我这批蓝图能造什么、要多少料** —— 按 ME/TE、技能、建筑给出真实材料清单
2. **造一件的成本和利润是多少** —— 材料成本 + 作业费（系统成本指数 × 结构税 + SCC）+ 税费，对照市场价算利润
3. **我的生产队列现在什么状态** —— 角色与军团的生产作业进度、剩余时间、材料是否够
4. **我的蓝图资产分布** —— BPO/BPC、ME/TE、剩余流程数、所在建筑

非目标（v1 不做）：市场挂单、合同、运输规划、POS 时代遗留工业设施。

---

## 2. 现状盘点

### 2.1 可复用的技术资产

| 层 | 已有能力 | 位置 |
|---|---|---|
| 后端 HTTP | 全局 `reqwest` 客户端、UA、60s 超时 | `src-tauri/src/esi.rs::http()` |
| 鉴权 | `ensure_token()`：缓存令牌 + 过期自动刷新 | `src-tauri/src/esi.rs` |
| 分页 | `fetch_paged_orders<T>()`：按 `X-Pages` 拉全量、带页数上限与 `truncated` 标记 | 同上 |
| 缓存头 | 解析 `Cache-Control: max-age`，返回 `cache_expires_at` | 同上 |
| 数据库 | `tauri-plugin-sql` + 顺序迁移 `0001~0007` | `src-tauri/migrations/` |
| 前端数据层 | `src/lib/db.ts` 统一封装 `invoke` / `db.select`，含批量 upsert 与「本轮清理」模式 | `src/lib/db.ts` |
| 查询缓存 | TanStack Query，`queryKey` 约定 + `staleTime` | 全项目 |
| 页面拆分范式 | `pages/MarketPage.tsx` + `pages/market/*Tab.tsx + *.css` | 市场模块 |
| 静态数据范式 | SDE → 精简 JSON → 动态 `import()` | `scripts/build-pi-sde.mjs` → `src/data/pi/*.json` |

### 2.2 已有静态数据（`eve-online-static-data/`）

实测统计：

| 文件 | 规模 | 用途 |
|---|---|---|
| `blueprints.jsonl` | 5,100 条蓝图 | 制造/反应/发明/复制/研究的时间与材料 |
| `types.jsonl` | 53,292 条类型 | 名称、体积、分组 |
| `typeMaterials.jsonl` | 2.2 MB | 旧版材料表（可作为交叉校验） |
| `industryActivities.jsonl` | 空 | 无需使用 |

蓝图活动分布（脚本实测）：

```
总蓝图      : 5,100
含 manufacturing : 4,890   ← 主流程
含 reaction      :   120   ← 月矿/燃料反应
含 invention     : 1,117   ← T2/T3 发明
含 copying       : 4,344
单蓝图最多材料种类: 24
涉及材料类型      : 1,597
```

### 2.3 关键缺口

| 缺口 | 影响 | 对策 |
|---|---|---|
| ESI 不返回建筑 rig / 加成 | 无法自动算结构减免 | 用户手动配置建筑（材料/时间减免、税率） |
| ESI 不返回角色工业技能等级（有 `/skills/`，需解析技能 ID） | 需维护技能 → 加成映射 | 内置常量表（按技能 ID） |
| 系统成本指数有缓存（约 1 小时） | 作业费会有滞后 | 显式标注数据时间 |

---

## 3. 总体架构

```
SDE blueprints.jsonl ──scripts/build-manufacturing-sde.mjs──▶ src/data/manufacturing/blueprints.json
                                                              （动态 import，按需加载）
                                                                     │
       ┌─────────────────────────────────────────────────────────────┘
       ▼
┌────────────────────┐   invoke    ┌──────────────────────────┐   HTTP   ┌──────────┐
│ React 页面          │ ──────────▶ │ Rust 命令 (esi_industry) │ ───────▶ │ ESI      │
│ pages/manufacturing │ ◀────────── │ - 蓝图 / 作业 / 技能      │ ◀─────── │          │
└─────────┬──────────┘             └───────────┬──────────────┘          └──────────┘
          │                                    │
          │ db.select / db.execute             │ sqlx
          ▼                                    ▼
   ┌────────────────────────────────────────────────┐
   │ SQLite：character_blueprint / industry_job      │
   │         industry_facility（用户配置）           │
   └────────────────────────────────────────────────┘
```

数据分三类，边界清晰：

- **静态**：蓝图配方（SDE 生成，随应用发布，只读）
- **远程**：角色蓝图、生产作业、技能（ESI，按需同步，落库缓存）
- **本地配置**：建筑加成、税率、偏好（SQLite，用户维护）

---

## 4. 数据层设计

### 4.1 SDE 生成脚本

新增 `scripts/build-manufacturing-sde.mjs`，与现有 `build-pi-sde.mjs` 同风格：

```js
// 伪代码
读 blueprints.jsonl
  取 _key / blueprintTypeID / maxProductionLimit
  取 activities.manufacturing | reaction | invention
    materials[{typeID, quantity}]  products[{typeID, quantity}]  time
  取 types.jsonl 中相关 typeID 的中文名与体积
输出 src/data/manufacturing/
  blueprints.json   // 主表：约 5,000 条，预估 1.2~1.8 MB
  names.json        // typeId → 中文名（仅被引用到的类型）
```

前端结构：

```ts
export interface ManufacturingRecipe {
  blueprintTypeId: number;
  productTypeId: number;
  productQuantity: number;
  activity: "manufacturing" | "reaction";
  time: number;                       // 秒 / 单次运行
  materials: Array<{ typeId: number; quantity: number }>;
  maxProductionLimit: number;
}
```

与行星工业一致，用 `loadManufacturingBlueprints()` 动态 `import()`，避免首屏加载 1.5 MB。

### 4.2 SQLite 迁移（`0008_manufacturing.sql`）

```sql
-- 角色拥有的蓝图（BPO / BPC）
CREATE TABLE character_blueprint (
  item_id             INTEGER PRIMARY KEY,   -- 蓝图物品实例 ID
  character_id        INTEGER NOT NULL,
  type_id             INTEGER NOT NULL,      -- 蓝图类型
  location_id         INTEGER NOT NULL,
  location_flag       TEXT NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT -1,  -- -1=BPO，其余=剩余流程
  material_efficiency INTEGER NOT NULL DEFAULT 0,
  time_efficiency     INTEGER NOT NULL DEFAULT 0,
  runs                INTEGER NOT NULL DEFAULT -1,
  synced_at           INTEGER NOT NULL
);
CREATE INDEX idx_character_blueprint_char ON character_blueprint(character_id, type_id);

-- 生产作业（角色 + 军团）
CREATE TABLE industry_job (
  job_id          INTEGER PRIMARY KEY,
  owner_id        INTEGER NOT NULL,          -- character_id 或 corporation_id
  owner_kind      TEXT NOT NULL,             -- 'character' | 'corporation'
  installer_id    INTEGER,                   -- 发起角色（军团作业才有）
  activity_id     INTEGER NOT NULL,          -- 1=制造 8=发明 9=反应 ...
  blueprint_type_id INTEGER NOT NULL,
  product_type_id   INTEGER NOT NULL,
  facility_id     INTEGER NOT NULL,
  runs            INTEGER NOT NULL,
  licensed_runs   INTEGER,
  cost            REAL,
  probability     REAL,
  status          TEXT NOT NULL,
  start_date      INTEGER NOT NULL,
  end_date        INTEGER NOT NULL,
  synced_at       INTEGER NOT NULL
);
CREATE INDEX idx_industry_job_owner ON industry_job(owner_id, status);

-- 用户配置的建筑（ESI 拿不到 rig 与税率的真实值）
CREATE TABLE industry_facility (
  facility_id          INTEGER PRIMARY KEY,
  name                 TEXT,
  solar_system_id      INTEGER,
  material_bonus       REAL NOT NULL DEFAULT 0,   -- 0.01 = 减免 1%
  time_bonus           REAL NOT NULL DEFAULT 0,
  tax_rate             REAL NOT NULL DEFAULT 0,   -- 结构税，0.01 = 1%
  cost_index_override  REAL,                      -- 手动覆盖系统成本指数（可选）
  updated_at           INTEGER NOT NULL
);
```

写入策略沿用现有「upsert 本轮 + 清理本轮未出现」模式（见 `saveStructureOrders`），避免同步中断导致列表变空。

### 4.3 前端数据层（`src/lib/manufacturing.ts`）

```ts
export async function loadBlueprints(): Promise<ManufacturingRecipe[]>;  // 动态 import
export async function listCharacterBlueprints(characterId: number): Promise<BlueprintRow[]>;
export async function listIndustryJobs(ownerId: number, kind: "character" | "corporation"): Promise<IndustryJobRow[]>;
export async function saveIndustryJobs(...): Promise<void>;
export async function listIndustryFacilities(): Promise<IndustryFacility[]>;
export async function upsertIndustryFacility(...): Promise<void>;
```

---

## 5. 计算模型

所有计算集中在 `src/lib/manufacturing/calc.ts`，纯函数、可单测。

### 5.1 材料需求

输入：`recipe`、`runs`、`me`、`结构材料减免`、`技能减免`

```ts
// 效率下限：ME/100 + 结构 + 技能，最低 0，最高不超过 1
const efficiency = clamp(me / 100 + structureBonus + skillBonus, 0, 1);

// 每 run 保底 1 件，整体向下取整（EVE 的整数裁剪）
const quantity = Math.max(
  runs,
  Math.floor(baseQuantity * runs * (1 - efficiency)),
);
```

> 取整方式不同来源略有差异（部分场景按 `ceil`）。实现时以「同配方已知成品」实证校准一次，把结果固化进单测快照。

### 5.2 生产时间

```ts
const seconds = Math.round(
  baseTime * runs * (1 - te / 100) * (1 - structureTimeBonus) * (1 - skillTimeBonus),
);
```

### 5.3 作业费

```ts
// 估算物品价值：材料基础价 × 数量（EVE 用 adjusted_price，缺失时回退 average_price）
const itemValue = Σ(material.quantity * adjustedPrice);

const jobCost = itemValue * (systemCostIndex * (1 + facilityTax) + SCC_SURCHARGE);
// SCC_SURCHARGE = 0.04（固定 4%）
```

- `systemCostIndex` 来自 `GET /industry/systems/`（公开接口，按 solar_system_id 取 `manufacturing` / `reaction` 指数）
- `facilityTax` 来自 `industry_facility.tax_rate`（用户填）

### 5.4 利润

```ts
const revenue = productQuantity * runs * sellPrice;      // 默认取最低卖价（保守）
const materialCost = Σ(需求 × buyPrice);                 // P0/矿物取最低卖价
const profit = revenue - materialCost - jobCost - salesTax;
const margin = profit / (materialCost + jobCost);
```

价格来源复用现有市场模块：

- 本地建筑行情：`market_structure_order`（已有）
- Jita 实时：`fetch_region_type_orders`（已有）
- 全局参考价：`/markets/prices/`（新增，可拉一次缓存 1 小时）

### 5.5 发明（v1 只做估算）

```ts
const successRate = baseChance * (1 + encryptionSkill / 100 * 0.01 + ...);
const expectedRuns = successRate * maxRuns;   // 期望产出
```

发明成功率公式涉及多个技能与解码器，v1 先按 `基础成功率 × (1 + 技能加成)` 线性近似，并在界面标注「估算值」。

---

## 6. ESI 集成

### 6.1 新增命令（`src-tauri/src/esi_industry.rs`）

| 命令 | ESI 接口 | Scope |
|---|---|---|
| `fetch_character_blueprints` | `GET /characters/{id}/blueprints/` | `esi-characters.read_blueprints.v1` |
| `fetch_character_industry_jobs` | `GET /characters/{id}/industry/jobs/` | `esi-industry.read_character_jobs.v1` |
| `fetch_corporation_industry_jobs` | `GET /corporations/{id}/industry/jobs/` | `esi-industry.read_corporation_jobs.v1` + 工厂经理角色 |
| `fetch_character_skills` | `GET /characters/{id}/skills/` | `esi-skills.read_skills.v1` |
| `fetch_industry_systems` | `GET /industry/systems/` | 公开 |
| `fetch_market_prices` | `GET /markets/prices/` | 公开 |

实现要点（复用现有模式）：

1. `ensure_token(pool, character_id)` 统一取令牌
2. 分页接口直接复用 `fetch_paged_orders<T>()`（虽名带 orders，但它是通用分页器，可考虑重命名为 `fetch_paged<T>()`）
3. 返回结构统一带 `{ items, truncated, fetchedAt, cacheExpiresAt }`
4. 403 → 提示「缺少 scope 或角色无权限」，不要抛通用错误

### 6.2 限流与缓存

- `X-Pages` 分页接口按页串行，页间不做并发（现有实现已如此）
- `/industry/systems/` 与 `/markets/prices/` 全局缓存 1 小时，存内存 + 落 `app_setting`
- 错误预算（`X-ESI-Error-Limit-Remain`）低于 20 时暂停请求并在界面提示

---

## 7. 前端设计

### 7.1 页面结构（延续市场页拆分范式）

```
src/pages/
├── ManufacturingPage.tsx        # 外壳：角色守卫 + Tabs 框架（约 120 行）
├── ManufacturingPage.css
└── manufacturing/
    ├── MfgBlueprintsTab.tsx + .css    # 蓝图资产（BOM 明细）
    ├── MfgCalculatorTab.tsx + .css    # 制造成本与利润计算器
    ├── MfgJobsTab.tsx + .css          # 生产队列进度
    └── MfgFacilitiesTab.tsx + .css    # 建筑加成 / 税率配置
```

标签页说明：

| 标签 | 内容 |
|---|---|
| 蓝图资产 | 按角色列出 BPO/BPC：产物、ME/TE、剩余流程、所在建筑；点击展开材料清单 |
| 成本计算 | 选蓝图 → 填 runs → 选建筑（自动带减免）→ 输出材料清单、作业费、总成本、利润、利润率；材料缺口对照本地库存 |
| 生产队列 | 进行中的作业（角色/军团切换），进度条、剩余时间、产品、数量；完成/已交付分组 |
| 建筑配置 | 手动维护 rig 减免与结构税；支持从已同步建筑一键带入 |

### 7.2 高度与滚动约定

沿用市场页落地后的规范：

- `TabsContent` 统一 `.mfg-page__content`（`display:flex; flex-direction:column; min-height:0`）
- 面板根 `flex min-h-0 flex-1 flex-col`
- 表格滚动收敛到最内层 `overflow-auto`
- `forceMount` 的面板必须显式写 `[data-state="inactive"] { display: none; }`

### 7.3 复用组件

| 组件 | 来源 |
|---|---|
| 物品搜索（名称/ID） | `searchTypes()`（已有） |
| 价格行 | `PiPriceRow` 风格，改为 `MfgPriceRow` |
| 库存抵扣 | 复用 `fetch_character_asset_totals`（已有） |
| 建筑选择 | 复用 `listStructures(true)` + `structure-compare` 的选择器样式 |

---

## 8. 实施计划

| 阶段 | 交付物 | 预估工时 | 验收 |
|---|---|---|---|
| **P1 数据底座** | `build-manufacturing-sde.mjs`、`blueprints.json`、`lib/manufacturing.ts` 加载与查询、单测 | 1.5 天 | 5,000 条配方可查，材料数量与游戏内一致（抽样 10 条对账） |
| **P2 蓝图资产** | `0008_manufacturing.sql`、`fetch_character_blueprints` 命令、蓝图标签页 | 2 天 | 角色蓝图列表、ME/TE/剩余流程正确，断网时显示上次同步数据 |
| **P3 成本计算** | `calc.ts`、成本标签页、价格接入（本地 + Jita + 全局参考价） | 2.5 天 | 10 个常见 T1 舰船/模块的材料与游戏内一致；作业费误差 < 2% |
| **P4 生产队列 + 建筑配置** | `fetch_character_industry_jobs` / 军团作业、作业标签页、建筑配置页 | 2 天 | 作业进度与游戏内一致；建筑加成在计算器中生效 |
| **P5 收尾** | 菜单解注释、空状态/错误态、打包验证 | 1 天 | `pnpm build` + `cargo check` 通过，安装包可运行 |

总计约 9 个工作日。P1 与 P2 可并行（前者纯静态数据，后者依赖 ESI）。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 材料取整方式与游戏不一致 | 差 1 件导致利润误判 | 用已知成品反向标定，固化单测快照；界面对「边缘值」标注取整说明 |
| 结构 rig 加成拿不到 | 成本偏高 | 手动配置 + 提供「按常见 rig 预设」快捷填充 |
| 军团作业需要工厂经理角色 | 部分用户看不到军团队列 | 明确提示所需角色权限，失败不阻断角色队列 |
| 蓝图数据 1.5 MB | 首屏变慢 | 动态 `import()`，仅在进入制造业页时加载 |
| `/markets/prices/` 缓存放大了价格偏差 | 利润估算偏乐观/悲观 | 界面标注「参考价，更新于 xx:xx」，并允许手动改价 |
| ESI 错误预算耗尽 | 同步失败 | 统一在 `esi.rs` 加错误预算检查与退避（可先只做提示） |

---

## 10. 关键设计决策

1. **蓝图数据放 JSON 而非 SQLite**：与行星工业一致，避免每次启动迁移大表；5,000 条量级前端筛选足够快
2. **角色蓝图与作业仍落 SQLite**：需要跨会话保留、支持离线查看、支持按产物聚合查询
3. **建筑加成只能手动**：ESI 无此数据，与其猜测不如显式配置，并在计算器里显示「当前假设」
4. **成本口径三分**：材料成本 / 作业费 / 税费分开列示，避免像行星工业那样反复调整总口径
5. **复用市场数据**：本地建筑行情 + Jita 实时价已具备，制造业只做「取价适配层」，不重复造轮子

---

## 11. 验收清单

- [ ] 抽取 10 个典型蓝图（护卫舰、巡洋舰、模块、弹药、T2 组件、反应产物），材料数量与游戏内完全一致
- [ ] 作业费与游戏内「估算作业费」误差 < 2%
- [ ] 角色蓝图列表包含 BPO/BPC 区分、ME/TE、剩余流程、位置
- [ ] 生产队列剩余时间与游戏内误差 < 1 分钟
- [ ] 断网状态下所有已同步数据可正常查看
- [ ] `pnpm exec tsc --noEmit`、`pnpm build`、`cargo check` 全部通过
- [ ] 磁盘与内存：进入制造业页后 JS 堆增量 < 80 MB

---

## 附录 A：ESI 接口速查

```
GET /characters/{character_id}/blueprints/          角色蓝图（分页）
GET /characters/{character_id}/industry/jobs/       角色生产作业（分页）
GET /corporations/{corporation_id}/industry/jobs/   军团生产作业（分页）
GET /characters/{character_id}/skills/              技能等级
GET /industry/systems/                              各星系成本指数（一次全量）
GET /markets/prices/                                adjusted_price / average_price
```

## 附录 B：活动 ID 对照

| activity_id | 含义 |
|---|---|
| 1 | manufacturing（制造） |
| 3 | researching_time_efficiency |
| 4 | researching_material_efficiency |
| 5 | copying |
| 8 | invention |
| 9 | reaction |

## 附录 C：技能 → 加成映射（需内置常量）

| 技能 | 作用 |
|---|---|
| Industry | 制造时间 -4%/级 |
| Advanced Industry | 制造时间 -3%/级 |
| Material Efficiency（旧）/ 现由蓝图与结构决定 | 材料 -
| Reactions | 反应时间 -4%/级 |
| Mass Reactions / Advanced Mass Reactions | 反应槽位与时间 |
| Research / Metallurgy / Science | 研究速度 |
