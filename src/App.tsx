import { useEffect, useState } from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  Crosshair,
  Factory,
  Map as MapIcon,
  Orbit,
  ShoppingCart,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import AccountPage from "./pages/AccountPage";
import MarketPage from "./pages/MarketPage";
import PlanetaryPage from "./pages/PlanetaryPage";
import { Toaster } from "@/components/ui/sonner";
import { useOrderSyncStore } from "@/stores/order-sync-store";
import type { MenuKey } from "./lib/nav";
import "./App.css";

interface MenuItem {
  key: MenuKey;
  label: string;
  description: string;
}

const MENUS: MenuItem[] = [
  {
    key: "account",
    label: "个人中心",
    description: "管理已授权的 EVE 角色与权限。",
  },
  {
    key: "planetary",
    label: "行星工业",
    description: "P0-P4 配方与收益、行星资源选址、主权升级预算。",
  },
  // 暂未开放，先隐藏入口；代码保留，恢复时取消注释即可
  // {
  //   key: "manufacturing",
  //   label: "制造业",
  //   description: "制造业模块占位，后续在此展示蓝图、材料清单与生产排期。",
  // },
  // {
  //   key: "map",
  //   label: "地图",
  //   description: "地图模块占位，后续在此展示星域、星系与航线信息。",
  // },
  // {
  //   key: "killmail",
  //   label: "KM查询",
  //   description: "KM 查询模块占位，后续在此查询击杀报告与战斗记录。",
  // },
  {
    key: "market",
    label: "市场",
    description: "市场模块，查看自己的订单与星城行情。",
  },
];

/** 每个菜单的图标（参考游戏内左侧功能栏） */
const MENU_ICONS: Partial<Record<MenuKey, LucideIcon>> = {
  planetary: Orbit,
  manufacturing: Factory,
  map: MapIcon,
  killmail: Crosshair,
  market: ShoppingCart,
  account: UserRound,
};

function App() {
  const [activeMenu, setActiveMenu] = useState<MenuKey>("planetary");
  /** 左侧菜单是否收起（收起时只显示图标） */
  const [collapsed, setCollapsed] = useState(true);

  // 订单自动同步挂在应用级：切到其他菜单也继续每 30 分钟同步一次
  const initOrderSync = useOrderSyncStore((state) => state.init);
  useEffect(() => {
    initOrderSync();
  }, [initOrderSync]);

  const current = MENUS.find((menu) => menu.key === activeMenu) ?? MENUS[0];

  const renderContent = () => {
    switch (activeMenu) {
      case "planetary":
        return <PlanetaryPage />;
      case "market":
        return <MarketPage onNavigate={setActiveMenu} />;
      case "account":
        return <AccountPage />;
      default:
        return (
          <section className="placeholder">
            <h1>{current.label}</h1>
            <p>{current.description}</p>
            <span className="placeholder-tag">占位内容</span>
          </section>
        );
    }
  };

  return (
    <div className="app">
      {/* 左侧图标导航：可收起，收起时悬停显示全称 */}
      <aside className={`sidebar${collapsed ? "" : " is-expanded"}`}>
        <nav className="sidebar__menu">
          {MENUS.map((menu) => {
            const Icon = MENU_ICONS[menu.key] ?? Orbit;

            return (
              <button
                key={menu.key}
                type="button"
                className={`sidebar__item${menu.key === activeMenu ? " is-active" : ""}`}
                data-label={menu.label}
                aria-label={menu.label}
                title={collapsed ? menu.label : undefined}
                onClick={() => setActiveMenu(menu.key)}
              >
                <Icon className="size-[18px] shrink-0" strokeWidth={1.8} />
                {!collapsed && (
                  <span className="sidebar__label">{menu.label}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* 展开 / 收起固定在侧栏底部 */}
        <button
          type="button"
          className="sidebar__toggle"
          onClick={() => setCollapsed((current) => !current)}
          title={collapsed ? "展开菜单" : "收起菜单"}
          aria-label={collapsed ? "展开菜单" : "收起菜单"}
        >
          {collapsed ? (
            <ChevronsRight className="size-[16px]" strokeWidth={1.8} />
          ) : (
            <ChevronsLeft className="size-[16px]" strokeWidth={1.8} />
          )}
        </button>
      </aside>

      <main
        className={
          activeMenu === "account" ||
          activeMenu === "market" ||
          activeMenu === "planetary"
            ? "content content--fill"
            : "content"
        }
      >
        {renderContent()}
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}

export default App;
