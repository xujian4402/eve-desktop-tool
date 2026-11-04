import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

/**
 * 本地 SQLite 访问层。
 *
 * 库文件位置由 tauri-plugin-sql 决定（应用数据目录下的 eve.db），
 * 建表语句在 src-tauri/migrations/0001_market_init.sql，随应用启动自动迁移。
 */

export interface EveCharacter {
  character_id: number;
  name: string;
  corporation_id: number | null;
  corporation_name: string | null;
  alliance_id: number | null;
  alliance_name: string | null;
  portrait_url: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export interface MarketStructure {
  structure_id: number;
  name: string | null;
  solar_system_id: number | null;
  solar_system_name: string | null;
  region_id: number | null;
  type_id: number | null;
  owner_id: number | null;
  resolve_status: string;
  resolve_error: string | null;
  auth_character_id: number | null;
  sync_enabled: number;
  sync_interval_min: number;
  last_synced_at: number | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  order_count: number;
  /** 是否开放市场：市场页的建筑订单只列出 has_market = 1 的建筑 */
  has_market: number;
  created_at: number;
  updated_at: number;
}

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:eve.db");
  }
  return dbPromise;
}

export async function listCharacters(): Promise<EveCharacter[]> {
  const db = await getDb();
  return db.select<EveCharacter[]>(
    "SELECT * FROM eve_character ORDER BY is_active DESC, name ASC",
  );
}

export async function getActiveCharacter(): Promise<EveCharacter | null> {
  const db = await getDb();
  const rows = await db.select<EveCharacter[]>(
    "SELECT * FROM eve_character WHERE is_active = 1 LIMIT 1",
  );
  return rows[0] ?? null;
}

/**
 * 读取已录入的建筑。
 * @param onlyWithMarket 为 true 时只返回开放市场的建筑（市场页「建筑订单」用）
 */
export async function listStructures(
  onlyWithMarket = false,
): Promise<MarketStructure[]> {
  const db = await getDb();
  const where = onlyWithMarket ? "WHERE has_market = 1" : "";
  return db.select<MarketStructure[]>(
    `SELECT * FROM market_structure ${where} ORDER BY sync_enabled DESC, name ASC`,
  );
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM app_setting WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO app_setting (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()],
  );
}

/** Rust 侧 eve_login 命令的返回结构 */
export interface LoginResult {
  characterId: number;
  name: string;
  corporationId: number | null;
  corporationName: string | null;
  allianceId: number | null;
  allianceName: string | null;
  birthday: string | null;
  securityStatus: number | null;
  scopes: string[];
  expiresAt: number;
}

