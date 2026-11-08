# EVEAntiCollision.exe 逆向分析报告

- **分析对象**: `EVEAntiCollision.exe`（1,106,432 字节）
- **生成时间**: 2020/11/10 23:21:00（文件时间戳）
- **分析日期**: 2026-11-08
- **分析方式**: .NET 程序集反射枚举 + IL 反汇编（静态分析，未运行程序）
- **配套文件**: `EVEAntiCollision.pdb`（调试符号）、`EVEAntiCollision.exe.config`、`sound.wav`（警报音，93KB）

---

## 1. 基本信息

| 项目 | 内容 |
|---|---|
| 框架 | .NET Framework 4.7.2，WinForms 应用 |
| 程序集 | `EVEAntiCollision, Version=1.0.0.0, PublicKeyToken=null` |
| 混淆 | 无混淆，未加壳，附带 PDB 符号，可完整反编译 |
| 用途 | EVE Online "红点/敌对目标"屏幕预警工具 |
| 侵入性 | **纯外部工具**：不读写游戏内存、不注入进程、不模拟输入，仅读取屏幕 |

## 2. 类型结构

| 类型 | 职责 |
|---|---|
| `Form1` | 主窗口：预警开关、截屏线程、颜色检测、日志 |
| `Form2` | 帮助/说明窗口（含 PictureBox 展示） |
| `Form3` | 设置窗口：4 个 TextBox 填写截屏区域坐标 |
| `Program` | 入口 `Main()` |
| `Properties.Resources` | 内嵌资源，含图片 `zfb`（支付宝收款码，捐赠入口） |
| `Properties.Settings` | 持久化配置 |

### Form1 关键字段

- `startX / startY`：截屏区域左上角屏幕坐标
- `areaX / areaY`：截屏区域宽高
- `WarningProcess`：预警是否开启（总开关）
- `WarningProcessCol`：预警线程运行标志（循环条件）
- `originBmp` / `pictureBox1`：截屏结果与预览
- `richTextBox1`：事件日志
- `_syncContext`：`SynchronizationContext`，用于后台线程安全更新 UI

### Form1 关键方法

| 方法 | 作用 |
|---|---|
| `button4_Click` | 开/关预警，启动或停止 `picThread` 线程 |
| `picThread` | 核心循环：截屏 → 检测 → 报警 |
| `GetRGB(Bitmap, tr, tg, tb)` | 逐像素颜色匹配 |
| `SetLabelText` | 日志追加（UI 线程回调） |
| `GenerateRandomString` / `GetTimeStamp` | 死代码（主流程未调用，疑似复制自其他项目） |

## 3. 核心原理：截屏 + 颜色匹配

工作流程（`picThread`，每轮休眠 600ms，约 1.6 次/秒）：

```
while (WarningProcessCol) {
    bmp = new Bitmap(areaX, areaY);
    Graphics.FromImage(bmp).CopyFromScreen(startX, startY, 0, 0, new Size(areaX, areaY));
    pictureBox1.Image = bmp;              // 区域预览
    Sleep(600);
    if (GetRGB(bmp, 149, 18, 23)) {       // 检测深红色
        new Audio().Play("sound.wav");    // 播放警报
        _syncContext.Post(SetLabelText, null);  // 日志: "hh:mm:ss:来红！"
    }
    Sleep(600);
}
```

### 颜色判定条件（GetRGB）

- 通过 `Bitmap.LockBits` 获取原始像素数据（`Format32bppArgb`，直接读指针，性能优先）。
- 双重循环遍历区域内每个像素，命中条件为三通道阈值判断：
  - 一个通道 > 125，且其余两个通道 < 20 / < 30
- 即匹配 **深红色**（参考目标色 `RGB(149, 18, 23)`），对应 EVE 总览（Overview）面板中敌对目标标记的红色图标。
- 扫描过程中会按 `x-y-颜色` 格式拼接字符串（命中位置的调试信息）。

### 预警开关逻辑（button4_Click）

- 开启：按钮变绿、文字"预警已开启"，`WarningProcessCol = true`，启动 `picThread` 线程，日志追加 `hh:mm:ss:预警开启 Fly Safe！`
- 暂停：按钮变红、文字"预警已暂停"，`WarningProcessCol = false`，日志追加 `hh:mm:ss:预警暂停 ------`

### 配置持久化（exe.config）

| 设置项 | 默认值 | 含义 |
|---|---|---|
| `start_x` | 200 | 截屏区域左上角 X |
| `start_y` | 300 | 截屏区域左上角 Y |
| `area_x` | 100 | 区域宽度 |
| `area_y` | 700 | 区域高度（竖长条，符合 EVE 总览面板形状） |

## 4. 使用条件与局限性

1. **必须人工校准区域**：Form3 中手动填入总览面板的屏幕坐标；换分辨率/换窗口位置后需重新设置。
2. **颜色依赖**：判定阈值写死（目标色 149/18/23 及 125/20/30 阈值），游戏主题、UI 缩放、敌方标记配色变化可能导致漏报或误报。
3. **仅检测红色**：只能发现"红色敌对标记"，无法区分敌对类型/数量。
4. **帧率约 1.6 次/秒**：极端快速接近场景下存在约 0.6 秒的反应延迟。
5. `GetTimeStamp` 中残留 UNIX 时间戳计算（1970 基准），`GenerateRandomString` 依赖 20 字节的 `constant` 静态数组——两者均未被主流程调用。

## 5. 安全性评估

- 未发现网络通信、文件写入（配置由 .NET 标准设置机制写入用户目录）、注册表操作、进程注入或内存读取。
- 行为完全等同于一个"定时截屏 + 找红点 + 放声音"的辅助提醒工具。
- 注意：此类第三方辅助工具是否符合 EVE Online 用户协议需用户自行判断。

## 6. 结论

`EVEAntiCollision` 是一个典型的**视觉识别式游戏辅助**：以 600ms 周期截取用户指定屏幕区域，逐像素比对深红色特征（RGB ≈ 149,18,23），命中即播放 `sound.wav` 并记录"来红！"日志。原理简单、无侵入、可逆推，可靠性取决于截屏区域校准与游戏内配色的一致性。
