import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { CharacterDetailPanel } from "@/components/character-detail-panel";
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
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { useCharacters } from "@/hooks/useCharacters";
import type { EveCharacter } from "@/lib/db";
import { cn } from "@/lib/utils";

/**
 * 授权等待的分阶段提示。
 * 桌面端无法感知浏览器标签页是否被关闭，只能在等待过久时主动引导用户取消。
 */
function loginHint(seconds: number): { text: string; warn: boolean } {
  if (seconds < 12) return { text: "正在打开浏览器", warn: false };
  if (seconds < 45) return { text: "请在浏览器中完成授权", warn: false };
  return { text: "浏览器页面已关闭？请点「取消」重试", warn: true };
}

/**
 * 个人中心：只剩角色详情。
 *
 * 角色切换、设为当前、解绑都在详情面板内完成；
 * 权限、资产等模块作为详情的二级标签存在。
 */
export default function AccountPage() {
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
  /** 详情页当前查看的角色；为空则跟随当前角色 */
  const [detailCharacterId, setDetailCharacterId] = useState<number | null>(
    null,
  );

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
    // 详情面板才能继续用 flex-1 撑满剩余空间并在内部滚动。
    <div className="mx-auto flex min-h-0 w-full max-w-[1180px] flex-1 flex-col">
      <header className="mb-4 flex shrink-0 items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">个人中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理已授权的 EVE 角色，查看资料、资产与权限
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

      <CharacterDetailPanel
        characters={characters}
        activeCharacterId={activeCharacter?.character_id ?? null}
        selectedCharacterId={detailCharacterId}
        onSelect={setDetailCharacterId}
        onSwitchTo={(characterId) => void switchTo(characterId)}
        onUnbind={setPendingUnbind}
      />

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
              将删除「{pendingUnbind?.name ?? "该角色"}」在本机的授权凭据、角色记录，
              以及该角色的订单、同步任务与行星工业库存等数据。之后如需使用，需要重新授权。
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