/** 授权成功后落库：该角色成为当前选中角色 */
export async function saveCharacter(result: LoginResult): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  await db.execute("UPDATE eve_character SET is_active = 0 WHERE is_active = 1");

  await db.execute(
    `INSERT INTO eve_character
       (character_id, name, corporation_id, corporation_name, alliance_id,
        alliance_name, birthday, security_status, portrait_url, is_active,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10)
     ON CONFLICT(character_id) DO UPDATE SET
       name             = excluded.name,
       corporation_id   = excluded.corporation_id,
       corporation_name = excluded.corporation_name,
       alliance_id      = excluded.alliance_id,
       alliance_name    = excluded.alliance_name,
       birthday         = excluded.birthday,
       security_status  = excluded.security_status,
       portrait_url     = excluded.portrait_url,
       is_active        = 1,
       updated_at       = excluded.updated_at`,
    [
      result.characterId,
      result.name,
      result.corporationId,
      result.corporationName,
      result.allianceId,
      result.allianceName,
      result.birthday,
      result.securityStatus,
      `https://images.evetech.net/characters/${result.characterId}/portrait?size=64`,
      now,
    ],
  );

  // access_token 只做展示用途，权威副本由 Rust 侧按需刷新
  await db.execute(
    `INSERT INTO eve_token (character_id, access_token, scopes, token_type, expires_at, updated_at)
     VALUES ($1, NULL, $2, 'Bearer', $3, $4)
     ON CONFLICT(character_id) DO UPDATE SET
       scopes     = excluded.scopes,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
    [result.characterId, JSON.stringify(result.scopes), result.expiresAt, now],
  );
}

/** 切换当前角色 */
export async function setActiveCharacter(characterId: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE eve_character SET is_active = 0 WHERE is_active = 1");
  await db.execute(
    "UPDATE eve_character SET is_active = 1, updated_at = $2 WHERE character_id = $1",
    [characterId, Date.now()],
  );
}

/**
 * 解绑角色：删除钥匙串凭据 + 该角色在本地的全部数据。
 *
 * 除了 eve_character（eve_token 由外键 ON DELETE CASCADE 跟随删除），
 * 还要清掉没有外键约束的业务数据：角色订单、同步任务、行星工业库存快照。
 * 否则重新授权同一个角色后，旧订单/旧库存会当成最新数据继续显示。
 */
export async function removeCharacter(characterId: number): Promise<void> {
  await invoke("eve_logout", { characterId });
  const db = await getDb();

  await db.execute("DELETE FROM character_order WHERE character_id = $1", [
    characterId,
  ]);
  await db.execute("DELETE FROM sync_task WHERE character_id = $1", [
    characterId,
  ]);
  await db.execute("DELETE FROM pi_stock WHERE character_id = $1", [
    characterId,
  ]);
  await db.execute("DELETE FROM eve_character WHERE character_id = $1", [
    characterId,
  ]);

  // 一个角色都不剩时，把合并库存快照（character_id 为 NULL）与残留订单一并清掉
  const remaining = await db.select<{ total: number }[]>(
    "SELECT COUNT(*) AS total FROM eve_character",
  );
  if ((remaining[0]?.total ?? 0) === 0) {
    await db.execute("DELETE FROM pi_stock", []);
    await db.execute("DELETE FROM character_order", []);
    await db.execute("DELETE FROM sync_task", []);
  }
}

/** 读取某角色已获得的授权作用域 */
export async function getCharacterScopes(characterId: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ scopes: string }[]>(
    "SELECT scopes FROM eve_token WHERE character_id = $1",
    [characterId],
  );
  if (!rows[0]?.scopes) return [];
  try {
    const parsed: unknown = JSON.parse(rows[0].scopes);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** unix 毫秒 → 本地时间字符串，空值显示占位 */
export function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/* ============================================================
   星城解析与订单同步
   ============================================================ */

export interface StructureInfo {
  structureId: number;
  name: string;
  solarSystemId: number | null;
  solarSystemName: string | null;
  typeId: number | null;
  ownerId: number | null;
  /** 是否开放市场（由 Rust 侧探测订单接口得出） */
  hasMarket: boolean;
}

export interface OrderRow {
  orderId: number;
  typeId: number;
  isBuyOrder: boolean;
  price: number;
  volumeRemain: number;
  volumeTotal: number;
  minVolume: number;
  duration: number;
  issued: string;
  range: string;
  locationId: number;
  regionId?: number | null;
  systemId?: number | null;
  escrow?: number | null;
  isCorporation?: boolean | null;
}

export interface OrdersPayload {
  orders: OrderRow[];
  fetchedAt: number;
  truncated: boolean;
  /** ESI 缓存到期时间（unix 毫秒），在此之前重复同步拿到的仍是同一份数据 */
  cacheExpiresAt?: number | null;
}

/** 批量语句的分片行数：13 列 × 200 行 = 2600 个参数，低于 SQLite 参数上限 */
const BATCH_ROWS = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/** 保存或更新星城信息（同一建筑重复添加视为刷新） */
export async function upsertStructure(
  info: StructureInfo,
  characterId: number,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  await db.execute(
    `INSERT INTO market_structure
       (structure_id, name, solar_system_id, solar_system_name, type_id, owner_id,
        resolve_status, resolve_error, auth_character_id, has_market,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'ok', NULL, $7, $8, $9, $9)
     ON CONFLICT(structure_id) DO UPDATE SET
       name              = excluded.name,
       solar_system_id   = excluded.solar_system_id,
       solar_system_name = excluded.solar_system_name,
       type_id           = excluded.type_id,
       owner_id          = excluded.owner_id,
       resolve_status    = 'ok',
       resolve_error     = NULL,
       auth_character_id = excluded.auth_character_id,
       has_market        = excluded.has_market,
       updated_at        = excluded.updated_at`,
    [
      info.structureId,
      info.name,
      info.solarSystemId,
      info.solarSystemName,
      info.typeId,
      info.ownerId,
      characterId,
      info.hasMarket ? 1 : 0,
      now,
    ],
  );
}

export async function removeStructure(structureId: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM market_structure_order WHERE structure_id = $1", [
    structureId,
  ]);
  await db.execute("DELETE FROM market_structure WHERE structure_id = $1", [
    structureId,
  ]);
}

/** 记录一次同步的结果 */
export async function markStructureSync(
  structureId: number,
  status: "ok" | "error",
  error: string | null,
  orderCount: number,
  syncedAt: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE market_structure
        SET last_synced_at = $2,
            last_sync_status = $3,
            last_sync_error = $4,
            order_count = $5,
            updated_at = $6
      WHERE structure_id = $1`,
    [structureId, syncedAt, status, error, orderCount, Date.now()],
  );
}

/**
 * 写入一批建筑订单。
 *
 * 采用「upsert 本次全部 + 清理本次未出现」而非「先清空再插入」：
 * 中途失败时旧数据仍在，不会出现空列表；synced_at 同时充当本轮标记。
 */
