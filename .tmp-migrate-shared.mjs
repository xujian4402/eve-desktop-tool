import fs from "node:fs";
import path from "node:path";

const dir = "src/pages/manufacturing";

for (const file of [
  "MfgLocationPage.tsx",
  "MfgMyIndustryPage.tsx",
  "MfgNpcBpPage.tsx",
  "MfgPlanPage.tsx",
  "MfgRankPage.tsx",
]) {
  const p = path.join(dir, file);
  let text = fs.readFileSync(p, "utf8");
  text = text.replace('from "./MfgCalculatorPage"', 'from "./shared"');
  fs.writeFileSync(p, text, "utf8");
  console.log("import fixed", file);
}

const cp = path.join(dir, "MfgCalculatorPage.tsx");
let c = fs.readFileSync(cp, "utf8");

// 删除 isk / duration 定义块
const start = c.indexOf("/** 数字格式化：1.23B");
const docStart = c.indexOf("/**\n * 制造计算器。");

if (start >= 0 && docStart > start) {
  c = c.slice(0, start) + c.slice(docStart);
  console.log("removed isk/duration");
}

// 删除 Stat / NumField 定义（Stat 在文件尾部，NumField 在其前）
const statIdx = c.indexOf("export function Stat({");
if (statIdx > 0) {
  c = c.slice(0, statIdx);
  console.log("removed Stat tail");
}

// NumField 也一并删除
const nfIdx = c.indexOf("function NumField({");
if (nfIdx > 0) {
  c = c.slice(0, nfIdx);
  console.log("removed NumField tail");
}

// 顶部补 shared 导入
c = c.replace(
  'import { cn } from "@/lib/utils";',
  'import { cn } from "@/lib/utils";\n\nimport { duration, isk, NumField, Stat } from "./shared";',
);

fs.writeFileSync(cp, c, "utf8");
console.log("calculator updated");
