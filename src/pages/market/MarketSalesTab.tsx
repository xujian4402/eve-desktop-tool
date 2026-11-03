import MarketSalesPanel from "@/components/market-sales-panel";

import "./MarketSalesTab.css";

/** 销量分析：按建筑统计物品成交量，给出最高 / 最低 Top 榜 */
export default function MarketSalesTab() {
  return (
    <div className="market-sales-tab">
      <MarketSalesPanel />
    </div>
  );
}
