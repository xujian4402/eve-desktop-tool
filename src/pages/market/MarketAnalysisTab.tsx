import OrderAnalysisPanel from "@/components/order-analysis-panel";
import type { EveCharacter } from "@/lib/db";

import "./MarketAnalysisTab.css";

/** 订单分析：按竞争力、到期、建筑分布重排自己的挂单 */
export default function MarketAnalysisTab({
  characters,
}: {
  characters: EveCharacter[];
}) {
  return (
    <div className="market-analysis-tab">
      <OrderAnalysisPanel characters={characters} />
    </div>
  );
}
