import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { PiInventoryPanel } from "@/components/pi/pi-inventory-panel";
import { PiSynthesisResult } from "@/components/pi/pi-synthesis-result";
import { useCharacters } from "@/hooks/useCharacters";
import { loadPiStock, savePiStock } from "@/lib/db";
import { PI_P0, PI_SCHEMATICS } from "@/lib/pi/data";
import {
  PI_INVENTORY_GROUPS,
  PI_MARKETS,
  toPriceRows,
  type PiStockSource,
} from "@/lib/pi/inventory";
import { fetchBestPrices } from "@/lib/pi/market";

/** Rust 侧 fetch_character_asset_totals 的返回结构 */
interface AssetTotals {
  totals: Record<string, number>;
  assetCount: number;
  truncated: boolean;
}

const PRICE_STORAGE_KEY = "pi-inventory-prices-v1";
const SOURCE_STORAGE_KEY = "pi-inventory-sources-v1";
const MARKET_STORAGE_KEY = "pi-inventory-market-v1";

/** P0 集合：P0 按最低卖单（买入），P1~P4 按最高买单（卖出） */
const P0_SET = new Set(PI_P0.map((item) => item.typeId));

/** 行星工业物资类型集合（P0 + P1~P4） */
const PI_TYPE_IDS = new Set<number>([
  ...PI_P0.map((item) => item.typeId),
  ...PI_SCHEMATICS.map((item) => item.outputTypeId),
]);

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 配方与收益（重构版）。
 *
 * 上半：P0~P4 物资清单 —— 设定每项来源（购买/库存）、行情单价、ESI 库存数量与估值。
 * 下半：合成结果 —— 把上面的标记代入计算，给出 1 小时产线的成本/收入/利润与库存缺口。
 */
