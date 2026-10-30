/**
 * 从 EVE 官方 SDE（JSONL 版）提取「行星工业」配方数据，生成前端可直接 import 的 JSON。
 *
 * 用法：
 *   node scripts/build-pi-sde.mjs [SDE 目录]
 *
 * 默认读取 eve-online-static-data/，输出到 src/data/pi/pi-schematics.json：
 *   - schematics：68 个配方（已算好等级 / 适用行星 / 设施档位）
 *   - p0：15 种原始资源
 *   - types：配方涉及的类型 ID → 中文名
 *
 * 说明：types.jsonl 约 147MB，只回填行星工业涉及的 ~200 个类型名，
 *      其余行只做一次 JSON.parse 判断 key 后丢弃。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const sdeDir =
  process.argv[2] ?? path.resolve(process.cwd(), "eve-online-static-data");
const outDir = path.resolve(process.cwd(), "src/data/pi");
const outFile = path.join(outDir, "pi-schematics.json");

const FACILITY_HIGH_TECH = "高科技工厂";
const FACILITY_ADVANCED = "高级工业设施";
const FACILITY_BASIC = "基础工业设施";

function sdeFile(name) {
  const full = path.join(sdeDir, name);
  if (!fs.existsSync(full)) {
    console.error(`找不到 SDE 文件：${full}`);
    process.exit(1);
  }
  return full;
}

/** 流式逐行读取 JSONL */
async function* readJsonl(name) {
  const rl = readline.createInterface({
    input: fs.createReadStream(sdeFile(name)),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // 跳过坏行
    }
  }
}

/** 多语言字段取名：中文优先，回退英文 */
function zh(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  return value.zh ?? value.en ?? fallback;
}

function en(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  return value.en ?? value.zh ?? fallback;
}

/** 由设施名取出行星类型： 「贫瘠行星高科技工厂」→「贫瘠行星」 */
function planetTypeOf(pinName) {
  const hit = /([^\s]+行星)/.exec(pinName ?? "");
  return hit ? hit[1] : null;
}

/** 由设施名判断档位 */
function facilityOf(pinNames) {
  if (pinNames.some((n) => n.includes("高科技工厂") || n.includes("High-Tech")))
    return FACILITY_HIGH_TECH;
  if (
    pinNames.some((n) => n.includes("高级工业设施") || n.includes("Advanced"))
  )
    return FACILITY_ADVANCED;
  return FACILITY_BASIC;
}

