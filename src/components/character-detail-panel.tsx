import { useQuery } from "@tanstack/react-query";
import { Building2, MapPin, Shield, Sparkles, Wallet } from "lucide-react";

import { CharacterAssets } from "@/components/account-assets-panel";
import { PermissionsPanel } from "@/components/account-permissions-panel";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  cleanCharacterBio,
  decodeEveText,
  fetchCharacterDetail,
  formatDuration,
  formatIsk,
  formatSp,
  type FittingItem,
} from "@/lib/character/detail";
import type { EveCharacter } from "@/lib/db";
import { cn } from "@/lib/utils";

/** 合同类型 */
const CONTRACT_TYPE_LABEL: Record<string, string> = {
  item_exchange: "物品交换",
  courier: "快递",
  auction: "拍卖",
  loan: "贷款",
};

/** 合同状态 */
const CONTRACT_STATUS_LABEL: Record<string, string> = {
  outstanding: "进行中",
  in_progress: "进行中",
  finished: "已完成",
  cancelled: "已取消",
  rejected: "已拒绝",
  failed: "失败",
  deleted: "已删除",
  reversed: "已撤销",
};

/** 舰队职务 */
const FLEET_ROLE_LABEL: Record<string, string> = {
  fleet_commander: "舰队指挥官",
  wing_commander: "联队指挥官",
  squad_commander: "中队指挥官",
  squad_member: "中队成员",
};

/** ISO → 月-日 时:分 */
function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 装配槽位分组：顺序即展示顺序 */
const FITTING_SLOTS: Array<{
  key: string;
  label: string;
  tone: string;
  match: (flag: string) => boolean;
}> = [
  {
    key: "hi",
    label: "高槽",
    tone: "border-cyan-400/50",
    match: (flag) => flag.startsWith("HiSlot"),
  },
  {
    key: "med",
    label: "中槽",
    tone: "border-sky-400/40",
    match: (flag) => flag.startsWith("MedSlot"),
  },
  {
    key: "lo",
    label: "低槽",
    tone: "border-indigo-400/40",
    match: (flag) => flag.startsWith("LoSlot"),
  },
  {
    key: "rig",
    label: "改装件",
    tone: "border-amber-400/40",
    match: (flag) => flag.startsWith("RigSlot"),
  },
  {
    key: "sub",
    label: "子系统",
    tone: "border-violet-400/40",
    match: (flag) => flag.startsWith("SubSystemSlot"),
  },
  {
    key: "drone",
    label: "无人机舱",
    tone: "border-border/50",
    match: (flag) => flag === "DroneBay",
  },
  {
    key: "fighter",
    label: "战斗机舱",
    tone: "border-border/50",
    match: (flag) => flag === "FighterBay",
  },
  {
    key: "cargo",
    label: "货舱",
    tone: "border-border/50",
    match: (flag) => flag === "Cargo",
  },
];