export async function saveStructureOrders(
  structureId: number,
  orders: OrderRow[],
  fetchedAt: number,
): Promise<void> {
  const db = await getDb();

  for (const batch of chunk(orders, BATCH_ROWS)) {
    const values: string[] = [];
    const params: unknown[] = [];

    batch.forEach((order, index) => {
      const base = index * 13;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${
          base + 6
        }, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${
          base + 12
        }, $${base + 13})`,
      );
      params.push(
        order.orderId,
        structureId,
        order.typeId,
        order.isBuyOrder ? 1 : 0,
        order.price,
        order.volumeRemain,
        order.volumeTotal,
        order.minVolume,
        order.duration,
        Date.parse(order.issued) || fetchedAt,
        order.range,
        order.locationId,
        fetchedAt,
      );
    });

    await db.execute(
      `INSERT INTO market_structure_order
         (order_id, structure_id, type_id, is_buy_order, price, volume_remain,
          volume_total, min_volume, duration, issued_at, range, location_id, synced_at)
       VALUES ${values.join(", ")}
       ON CONFLICT(order_id) DO UPDATE SET
         price         = excluded.price,
         volume_remain = excluded.volume_remain,
         volume_total  = excluded.volume_total,
         min_volume    = excluded.min_volume,
         issued_at     = excluded.issued_at,
         synced_at     = excluded.synced_at`,
      params,
    );
  }

  // 本轮未出现的订单已经成交或被撤单
  await db.execute(
    "DELETE FROM market_structure_order WHERE structure_id = $1 AND synced_at < $2",
    [structureId, fetchedAt],
  );
}

/** 写入角色自己的订单，策略同上 */
export async function saveCharacterOrders(
  characterId: number,
  orders: OrderRow[],
  fetchedAt: number,
): Promise<void> {
  const db = await getDb();

  for (const batch of chunk(orders, BATCH_ROWS)) {
    const values: string[] = [];
    const params: unknown[] = [];

    batch.forEach((order, index) => {
      const base = index * 16;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${
          base + 6
        }, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${
          base + 12
        }, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16})`,
      );
      params.push(
        order.orderId,
        characterId,
        order.typeId,
        order.locationId,
        order.regionId ?? 0,
        order.isBuyOrder ? 1 : 0,
        order.price,
        order.volumeRemain,
        order.volumeTotal,
        order.minVolume,
        order.duration,
        Date.parse(order.issued) || fetchedAt,
        order.range,
        order.escrow ?? null,
        order.isCorporation ? 1 : 0,
        fetchedAt,
      );
    });

    await db.execute(
      `INSERT INTO character_order
         (order_id, character_id, type_id, location_id, region_id, is_buy_order,
          price, volume_remain, volume_total, min_volume, duration, issued_at,
          range, escrow, is_corporation, synced_at)
       VALUES ${values.join(", ")}
       ON CONFLICT(order_id) DO UPDATE SET
         price         = excluded.price,
         volume_remain = excluded.volume_remain,
         volume_total  = excluded.volume_total,
         escrow        = excluded.escrow,
         synced_at     = excluded.synced_at`,
      params,
    );
  }

  await db.execute(
    "DELETE FROM character_order WHERE character_id = $1 AND synced_at < $2",
    [characterId, fetchedAt],
  );
}

export interface CharacterOrderView {
  order_id: number;
  type_id: number;
  /** 物品名称（来自 eve_type，可能为 null） */
  type_name: string | null;
  /** 挂单位置名称（已收录建筑才有名字，否则为 null） */
  location_name: string | null;
  /** 挂单持续天数 */
  duration: number;
  location_id: number;
  region_id: number;
  is_buy_order: number;
  price: number;
  volume_remain: number;
  volume_total: number;
  min_volume: number;
  issued_at: number;
  range: string;
  escrow: number | null;
  is_corporation: number;
}

export async function listCharacterOrders(
  characterId: number,
): Promise<CharacterOrderView[]> {
  const db = await getDb();
  return db.select<CharacterOrderView[]>(
    `SELECT o.order_id, o.type_id, o.location_id, o.region_id, o.is_buy_order,
            o.price, o.volume_remain, o.volume_total, o.min_volume, o.duration,
            o.issued_at, o.range, o.escrow, o.is_corporation,
            COALESCE(t.name_zh, t.name_en) AS type_name,
            s.name AS location_name
       FROM character_order o
       LEFT JOIN eve_type t ON t.type_id = o.type_id
       LEFT JOIN market_structure s ON s.structure_id = o.location_id
      WHERE o.character_id = $1
      ORDER BY o.is_buy_order ASC, o.price DESC`,
    [characterId],
  );
}

export interface StructureOrderView {
  order_id: number;
  type_id: number;
  is_buy_order: number;
  price: number;
  volume_remain: number;
  volume_total: number;
  min_volume: number;
  issued_at: number;
  range: string;
}

