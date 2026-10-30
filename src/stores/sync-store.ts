import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import {
  markStructureSync,
  saveStructureOrders,
  type MarketStructure,
  type OrdersPayload,
} from "@/lib/db";

export interface BatchProgress {
  total: number;
  /** 已处理完的数量 */
  current: number;
  /** 正在同步的建筑名 */
  name: string;
  /** 最近一次更新时间，用于判断进度是否已过期 */
  updatedAt: number;
}

interface SyncStore {
  /** 进行中的批量同步；null 表示空闲 */
  batch: BatchProgress | null;
  /** 每次批量结束 +1，页面据此刷新列表 */
  revision: number;
  startBatch: (
    targets: MarketStructure[],
    fallbackCharacterId: number | null,
  ) => Promise<void>;
}

/**
 * 批量同步放在 store 里而不是页面组件里。
 *
 * 原因：市场页在切换顶部菜单时会整体卸载，组件内的 state 与闭包随之失效，
 * 进度看不到、列表也不会刷新。放到 store 后任务在模块级作用域继续跑，
 * 页面重新挂载仍能读到实时进度。
 */
export const useSyncStore = create<SyncStore>((set, get) => ({
  batch: null,
  revision: 0,

  startBatch: async (targets, fallbackCharacterId) => {
    if (get().batch !== null || targets.length === 0) return;

    const toastId = `sync-batch-${Date.now()}`;

    set({
      batch: {
        total: targets.length,
        current: 0,
        name: "",
        updatedAt: Date.now(),
      },
    });

    // 进度同时挂到全局 toast：页面被卸载（切菜单）也看得到
    toast.loading(`正在同步 0/${targets.length}`, {
      id: toastId,
      duration: Infinity,
    });

    let succeeded = 0;

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];

      const label = target.name ?? `#${target.structure_id}`;

      set({
        batch: {
          total: targets.length,
          current: index,
          name: label,
          updatedAt: Date.now(),
        },
      });

      toast.loading(`正在同步 ${index}/${targets.length} · ${label}`, {
        id: toastId,
        duration: Infinity,
      });

      const characterId = target.auth_character_id ?? fallbackCharacterId;

      try {
        if (!characterId) {
          throw new Error("缺少授权角色，请在个人中心检查");
        }

        const payload = await invoke<OrdersPayload>("sync_structure_orders", {
          structureId: target.structure_id,
          characterId,
        });

        await saveStructureOrders(
          target.structure_id,
          payload.orders,
          payload.fetchedAt,
        );
        await markStructureSync(
          target.structure_id,
          "ok",
          null,
          payload.orders.length,
          payload.fetchedAt,
        );

        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markStructureSync(
          target.structure_id,
          "error",
          message,
          0,
          Date.now(),
        );
      }
    }

    set({ batch: null, revision: get().revision + 1 });

    toast.success(`同步完成：成功 ${succeeded} / ${targets.length}`, {
      id: toastId,
      duration: 4000,
    });
  },
}));
