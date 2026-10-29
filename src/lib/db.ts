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

/** 解绑角色：删除钥匙串凭据 + 本地记录 */
export async function removeCharacter(characterId: number): Promise<void> {
  await invoke("eve_logout", { characterId });
  const db = await getDb();
  await db.execute("DELETE FROM eve_character WHERE character_id = $1", [
    characterId,
  ]);
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
    `SELECT order_id, type_id, location_id, region_id, is_buy_order, price,
            volume_remain, volume_total, min_volume, issued_at, range, escrow,
            is_corporation
       FROM character_order
      WHERE character_id = $1
      ORDER BY is_buy_order ASC, price DESC`,
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
  /** character：角色个人资产；corporation：军团资产 */
  source: "character" | "corporation";
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
  /** 军团资产条数（无权限时为 0） */
  corporationAssetCount: number;
  /** 军团资产未能加载时的原因说明 */
  corporationNote: string | null;
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
