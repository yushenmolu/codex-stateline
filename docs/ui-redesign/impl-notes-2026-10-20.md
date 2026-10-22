# UI 重生 · 实施记录（2026-10-20）

> **归档说明（仓库整理时追加）**：文中引用的实施后截图（`output/ui-redesign-after/*.png`）已删除；
> 验收结论以正文的文字记录与 `npm run verify` 的现行检查为准。

对应设计文档：`docs/ui-redesign/codex-stateline-ui-redesign.md`

## 1. 已完成

### 1.1 Web 面板（`/`）
| 文件 | 变更 |
| --- | --- |
| `src/public/tokens.css` | 新增，设计令牌唯一来源（调色板 / 字号 / 间距 / 圆角 / 阴影 / 动效） |
| `src/public/styles.css` | 整表替换为设计稿（三层表面、语义色、字号阶、focus-visible） |
| `src/public/preview.css` | 整表替换（预览窗内嵌面板，共用同一套语义） |
| `src/public/index.html` | 挂 `tokens.css`（先于 `styles.css`） |
| `src/public/preview.html` | 挂 `tokens.css`（先于 `preview.css`） |
| `src/server.js` | 静态白名单新增 `/tokens.css`（路由表、资产校验分支、静态处理器三处） |

### 1.2 原生悬浮窗（`scripts/native/WidgetClient.cs`）
1. **调色板**：130 处颜色字面量按「角色」替换，旧的薄荷绿强调 / 青灰三套底色 → 中性深灰 + 靛蓝强调。
2. **字号**：`10 → 11`（12 处）、`10.5 → 12`（4 处）、`11.5 → 12`（1 处）、标题 `12 → 13`。
3. **按钮层级**：次级按钮改为无边框幽灵按钮（悬停 10% 白、按下 18% 黑），主按钮保留 `#4A5AD6` 实心。
4. **圆角**：主窗根 12 → 14；用量面板 / hero 卡 8 → 10；结果窗 10；任务条 10；XAML 模板内 9 → 8、弹层 8。
5. **间距**：22 处奇数 `Thickness` 归一到偶数栅格（2/4/6/8/12/16），横向 `9 → 8`、对话框内边距 `14 → 16` 除外（见 §2）。

## 2. 与设计文档的偏差（有意为之）

| 文档建议 | 实际做法 | 原因 |
| --- | --- | --- |
| 新增 `WidgetTheme.cs`，以 `WidgetTheme.Accent` 等令牌引用 | 保留 `B("#RRGGBB")` 调用形态，只替换色值 | 不新增编译单元 → 不触碰 `Add-Type` 编译清单与 `-as [type]` 守卫，改动零编译风险；视觉结果完全相同 |
| 字号整体上移一档（含 `11 → 12` 共 20 处） | 只上移最小的三档，`11` 保持 | 自检断言存在宽度约束（`FormattedText.Width -le metric.ActualWidth`、任务选择器标签不得压住箭头），整体上移会触发溢出断言失败 |
| 间距 / 圆角 / 阴影统一 | 圆角与间距已做，阴影未做 | 阴影见下条 |
| 三处窗口投影（对话框 / 下拉弹层 / 任务条） | 未做 | 底色已是 `#141518`，黑色阴影在其上几乎不可见；且三个窗口都是 `WindowStyle=None` + `AllowsTransparency` 且尺寸紧贴内容，投影会被窗口边界裁掉。要出效果必须把窗口放大 16–20px 留出外边距，与固定几何（380×320、结果窗 610×420 紧凑档）和自检断言冲突。改用「表面升阶」（`#0E0F11 → #1C1D21 → #24252A`）+ 1px 描边表达层次 |
| `Text()` 默认行距 `(0,3,0,3)` → `(0,4,0,4)` | 保留 `(0,3,0,3)` | 每个文本块 +2px 会让结果窗紧凑档（610×420）的作品图从 150 掉到 148，卡在 `native-widget.selftest.ps1:938` 的 `ActualHeight -ge 150` 断言上。实测数据：`viewportH=236 used=56 → imgH=148` |

## 3. 配色对照

