import { useQuery } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";

import { getCharacterScopes } from "@/lib/db";
import { cn } from "@/lib/utils";

/**
 * 当前功能真正依赖的作用域。授权时实际申请的是 ESI 全部权限（见 Rust 侧 SCOPES），
 * 这里只用于提示「哪些关键权限缺失会导致功能不可用」。
 */
const KEY_SCOPES: { scope: string; purpose: string }[] = [
  { scope: "publicData", purpose: "读取角色、军团、联盟等公开信息" },
  {
    scope: "esi-markets.read_character_orders.v1",
    purpose: "读取角色自己挂出的买单与卖单",
  },
  {
    scope: "esi-markets.structure_markets.v1",
    purpose: "读取星城等玩家建筑的市场订单",
  },
  {
    scope: "esi-universe.read_structures.v1",
    purpose: "解析建筑名称与所在星系",
  },
  {
    scope: "esi-search.search_structures.v1",
    purpose: "按名称搜索建筑",
  },
  {
    scope: "esi-assets.read_assets.v1",
    purpose: "读取角色资产并按建筑分组展示",
  },
  {
    scope: "esi-location.read_location.v1",
    purpose: "读取角色当前停靠的建筑",
  },
];

/**
 * 已授予权限列表。
 *
 * 高度行为：根节点 `h-full` 纵向 flex，说明文字 / 状态提示 / 标题行固定，
 * 权限列表用 `flex-1` 填满剩余高度并在内部滚动
 * （以前是写死 `h-72`，窗口变高后列表下方就会留出一块空白）。
 */
export function PermissionsPanel({
  characterId,
  characterName,
}: {
  characterId: number | null;
  characterName: string | null;
}) {
  const query = useQuery({
    queryKey: ["scopes", characterId],
    queryFn: () => getCharacterScopes(characterId as number),
    enabled: characterId !== null,
  });

  const granted = query.data ?? [];
  const missing = KEY_SCOPES.filter((item) => !granted.includes(item.scope));

  if (characterId === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>需要先授权角色</EmptyTitle>
          <EmptyDescription>在「角色」标签页添加 EVE 角色后即可查看授权范围。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (granted.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>没有记录授权范围</EmptyTitle>
          <EmptyDescription>
            该角色可能是旧版本授权的。重新授权一次即可记录完整的作用域列表。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="mb-3 shrink-0 text-sm text-muted-foreground">
        授权时申请 ESI 的全部权限，数据全部保存在本机，不会上传。
        {characterName ? `（以下以「${characterName}」的授权为准）` : ""}
      </p>

      {missing.length > 0 ? (
        <Alert variant="destructive" className="mb-3 shrink-0">
          <AlertTitle>缺少当前功能需要的权限</AlertTitle>
          <AlertDescription>
            <p>{missing.map((item) => item.scope).join("、")}</p>
            <p className="text-muted-foreground">
              这些权限缺失会导致市场、资产相关功能不可用，请在「角色」页解绑后重新授权。
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert className="mb-3 shrink-0">
          <AlertTitle>关键权限齐全</AlertTitle>
          <AlertDescription>
            市场与资产相关功能所需的 {KEY_SCOPES.length} 项权限均已授予。
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-2 flex shrink-0 items-center gap-2">
        <span className="text-sm font-medium text-foreground/85">已授予权限</span>
        <Badge variant="secondary" className="tabular-nums">
          {granted.length}
        </Badge>
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border bg-card/40">
        <ul className="flex flex-col gap-0.5 p-2">
          {granted.map((scope) => {
            const isKey = KEY_SCOPES.some((item) => item.scope === scope);

            return (
              <li
                key={scope}
                className={cn(
                  "rounded-md px-2 py-1 font-mono text-xs",
                  isKey ? "bg-primary/10 text-primary" : "text-muted-foreground",
                )}
              >
                {scope}
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}
