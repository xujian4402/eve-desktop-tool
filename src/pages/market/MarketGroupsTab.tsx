import MarketGroupBrowser from "@/components/market-group-browser";

import "./MarketGroupsTab.css";

/** 交易市场：按官方市场分类浏览物品与行情 */
export default function MarketGroupsTab({
  characterId,
}: {
  characterId: number | null;
}) {
  return (
    <div className="market-groups-tab">
      <MarketGroupBrowser characterId={characterId} />
    </div>
  );
}
