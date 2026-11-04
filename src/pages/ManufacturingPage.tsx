import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { fetchCharacterSkills } from "@/lib/manufacturing/api";
import { loadMfgData, type MfgData } from "@/lib/manufacturing/data";
import { MENU_ACCOUNT, type MenuKey } from "@/lib/nav";

import MfgBlueprintTab from "./manufacturing/MfgBlueprintTab";
import MfgCalculatorTab from "./manufacturing/MfgCalculatorTab";
import MfgFacilityTab from "./manufacturing/MfgFacilityTab";
import MfgJobsTab from "./manufacturing/MfgJobsTab";
import "./ManufacturingPage.css";

interface ManufacturingPageProps {
  onNavigate: (menu: MenuKey) => void;
}

/**
 * 制造业外壳。
 *
 * 蓝图数据（约 5,000 条）在这里加载一次后下发给各标签页，
 * 避免每个页签各自 import 同一份大 JSON。
 */
export default function ManufacturingPage({
  onNavigate,
}: ManufacturingPageProps) {
  const { characters, activeCharacter, loading, loadError } = useCharacters();
  const [tab, setTab] = useState("blueprints");
  const [data, setData] = useState<MfgData | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  /** 当前角色的制造业技能等级（用于时间减免） */
  const [skills, setSkills] = useState<Record<string, number>>({});

  const activeCharacterId = activeCharacter?.character_id ?? null;

  useEffect(() => {
    if (activeCharacterId === null) {
      setSkills({});
      return;
    }

    let cancelled = false;
    void fetchCharacterSkills(activeCharacterId)
      .then((levels) => {
        if (!cancelled) setSkills(levels);
      })
      .catch(() => {
        // 缺 scope 或网络异常时按「无技能加成」继续，不影响其它功能
        if (!cancelled) setSkills({});
      });

    return () => {
      cancelled = true;
    };
  }, [activeCharacterId]);

  useEffect(() => {
    let cancelled = false;

    void loadMfgData()
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDataError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

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

  if (characters.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1400px]">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>需要先授权 EVE 角色</EmptyTitle>
            <EmptyDescription>
              制造业需要读取角色的蓝图与生产队列，请先在个人中心完成角色授权。
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
    <div className="manufacturing-page">
      {dataError && (
        <Alert variant="destructive" className="mb-3 shrink-0">
          <AlertTitle>蓝图数据加载失败</AlertTitle>
          <AlertDescription>{dataError}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="gap-1.5">
          <TabsTrigger value="blueprints">蓝图资产</TabsTrigger>
          <TabsTrigger value="calculator">成本计算</TabsTrigger>
          <TabsTrigger value="jobs">生产队列</TabsTrigger>
          <TabsTrigger value="facilities">建筑配置</TabsTrigger>
        </TabsList>

        <TabsContent value="blueprints" className="manufacturing-page__content">
          <MfgBlueprintTab
            characters={characters}
            activeCharacterId={activeCharacterId}
            data={data}
          />
        </TabsContent>

        <TabsContent
          value="calculator"
          forceMount
          className="manufacturing-page__content data-[state=inactive]:hidden"
        >
          <MfgCalculatorTab data={data} skills={skills} />
        </TabsContent>

        <TabsContent value="jobs" className="manufacturing-page__content">
          <MfgJobsTab
            characters={characters}
            activeCharacterId={activeCharacterId}
            data={data}
          />
        </TabsContent>

        <TabsContent value="facilities" className="manufacturing-page__content">
          <MfgFacilityTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