/* ---------- 资产（来自 Rust fetch_character_assets） ---------- */

export interface AssetItem {
  typeId: number;
  typeName: string | null;
  quantity: number;
  locationFlag: string;
  isBlueprintCopy: boolean;
}

export interface AssetGroup {
  locationId: number;
  locationKind: "structure" | "station" | "system";
  locationName: string;
  items: AssetItem[];
  totalQuantity: number;
}

export interface AssetsPayload {
  groups: AssetGroup[];
  assetCount: number;
  /** 资产条数超过分页上限时为 true，提示结果不完整 */
  truncated: boolean;
}

/** 「同步建筑」通过五源汇总发现的玩家建筑 */
export interface DiscoveredStructure {
  structureId: number;
  /** 无访问权限时为 null */
  name: string | null;
  solarSystemId: number | null;
  solarSystemName: string | null;
  typeId: number | null;
  ownerId: number | null;
  /** 由哪些来源发现：挂单 / 资产 / 合同 / 所在 / 军团 */
  sources: string[];
  hasMarket: boolean;
  accessible: boolean;
}

export interface StructureSyncResult {
  structures: DiscoveredStructure[];
  notes: string[];
  candidateCount: number;
  truncated: boolean;
}

/** 批量保存同步到的建筑（仅写入能解析到信息的那些） */
export async function saveDiscoveredStructures(
  structures: DiscoveredStructure[],
  characterId: number,
): Promise<number> {
  const usable = structures.filter(
    (item) => item.accessible && item.name !== null,
  );

  for (const item of usable) {
    await upsertStructure(
      {
        structureId: item.structureId,
        name: item.name as string,
        solarSystemId: item.solarSystemId,
        solarSystemName: item.solarSystemName,
        typeId: item.typeId,
        ownerId: item.ownerId,
        hasMarket: item.hasMarket,
      },
      characterId,
    );
  }

  return usable.length;
}

export async function listStructureOrders(
  structureId: number,
  limit = 200,
): Promise<StructureOrderView[]> {
  const db = await getDb();
  return db.select<StructureOrderView[]>(
    `SELECT order_id, type_id, is_buy_order, price, volume_remain, volume_total,
            min_volume, issued_at, range
       FROM market_structure_order
      WHERE structure_id = $1
      ORDER BY is_buy_order ASC, price DESC
      LIMIT $2`,
    [structureId, limit],
  );
}

/* ============================================================
   市场物品分类（market groups）
   ============================================================ */

export interface MarketGroupRow {
  market_group_id: number;
  name: string;
  name_en: string | null;
  description: string;
  parent_group_id: number | null;
  /** 直属物品类型 ID 的 JSON 数组 */
  types: string;
  synced_at: number;
}

export interface MarketGroupSyncResult {
  totalIds: number;
  synced: number;
  failed: number;
  removed: number;
  typeNames: number;
}

export async function listMarketGroups(): Promise<MarketGroupRow[]> {
  const db = await getDb();
  return db.select<MarketGroupRow[]>(
    "SELECT * FROM market_group ORDER BY name ASC",
  );
}

/** 物品类型 ID → 名称（来自 eve_type，中英文优先取中文） */
export async function getTypeNameMap(): Promise<Record<number, string>> {
  const db = await getDb();
  const rows = await db.select<{ type_id: number; name: string | null }[]>(
    "SELECT type_id, COALESCE(name_zh, name_en) AS name FROM eve_type",
  );

  const map: Record<number, string> = {};
  for (const row of rows) {
    if (row.name) map[row.type_id] = row.name;
  }
  return map;
}

/* ---------- 单个物品在某建筑内的订单 ---------- */

export interface TypeOrderRow {
  order_id: number;
  is_buy_order: number;
  price: number;
  volume_remain: number;
  volume_total: number;
  min_volume: number;
  range: string;
  issued_at: number;
}

/**
 * 读取某建筑内某物品的订单（数据来自已同步的 market_structure_order）。
 * 卖单在前（价格升序即最优），买单在后（价格降序即最优）。
 */
export async function listTypeOrders(
  structureId: number,
  typeId: number,
): Promise<TypeOrderRow[]> {
  const db = await getDb();
  return db.select<TypeOrderRow[]>(
    `SELECT order_id, is_buy_order, price, volume_remain, volume_total,
            min_volume, range, issued_at
       FROM market_structure_order
      WHERE structure_id = $1 AND type_id = $2
      ORDER BY is_buy_order ASC, price DESC`,
    [structureId, typeId],
  );
}

/* ---------- 筛选用的物品类型集合 ---------- */

export interface StructureSalesRow {
  type_id: number;
  type_name: string | null;
  /** 已成交量（订单总量 − 剩余量），作为销量代理指标 */
  sold_volume: number;
  /** 仍挂在市场上的量 */
  remain_volume: number;
  order_count: number;
  /** 按总量加权的平均挂单价 */
  avg_price: number | null;
  best_sell: number | null;
  best_buy: number | null;
}

