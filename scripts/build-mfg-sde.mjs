/**
 * 从 EVE 官方 SDE（JSONL 版）提取「制造业」所需数据，生成随应用打包的静态资源。
 *
 * 用法：
 *   node scripts/build-mfg-sde.mjs [SDE 目录]
 *
 * 默认读取 eve-online-static-data/，输出 src-tauri/resources/mfg-sde.json
 * （由 Rust 侧 include_str! 内嵌，离线可用）。
 *
 * 产物结构：
 *   {
 *     generatedAt: "2026-11-12",
 *     blueprints: [{ p, bp, q, t, act, maxRuns, mats: [[id,qty]], skills: [[id,lv]] }],
 *     inventions: [{ t2, t1, prob, runs, t, mats: [[id,qty]], skills: [[id,lv]] }],
 *     research:   [{ bp, me, te, copy }],
 *     types:      { [typeId]: [中文名, 英文名, 分组ID, 体积] },
 *     decryptors: [...], facilities: [...], rigs: [...]   // 内置常量表
 *   }
 *
 * 说明：
 * - NPC 军团是否售卖蓝图（npc_sold）暂不导入，P5 做「NPC 蓝图」页时再补。
 * - 解码器 / 建筑 / rig 属于游戏机制常量，直接写在脚本里，避免再依赖一份 SDE。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const sdeDir =
  process.argv[2] ?? path.resolve(process.cwd(), "eve-online-static-data");
const outFile = path.resolve(process.cwd(), "src-tauri/resources/mfg-sde.json");

const blueprintsFile = path.join(sdeDir, "blueprints.jsonl");
const typesFile = path.join(sdeDir, "types.jsonl");
const npcCorpFile = path.join(sdeDir, "npcCorporations.jsonl");
const solarSystemsFile = path.join(sdeDir, "mapSolarSystems.jsonl");

for (const file of [blueprintsFile, typesFile]) {
  if (!fs.existsSync(file)) {
    console.error(`找不到 SDE 文件：${file}`);
    process.exit(1);
  }
}

const optional = (file) => fs.existsSync(file);

/** 逐行读取 JSONL */
async function* readJsonl(file) {
  const stream = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of stream) {
    const text = line.trim();
    if (!text) continue;
    try {
      yield JSON.parse(text);
    } catch {
      // 跳过损坏行
    }
  }
}

/* ============================================================
   内置常量：解码器 / 建筑 / 改装件
   ============================================================ */

/** 8 个发明解码器（参数取自游戏机制） */
const DECRYPTORS = [
  { typeId: 12836, name: "校准数据", prob: 1.1, me: 2, te: 2, runs: 1 },
  { typeId: 12958, name: "加速器", prob: 1.2, me: 2, te: 10, runs: -2 },
  { typeId: 12180, name: "先进系统数据", prob: 0.9, me: 0, te: 0, runs: 4 },
  { typeId: 12182, name: "先进材料数据", prob: 0.8, me: 3, te: 0, runs: 0 },
  { typeId: 12184, name: "先进复合数据", prob: 0.9, me: 2, te: 0, runs: 0 },
  { typeId: 12186, name: "先进武器数据", prob: 1.2, me: 0, te: 4, runs: 0 },
  { typeId: 12188, name: "先进反应堆数据", prob: 1.1, me: 0, te: 2, runs: 2 },
  { typeId: 12190, name: "先进感应器数据", prob: 0.8, me: 0, te: 0, runs: 0 },
];