| 角色 | 旧值 | 新值 |
| --- | --- | --- |
| 页面底 | `#131A21` | `#141518` |
| 卡片 | `#1B252E` | `#1C1D21` |
| 抬升面 | `#202A34` | `#24252A` |
| 内凹/画布 | `#18232B` | `#0E0F11` |
| 描边 | `#35414C` | `#3F414B` |
| 细分隔 | `#2C3A44` | `#373941` |
| 主文本 | `#F2F5F7` | `#EDEEF2` |
| 次文本 | `#D9E6E9` | `#B0B3BF` |
| 弱文本 | `#ADB8C4` | `#9A9EAC` |
| 占位 | `#6B7A86` | `#636674` |
| 强调 | `#9DE5D0`（薄荷） | `#8593FF`（靛蓝） |
| 强调实心 | — | `#4A5AD6` |
| 成功 | `#6FBF9E` | `#69D3A2` |
| 警告 | `#EBC58D` / `#F1C778` | `#F8B659` |
| 数据 1 / 2 / 3 | — | `#8F9CFF` / `#49D4C6` / `#C08DE2` |

## 4. 验证

| 项 | 结果 |
| --- | --- |
| `native-widget.ps1 -SelfTest`（颜色改造后） | **PASS**，1671 checks，fixtureOnly，realModelCalls 0 |
| `native-widget.ps1 -SelfTest`（按钮/字号改造后） | **PASS**，1671 checks |
| `native-widget.ps1 -SelfTest`（圆角 + 间距 + 最终态） | **PASS**，1671 checks |
| `node tests/server.test.js` | 39/39 通过 |
| 截图 | `output/ui-redesign-after/*.png` |

> 注：`node --test` 在本机沙箱下会因 `spawn EPERM`（stdio 管道被拦截）失败，需逐文件 `node tests/<name>.test.js` 运行。
>
> 注：`native-widget.ps1` 必须用 Windows PowerShell 5.1（`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`）+ `-STA` 运行；pwsh 7 缺 `System.Web.Extensions.dll`，`Add-Type` 会直接失败。

## 5. 未完成 / 后续

- `WidgetTheme.cs` 令牌化（可维护性，不影响观感）。
- 窗口投影 / 毛玻璃（`AllowsTransparency` 下需为阴影预留外边距，会缩小内容区，与固定几何冲突；详见 §2）。
- 视觉验收专家的量化验收数据缺失（该专家任务失败），本次只做了自检 + 截图目视。

## 6. 本轮排障记录（间距改造踩坑）

把间距归一到偶数栅格后，`-SelfTest` 连续失败，报 `fixture deadline exceeded`（抛出点 `tests/native-widget.selftest.ps1:56` 的 `PumpUntil`，调用点 `:938`）。定位过程与结论：

1. 用 `$_.ScriptStackTrace` 拿到真正卡住的 `PumpUntil` 调用行（`:938`），而不是只看抛出点。
2. 临时在 `:938` 前插入诊断探针，打印 `cockpitImage.ActualHeight / cockpitMessage.IsVisible / resultHeading.IsVisible / ViewportHeight`，得到 `img=148 msgVis=False headVis=False vh=236`。
3. 结论：可见性逻辑正常，只差 **2px** 高度。作品图尺寸由 `WidgetClient.cs:1018 SizeResultImages()` 计算：`availableHeight=(viewportH-used)/images - margins - 2`，任何上行 +1~2px 都会把它压到 150 阈值以下。
4. 逐个回退间距改动，发现元凶是 `Text()` 默认 `Margin` 从 `(0,3,0,3)` 改成 `(0,4,0,4)`（全站文本块统一 +2px）。回退该处后 `-SelfTest` 立即 PASS 1671 checks。

> 教训：这个界面的紧凑档（结果窗 610×420、悬浮窗 380×320）几何余量是 **0–2px 级**的。任何全局性行距/内边距增量都必须先跑 `-SelfTest`，不能用「看起来更整齐」判断。诊断探针要插在 `PumpUntil` 之前并先 `Start-Sleep`，再 `UpdateLayout`，否则读到的是布局未收敛的中间值。
