import CharacterOrdersPanel from "@/components/character-orders-panel";
import type { EveCharacter } from "@/lib/db";

import "./MarketOrdersTab.css";

/** 我的订单：按角色查看挂单，含定时同步与被压价提醒 */
export default function MarketOrdersTab({
  characters,
  activeCharacterId,
  onOpenType,
}: {
  characters: EveCharacter[];
  activeCharacterId: number | null;
  /** 点击物品名称跳到交易市场查看价格 */
  onOpenType: (typeId: number) => void;
}) {
  return (
    <div className="market-orders-tab">
      <CharacterOrdersPanel
        characters={characters}
        activeCharacterId={activeCharacterId}
        onOpenType={onOpenType}
      />
    </div>
  );
}