export function PiSchematicsPanel() {
  const { characters, activeCharacter } = useCharacters();

  const [prices, setPrices] = useState<Record<number, string>>(() =>
    readStorage<Record<number, string>>(PRICE_STORAGE_KEY, {}),
  );
  const [source, setSource] = useState<Record<number, PiStockSource>>(() =>
    readStorage<Record<number, PiStockSource>>(SOURCE_STORAGE_KEY, {}),
  );
  const [market, setMarket] = useState<number>(() =>
    readStorage<number>(MARKET_STORAGE_KEY, PI_MARKETS[0].id),
  );
  /** 读取库存的角色："all" 或角色 ID 字符串 */
  const [characterValue, setCharacterValue] = useState<string>("all");
  const characterInitRef = useRef(false);
  const [stock, setStock] = useState<Map<number, number>>(new Map());
  /** 库存输入框草稿：保留用户正在输入的原始字符串 */
  const [stockDraft, setStockDraft] = useState<Record<number, string>>({});

  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [fetchingStock, setFetchingStock] = useState(false);
  const [priceMessage, setPriceMessage] = useState<string | null>(null);
  const [stockMessage, setStockMessage] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PRICE_STORAGE_KEY, JSON.stringify(prices));
    } catch {
      // 忽略存储失败
    }
  }, [prices]);

  useEffect(() => {
    try {
      localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(source));
    } catch {
      // 忽略存储失败
    }
  }, [source]);

  useEffect(() => {
    try {
      localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify(market));
    } catch {
      // 忽略存储失败
    }
  }, [market]);

  // 角色列表就绪后默认选中当前角色（只做一次，之后尊重用户选择）
  useEffect(() => {
    if (characterInitRef.current || characters.length === 0) return;
    const id = activeCharacter?.character_id ?? characters[0]?.character_id;
    if (id === undefined) return;
    characterInitRef.current = true;
    setCharacterValue(String(id));
  }, [characters, activeCharacter]);

  // 启动时恢复上次从 ESI 读取的库存快照（数据库不可用时静默跳过）
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const rows = await loadPiStock();
        if (cancelled || rows.length === 0) return;

        const map = new Map<number, number>();
        for (const row of rows) map.set(row.type_id, row.quantity);

        setStock(map);
        // 只给还没设置过来源的物品打上「库存」，不覆盖用户的手动选择
        setSource((current) => {
          const next = { ...current };
          for (const row of rows) {
            if (next[row.type_id] === undefined) next[row.type_id] = "stock";
          }
          return next;
        });

        const last = rows.reduce((max, row) => Math.max(max, row.updated_at), 0);
        setStockMessage(
          `已载入本地库存快照：${rows.length} 种${
            last > 0 ? `，更新于 ${new Date(last).toLocaleString("zh-CN")}` : ""
          }`,
        );
      } catch {
        // 本地库未就绪时忽略，用户仍可手动填写或重新从 ESI 读取
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const priceRows = useMemo(
    () => toPriceRows(prices, (typeId) => P0_SET.has(typeId)),
    [prices],
  );

  /** 手动修改库存数量：草稿保存原始输入，Map 里存解析后的整数 */
  const handleStockChange = (typeId: number, raw: string) => {
    setStockDraft((current) => ({ ...current, [typeId]: raw }));

    const numeric = Number(raw);
    setStock((current) => {
      const next = new Map(current);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        next.delete(typeId);
      } else {
        next.set(typeId, Math.floor(numeric));
      }
      return next;
    });
  };

  /** 清除指定等级的全部库存（界面 + 本地库同步） */
  const handleClearStock = async (typeIds: number[]) => {
    const targets = new Set(typeIds);

    const next = new Map<number, number>();
    for (const [typeId, quantity] of stock) {
      if (!targets.has(typeId)) next.set(typeId, quantity);
    }
    setStock(next);

    setStockDraft((current) => {
      const draft = { ...current };
      for (const typeId of typeIds) delete draft[typeId];
      return draft;
    });

    try {
      await savePiStock(
        activeCharacter?.character_id ?? null,
        [...next].map(([typeId, quantity]) => ({ typeId, quantity })),
      );
      setStockMessage(`已清除 ${typeIds.length} 项的库存数量`);
    } catch {
      setStockMessage("已清除界面上的库存，但写入本地库失败");
    }
  };

  /** 一键录入：把当前等级的物品数量都设为同一个值（界面 + 本地库同步） */
  const handleBulkFill = async (typeIds: number[], quantity: number) => {
    if (!Number.isFinite(quantity) || quantity <= 0) return;

    const value = Math.floor(quantity);
    const next = new Map(stock);
    for (const typeId of typeIds) next.set(typeId, value);

    setStock(next);
    setStockDraft((current) => {
      const draft = { ...current };
      for (const typeId of typeIds) delete draft[typeId];
      return draft;
    });

    try {
      await savePiStock(
        activeCharacter?.character_id ?? null,
        [...next].map(([typeId, quantity]) => ({ typeId, quantity })),
      );
      setStockMessage(`已将当前等级 ${typeIds.length} 项的数量设为 ${value}`);
    } catch {
      setStockMessage("已设置界面数量，但写入本地库失败");
    }
  };

  /** 清除所有等级的库存（界面 + 本地库同步） */
  const handleClearAllStock = async () => {
    setStock(new Map());
    setStockDraft({});

    try {
      await savePiStock(activeCharacter?.character_id ?? null, []);
      setStockMessage("已清除全部库存数量");
    } catch {
      setStockMessage("已清除界面上的库存，但写入本地库失败");
    }
  };

  /** 拉取所选市场的最优买卖价并回填 */
  const handleRefreshPrices = async () => {
    const typeIds = PI_INVENTORY_GROUPS.flatMap((group) =>
      group.items.map((item) => item.typeId),
    );

    setFetchingPrices(true);
    setPriceMessage(null);

    try {
      const result = await fetchBestPrices(typeIds, { concurrency: 3 });
      const entries: Array<{ typeId: number; value: number }> = [];

      for (const [typeId, best] of result.prices) {
        const value = P0_SET.has(typeId) ? best.sell : best.buy;
        if (value !== null && value > 0) {
          entries.push({ typeId, value: Math.round(value * 100) / 100 });
        }
      }

      setPrices((current) => {
        const next = { ...current };
        for (const entry of entries) next[entry.typeId] = String(entry.value);
        return next;
      });

      const marketName =
        PI_MARKETS.find((item) => item.id === market)?.name ?? String(market);
      setPriceMessage(
        `${marketName}：更新 ${entries.length} 项${
          result.failed.length > 0 ? `，${result.failed.length} 项失败（可重试）` : ""
        }`,
      );
    } catch (error) {
      setPriceMessage(
        `刷新行情失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setFetchingPrices(false);
    }
  };

  /** 读取选中角色（或全部角色）的资产，合并成库存数量 */
  const handleFetchStock = async () => {
    const targets =
      characterValue === "all"
        ? characters.map((item) => item.character_id)
        : [Number(characterValue)].filter((id) => Number.isFinite(id) && id > 0);

    if (targets.length === 0) {
      setStockMessage("请先在「个人中心」添加 EVE 角色");
      return;
    }

    setFetchingStock(true);
    setStockMessage(null);

    try {
      const merged = new Map<number, number>();
      let assetCount = 0;
      let truncated = false;

      for (const characterId of targets) {
        const payload = await invoke<AssetTotals>(
          "fetch_character_asset_totals",
          { characterId },
        );
        assetCount += payload.assetCount;
        truncated = truncated || payload.truncated;

        for (const [key, value] of Object.entries(payload.totals)) {
          const typeId = Number(key);
          if (!PI_TYPE_IDS.has(typeId) || value <= 0) continue;
          // 多角色时同一物品直接累加
          merged.set(typeId, (merged.get(typeId) ?? 0) + value);
        }
      }

      setStock(merged);
      // ESI 重读后草稿作废，否则会盖住新数量
      setStockDraft({});

      // 读到库存的物品默认按「库存」计，用户可再手动改成购买
      setSource((current) => {
        const updated = { ...current };
        for (const typeId of merged.keys()) updated[typeId] = "stock";
        return updated;
      });

      // 落库：下次打开应用直接恢复，不必再请求 ESI
      let savedHint = "";
      try {
        await savePiStock(
          targets.length === 1 ? targets[0] : null,
          [...merged].map(([typeId, quantity]) => ({ typeId, quantity })),
        );
        savedHint = "，已存入本地库";
      } catch {
        savedHint = "，写入本地库失败";
      }

      const scope =
        targets.length === 1
          ? `${characters.find((item) => item.character_id === targets[0])?.name ?? "角色"}`
          : `全部 ${targets.length} 个角色`;

      setStockMessage(
        `${scope}：读取 ${assetCount.toLocaleString()} 条资产，命中行星物资 ${merged.size} 种${
          truncated ? "（资产过多，已截断）" : ""
        }${savedHint}`,
      );
    } catch (error) {
      setStockMessage(
        `读取库存失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setFetchingStock(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PiInventoryPanel
        prices={prices}
        stock={stock}
        stockDraft={stockDraft}
        source={source}
        market={market}
        characters={characters.map((item) => ({
          id: item.character_id,
          name: item.name,
        }))}
        characterValue={characterValue}
        onCharacterChange={setCharacterValue}
        onMarketChange={setMarket}
        onPriceChange={(typeId, value) =>
          setPrices((current) => ({ ...current, [typeId]: value }))
        }
        onStockChange={handleStockChange}
        onSourceChange={(typeId, value) =>
          setSource((current) => ({ ...current, [typeId]: value }))
        }
        onClearStock={(typeIds) => void handleClearStock(typeIds)}
        onClearAllStock={() => void handleClearAllStock()}
        onBulkFill={(typeIds, quantity) => void handleBulkFill(typeIds, quantity)}
        onRefreshPrices={() => void handleRefreshPrices()}
        onFetchStock={() => void handleFetchStock()}
        fetchingPrices={fetchingPrices}
        fetchingStock={fetchingStock}
        priceMessage={priceMessage}
        stockMessage={stockMessage}
      />

      <PiSynthesisResult
        priceRows={priceRows}
        stock={stock}
        source={source}
      />
    </div>
  );
}
