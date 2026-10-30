import { useState } from "react";
import AccountPage from "./pages/AccountPage";
import MarketPage from "./pages/MarketPage";
import { Toaster } from "@/components/ui/sonner";
import type { MenuKey } from "./lib/nav";
import "./App.css";

interface MenuItem {
  key: MenuKey;
  label: string;
  description: string;
}

const MENUS: MenuItem[] = [
  {
    key: "planetary",
    label: "行星工业",
    description: "行星工业模块占位，后续在此展示殖民地、开采与产出规划。",
  },
  {
    key: "manufacturing",
    label: "制造业",
    description: "制造业模块占位，后续在此展示蓝图、材料清单与生产排期。",
  },
  {
    key: "map",
    label: "地图",
    description: "地图模块占位，后续在此展示星域、星系与航线信息。",
  },
  {
    key: "killmail",
    label: "KM查询",
    description: "KM 查询模块占位，后续在此查询击杀报告与战斗记录。",
  },
  {
    key: "market",
    label: "市场",
    description: "市场模块，查看自己的订单与星城行情。",
  },
  {
    key: "account",
    label: "个人中心",
    description: "管理已授权的 EVE 角色与权限。",
  },
];

function App() {
  const [activeMenu, setActiveMenu] = useState<MenuKey>("planetary");

  const current = MENUS.find((menu) => menu.key === activeMenu) ?? MENUS[0];

  const renderContent = () => {
    switch (activeMenu) {
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
      <header className="menubar">
        <span className="brand">EVE-无面者军团-工具</span>

        <nav className="menu">
          {MENUS.map((menu) => (
            <button
              key={menu.key}
              type="button"
              className={`menu-item${menu.key === activeMenu ? " is-active" : ""}`}
              onClick={() => setActiveMenu(menu.key)}
            >
              {menu.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">{renderContent()}</main>
      <Toaster position="bottom-right" />
    </div>
  );
}

export default App;
