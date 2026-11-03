import { useState } from "react";
import { Building2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCharacters } from "@/hooks/useCharacters";
import { MENU_ACCOUNT, type MenuKey } from "@/lib/nav";
import { useUiStore, type MarketTab } from "@/stores/ui-store";

import MarketAnalysisTab from "./market/MarketAnalysisTab";
import MarketCompareTab from "./market/MarketCompareTab";
import MarketGroupsTab from "./market/MarketGroupsTab";
import MarketOrdersTab from "./market/MarketOrdersTab";
import MarketSalesTab from "./market/MarketSalesTab";
import MarketStructuresTab from "./market/MarketStructuresTab";
import "./MarketPage.css";

interface MarketPageProps {
  onNavigate: (menu: MenuKey) => void;
}

/**
 * 市场页外壳。
 *
 * 只负责角色状态守卫与标签框架，每个标签的具体实现放在 ./market/*Tab.tsx，
 * 样式各自维护在同名 .css 里，避免这个文件继续膨胀。
 */
export default function MarketPage({ onNavigate }: MarketPageProps) {
  const { characters, activeCharacter, loading, loadError } = useCharacters();
  const { marketTab, setMarketTab, setPendingTypeId } = useUiStore();
  /** 「同步市场订单」弹窗 */
  const [structuresOpen, setStructuresOpen] = useState(false);

  const activeCharacterId = activeCharacter?.character_id ?? null;

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
        <AlertDescription>
          <p>{loadError}</p>
          <p className="text-muted-foreground">
            该页面需要在 Tauri 窗口中运行（<code>pnpm tauri dev</code>），
            纯浏览器打开 <code>pnpm dev</code> 无法访问 SQLite。
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  if (characters.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1400px]">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>需要先授权 EVE 角色</EmptyTitle>
            <EmptyDescription>
              市场数据依赖 EVE 官方接口，需要先在个人中心完成角色授权，
              应用才能读取你的订单和星城行情。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => onNavigate(MENU_ACCOUNT)}>前往个人中心</Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="market-page">
      <Tabs
        value={marketTab}
        onValueChange={(value) => setMarketTab(value as MarketTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-wrap items-center gap-2">
          <TabsList className="gap-1.5">
            <TabsTrigger value="groups">交易市场</TabsTrigger>
            <TabsTrigger value="compare">市场差价对比</TabsTrigger>
            <TabsTrigger value="orders">我的订单</TabsTrigger>
            <TabsTrigger value="analysis">订单分析</TabsTrigger>
            <TabsTrigger value="sales">销量分析</TabsTrigger>
          </TabsList>

          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-8 text-xs"
            onClick={() => setStructuresOpen(true)}
          >
            <Building2 className="size-3.5" />
            同步市场订单
          </Button>
        </div>

        <TabsContent value="groups" className="market-page__content">
          <MarketGroupsTab characterId={activeCharacterId} />
        </TabsContent>

        <TabsContent value="compare" className="market-page__content">
          <MarketCompareTab />
        </TabsContent>

        <TabsContent
          value="orders"
          forceMount
          className="market-page__content data-[state=inactive]:hidden"
        >
          <MarketOrdersTab
            characters={characters}
            activeCharacterId={activeCharacterId}
            onOpenType={(typeId) => {
              setPendingTypeId(typeId);
              setMarketTab("groups");
            }}
          />
        </TabsContent>

        <TabsContent value="analysis" className="market-page__content">
          <MarketAnalysisTab characters={characters} />
        </TabsContent>

        <TabsContent value="sales" className="market-page__content">
          <MarketSalesTab />
        </TabsContent>
      </Tabs>

      {/* 同步市场订单：从标签页改为弹窗，避免占掉一个主标签 */}
      <Dialog open={structuresOpen} onOpenChange={setStructuresOpen}>
        <DialogContent className="flex h-[80vh] flex-col gap-3 sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>同步市场订单</DialogTitle>
            <DialogDescription>
              录入建筑并同步订单数据。只列出开放市场的建筑，同步结果会存到本地库，
              供「我的订单」「市场差价对比」「销量分析」等标签使用。
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-hidden">
            <MarketStructuresTab characterId={activeCharacterId} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
