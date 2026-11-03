import StructureComparePanel from "@/components/structure-compare-panel";

import "./MarketCompareTab.css";

/** 市场对比：多栋建筑间的最优买卖价与价差榜 */
export default function MarketCompareTab() {
  return (
    <div className="market-compare-tab">
      <StructureComparePanel />
    </div>
  );
}