/** 建筑类型：me/te/cost 为百分比，tax 为设施税（可覆盖） */
const FACILITIES = [
  {
    typeId: 0,
    name: "NPC 空间站",
    category: "npc",
    me: 0,
    te: 0,
    cost: 0,
    tax: 0,
    rigSlots: 0,
  },
  {
    typeId: 35825,
    name: "莱塔卢",
    category: "engineering",
    me: 1,
    te: 15,
    cost: 3,
    tax: 0.5,
    rigSlots: 3,
  },
  {
    typeId: 35826,
    name: "阿兹贝尔",
    category: "engineering",
    me: 1,
    te: 20,
    cost: 4,
    tax: 0.5,
    rigSlots: 3,
  },
  {
    typeId: 35827,
    name: "索迪约",
    category: "engineering",
    me: 1,
    te: 30,
    cost: 5,
    tax: 0.5,
    rigSlots: 3,
  },
  {
    typeId: 35835,
    name: "阿塔诺",
    category: "refinery",
    me: 1,
    te: 50,
    cost: 4,
    tax: 0.5,
    rigSlots: 3,
  },
  {
    typeId: 35836,
    name: "塔塔拉",
    category: "refinery",
    me: 1,
    te: 25,
    cost: 5,
    tax: 0.5,
    rigSlots: 3,
  },
];

/** 常用改装件（T1/T2 制造与反应） */
const RIGS = [
  {
    typeId: 37178,
    name: "Standup M-Set 制造材料效率 I",
    category: "engineering",
    effect: "material",
    bonus: 2,
    highSecOk: 1,
  },
  {
    typeId: 37179,
    name: "Standup M-Set 制造材料效率 II",
    category: "engineering",
    effect: "material",
    bonus: 2.4,
    highSecOk: 1,
  },
  {
    typeId: 37180,
    name: "Standup M-Set 制造时间效率 I",
    category: "engineering",
    effect: "time",
    bonus: 20,
    highSecOk: 1,
  },
  {
    typeId: 37181,
    name: "Standup M-Set 制造时间效率 II",
    category: "engineering",
    effect: "time",
    bonus: 24,
    highSecOk: 1,
  },
  {
    typeId: 46640,
    name: "Standup M-Set 反应材料效率 I",
    category: "refinery",
    effect: "material",
    bonus: 2,
    highSecOk: 1,
  },
  {
    typeId: 46642,
    name: "Standup M-Set 反应时间效率 I",
    category: "refinery",
    effect: "time",
    bonus: 20,
    highSecOk: 1,
  },
];

/* ============================================================
   第一遍：解析蓝图
   ============================================================ */

/** 产品 → 配方。同一产品若既有制造又有反应，优先制造（与参考项目一致） */
const blueprintMap = new Map();
const inventions = [];
const research = [];
/** 需要保存名称的 type id */
const neededTypes = new Set();

function collectMats(list, out) {
  for (const item of list ?? []) {
    const id = item.typeID;
    const qty = item.quantity ?? 0;
    if (!id || qty <= 0) continue;
    out.push([id, qty]);
    neededTypes.add(id);
  }
}

function collectSkills(list, out) {
  for (const item of list ?? []) {
    const id = item.typeID;
    const level = item.level ?? 0;
    if (!id) continue;
    out.push([id, level]);
    neededTypes.add(id);
  }
}

const ACT_KEYS = [
  ["manufacturing", "manufacturing"],
  ["reaction", "reaction"],
];

for await (const bp of readJsonl(blueprintsFile)) {
  const activities = bp.activities ?? {};
  const bpId = bp.blueprintTypeID ?? bp._key;
  if (!bpId) continue;

  neededTypes.add(bpId);

  // 制造 / 反应：每个产品一条记录
  for (const [key, act] of ACT_KEYS) {
    const activity = activities[key];
    if (!activity) continue;

    const products = activity.products ?? [];
    if (products.length === 0) continue;

    const mats = [];
    collectMats(activity.materials, mats);

    const skills = [];
    collectSkills(activity.skills, skills);

    for (const product of products) {
      const productId = product.typeID;
      if (!productId) continue;
      neededTypes.add(productId);

      const existing = blueprintMap.get(productId);
      // 已有的不动，除非当前是制造而原有是反应
      if (existing && !(act === "manufacturing" && existing.act === "reaction")) {
        continue;
      }

      blueprintMap.set(productId, {
        p: productId,
        bp: bpId,
        q: product.quantity ?? 1,
        t: activity.time ?? 0,
        act,
        maxRuns: bp.maxProductionLimit ?? 1,
        mats,
        skills,
      });
    }
  }

  // 发明：本蓝图（T1）→ 产物（T2 蓝图）
  const invention = activities.invention;
  if (invention) {
    const products = invention.products ?? [];
    const t2 = products[0]?.typeID;

    if (t2) {
      neededTypes.add(t2);

      const mats = [];
      collectMats(invention.materials, mats);

      const skills = [];
      collectSkills(invention.skills, skills);

      inventions.push({
        t2,
        t1: bpId,
        prob: products[0]?.probability ?? 0,
        // 发明默认产出 1 流程拷贝，解码器 runs_add 另计
        runs: products[0]?.quantity ?? 1,
        t: invention.time ?? 0,
        mats,
        skills,
      });
    }
  }

  // 研究 / 拷贝
  const meTime = activities.research_material?.time ?? 0;
  const teTime = activities.research_time?.time ?? 0;
  const copyTime = activities.copying?.time ?? 0;

  if (meTime || teTime || copyTime) {
    research.push({ bp: bpId, me: meTime, te: teTime, copy: copyTime });
  }
}

