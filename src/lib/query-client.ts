import { QueryClient } from "@tanstack/react-query";

/**
 * 桌面端数据源是本地 SQLite + ESI，切换窗口、重进页面不构成「重新加载」的理由，
 * 因此默认 staleTime 放宽；凡是需要强制刷新的操作（同步、授权）都显式 invalidate。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 0,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