/** 市场顶层分类（用于销量分析过滤） */
export interface MarketTopGroup {
  market_group_id: number;
  name: string;
}

export async function listMarketTopGroups(): Promise<MarketTopGroup[]> {
  const db = await getDb();
  return db.select<MarketTopGroup[]>(
    `SELECT market_group_id, name
       FROM market_group
      WHERE parent_group_id IS NULL
      ORDER BY name`,
  );
}

/**
 * 某个建筑内按物品汇总的「成交量」。
 *
 * ESI 没有星城级别的历史销量，这里用订单的「总量 − 剩余」近似：
 * 它表示这些挂单自创建以来被吃掉的部分，能反映近期需求强弱。
 */
export async function listStructureSales(
  structureId: number,
  /** 市场顶层分类 ID；0 表示不按分类过滤 */
  marketGroupId = 0,
): Promise<StructureSalesRow[]> {
  const db = await getDb();
  return db.select<StructureSalesRow[]>(
    `WITH RECURSIVE subtree(id) AS (
       SELECT $2
       UNION ALL
       SELECT g.market_group_id
         FROM market_group g
         JOIN subtree s ON g.parent_group_id = s.id
     )
     SELECT o.type_id,
            COALESCE(t.name_zh, t.name_en) AS type_name,
            COALESCE(SUM(o.volume_total - o.volume_remain), 0) AS sold_volume,
            COALESCE(SUM(o.volume_remain), 0) AS remain_volume,
            COUNT(o.order_id) AS order_count,
            CASE WHEN SUM(o.volume_total) > 0
                 THEN SUM(o.price * o.volume_total) * 1.0 / SUM(o.volume_total)
            END AS avg_price,
            MIN(CASE WHEN o.is_buy_order = 0 THEN o.price END) AS best_sell,
            MAX(CASE WHEN o.is_buy_order = 1 THEN o.price END) AS best_buy
       FROM market_structure_order o
       LEFT JOIN eve_type t ON t.type_id = o.type_id
      WHERE o.structure_id = $1
        AND (
          $2 = 0
          OR EXISTS (
            SELECT 1
              FROM market_type mt
             WHERE mt.type_id = o.type_id
               AND mt.market_group_id IN (SELECT id FROM subtree)
          )
        )
      GROUP BY o.type_id, t.name_zh, t.name_en`,
    [structureId, marketGroupId],
  );
}

/** 某建筑内当前有订单的物品类型 ID */
export async function listStructureTypeIds(
  structureId: number,
): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ type_id: number }[]>(
    "SELECT DISTINCT type_id FROM market_structure_order WHERE structure_id = $1",
    [structureId],
  );
  return rows.map((row) => row.type_id);
}

/** 角色自己挂了单的物品类型 ID */
export async function listCharacterOrderTypeIds(
  characterId: number,
): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ type_id: number }[]>(
    "SELECT DISTINCT type_id FROM character_order WHERE character_id = $1",
    [characterId],
  );
  return rows.map((row) => row.type_id);
}

/* ---------- 玩家市场对比 ---------- */

/** 按名称或类型 ID 搜索物品（中文优先） */
export async function searchTypes(
  keyword: string,
  limit = 20,
): Promise<{ type_id: number; name: string }[]> {
  const db = await getDb();
  const raw = keyword.trim();
  if (!raw) return [];

  const like = `%${raw}%`;

  // 只搜有市场分类的物品，避免出现技能书、蓝图拷贝等无法在市场挂单的条目
  return db.select<{ type_id: number; name: string }[]>(
    `SELECT t.type_id, COALESCE(t.name_zh, t.name_en) AS name
       FROM eve_type t
       JOIN market_type m ON m.type_id = t.type_id
      WHERE t.name_zh LIKE $1
         OR t.name_en LIKE $1
         OR CAST(t.type_id AS TEXT) = $2
      ORDER BY LENGTH(COALESCE(t.name_zh, t.name_en)) ASC
      LIMIT $3`,
    [like, raw, limit],
  );
}

/** 单个物品在某几栋建筑里的买卖盘概况 */
export interface StructurePriceRow {
  structure_id: number;
  name: string | null;
  solar_system_name: string | null;
  best_buy: number | null;
  best_sell: number | null;
  sell_volume: number;
  buy_volume: number;
  order_count: number;
  last_synced_at: number | null;
}

/**
 * 对比同一物品在多栋建筑的最优买卖价。
 * 数据来自本地已同步的订单快照，不会触发 ESI 请求。
 */
