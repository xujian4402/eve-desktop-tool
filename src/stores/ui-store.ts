import { create } from "zustand";

export type AccountTab = "characters" | "assets" | "permissions";

/** 市场页的标签页：交易市场 / 同步市场订单 / 我的订单 */
export type MarketTab =
  | "groups"
  | "orders"
  | "analysis"
  | "compare"
  | "structures";

interface UiState {
  /** 个人中心当前标签（切换页面后保留） */
  accountTab: AccountTab;
  setAccountTab: (tab: AccountTab) => void;

  /** 市场页当前标签 */
  marketTab: MarketTab;
  setMarketTab: (tab: MarketTab) => void;
  /** 从其他标签跳到「交易市场」时要定位的物品；消费后置空 */
  pendingTypeId: number | null;
  setPendingTypeId: (typeId: number | null) => void;
}

/**
 * 纯 UI 状态：只放「切走页面后仍希望保留」的选择结果。
 * 角色、资产等来自数据库/ESI 的数据交由 TanStack Query 管理，避免两套缓存打架。
 */
export const useUiStore = create<UiState>((set) => ({
  accountTab: "characters",
  setAccountTab: (accountTab) => set({ accountTab }),

  marketTab: "groups",
  setMarketTab: (marketTab) => set({ marketTab }),
  pendingTypeId: null,
  setPendingTypeId: (pendingTypeId) => set({ pendingTypeId }),
}));
