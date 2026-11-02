import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import {
  listCharacterOrders,
  listCharacters,
  listMyOrderMarketPrices,
  listStructures,
  markStructureSync,
  saveCharacterOrders,
  saveStructureOrders,
  upsertStructure,
  type OrderRow,
  type OrdersPayload,
  type StructureInfo,
} from "@/lib/db";
import { describeError } from "@/hooks/useCharacters";
import {
  findUndercutOrders,
  indexPrices,
  playAlertSound,
} from "@/lib/orders/undercut";

const AUTO_SYNC_KEY = "orders-auto-sync";
const AUTO_SYNC_MINUTES_KEY = "orders-auto-sync-minutes";

/** 自动同步最短间隔：低于 20 分钟会一直撞上 ESI 订单接口的缓存 */
export const AUTO_SYNC_MIN_MINUTES = 20;
export const AUTO_SYNC_DEFAULT_MINUTES = 30;
/** 可选的同步间隔（分钟） */
export const AUTO_SYNC_OPTIONS = [20, 25, 30, 45, 60, 90, 120] as const;

function readAutoSyncEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_SYNC_KEY) !== "0";
  } catch {
    return true;
  }
}

function readIntervalMinutes(): number {
  try {
    const raw = Number(localStorage.getItem(AUTO_SYNC_MINUTES_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return AUTO_SYNC_DEFAULT_MINUTES;
    return Math.max(AUTO_SYNC_MIN_MINUTES, Math.round(raw));
  } catch {
    return AUTO_SYNC_DEFAULT_MINUTES;
  }
}

/** 间隔（分钟）换算成毫秒，同时兜底下限 */
export function autoSyncIntervalMs(minutes: number): number {
  return Math.max(AUTO_SYNC_MIN_MINUTES, Math.round(minutes)) * 60 * 1000;
}

/** 同步角色订单，并顺着挂单把所在建筑的行情一起刷一遍 */
async function syncCharacter(characterId: number): Promise<{
  orderCount: number;
  cacheExpiresAt: number | null;
  structureSynced: number;
  structureFailed: number;
}> {
  const payload = await invoke<OrdersPayload>("sync_character_orders", {
    characterId,
  });
  await saveCharacterOrders(characterId, payload.orders, payload.fetchedAt);

  const structures = await syncStructuresOf(characterId, payload.orders);

  return {
    orderCount: payload.orders.length,
    cacheExpiresAt: payload.cacheExpiresAt ?? null,
    structureSynced: structures.synced,
    structureFailed: structures.failed,
  };
}

/**
 * 建筑可能没在本工具里录入过：先用 resolve_structure 解析并落库；
 * 没有市场或该角色没有访问权限的建筑只记录错误，不影响角色订单本身。
 */
async function syncStructuresOf(
  characterId: number,
  orders: OrderRow[],
): Promise<{ synced: number; failed: number }> {
  const locationIds = [...new Set(orders.map((order) => order.locationId))].filter(
    (id) => Number.isFinite(id) && id > 0,
  );

  if (locationIds.length === 0) return { synced: 0, failed: 0 };

  const known = new Set(
    (await listStructures(false)).map((item) => item.structure_id),
  );

  let synced = 0;
  let failed = 0;

  for (const structureId of locationIds) {
    try {
      if (!known.has(structureId)) {
        const info = await invoke<StructureInfo>("resolve_structure", {
          structureId,
          characterId,
        });
        await upsertStructure(info, characterId);
        if (!info.hasMarket) continue;
      }

      const payload = await invoke<OrdersPayload>("sync_structure_orders", {
        structureId,
        characterId,
      });
      await saveStructureOrders(
        structureId,
        payload.orders,
        payload.fetchedAt,
      );
      await markStructureSync(
        structureId,
        "ok",
        null,
        payload.orders.length,
        payload.fetchedAt,
      );
      synced += 1;
    } catch (err) {
      failed += 1;
      await markStructureSync(
        structureId,
        "error",
        describeError(err),
        0,
        Date.now(),
      ).catch(() => undefined);
    }
  }

  return { synced, failed };
}

/** 检测被压价订单；有则播放提示音 */
async function detectUndercut(
  characterId: number,
): Promise<{ count: number; names: string[] }> {
  const [orders, prices] = await Promise.all([
    listCharacterOrders(characterId),
    listMyOrderMarketPrices(characterId),
  ]);

  const undercut = findUndercutOrders(orders, indexPrices(prices));
  if (undercut.length > 0) {
    playAlertSound();
  }

  return {
    count: undercut.length,
    names: undercut
      .slice(0, 3)
      .map((order) => order.type_name ?? `#${order.type_id}`),
  };
}

interface OrderSyncStore {
  /** 是否开启自动同步 */
  autoSync: boolean;
  /** 自动同步间隔（分钟），最小 20 */
  intervalMinutes: number;
  /** 下次自动同步的时间点，null 表示未开启或未初始化 */
  nextSyncAt: number | null;
  /** 正在同步的单个角色 */
  syncingId: number | null;
  /** 是否处于同步流程中（含「同步全部角色」） */
  syncingAll: boolean;
  /** 最近一次检测到的被压价订单数 */
  undercutCount: number;
  /** 最近一次同步的 ESI 缓存到期时间 */
  lastCacheExpiresAt: number | null;
  lastError: string | null;
  /** 每次同步结束 +1，页面据此重新读库 */
  revision: number;

  /** 应用启动时调用一次，负责拉起定时器 */
  init: () => void;
  setAutoSync: (enabled: boolean) => void;
  toggleAutoSync: () => void;
  /** 调整同步间隔；小于 20 分钟按 20 分钟处理 */
  setIntervalMinutes: (minutes: number) => void;
  sync: (characterIds: number[], options?: { silent?: boolean }) => Promise<void>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

function schedule(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  const { autoSync, intervalMinutes } = useOrderSyncStore.getState();
  if (!autoSync) return;

  timer = setInterval(() => {
    void runAutoSync();
  }, autoSyncIntervalMs(intervalMinutes));
}

async function runAutoSync(): Promise<void> {
  const state = useOrderSyncStore.getState();
  if (state.syncingAll) return;

  try {
    const characters = await listCharacters();
    if (characters.length === 0) return;
    await state.sync(
      characters.map((character) => character.character_id),
      { silent: true },
    );
  } catch {
    // 自动同步失败已在 sync 内提示
  } finally {
    const { intervalMinutes } = useOrderSyncStore.getState();
    useOrderSyncStore.setState({
      nextSyncAt: Date.now() + autoSyncIntervalMs(intervalMinutes),
    });
  }
}

/**
 * 订单同步放在 store 里而不是页面组件里。
 *
 * 原因：市场页在切换菜单时会整体卸载，组件内的定时器随之销毁，
 * 自动同步就会断掉。放到模块级后，只要应用开着就一直生效。
 */
export const useOrderSyncStore = create<OrderSyncStore>((set, get) => ({
  autoSync: readAutoSyncEnabled(),
  intervalMinutes: readIntervalMinutes(),
  nextSyncAt: null,
  syncingId: null,
  syncingAll: false,
  undercutCount: 0,
  lastCacheExpiresAt: null,
  lastError: null,
  revision: 0,

  init: () => {
    if (initialized) return;
    initialized = true;

    set({
      nextSyncAt: get().autoSync
        ? Date.now() + autoSyncIntervalMs(get().intervalMinutes)
        : null,
    });
    schedule();
  },

  setAutoSync: (enabled) => {
    try {
      localStorage.setItem(AUTO_SYNC_KEY, enabled ? "1" : "0");
    } catch {
      // 存储不可用时忽略
    }

    set({
      autoSync: enabled,
      nextSyncAt: enabled
        ? Date.now() + autoSyncIntervalMs(get().intervalMinutes)
        : null,
    });
    schedule();
  },

  toggleAutoSync: () => get().setAutoSync(!get().autoSync),

  setIntervalMinutes: (minutes) => {
    const clamped = Math.max(AUTO_SYNC_MIN_MINUTES, Math.round(minutes));

    try {
      localStorage.setItem(AUTO_SYNC_MINUTES_KEY, String(clamped));
    } catch {
      // 存储不可用时忽略
    }

    set({
      intervalMinutes: clamped,
      nextSyncAt: get().autoSync
        ? Date.now() + autoSyncIntervalMs(clamped)
        : null,
    });
    schedule();
  },

  sync: async (characterIds, options) => {
    const silent = options?.silent ?? false;

    // 定时器与手动点击可能撞车，正在同步时直接跳过
    if (get().syncingAll || characterIds.length === 0) return;

    set({ syncingAll: true, lastError: null });

    let succeeded = 0;
    let structureSynced = 0;
    let structureFailed = 0;
    let undercutTotal = 0;
    const undercutNames: string[] = [];

    try {
      for (const characterId of characterIds) {
        set({ syncingId: characterId });
        try {
          const result = await syncCharacter(characterId);
          structureSynced += result.structureSynced;
          structureFailed += result.structureFailed;

          const undercut = await detectUndercut(characterId);
          undercutTotal += undercut.count;
          undercutNames.push(...undercut.names);

          succeeded += 1;
          set({ lastCacheExpiresAt: result.cacheExpiresAt });
        } catch (err) {
          set({ lastError: describeError(err) });
        }
      }
    } finally {
      set((state) => ({
        syncingId: null,
        syncingAll: false,
        undercutCount: undercutTotal,
        revision: state.revision + 1,
        nextSyncAt: state.autoSync
          ? Date.now() + autoSyncIntervalMs(state.intervalMinutes)
          : null,
      }));
    }

    const parts = [`成功 ${succeeded} / ${characterIds.length}`];
    if (structureSynced > 0) parts.push(`更新 ${structureSynced} 个建筑行情`);
    if (structureFailed > 0) parts.push(`${structureFailed} 个建筑无权限或失败`);
    if (undercutTotal > 0) parts.push(`${undercutTotal} 笔被压价`);
    const summary = parts.join("，");

    if (undercutTotal > 0) {
      toast.warning(
        `有 ${undercutTotal} 笔订单被压价：${undercutNames.slice(0, 3).join("、")}${
          undercutNames.length > 3 ? " 等" : ""
        }`,
        { duration: 10_000 },
      );
    } else if (succeeded < characterIds.length) {
      toast.error(`同步完成：${summary}`);
    } else if (!silent) {
      toast.success(`同步完成：${summary}`);
    }
  },
}));