export async function compareStructurePrices(
  typeId: number,
  structureIds: number[],
): Promise<StructurePriceRow[]> {
  const db = await getDb();
  if (structureIds.length === 0) return [];

  const placeholders = structureIds
    .map((_, index) => `$${index + 2}`)
    .join(", ");

  return db.select<StructurePriceRow[]>(
    `SELECT s.structure_id,
            s.name,
            s.solar_system_name,
            s.last_synced_at,
            MAX(CASE WHEN o.is_buy_order = 1 THEN o.price END) AS best_buy,
            MIN(CASE WHEN o.is_buy_order = 0 THEN o.price END) AS best_sell,
            COALESCE(SUM(CASE WHEN o.is_buy_order = 0 THEN o.volume_remain ELSE 0 END), 0) AS sell_volume,
            COALESCE(SUM(CASE WHEN o.is_buy_order = 1 THEN o.volume_remain ELSE 0 END), 0) AS buy_volume,
            COUNT(o.order_id) AS order_count
       FROM market_structure s
       LEFT JOIN market_structure_order o
              ON o.structure_id = s.structure_id AND o.type_id = $1
      WHERE s.structure_id IN (${placeholders})
      GROUP BY s.structure_id, s.name, s.solar_system_name, s.last_synced_at`,
    [typeId, ...structureIds],
  );
}

/** 订单簿中的一个价格档位（同价订单已合并） */
export interface OrderBookLevel {
  structure_id: number;
  type_id: number;
  name: string | null;
  is_buy_order: number;
  price: number;
  volume: number;
  min_volume: number;
}

/**
 * 取两栋建筑的全部盘口档位，供前端做逐档撮合。
 * 同价订单在 SQL 里合并成一档，避免把上万条订单搬到内存。
 */
export async function listOrderBookLevels(
  structureA: number,
  structureB: number,
): Promise<OrderBookLevel[]> {
  const db = await getDb();

  return db.select<OrderBookLevel[]>(
    `SELECT o.structure_id,
            o.type_id,
            o.is_buy_order,
            o.price,
            SUM(o.volume_remain) AS volume,
            MAX(o.min_volume) AS min_volume,
            COALESCE(t.name_zh, t.name_en) AS name
       FROM market_structure_order o
       LEFT JOIN eve_type t ON t.type_id = o.type_id
      WHERE o.structure_id IN ($1, $2) AND o.price > 0
      GROUP BY o.structure_id, o.type_id, o.is_buy_order, o.price`,
    [structureA, structureB],
  );
}

/* ---------- 我的订单：汇总与竞争力 ---------- */

export interface CharacterOrderStats {
  order_count: number;
  /** 卖单挂单总价值（单价 × 剩余量） */
  sell_value: number;
  /** 买单挂单总价值 */
  buy_value: number;
  /** 买单冻结的托管金额 */
  escrow_total: number;
}

export async function getCharacterOrderStats(
  characterId: number,
): Promise<CharacterOrderStats> {
  const db = await getDb();
  const rows = await db.select<CharacterOrderStats[]>(
    `SELECT COUNT(*) AS order_count,
            COALESCE(SUM(CASE WHEN is_buy_order = 0 THEN price * volume_remain ELSE 0 END), 0) AS sell_value,
            COALESCE(SUM(CASE WHEN is_buy_order = 1 THEN price * volume_remain ELSE 0 END), 0) AS buy_value,
            COALESCE(SUM(COALESCE(escrow, 0)), 0) AS escrow_total
       FROM character_order
      WHERE character_id = $1`,
    [characterId],
  );

  return (
    rows[0] ?? {
      order_count: 0,
      sell_value: 0,
      buy_value: 0,
      escrow_total: 0,
    }
  );
}

export interface OrderMarketPrice {
  structure_id: number;
  type_id: number;
  best_sell: number | null;
  best_buy: number | null;
}

/**
 * 取「我的订单涉及的建筑 + 物品」在同建筑里的最优买卖价，
 * 用于判断自己的挂单是否被压价。只覆盖已同步过订单的建筑。
 */
export async function listMyOrderMarketPrices(
  characterId: number,
): Promise<OrderMarketPrice[]> {
  const db = await getDb();

  return db.select<OrderMarketPrice[]>(
    `SELECT o.structure_id,
            o.type_id,
            MIN(CASE WHEN o.is_buy_order = 0 THEN o.price END) AS best_sell,
            MAX(CASE WHEN o.is_buy_order = 1 THEN o.price END) AS best_buy
       FROM market_structure_order o
      WHERE EXISTS (
              SELECT 1
                FROM character_order c
               WHERE c.character_id = $1
                 AND c.location_id = o.structure_id
                 AND c.type_id = o.type_id
            )
      GROUP BY o.structure_id, o.type_id`,
    [characterId],
  );
}

