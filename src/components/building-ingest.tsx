import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { upsertStructure, type StructureInfo } from "@/lib/db";
import { describeError } from "@/hooks/useCharacters";

interface BuildingIngestProps {
  characterId: number | null;
  /** 录入成功后触发，让外层的建筑列表刷新 */
  onSaved: () => void | Promise<void>;
  className?: string;
}

/**
 * 从各种粘贴内容里提取建筑 ID，支持：
 *   - 纯数字：1035466617946
 *   - 游戏内链接：<url=showinfo:35833//1035466617946>Jita Keepstar</url>
 *   - 裸 showinfo：showinfo:35833//1035466617946
 *   - 带名字的整行文本（兜底取 12 位以上的长数字）
 */
function parseStructureId(input: string): number | null {
  const text = input.trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const id = Number(text);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  const showInfo = text.match(/showinfo:\d+\/\/(\d+)/i);
  if (showInfo) {
    const id = Number(showInfo[1]);
    if (Number.isFinite(id) && id > 0) return id;
  }

  // 玩家建筑 ID 都是 1e12 以上，用长度兜底避免误取 type_id 之类的短数字
  const longNumbers = text.match(/\d{12,}/g);
  if (longNumbers && longNumbers.length > 0) {
    const id = Number(longNumbers[0]);
    if (Number.isFinite(id) && id > 0) return id;
  }

  return null;
}

/**
 * 按建筑 ID / 游戏内链接录入：调 ESI 读取名称 / 类型 / 星系后写入本地库。
 * 独立成组件是为了能塞进「同步市场订单」的标题行右侧。
 */
export default function BuildingIngest({
  characterId,
  onSaved,
  className,
}: BuildingIngestProps) {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);

  const handleIngest = async () => {
    if (characterId === null) {
      toast.error("请先在个人中心授权角色");
      return;
    }

    const id = parseStructureId(text);
    if (id === null) {
      toast.error(
        "无法从输入中识别建筑 ID。可直接粘贴建筑 ID，或游戏内复制的建筑链接。",
      );
      return;
    }

    setAdding(true);
    try {
      const info = await invoke<StructureInfo>("resolve_structure", {
        structureId: id,
        characterId,
      });
      await upsertStructure(info, characterId);
      setText("");
      await onSaved();

      if (info.hasMarket) {
        toast.success(`已录入：${info.name}`);
      } else {
        toast.warning(
          `已录入「${info.name}」，但该建筑未开放市场，不会出现在同步市场订单列表`,
        );
      }
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div id="building-ingest" className={cn("flex items-center gap-2", className)}>
      <Input
        value={text}
        placeholder="建筑 ID 或游戏内链接"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void handleIngest();
        }}
        className="h-8 w-64 text-xs"
      />
      <Button
        size="sm"
        disabled={adding || characterId === null}
        onClick={() => void handleIngest()}
      >
        {adding ? "解析中…" : "录入建筑"}
      </Button>
    </div>
  );
}