async function main() {
  console.log(`[pi-sde] 数据目录：${sdeDir}`);

  /* ---------------- 1. 配方 ---------------- */
  const schematicDrafts = [];
  const neededTypeIds = new Set();

  for await (const row of readJsonl("planetSchematics.jsonl")) {
    const pins = Array.isArray(row.pins) ? row.pins.map(Number) : [];
    pins.forEach((id) => neededTypeIds.add(id));

    const materials = Array.isArray(row.types) ? row.types : [];
    materials.forEach((m) => neededTypeIds.add(Number(m._key)));

    schematicDrafts.push({
      id: Number(row._key),
      name: zh(row.name, `配方 #${row._key}`),
      nameEn: en(row.name, ""),
      cycleTime: Number(row.cycleTime ?? 0),
      pins,
      materials: materials.map((m) => ({
        typeId: Number(m._key),
        quantity: Number(m.quantity ?? 0),
        isInput: Boolean(m.isInput),
      })),
    });
  }
  console.log(`[pi-sde] 配方 ${schematicDrafts.length} 个`);

  /* ---------------- 2. 类型名称（流式，147MB） ---------------- */
  const typeNames = new Map();
  for await (const row of readJsonl("types.jsonl")) {
    const id = Number(row._key);
    if (!neededTypeIds.has(id)) continue;
    typeNames.set(id, {
      zh: zh(row.name, `#${id}`),
      en: en(row.name, ""),
    });
  }
  console.log(`[pi-sde] 类型名 ${typeNames.size} / 需要 ${neededTypeIds.size}`);
  const nameOf = (id) => typeNames.get(id)?.zh ?? `#${id}`;

  /* ---------------- 2.5 星系 → 行星类型分布 ---------------- */
  const PLANET_TYPE_BY_ID = new Map([
    [11, "温和行星"],
    [12, "冰体行星"],
    [13, "气体行星"],
    [2014, "海洋行星"],
    [2015, "熔岩行星"],
    [2016, "贫瘠行星"],
    [2017, "风暴行星"],
    [2063, "等离子行星"],
  ]);

  const systemMeta = new Map();
  for await (const row of readJsonl("mapSolarSystems.jsonl")) {
    systemMeta.set(Number(row._key), {
      name: zh(row.name, String(row._key)),
      security: Number(row.securityStatus ?? 0),
      regionId: Number(row.regionID),
    });
  }

  const regionNames = new Map();
  for await (const row of readJsonl("mapRegions.jsonl")) {
    regionNames.set(Number(row._key), zh(row.name, ""));
  }

  const planetCounts = new Map();
  for await (const row of readJsonl("mapPlanets.jsonl")) {
    const systemId = Number(row.solarSystemID);
    const typeId = Number(row.typeID);
    if (!PLANET_TYPE_BY_ID.has(typeId)) continue;
    const counts = planetCounts.get(systemId) ?? new Map();
    counts.set(typeId, (counts.get(typeId) ?? 0) + 1);
    planetCounts.set(systemId, counts);
  }

  const systemRows = [...planetCounts]
    .map(([systemId, counts]) => {
      const meta = systemMeta.get(systemId);
      return {
        id: systemId,
        name: meta?.name ?? `#${systemId}`,
        security: Number((meta?.security ?? 0).toFixed(2)),
        region: regionNames.get(meta?.regionId ?? 0) ?? "",
        planets: Object.fromEntries(counts),
      };
    })
    .sort((a, b) => a.id - b.id);

  console.log(`[pi-sde] 含行星的星系 ${systemRows.length} 个`);

  /* ---------------- 3. 组装配方视图 ---------------- */
  const drafts = schematicDrafts.map((s) => {
    const pinNames = s.pins.map((id) => nameOf(id));
    const inputs = s.materials
      .filter((m) => m.isInput)
      .map((m) => ({
        typeId: m.typeId,
        name: nameOf(m.typeId),
        quantity: m.quantity,
      }));
    const outputs = s.materials
      .filter((m) => !m.isInput)
      .map((m) => ({
        typeId: m.typeId,
        name: nameOf(m.typeId),
        quantity: m.quantity,
      }));

    const planetTypes = [
      ...new Set(pinNames.map(planetTypeOf).filter((v) => v !== null)),
    ];

    return {
      id: s.id,
      name: s.name,
      nameEn: s.nameEn,
      cycleTime: s.cycleTime,
      outputTypeId: outputs[0]?.typeId ?? 0,
      facility: facilityOf(pinNames),
      planetTypes,
      inputs,
      outputs,
    };
  });

  const byOutput = new Map(drafts.map((d) => [d.outputTypeId, d]));

  // 等级推导：输入全是「非产出物」的是 P1，其余 = 上游最大等级 + 1
  const tierMap = new Map();
  for (const d of drafts) {
    if (d.inputs.every((i) => !byOutput.has(i.typeId)))
      tierMap.set(d.outputTypeId, 1);
  }
  for (let round = 0; round < 6; round += 1) {
    let changed = false;
    for (const d of drafts) {
      const levels = d.inputs.map((i) => tierMap.get(i.typeId));
      if (levels.some((l) => l === undefined)) continue;
      const tier = Math.max(...levels) + 1;
      if (tierMap.get(d.outputTypeId) !== tier && tier <= 4) {
        tierMap.set(d.outputTypeId, tier);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const schematics = drafts
    .map((d) => ({ ...d, tier: tierMap.get(d.outputTypeId) ?? 1 }))
    .sort((a, b) => a.tier - b.tier || a.id - b.id);

  const outputTypeIds = new Set(schematics.map((s) => s.outputTypeId));
  const p0Set = new Map();
  for (const s of schematics) {
    for (const i of s.inputs) {
      if (!outputTypeIds.has(i.typeId)) p0Set.set(i.typeId, i.name);
    }
  }
  const p0 = [...p0Set]
    .map(([typeId, name]) => ({ typeId, name }))
    .sort((a, b) => a.typeId - b.typeId);

  console.log(
    `[pi-sde] 等级分布：${[1, 2, 3, 4]
      .map((t) => `P${t} ${schematics.filter((s) => s.tier === t).length}`)
      .join(" / ")}，P0 ${p0.length} 种`,
  );

  /* ---------------- 4. 写出 ---------------- */
  fs.mkdirSync(outDir, { recursive: true });

  const payload = {
    generatedAt: new Date().toISOString().slice(0, 10),
    schematics,
    p0,
    types: Object.fromEntries([...typeNames].map(([id, value]) => [id, value.zh])),
  };

  const body = JSON.stringify(payload);
  fs.writeFileSync(outFile, body, "utf8");
  console.log(`[pi-sde] pi-schematics.json  ${(body.length / 1024).toFixed(1)} KB`);

  const systemPayload = {
    generatedAt: payload.generatedAt,
    systems: systemRows,
  };
  const systemBody = JSON.stringify(systemPayload);
  fs.writeFileSync(path.join(outDir, "pi-systems.json"), systemBody, "utf8");
  console.log(
    `[pi-sde] pi-systems.json  ${(systemBody.length / 1024).toFixed(1)} KB`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
