import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";

import {
  saveDiscoveredStructures,
  type StructureSyncResult,
} from "@/lib/db";
import { describeError } from "@/hooks/useCharacters";

interface BuildingManagerProps {
  characterId: number | null;
  /** 录入或同步成功后触发，让外层的建筑列表刷新 */
  onSaved: () => void | Promise<void>;
}

/**
 * 获取玩家市场建筑：五源汇总（挂单 / 资产 / 合同 / 所在 / 军团）
 * 发现角色可访问的玩家建筑，只保留开放市场的那些。
 *
 * 单栋录入已拆到 building-ingest.tsx（放在标题行右侧）。
 */
export default function BuildingManager({
  characterId,
  onSaved,
}: BuildingManagerProps) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<StructureSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (characterId === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>需要先授权角色</EmptyTitle>
          <EmptyDescription>
            在个人中心「角色」标签页添加 EVE 角色后即可录入与同步建筑。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const result = await invoke<StructureSyncResult>(
        "sync_character_structures",
        { characterId },
      );
      setSyncResult(result);
      const saved = await saveDiscoveredStructures(result.structures, characterId);
      await onSaved();
      toast.success(`发现 ${result.structures.length} 个建筑，已录入 ${saved} 个`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSyncing(false);
    }
  };

  // 同步结果里只展示开放市场的建筑
  const marketStructures =
    syncResult?.structures.filter((item) => item.hasMarket) ?? [];

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section>
        <h3 className="mb-1 text-sm font-medium">获取玩家市场建筑</h3>
        <p className="mb-2 text-sm text-muted-foreground">
          汇总「挂单 · 资产 · 合同 · 当前位置 · 军团建筑」五个来源，
          找出当前角色能访问的玩家建筑并逐个解析，只保留开放市场的建筑。
          整个过程约需十几秒到半分钟。
        </p>
        <Button variant="outline" disabled={syncing} onClick={() => void handleSync()}>
          {syncing ? (
            <>
              <Spinner className="size-4" />
              获取中…
            </>
          ) : (
            "开始获取"
          )}
        </Button>
      </section>

      {syncResult && (
        <>
          <Separator />
          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">同步结果</h3>
              <Badge variant="secondary" className="tabular-nums">
                {marketStructures.length}
              </Badge>
              {syncResult.truncated && (
                <span className="text-xs text-amber-400">
                  候选共 {syncResult.candidateCount} 个，仅解析了前一部分
                </span>
              )}
            </div>

            {syncResult.notes.length > 0 && (
              <Alert className="mb-2">
                <AlertTitle>部分来源不可用</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {syncResult.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {marketStructures.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>没有发现开放市场的建筑</EmptyTitle>
                  <EmptyDescription>
                    五个来源里没有找到开放市场的玩家建筑。
                    可以在游戏内把物品放进某个有市场的建筑、或在其中挂单后再试。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-2">
                {marketStructures.map((item) => (
                  <li
                    key={item.structureId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span className="block text-sm">
                        {item.name ?? `#${item.structureId}`}
                        {!item.accessible && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            无访问权限
                          </span>
                        )}
                      </span>
                      <span className="block font-mono text-[11px] text-muted-foreground">
                        {item.structureId}
                        {item.solarSystemName ? ` · ${item.solarSystemName}` : ""}
                        {item.sources.length > 0
                          ? ` · ${item.sources.join(" / ")}`
                          : ""}
                      </span>
                    </div>

                    <Badge variant="secondary" className="shrink-0">
                      有市场
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