/** 单个装配方案卡片：按槽位分组展示物品 */
function FittingCard({ fitting }: { fitting: FittingItem }) {
  const groups = FITTING_SLOTS.map((slot) => ({
    ...slot,
    items: fitting.items.filter((item) => slot.match(item.flag)),
  })).filter((group) => group.items.length > 0);

  const known = (flag: string) =>
    FITTING_SLOTS.some((slot) => slot.match(flag));
  const others = fitting.items.filter((item) => !known(item.flag));

  if (others.length > 0) {
    groups.push({
      key: "other",
      label: "其它",
      tone: "border-border/50",
      match: () => true,
      items: others,
    });
  }

  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-card/40 p-2.5">
      <header className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate text-[12px] font-medium text-foreground/90">
            {fitting.name}
          </h3>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
            #{fitting.fittingId}
          </span>
        </div>

        <p className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
          <span className="text-cyan-300/80">
            {fitting.shipTypeName ?? "未知船体"}
          </span>
          <span>物品 {fitting.itemCount} 件</span>
          <span>槽位 {groups.length} 组</span>
        </p>
      </header>

      <div className="flex flex-col gap-1">
        {groups.map((group) => (
          <div
            key={group.key}
            className={cn("flex gap-2 rounded-sm border-l-2 py-0.5 pl-2", group.tone)}
          >
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground/70">
              {group.label}
            </span>

            <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
              {group.items.map((item, index) => (
                <span
                  key={`${item.typeId}-${item.flag}-${index}`}
                  className="text-[11px] text-foreground/80"
                  title={item.typeName ?? `#${item.typeId}`}
                >
                  {item.typeName ?? `#${item.typeId}`}
                  {item.quantity > 1 && (
                    <span className="text-muted-foreground/60">
                      {" "}
                      ×{item.quantity}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 一个指标格 */
function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-card/40 px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-sm tabular-nums text-foreground/90">
        {value}
      </p>
      {hint && <p className="text-[10px] text-muted-foreground/60">{hint}</p>}
    </div>
  );
}

/** 一张信息卡：标题 + 若干「键 值」行 */
function InfoCard({
  icon: Icon,
  title,
  rows,
  empty,
}: {
  icon: typeof Building2;
  title: string;
  rows: Array<{ label: string; value: string | null | undefined }>;
  empty?: string;
}) {
  const visible = rows.filter((row) => row.value);

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-cyan-300/80" />
        <h3 className="text-[11px] font-medium tracking-wide text-foreground/80">
          {title}
        </h3>
      </div>

      {visible.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60">
          {empty ?? "暂无数据"}
        </p>
      ) : (
        <div className="flex flex-col">
          {visible.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-3 border-b border-border/30 py-1 text-[11px] last:border-b-0"
            >
              <span className="shrink-0 text-muted-foreground/70">
                {row.label}
              </span>
              <span className="min-w-0 truncate text-right text-foreground/85">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** 单个角色的详情内容（懒加载：只在对应 Tab 激活时请求） */
function CharacterDetailBody({
  character,
  isCurrent,
  onSwitchTo,
  onUnbind,
}: {
  character: EveCharacter;
  /** 是否是当前角色（卡片上标「当前角色」并隐藏「设为当前」） */
  isCurrent: boolean;
  onSwitchTo?: (characterId: number) => void;
  onUnbind?: (character: EveCharacter) => void;
}) {
  const detailQuery = useQuery({
    queryKey: ["character-detail", character.character_id],
    queryFn: () => fetchCharacterDetail(character.character_id),
    staleTime: 60_000,
  });

  if (detailQuery.isPending) {
    return (
      <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
        <Spinner /> 正在读取角色详情…
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <p className="p-2 text-sm text-rose-400">
        读取失败：{String(detailQuery.error)}
      </p>
    );
  }

  const detail = detailQuery.data;
  const security = detail.securityStatus;
  const birthday = detail.birthday
    ? new Date(detail.birthday).toLocaleDateString("zh-CN")
    : null;
  /** 简介是 CCP 富文本，需要清洗掉标签、转义与 repr 包裹 */
  const cleanBio = detail.description
    ? cleanCharacterBio(detail.description)
    : "";

  /** 名称类字段同样可能带 Python repr（例如玩家自定义的舰船名） */
  const displayName = decodeEveText(detail.name);
  const displayCorp = detail.corporationName
    ? decodeEveText(detail.corporationName)
    : null;
  const displayAlliance = detail.allianceName
    ? decodeEveText(detail.allianceName)
    : null;
  const displayShipName = detail.shipName
    ? decodeEveText(detail.shipName)
    : null;

  /** 合同按状态汇总：数量多的排前面 */
  const contractSummary: Array<[string, number]> = (() => {
    const map = new Map<string, number>();
    for (const contract of detail.contracts) {
      map.set(contract.status, (map.get(contract.status) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  })();

  /** 已分配技能点占比（用于技能页的简易进度条） */
  const allocatedRatio =
    detail.totalSp && detail.unallocatedSp !== null
      ? Math.max(
          0,
          Math.min(1, (detail.totalSp - detail.unallocatedSp) / detail.totalSp),
        )
      : null;

  /** 角色卡片：概览页顶部展示完整身份与操作 */
  const characterCard = (
    <section className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-border/70 bg-card/40 p-3">
      <Avatar className="size-14">
        {character.portrait_url && (
          <AvatarImage src={character.portrait_url} alt={detail.name} />
        )}
        <AvatarFallback>
          {(displayName || character.name || "?").slice(0, 1)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{displayName}</h2>
          {isCurrent && (
            <Badge variant="secondary" className="text-[10px]">
              当前角色
            </Badge>
          )}
          <span className="font-mono text-[11px] text-muted-foreground">
            #{detail.characterId}
          </span>
          {security !== null && (
            <Badge
              variant="secondary"
              className={cn(
                "font-mono text-[10px]",
                security >= 5 && "text-emerald-300",
                security >= 0 && security < 5 && "text-amber-300",
                security < 0 && "text-rose-300",
              )}
              title="安全等级"
            >
              <Shield className="mr-1 size-3" />
              {security.toFixed(2)}
            </Badge>
          )}
        </div>

        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            军团：
            {displayCorp ?? "未知"}
            {detail.corporationTicker ? ` [${detail.corporationTicker}]` : ""}
          </span>
          <span>联盟：{displayAlliance ?? "无"}</span>
          <span>创建：{birthday ?? "—"}</span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!isCurrent && onSwitchTo && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            onClick={() => onSwitchTo(character.character_id)}
          >
            设为当前
          </Button>
        )}
        {onUnbind && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[10px] text-destructive hover:text-destructive"
            onClick={() => onUnbind(character)}
          >
            解绑
          </Button>
        )}
      </div>
    </section>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {/* 角色信息：二级标签 */}
      <Tabs
        defaultValue="overview"
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="h-8 w-full shrink-0 justify-start gap-1 overflow-x-auto">
          <TabsTrigger
            value="overview"
            className="h-7 shrink-0 px-2 text-[11px]"
          >
            概览
          </TabsTrigger>
          <TabsTrigger value="corp" className="h-7 shrink-0 px-2 text-[11px]">
            军团与联盟
          </TabsTrigger>
          <TabsTrigger
            value="skills"
            className="h-7 shrink-0 px-2 text-[11px]"
          >
            技能
          </TabsTrigger>
          <TabsTrigger
            value="assets"
            className="h-7 shrink-0 px-2 text-[11px]"
          >
            资产
          </TabsTrigger>
          <TabsTrigger
            value="contracts"
            className="h-7 shrink-0 px-2 text-[11px]"
          >
            合同 {detail.contracts.length}
          </TabsTrigger>
          <TabsTrigger value="mail" className="h-7 shrink-0 px-2 text-[11px]">
            邮件
            {detail.unreadMailCount > 0 ? ` ${detail.unreadMailCount}*` : ""}
          </TabsTrigger>
          <TabsTrigger
            value="fittings"
            className="h-7 shrink-0 px-2 text-[11px]"
          >
            装配 {detail.fittings.length}
          </TabsTrigger>
          <TabsTrigger value="fleet" className="h-7 shrink-0 px-2 text-[11px]">
            舰队
          </TabsTrigger>
          <TabsTrigger
            value="permissions"
            className="h-7 shrink-0 px-2 text-[11px]"
          >
            权限
          </TabsTrigger>
        </TabsList>

        {/* 概览：角色卡片 + 关键指标 + 简介 + 未加载项 */}
        <TabsContent
          value="overview"
          className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto data-[state=inactive]:hidden"
        >
          {characterCard}

          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat
              label="钱包余额"
              value={
                detail.walletBalance === null
                  ? "—"
                  : `${formatIsk(detail.walletBalance)} ISK`
              }
            />
            <Stat
              label="总技能点"
              value={formatSp(detail.totalSp)}
              hint={
                detail.unallocatedSp
                  ? `未分配 ${formatSp(detail.unallocatedSp)}`
                  : undefined
              }
            />
            <Stat
              label="军团税率"
              value={
                detail.corporationTaxRate === null
                  ? "—"
                  : `${(detail.corporationTaxRate * 100).toFixed(1)}%`
              }
            />
            <Stat
              label="军团成员"
              value={
                detail.corporationMemberCount === null
                  ? "—"
                  : detail.corporationMemberCount.toLocaleString("zh-CN")
              }
            />
          </div>

          {/* 位置与舰船 */}
          <div className="grid gap-2 lg:grid-cols-2">
            <InfoCard
              icon={MapPin}
              title="当前位置"
              rows={[
                { label: "星系", value: detail.solarSystemName },
                { label: "空间站", value: detail.stationName },
                {
                  label: "建筑",
                  value:
                    detail.structureName ??
                    (detail.structureId ? `#${detail.structureId}` : null),
                },
              ]}
              empty="没有位置数据（可能未在线或缺少授权）"
            />

            <InfoCard
              icon={Sparkles}
              title="当前舰船"
              rows={[
                {
                  label: "舰船",
                  value:
                    detail.shipTypeName ??
                    (detail.shipTypeId ? `#${detail.shipTypeId}` : null),
                },
                { label: "舰船名", value: displayShipName },
              ]}
              empty="没有舰船数据"
            />
          </div>

          {cleanBio && (
            <section className="rounded-lg border border-border/70 bg-card/40 p-3">
              <h3 className="mb-1 text-[11px] font-medium text-foreground/80">
                角色简介
              </h3>
              <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
                {cleanBio}
              </p>
            </section>
          )}

          {detail.warnings.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
              <p className="mb-1 flex items-center gap-1 text-[11px] text-amber-300">
                <Wallet className="size-3" />
                部分数据未加载
              </p>
              <ul className="flex flex-col gap-0.5">
                {detail.warnings.map((warning) => (
                  <li key={warning} className="text-[10px] text-amber-200/70">
                    · {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        {/* 军团与联盟 */}
        <TabsContent
          value="corp"
          className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto data-[state=inactive]:hidden"
        >
          <div className="grid gap-2 lg:grid-cols-2">
            <InfoCard
              icon={Building2}
              title="军团"
              rows={[
                { label: "名称", value: displayCorp },
                { label: "代号", value: detail.corporationTicker },
                { label: "ID", value: detail.corporationId?.toString() },
                {
                  label: "CEO ID",
                  value: detail.corporationCeoId?.toString(),
                },
                {
                  label: "成员数",
                  value: detail.corporationMemberCount?.toLocaleString("zh-CN"),
                },
                {
                  label: "税率",
                  value:
                    detail.corporationTaxRate === null
                      ? null
                      : `${(detail.corporationTaxRate * 100).toFixed(1)}%`,
                },
              ]}
            />

            <InfoCard
              icon={Sparkles}
              title="联盟"
              rows={[
                { label: "名称", value: displayAlliance },
                { label: "代号", value: detail.allianceTicker },
                { label: "ID", value: detail.allianceId?.toString() },
              ]}
              empty="当前没有加入联盟"
            />
          </div>
        </TabsContent>

        {/* 技能 */}
        <TabsContent
          value="skills"
          className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto data-[state=inactive]:hidden"
        >
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Stat label="总技能点" value={formatSp(detail.totalSp)} />
            <Stat
              label="未分配技能点"
              value={formatSp(detail.unallocatedSp)}
            />
            <Stat
              label="已分配"
              value={
                detail.totalSp !== null && detail.unallocatedSp !== null
                  ? formatSp(detail.totalSp - detail.unallocatedSp)
                  : "—"
              }
            />
          </div>

          {allocatedRatio !== null && (
            <section className="rounded-lg border border-border/70 bg-card/40 p-3">
              <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>技能点分配进度</span>
                <span className="tabular-nums">
                  {(allocatedRatio * 100).toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
                <div
                  className="h-full rounded-full bg-cyan-400/70"
                  style={{ width: `${allocatedRatio * 100}%` }}
                />
              </div>
            </section>
          )}

          {/* 技能训练队列 */}
          <section className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-card/40 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-medium text-foreground/80">
                技能训练队列
              </h3>
              <span className="text-[10px] text-muted-foreground/60">
                {detail.skillQueue.length} 项
              </span>
            </div>

            {detail.skillQueue.length === 0 ? (
              <p className="py-2 text-center text-[11px] text-muted-foreground/60">
                队列为空，没有正在训练的技能
              </p>
            ) : (
              <div className="flex flex-col">
                <div className="grid grid-cols-[28px_minmax(0,1fr)_56px_88px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
                  <span>#</span>
                  <span>技能</span>
                  <span className="text-right">目标</span>
                  <span className="text-right">剩余</span>
                </div>

                {detail.skillQueue.map((item, index) => {
                  const finish = item.finishDate
                    ? Date.parse(item.finishDate)
                    : Number.NaN;
                  const remaining = Number.isFinite(finish)
                    ? finish - Date.now()
                    : Number.NaN;
                  const isTrained = Number.isFinite(remaining)
                    ? remaining <= 0
                    : false;

                  return (
                    <div
                      key={`${item.queuePosition}-${item.skillId}`}
                      className={cn(
                        "grid grid-cols-[28px_minmax(0,1fr)_56px_88px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0",
                        index === 0 && "text-foreground/90",
                      )}
                    >
                      <span className="font-mono text-[10px] text-muted-foreground/60">
                        {item.queuePosition}
                      </span>
                      <span
                        className="min-w-0 truncate"
                        title={item.skillName ?? `#${item.skillId}`}
                      >
                        {item.skillName ?? `#${item.skillId}`}
                      </span>
                      <span className="text-right font-mono text-muted-foreground">
                        Lv{item.finishedLevel}
                      </span>
                      <span
                        className={cn(
                          "text-right font-mono tabular-nums",
                          Number.isFinite(remaining)
                            ? isTrained
                              ? "text-emerald-400/80"
                              : "text-cyan-300/90"
                            : "text-amber-300/80",
                        )}
                      >
                        {Number.isFinite(remaining)
                          ? formatDuration(remaining)
                          : "已暂停"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <p className="text-[10px] text-muted-foreground/60">
            技能与队列来自 ESI `/characters/{"{id}"}/skills/`、`/skillqueue/`，
            需要 esi-skills 相关授权。
          </p>
        </TabsContent>

        {/* 资产：复用个人中心的单角色资产视图 */}
        <TabsContent
          value="assets"
          className="mt-2 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <CharacterAssets characterId={character.character_id} />
        </TabsContent>

        {/* 合同 */}
        <TabsContent
          value="contracts"
          className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto data-[state=inactive]:hidden"
        >
          {detail.contracts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-[11px] text-muted-foreground/60">
              没有合同记录（或缺少 esi-contracts 授权）
            </p>
          ) : (
            <>
              {/* 按状态汇总 */}
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/70 bg-card/40 px-3 py-2">
                <span className="mr-1 text-[10px] text-muted-foreground">
                  共 {detail.contracts.length} 条
                </span>

                {contractSummary.map(([status, count]) => (
                  <span
                    key={status}
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] tabular-nums",
                      status === "outstanding" || status === "in_progress"
                        ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                        : status === "finished"
                          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300/80"
                          : "border-border/60 text-muted-foreground/70",
                    )}
                  >
                    {CONTRACT_STATUS_LABEL[status] ?? status}
                    <span className="ml-1 font-mono">{count}</span>
                  </span>
                ))}
              </div>

              <section className="rounded-lg border border-border/70 bg-card/40 p-3">
              <div className="grid grid-cols-[64px_60px_minmax(0,1fr)_90px_80px] items-center gap-2 border-b border-border/40 pb-1 text-[10px] text-muted-foreground/70">
                <span>类型</span>
                <span>状态</span>
                <span>标题</span>
                <span className="text-right">价格</span>
                <span className="text-right">截止</span>
              </div>

              {detail.contracts.map((contract) => (
                <div
                  key={contract.contractId}
                  className="grid grid-cols-[64px_60px_minmax(0,1fr)_90px_80px] items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
                >
                  <span className="truncate text-muted-foreground">
                    {CONTRACT_TYPE_LABEL[contract.contractType] ??
                      contract.contractType}
                  </span>
                  <span
                    className={cn(
                      "truncate",
                      contract.status === "outstanding" ||
                        contract.status === "in_progress"
                        ? "text-cyan-300/90"
                        : "text-muted-foreground/70",
                    )}
                  >
                    {CONTRACT_STATUS_LABEL[contract.status] ?? contract.status}
                  </span>
                  <span className="min-w-0 truncate" title={contract.title ?? ""}>
                    {contract.title ||
                      (contract.forCorporation ? "（军团合同）" : "（无标题）")}
                  </span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">
                    {contract.price === null
                      ? "—"
                      : formatIsk(contract.price)}
                  </span>
                  <span className="text-right text-[10px] text-muted-foreground/70">
                    {shortTime(contract.dateExpired)}
                  </span>
                </div>
              ))}

              <p className="mt-1 text-[10px] text-muted-foreground/50">
                仅显示最近一页（最多 50 条）
              </p>
              </section>
            </>
          )}
        </TabsContent>

        {/* 邮件 */}
        <TabsContent
          value="mail"
          className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto data-[state=inactive]:hidden"
        >
          {detail.mails.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-[11px] text-muted-foreground/60">
              没有邮件（或缺少 esi-mail 授权）
            </p>
          ) : (
            <section className="flex flex-col rounded-lg border border-border/70 bg-card/40 p-3">
              {detail.mails.map((mail) => (
                <div
                  key={mail.mailId}
                  className="flex items-center gap-2 border-b border-border/20 py-1 text-[11px] last:border-b-0"
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      mail.isRead ? "bg-transparent" : "bg-cyan-400",
                    )}
                    title={mail.isRead ? "已读" : "未读"}
                  />
                  <span className="w-28 shrink-0 truncate text-muted-foreground/80">
                    {mail.fromName ?? "未知发件人"}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      !mail.isRead && "font-medium text-foreground/90",
                    )}
                    title={mail.subject ?? ""}
                  >
                    {mail.subject || "（无主题）"}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {shortTime(mail.timestamp)}
                  </span>
                </div>
              ))}

              <p className="mt-1 text-[10px] text-muted-foreground/50">
                仅显示最近一页（最多 50 条），未读 {detail.unreadMailCount} 封
              </p>
            </section>
          )}
        </TabsContent>

        {/* 装配 */}
        <TabsContent
          value="fittings"
          className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto data-[state=inactive]:hidden"
        >
          {detail.fittings.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-[11px] text-muted-foreground/60">
              没有保存的装配方案（或缺少 esi-fittings 授权）
            </p>
          ) : (
            <>
              {/* 汇总 */}
              <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4">
                <Stat
                  label="装配方案"
                  value={String(detail.fittings.length)}
                />
                <Stat
                  label="涉及船体"
                  value={String(
                    new Set(detail.fittings.map((item) => item.shipTypeId))
                      .size,
                  )}
                />
                <Stat
                  label="配置物品总数"
                  value={String(
                    detail.fittings.reduce(
                      (sum, item) => sum + item.itemCount,
                      0,
                    ),
                  )}
                />
                <Stat
                  label="平均每套"
                  value={`${Math.round(
                    detail.fittings.reduce(
                      (sum, item) => sum + item.itemCount,
                      0,
                    ) / detail.fittings.length,
                  )} 件`}
                />
              </div>

              {/* 卡片列表 */}
              <div className="grid gap-2 lg:grid-cols-2">
                {detail.fittings.map((fitting) => (
                  <FittingCard
                    key={fitting.fittingId}
                    fitting={fitting}
                  />
                ))}
              </div>
            </>
          )}
        </TabsContent>

        {/* 权限：复用个人中心的权限面板 */}
        <TabsContent
          value="permissions"
          className="mt-2 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <PermissionsPanel
            characterId={character.character_id}
            characterName={character.name}
          />
        </TabsContent>

        {/* 舰队 */}
        <TabsContent
          value="fleet"
          className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto data-[state=inactive]:hidden"
        >
          {detail.fleet === null ? (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-[11px] text-muted-foreground/60">
              当前不在舰队中（或缺少 esi-fleets 授权）
            </p>
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              <InfoCard
                icon={Sparkles}
                title="舰队"
                rows={[
                  { label: "舰队 ID", value: String(detail.fleet.fleetId) },
                  {
                    label: "职务",
                    value:
                      FLEET_ROLE_LABEL[detail.fleet.role] ?? detail.fleet.role,
                  },
                ]}
              />

              <InfoCard
                icon={Building2}
                title="编制"
                rows={[
                  {
                    label: "联队 ID",
                    value: detail.fleet.wingId?.toString() ?? null,
                  },
                  {
                    label: "中队 ID",
                    value: detail.fleet.squadId?.toString() ?? null,
                  },
                ]}
                empty="未分配联队 / 中队"
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * 角色详情：顶部用 Tabs 列出全部角色，点击即可切换查看。
 *
 * 每个角色一个 TabsContent，Radix 默认只渲染激活的那个，
 * 因此切换时才请求对应角色的数据，不会一次性打满 ESI。
 */
export function CharacterDetailPanel({
  characters,
  activeCharacterId,
  selectedCharacterId,
  onSelect,
  onSwitchTo,
  onUnbind,
}: {
  characters: EveCharacter[];
  /** 当前角色（Tab 上会标「当前」） */
  activeCharacterId: number | null;
  /** 外部指定的查看对象（角色卡片的「详情」按钮） */
  selectedCharacterId: number | null;
  onSelect: (characterId: number) => void;
  /** 设为当前角色 */
  onSwitchTo?: (characterId: number) => void;
  /** 解绑角色（由外层弹确认框） */
  onUnbind?: (character: EveCharacter) => void;
}) {
  if (characters.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        还没有绑定角色，点右上角「添加角色」授权一个。
      </p>
    );
  }

  const currentId =
    selectedCharacterId ??
    activeCharacterId ??
    characters[0].character_id;

  const current = characters.some((item) => item.character_id === currentId)
    ? String(currentId)
    : String(characters[0].character_id);

  return (
    <Tabs
      value={current}
      onValueChange={(value) => onSelect(Number(value))}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border">
        <TabsList className="h-auto min-w-0 flex-1 justify-start gap-1 overflow-x-auto rounded-none border-b-0 bg-transparent p-0">
          {characters.map((character) => (
            <TabsTrigger
              key={character.character_id}
              value={String(character.character_id)}
              className="h-9 shrink-0 gap-1.5 px-2 text-[11px] data-[state=active]:bg-muted/50"
            >
              <Avatar className="size-4">
                {character.portrait_url && (
                  <AvatarImage
                    src={character.portrait_url}
                    alt={character.name}
                  />
                )}
                <AvatarFallback className="text-[8px]">
                  {character.name.slice(0, 1)}
                </AvatarFallback>
              </Avatar>
              <span className="max-w-[120px] truncate">{character.name}</span>
              {character.character_id === activeCharacterId && (
                <span className="text-[9px] text-emerald-400">当前</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

      </div>

      {characters.map((character) => (
        <TabsContent
          key={character.character_id}
          value={String(character.character_id)}
          className="mt-2 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <CharacterDetailBody
            character={character}
            isCurrent={character.character_id === activeCharacterId}
            onSwitchTo={onSwitchTo}
            onUnbind={onUnbind}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
