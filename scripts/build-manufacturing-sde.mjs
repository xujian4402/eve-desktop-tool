/**
 * 生成制造业静态数据。
 *
 * 数据来源：eve-online-static-data/
 *   blueprints.jsonl  蓝图活动（材料、产出、时间）
 *   types.jsonl       类型名称
 *
 * 输出：src/data/manufacturing/blueprints.json
 *   { types: { id: 名称 }, recipes: [{ 蓝图, 产出, 活动, 时间, 材料 }] }
 *
 * 只保留「制造」与「反应」两类活动：发明/复制/研究的时间在 v1 用不到，
 * 保留它们会让 JSON 体积翻倍却没有消费方。
 */
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdeDir = join(root, "eve-online-static-data");
const outFile = join(root, "src", "data", "manufacturing", "blueprints.json");

/** 逐行读取 jsonl */
async function readJsonl(file, onRow) {
  const rl = createInterface({
    input: createReadStream(join(sdeDir, file), "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    onRow(JSON.parse(line));
  }
}

const recipes = [];
/** 需要翻译名称的类型：材料 + 产物 + 蓝图本体 */
const neededTypes = new Set();
let skipped = 0;

await readJsonl("blueprints.jsonl", (bp) => {
  const activities = bp.activities ?? {};

  for (const [activity, key] of [
    ["manufacturing", "manufacturing"],
    ["reaction", "reaction"],
  ]) {
    const detail = activities[activity];
    if (!detail) continue;

    const products = detail.products ?? [];
    const materials = detail.materials ?? [];
    if (products.length === 0 || materials.length === 0) {
      skipped += 1;
      continue;
    }

    // 极少数蓝图有多个产物，v1 只取主产物
    const [main] = products;

    recipes.push({
      blueprintTypeId: bp.blueprintTypeID,
      productTypeId: main.typeID,
      productQuantity: main.quantity,
      activity: key,
      time: detail.time ?? 0,
      maxProductionLimit: bp.maxProductionLimit ?? 1,
      materials: materials.map((item) => ({
        typeId: item.typeID,
        quantity: item.quantity,
      })),
    });

    neededTypes.add(bp.blueprintTypeID);
    neededTypes.add(main.typeID);
    for (const item of materials) neededTypes.add(item.typeID);
  }
});

const types = {};
await readJsonl("types.jsonl", (type) => {
  if (!neededTypes.has(type._key)) return;
  const name = type.name?.zh || type.name?.en || `#${type._key}`;
  types[type._key] = name;
});

await mkdir(dirname(outFile), { recursive: true });
await writeFile(
  outFile,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    types,
    recipes,
  }),
);

const totalMaterials = recipes.reduce((sum, r) => sum + r.materials.length, 0);

console.log(
  [
    `蓝图配方: ${recipes.length} 条（跳过 ${skipped}）`,
    `覆盖物品: ${Object.keys(types).length} 种`,
    `材料条目: ${totalMaterials} 条`,
    `输出: ${outFile}`,
  ].join("\n"),
);