/** 当前已同步的所有角色订单 ID，用于在市场上标出自己的挂单 */
export async function listMyOrderIds(
  characterId?: number,
): Promise<number[]> {
  const db = await getDb();

  if (characterId === undefined) {
    const rows = await db.select<{ order_id: number }[]>(
      "SELECT order_id FROM character_order",
    );
    return rows.map((row) => row.order_id);
  }

  const rows = await db.select<{ order_id: number }[]>(
    "SELECT order_id FROM character_order WHERE character_id = $1",
    [characterId],
  );
  return rows.map((row) => row.order_id);
}

/**
 * 物品 → 所属市场分类名。
 *
 * 直接读 Rust 侧内置的 SDE 静态数据（resources/sde-market-groups.json），
 * 不查 market_type / market_group 表——那两张表要等用户打开「市场」页
 * 触发 seed_market_groups 才会有数据，资产页的分类列会因此整列空白。
 */
export async function getTypeGroupNameMap(): Promise<Record<number, string>> {
  return invoke<Record<number, string>>("get_type_group_names");
}

/* ============================================================
   行星工业库存快照（pi_stock）
   ============================================================ */

export interface PiStockSnapshotRow {
  type_id: number;
  quantity: number;
  /** 最后一次读取该库存的角色 */
  character_id: number | null;
  updated_at: number;
}

/** 读取本地保存的行星工业库存（没有快照时返回空数组） */
export async function loadPiStock(): Promise<PiStockSnapshotRow[]> {
  const db = await getDb();
  return db.select<PiStockSnapshotRow[]>(
    "SELECT type_id, quantity, character_id, updated_at FROM pi_stock ORDER BY type_id",
  );
}

/**
 * 覆盖保存行星工业库存。
 *
 * 库存是「最近一次从 ESI 读取的快照」，因此整表替换而不是增量更新，
 * 避免已消耗掉的物资一直留在表里。
 */
export async function savePiStock(
  characterId: number | null,
  entries: Array<{ typeId: number; quantity: number }>,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  await db.execute("DELETE FROM pi_stock", []);

  for (const batch of chunk(entries, 300)) {
    const values: string[] = [];
    const params: unknown[] = [];

    batch.forEach((entry, index) => {
      const base = index * 4;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`,
      );
      params.push(entry.typeId, entry.quantity, characterId, now);
    });

    await db.execute(
      `INSERT INTO pi_stock (type_id, quantity, character_id, updated_at)
       VALUES ${values.join(", ")}`,
      params,
    );
  }
}

/* ============================================================
   制造业
   ============================================================ */

export interface BlueprintRow {
  item_id: number;
  character_id: number;
  type_id: number;
  location_id: number;
  location_flag: string;
  /** -1 = BPO */
  quantity: number;
  material_efficiency: number;
  time_efficiency: number;
  /** BPO 为 -1 */
  runs: number;
  synced_at: number;
}

export async function listCharacterBlueprints(
  characterId: number,
): Promise<BlueprintRow[]> {
  const db = await getDb();
  return db.select<BlueprintRow[]>(
    `SELECT * FROM character_blueprint
      WHERE character_id = $1
      ORDER BY type_id ASC, material_efficiency DESC`,
    [characterId],
  );
}

/** 覆盖保存角色蓝图（同步即全量刷新） */
export async function saveCharacterBlueprints(
  characterId: number,
  rows: Array<Omit<BlueprintRow, "character_id" | "synced_at">>,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  for (const batch of chunk(rows, BATCH_ROWS)) {
    const values: string[] = [];
    const params: unknown[] = [];

    batch.forEach((row, index) => {
      const base = index * 10;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
          $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
      );
      params.push(
        row.item_id,
        characterId,
        row.type_id,
        row.location_id,
        row.location_flag,
        row.quantity,
        row.material_efficiency,
        row.time_efficiency,
        row.runs,
        now,
      );
    });

    await db.execute(
      `INSERT INTO character_blueprint
         (item_id, character_id, type_id, location_id, location_flag,
          quantity, material_efficiency, time_efficiency, runs, synced_at)
       VALUES ${values.join(", ")}
       ON CONFLICT(item_id) DO UPDATE SET
         type_id             = excluded.type_id,
         location_id         = excluded.location_id,
         location_flag       = excluded.location_flag,
         quantity            = excluded.quantity,
         material_efficiency = excluded.material_efficiency,
         time_efficiency     = excluded.time_efficiency,
         runs                = excluded.runs,
         synced_at           = excluded.synced_at`,
      params,
    );
  }

  // 已售出/转移的蓝图本轮不会再出现，按同步标记清理
  await db.execute(
    "DELETE FROM character_blueprint WHERE character_id = $1 AND synced_at < $2",
    [characterId, now],
  );
}

export interface IndustryJobRow {
  job_id: number;
  owner_id: number;
  owner_kind: "character" | "corporation";
  installer_id: number | null;
  activity_id: number;
  blueprint_type_id: number;
  product_type_id: number;
  facility_id: number;
  runs: number;
  licensed_runs: number | null;
  cost: number | null;
  probability: number | null;
  status: string;
  start_date: string;
  end_date: string;
  synced_at: number;
}

export async function listIndustryJobs(
  ownerId: number,
  ownerKind: "character" | "corporation",
): Promise<IndustryJobRow[]> {
  const db = await getDb();
  return db.select<IndustryJobRow[]>(
    `SELECT * FROM industry_job
      WHERE owner_id = $1 AND owner_kind = $2
      ORDER BY end_date ASC`,
    [ownerId, ownerKind],
  );
}

/** 覆盖保存作业队列（按 job_id upsert，结束后清理） */
export async function saveIndustryJobs(
  ownerId: number,
  ownerKind: "character" | "corporation",
  rows: Array<Omit<IndustryJobRow, "owner_id" | "owner_kind" | "synced_at">>,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  for (const batch of chunk(rows, 100)) {
    const values: string[] = [];
    const params: unknown[] = [];

    batch.forEach((row, index) => {
      const base = index * 16;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
          $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10},
          $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15},
          $${base + 16})`,
      );
      params.push(
        row.job_id,
        ownerId,
        ownerKind,
        row.installer_id,
        row.activity_id,
        row.blueprint_type_id,
        row.product_type_id,
        row.facility_id,
        row.runs,
        row.licensed_runs,
        row.cost,
        row.probability,
        row.status,
        row.start_date,
        row.end_date,
        now,
      );
    });

    await db.execute(
      `INSERT INTO industry_job
         (job_id, owner_id, owner_kind, installer_id, activity_id,
          blueprint_type_id, product_type_id, facility_id, runs, licensed_runs,
          cost, probability, status, start_date, end_date, synced_at)
       VALUES ${values.join(", ")}
       ON CONFLICT(job_id) DO UPDATE SET
         status      = excluded.status,
         runs        = excluded.runs,
         cost        = excluded.cost,
         probability = excluded.probability,
         start_date  = excluded.start_date,
         end_date    = excluded.end_date,
         synced_at   = excluded.synced_at`,
      params,
    );
  }

  // 队列里已交付/取消的作业不再返回，按同步标记清理
  await db.execute(
    "DELETE FROM industry_job WHERE owner_id = $1 AND owner_kind = $2 AND synced_at < $3",
    [ownerId, ownerKind, now],
  );
}

