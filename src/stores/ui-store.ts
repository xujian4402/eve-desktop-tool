import { create } from "zustand";

export type AccountTab = "characters" | "assets" | "permissions";

/** 市场页的标签页：建筑订单 / 我的订单 / 物品分类 / 建筑管理 */
export type MarketTab = "structures" | "orders" | "groups" | "manage";

interface UiState {
  /** 个人中心当前标签（切换页面后保留） */
  accountTab: AccountTab;
  setAccountTab: (tab: AccountTab) => void;

  /** 市场页当前标签 */
  marketTab: MarketTab;
  setMarketTab: (tab: MarketTab) => void;

  /** 市场页当前展开明细的建筑 */
  marketDetailStructureId: number | null;
  setMarketDetailStructureId: (structureId: number | null) => void;
}

/**
 * 纯 UI 状态：只放「切走页面后仍希望保留」的选择结果。
 * 角色、资产等来自数据库/ESI 的数据交由 TanStack Query 管理，避免两套缓存打架。
 */
export const useUiStore = create<UiState>((set) => ({
  accountTab: "characters",
  setAccountTab: (accountTab) => set({ accountTab }),

  marketTab: "structures",
  setMarketTab: (marketTab) => set({ marketTab }),

  marketDetailStructureId: null,
  setMarketDetailStructureId: (marketDetailStructureId) =>
    set({ marketDetailStructureId }),
}));
