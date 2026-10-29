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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";

import {
  saveDiscoveredStructures,
  upsertStructure,
  type StructureInfo,
  type StructureSyncResult,
} from "@/lib/db";
import { describeError } from "@/hooks/useCharacters";

interface BuildingManagerProps {
  characterId: number | null;
  /** 录入或同步成功后触发，让外层的建筑列表刷新 */
  onSaved: () => void | Promise<void>;
}

/**
 * 建筑录入与同步。
 *
 * 录入：按建筑 ID 调 ESI 读取详情后入库。
 * 同步：五源汇总（挂单 / 资产 / 合同 / 所在 / 军团）发现角色可访问的玩家建筑。
 */
export default function BuildingManager({
  characterId,
  onSaved,
}: BuildingManagerProps) {
  const [structureIdText, setStructureIdText] = useState("");
  const [adding, setAdding] = useState(false);
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

  const handleIngest = async () => {
    const id = Number(structureIdText.trim());
    if (!Number.isFinite(id) || id <= 0) {
      setError("请输入有效的建筑 ID（纯数字）");
      return;
    }

    setAdding(true);
    setError(null);
    try {
      const info = await invoke<StructureInfo>("resolve_structure", {
        structureId: id,
        characterId,
      });
      await upsertStructure(info, characterId);
      setStructureIdText("");
      await onSaved();
      if (info.hasMarket) {
        toast.success(`已录入：${info.name}`);
      } else {
        toast.warning(
          `已录入「${info.name}」，但该建筑未开放市场，不会出现在建筑订单列表`,
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAdding(false);
    }
  };

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

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section>
        <h3 className="mb-1 text-sm font-medium">录入建筑</h3>
        <p className="mb-2 text-sm text-muted-foreground">
          填入建筑 ID 后会读取名称、类型与所在星系并写入本地，随后即可同步该建筑的订单。
        </p>
        <div className="flex gap-2">
          <Input
            value={structureIdText}
            placeholder="建筑 ID（1,000,000,000,000 以上的长数字）"
            onChange={(event) => setStructureIdText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleIngest();
            }}
          />
          <Button disabled={adding} onClick={() => void handleIngest()}>
            {adding ? "解析中…" : "录入"}
          </Button>
        </div>
      </section>

      <Separator />

      <section>
        <h3 className="mb-1 text-sm font-medium">同步建筑</h3>
        <p className="mb-2 text-sm text-muted-foreground">
          汇总「挂单 · 资产 · 合同 · 当前位置 · 军团建筑」五个来源，
          找出当前角色能访问的玩家建筑并逐个解析。整个过程约需十几秒到半分钟。
        </p>
        <Button variant="outline" disabled={syncing} onClick={() => void handleSync()}>
          {syncing ? (
            <>
              <Spinner className="size-4" />
              同步中…
            </>
          ) : (
            "开始同步"
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
                {syncResult.structures.length}
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

            {syncResult.structures.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>没有发现玩家建筑</EmptyTitle>
                  <EmptyDescription>
                    五个来源里都没有找到玩家建筑。可以在游戏内把物品放进某个建筑、
                    或在建筑里挂单后再试。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-2">
                {syncResult.structures.map((item) => (
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

                    <div className="flex shrink-0 gap-1">
                      {item.hasMarket ? (
                        <Badge variant="secondary">有市场</Badge>
                      ) : item.accessible ? (
                        <Badge variant="outline">无市场</Badge>
                      ) : null}
                    </div>
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