export interface IndustryFacilityRow {
  facility_id: number;
  name: string | null;
  solar_system_id: number | null;
  /** 0.01 = 减免 1% */
  material_bonus: number;
  time_bonus: number;
  /** 0.01 = 1% */
  tax_rate: number;
  updated_at: number;
}

export async function listIndustryFacilities(): Promise<IndustryFacilityRow[]> {
  const db = await getDb();
  return db.select<IndustryFacilityRow[]>(
    "SELECT * FROM industry_facility ORDER BY name ASC",
  );
}

export async function upsertIndustryFacility(
  row: Omit<IndustryFacilityRow, "updated_at">,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO industry_facility
       (facility_id, name, solar_system_id, material_bonus, time_bonus, tax_rate, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(facility_id) DO UPDATE SET
       name            = excluded.name,
       solar_system_id = excluded.solar_system_id,
       material_bonus  = excluded.material_bonus,
       time_bonus      = excluded.time_bonus,
       tax_rate        = excluded.tax_rate,
       updated_at      = excluded.updated_at`,
    [
      row.facility_id,
      row.name,
      row.solar_system_id,
      row.material_bonus,
      row.time_bonus,
      row.tax_rate,
      Date.now(),
    ],
  );
}

export async function removeIndustryFacility(
  facilityId: number,
): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM industry_facility WHERE facility_id = $1", [
    facilityId,
  ]);
}

/** 所有物品的最优买卖价（来自本地建筑订单快照） */
export async function listBestPrices(
  typeIds: number[],
): Promise<Array<{ type_id: number; best_buy: number | null; best_sell: number | null }>> {
  const db = await getDb();
  if (typeIds.length === 0) return [];

  const result: Array<{
    type_id: number;
    best_buy: number | null;
    best_sell: number | null;
  }> = [];

  for (const batch of chunk(typeIds, 500)) {
    const placeholders = batch.map((_, index) => `$${index + 1}`).join(", ");
    const rows = await db.select<
      Array<{ type_id: number; best_buy: number | null; best_sell: number | null }>
    >(
      `SELECT type_id,
              MAX(CASE WHEN is_buy_order = 1 THEN price END) AS best_buy,
              MIN(CASE WHEN is_buy_order = 0 THEN price END) AS best_sell
         FROM market_structure_order
        WHERE type_id IN (${placeholders})
        GROUP BY type_id`,
      batch,
    );
    result.push(...rows);
  }

  return result;
}