/* ============================================================
   第二遍：只取需要的类型名
   ============================================================ */

const types = {};
/** 仅用于计算 NPC 售价，不输出到前端 */
const basePrices = {};

for await (const type of readJsonl(typesFile)) {
  const id = type._key;
  if (!id || !neededTypes.has(id)) continue;

  const name = type.name ?? {};
  types[id] = [
    name.zh ?? name.en ?? `#${id}`,
    name.en ?? "",
    type.groupID ?? 0,
    type.volume ?? 0,
  ];
  basePrices[id] = type.basePrice ?? 0;
}

/* ============================================================
   第三遍：NPC 蓝图（军团售卖）与星系安全等级
   ============================================================ */

/** 蓝图 typeID 集合，用于过滤军团交易里的非蓝图物品 */
const blueprintTypeIds = new Set(
  [...blueprintMap.values()].map((item) => item.bp),
);

/** { bpTypeId: { price, corps: [corpId] } } */
const npcBlueprints = {};
/** { corpId: [name, factionId, solarSystemId] } */
const npcCorps = {};

if (optional(npcCorpFile)) {
  for await (const corp of readJsonl(npcCorpFile)) {
    const corpId = corp._key;
    const trades = corp.corporationTrades;
    if (!corpId || !Array.isArray(trades) || trades.length === 0) continue;

    const name = corp.name ?? {};
    npcCorps[corpId] = [
      name.zh ?? name.en ?? `#${corpId}`,
      corp.factionID ?? 0,
      corp.solarSystemID ?? 0,
    ];

    for (const trade of trades) {
      const bpId = trade._key;
      if (!bpId || !blueprintTypeIds.has(bpId)) continue;

      // 军团价格 = 蓝图基础价 × 交易系数
      const price = (basePrices[bpId] ?? 0) * (trade._value ?? 0);
      if (!(price > 0)) continue;

      if (!npcBlueprints[bpId]) {
        npcBlueprints[bpId] = { price: Math.round(price), corps: [] };
      }
      npcBlueprints[bpId].corps.push(corpId);
    }
  }
}

/** { solarSystemId: [name, security] } */
const solarSystems = {};

if (optional(solarSystemsFile)) {
  for await (const system of readJsonl(solarSystemsFile)) {
    const id = system._key;
    if (!id) continue;

    const name = system.name ?? {};
    solarSystems[id] = [
      name.zh ?? name.en ?? `#${id}`,
      system.security ?? 0,
    ];
  }
}

/* ============================================================
   输出
   ============================================================ */

const blueprints = [...blueprintMap.values()];

const payload = {
  generatedAt: new Date().toISOString(),
  blueprints,
  inventions,
  research,
  types,
  decryptors: DECRYPTORS,
  facilities: FACILITIES,
  rigs: RIGS,
  npcBlueprints,
  npcCorps,
  solarSystems,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(payload), "utf8");

const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);

console.log(
  [
    `蓝图 ${blueprints.length} 条`,
    `发明 ${inventions.length} 条`,
    `研究 ${research.length} 条`,
    `类型 ${Object.keys(types).length} 个`,
    `输出 ${outFile}（${sizeMb} MB）`,
  ].join("\n"),
);
