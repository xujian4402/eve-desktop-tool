import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { AssetsPanel } from "@/components/account-assets-panel";
import { PermissionsPanel } from "@/components/account-permissions-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useCharacters } from "@/hooks/useCharacters";
import type { EveCharacter } from "@/lib/db";
import { cn } from "@/lib/utils";
import { useUiStore, type AccountTab } from "@/stores/ui-store";

/**
 * 授权等待的分阶段提示。
 * 桌面端无法感知浏览器标签页是否被关闭，只能在等待过久时主动引导用户取消。
 */
function loginHint(seconds: number): { text: string; warn: boolean } {
  if (seconds < 12) return { text: "正在打开浏览器", warn: false };
  if (seconds < 45) return { text: "请在浏览器中完成授权", warn: false };
  return { text: "浏览器页面已关闭？请点「取消」重试", warn: true };
}

export default function AccountPage() {
  const { accountTab, setAccountTab } = useUiStore();
  const {
    characters,
    activeCharacter,
    loading,
    loadError,
    authorizing,
    actionError,
    login,
    switchTo,
    remove,
  } = useCharacters();

  const [pendingUnbind, setPendingUnbind] = useState<EveCharacter | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);

  // 授权等待计时：用于分阶段提示与「等待过久」的引导
  useEffect(() => {
    if (!authorizing) {
      setWaitSeconds(0);
      return;
    }

    setWaitSeconds(0);
    const timer = setInterval(() => setWaitSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [authorizing]);

  const waitHint = loginHint(waitSeconds);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 正在打开本地数据库…
      </div>
    );
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>本地数据库不可用</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }

  return (
    // 父级 .content--fill 是 flex 容器，这里用 flex-1 拿到确定高度，
    // 资产/权限面板才能继续用 flex-1 撑满剩余空间并在内部滚动。
    <div className="mx-auto flex min-h-0 w-full max-w-[1080px] flex-1 flex-col">
      <header className="mb-6 flex shrink-0 items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">个人中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理已授权的 EVE 角色、资产与权限
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {authorizing ? (
            <>
              <Spinner className="size-3.5" />
              <span
                className={cn(
                  "text-xs tabular-nums",
                  waitHint.warn ? "text-amber-400" : "text-muted-foreground",
                )}
              >
                {waitHint.text} · {waitSeconds}s
              </span>
              <Button
                variant="outline"
                onClick={() => {
                  void invoke("eve_cancel_login");
                  toast.info("已取消授权");
                }}
              >
                取消
              </Button>
            </>
          ) : (
            <Button
              onClick={() => {
                void login()
                  .then((result) => toast.success(`已添加角色：${result.name}`))
                  .catch(() => {
                    // 失败原因由 actionError 统一展示
                  });
              }}
            >
              添加角色
            </Button>
          )}
        </div>
      </header>

      {/* 用户主动取消不算失败，已在点击时 toast 提示，这里不再重复展示 */}
      {actionError && !actionError.includes("已取消") && (
        <Alert variant="destructive" className="mb-4 shrink-0">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={accountTab}
        onValueChange={(value) => setAccountTab(value as AccountTab)}
        className="min-h-0 flex-1"
      >
        <TabsList>
          <TabsTrigger value="characters">角色</TabsTrigger>
          <TabsTrigger value="assets">资产</TabsTrigger>
          <TabsTrigger value="permissions">权限</TabsTrigger>
        </TabsList>

        <TabsContent value="characters" className="mt-4">
          {characters.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>还没有绑定角色</EmptyTitle>
                <EmptyDescription>
                  点击右上角「添加角色」，会在系统浏览器中打开 EVE 官方登录页。
                  授权完成后自动返回，凭据加密保存在本机系统凭据库中。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {characters.map((character) => {
                const isActive =
                  character.character_id === activeCharacter?.character_id;

                return (
                  <Item
                    key={character.character_id}
                    variant="outline"
                    className="bg-card/60"
                  >
                    <ItemMedia>
                      <Avatar className="size-10">
                        {character.portrait_url && (
                          <AvatarImage
                            src={character.portrait_url}
                            alt={character.name}
                          />
                        )}
                        <AvatarFallback>
                          {character.name.slice(0, 1)}
                        </AvatarFallback>
                      </Avatar>
                    </ItemMedia>

                    <ItemContent>
                      <ItemTitle>
                        {character.name}
                        {isActive && <Badge variant="secondary">当前</Badge>}
                      </ItemTitle>
                      <p className="text-xs text-muted-foreground">
                        {character.corporation_name ?? "未知军团"}
                        {character.alliance_name
                          ? ` · ${character.alliance_name}`
                          : ""}
                      </p>
                    </ItemContent>

                    <ItemActions>
                      {!isActive && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void switchTo(character.character_id)}
                        >
                          设为当前
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setPendingUnbind(character)}
                      >
                        解绑
                      </Button>
                    </ItemActions>
                  </Item>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Radix 用 hidden 属性隐藏未激活面板，而 display 工具类会覆盖 UA 的
            [hidden]{display:none}（项目没引入 preflight），所以加 flex 的同时
            必须用 data-[state=inactive]:hidden 把它显式藏回去。 */}
        <TabsContent
          value="assets"
          className="mt-4 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <AssetsPanel
            characters={characters}
            activeCharacterId={activeCharacter?.character_id ?? null}
          />
        </TabsContent>

        <TabsContent
          value="permissions"
          className="mt-4 flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <PermissionsPanel
            characterId={activeCharacter?.character_id ?? null}
            characterName={activeCharacter?.name ?? null}
          />
        </TabsContent>
      </Tabs>

      <AlertDialog
        open={pendingUnbind !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUnbind(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解绑角色？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{pendingUnbind?.name ?? "该角色"}」在本机的授权凭据与角色记录。
              之后如需使用，需要重新授权。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingUnbind;
                setPendingUnbind(null);
                if (!target) return;

                void (async () => {
                  try {
                    await remove(target.character_id);
                    toast.success("已解绑角色");
                  } catch {
                    // 失败原因由 useCharacters 统一写入 actionError
                  }
                })();
              }}
            >
              解绑
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
