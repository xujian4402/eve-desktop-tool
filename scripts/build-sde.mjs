/**
 * 从 EVE 官方 SDE（JSONL 版）提取市场物品分类，生成随应用打包的静态资源。
 *
 * 用法：
 *   node scripts/build-sde.mjs [SDE 目录]
 *
 * 默认读取 ../eve-faceless-next/eve-online-static-data，
 * 输出 src-tauri/resources/sde-market-groups.json（编译进二进制，离线可用）。
 *
 * 产物结构：
 *   {
 *     generatedAt: "2026-10-13",
 *     groups: [{ id, name, nameEn, description, parentId, types: [typeId] }],
 *     types:  { [typeId]: "中文名" }
 *   }
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const sdeDir =
  process.argv[2] ??
  path.resolve(process.cwd(), "../eve-faceless-next/eve-online-static-data");

const marketGroupsFile = path.join(sdeDir, "marketGroups.jsonl");
const typesFile = path.join(sdeDir, "types.jsonl");

for (const file of [marketGroupsFile, typesFile]) {
  if (!fs.existsSync(file)) {
    console.error(`找不到 SDE 文件：${file}`);
    process.exit(1);
  }
}

/** 描述截断长度：完整多语言描述体积过大，中文简述已足够界面展示 */
const DESCRIPTION_MAX = 300;

// ---------- 1. 市场分组 ----------
const groups = new Map();
const groupLines = fs
  .readFileSync(marketGroupsFile, "utf8")
  .split("\n")
  .filter((line) => line.trim());

for (const line of groupLines) {
  const row = JSON.parse(line);
  groups.set(row._key, {
    id: row._key,
    name: row.name?.zh ?? row.name?.en ?? `#${row._key}`,
    nameEn: row.name?.en ?? null,
    description: (row.description?.zh ?? row.description?.en ?? "").slice(
      0,
      DESCRIPTION_MAX,
    ),
    parentId: row.parentGroupID ?? null,
    types: [],
  });
}

console.log(`分组：${groups.size}`);

// ---------- 2. 物品类型（流式，types.jsonl 约 150MB） ----------
const typeNames = {};
let typeCount = 0;
let orphanTypes = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(typesFile),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line.trim()) continue;

  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }

  const id = row._key;
  if (!id) continue;

  const name = row.name?.zh ?? row.name?.en;
  if (name) {
    typeNames[id] = name;
    typeCount += 1;
  }

  const groupId = row.marketGroupID;
  if (!groupId) continue;

  const group = groups.get(groupId);
  if (group) group.types.push(id);
  else orphanTypes += 1;
}

console.log(`物品：${typeCount}（marketGroupID 指向不存在分组：${orphanTypes}）`);

// ---------- 3. 输出 ----------
const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  groups: [...groups.values()],
  types: typeNames,
};

const outDir = path.resolve(process.cwd(), "src-tauri/resources");
fs.mkdirSync(outDir, { recursive: true });

const outFile = path.join(outDir, "sde-market-groups.json");
fs.writeFileSync(outFile, JSON.stringify(payload), "utf8");

const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`已写入 ${outFile}（${sizeKb} KB）`);
