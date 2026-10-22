# Live 卡片视觉重构设计规格

> **归档说明（仓库整理时追加）**：本文是 UI 重构的设计规格与认知记录。文中引用的调试截图
> （`output/widget-*.png`）已删除，相关的渲染事实已用文字描述保留在正文；其余设计约束仍然有效。

> 目标窗口：主悬浮窗 380×320（`scripts/native/WidgetClient.cs:111` 的 `Width=Math.Min(380,…)` / `Height=Math.Min(320,…)`）。
> 唯一实现文件：`scripts/native/WidgetClient.cs`。
> 本文所有行号均指**当前工作区**该文件（工作区版本与 HEAD 不同，实现者要改的就是这一份）。
> 所有色值与尺寸均为我在代码里实际读到的现值，不含任何推测。

---

## 0. 令牌核对：两个"现值"其实是过期值

派活单里点名要查 `#9DE5D0`（薄荷）与 `#E6EDF4`。**这两个值在当前 `scripts/native/WidgetClient.cs` 中一个都不存在。** 全仓检索后它们只残留在历史与备份位置：

| 文件名 | 位置 | 性质 |
| --- | --- | --- |
| `docs/ui-redesign/impl-notes-2026-10-20.md:48` | 强调色换代对照表 | 历史文档 |
| `docs/ui-redesign/codex-stateline-ui-redesign.md:718-726` | 旧 `#9DE5D0` 逐处映射 | 上一轮审计 |
| `Temp/WidgetClient.mineonly.cs:126` | 备份 | 非编译 |
| `.test-tmp/head-widget.cs:104` | 测试残留 | 非编译 |
| `.task-backups/` 下若干 | 备份 | 非编译 |

`docs/ui-redesign/impl-notes-2026-10-20.md:48` 的对照关系是：强调色 **`#9DE5D0`（薄荷）→ `#8593FF`（靛蓝）**；`docs/ui-redesign/codex-stateline-ui-redesign.md:719` 记录旧 `#9DE5D0` 曾在 17 处同时充当强调文字、滑块填充、选中底色、图标；旧成功色 `#6FBF9E` → 新 `#69D3A2`。

**结论：本项目已经换过一轮色板，`#8593FF` 才是现行强调色，`#EDEEF2` 才是现行一级文字色。** 本文一律使用现行值，凡涉及被替换的旧值处均显式标注。

### 0.1 现行色板与语义角色（按代码实际用法归纳，附出现次数）

| 角色名 | 色值 | 出现次数 | 代表锚点 | 现有语义问题 |
| --- | --- | --- | --- | --- |
| 一级文字 Text1 | `#EDEEF2` | 18 | `WidgetClient.cs:109`（`Text()` 默认前景） | 无 |
| 二级文字 Text2 | `#B0B3BF` | 6 | `WidgetClient.cs:319` 状态串、`WidgetClient.cs:346` 输入输出数值 | 无 |
| 辅助文字 Text3 | `#9A9EAC` | **29** | `WidgetClient.cs:322` 卡片标题、`WidgetClient.cs:335` 会话合计标签、`WidgetClient.cs:349` 上轮请求整行 | **滥用最严重**：几乎所有说明文字都用它，导致"什么都很淡" |
| 禁用 / 未知 TextDisabled | `#636674` | 4 | `WidgetClient.cs:323` 状态圆点默认色、`WidgetClient.cs:441` 占位符 `—` | 无 |
| 强调 Accent | `#8593FF` | 15 | `WidgetClient.cs:1185` taskPin 文字 | **语义过载**，见下 |
| 强调填充 AccentFill | `#4A5AD6` | 2 | `WidgetClient.cs:1051`「开始生成」按钮 | 仅结果页，与本卡无关 |
| 焦点环 FocusRing | `#8593FF` | 15（与 Accent 同值） | `WidgetClient.cs:110` 按钮焦点环、`WidgetClient.cs:234` 滑块焦点 | 与 Accent 同值 → 焦点态和内容强调态无法区分 |
| 成功 Success | `#69D3A2` | 1 | `WidgetClient.cs:438`「已核实」 | 全文件只 1 处，几乎不可见 |
| 告警 Warning | `#F8B659` | 4 | `WidgetClient.cs:119` 状态行、`WidgetClient.cs:1186` taskFlags | **语义误用**，见诊断 S5 |
| 危险 Danger | `#FA8088` | **0** | 仅存在于未编译的 `docs/ui-redesign/WidgetTheme.cs` | 未生效 |
| 页面底色 Page | `#141518` | 6 | `WidgetClient.cs:116` 窗口外壳 | 无 |
| 卡片底 Card | `#1C1D21` | 10 | `WidgetClient.cs:339` heroSurface、`WidgetClient.cs:1185` taskSurface | 无 |
| 抬升底 Raised | `#24252A` | 5 | `WidgetClient.cs:1185` taskCombo / taskPin | 无 |
| 内凹底 Inset | `#0E0F11` | 2 | `WidgetClient.cs:121` usageSurface | 无 |
| 悬停底 Hover | `#2D2E34` | 2 | ComboBoxItem 高亮 | 无 |
| 细边框 BorderSubtle | `#373941` | 7 | `WidgetClient.cs:339` heroSurface 边框 | 无 |
| 默认边框 BorderDefault | `#3F414B` | 14 | `WidgetClient.cs:116` 窗口边框 | 无 |
| 数据色 输入 Data1 | `#8F9CFF` | 2 | `WidgetClient.cs:140` 图例 | 本卡未使用 |
| 数据色 输出 Data3 | `#C08DE2` | 2 | `WidgetClient.cs:140` 图例 | 本卡未使用 |
| 数据色 Data2 | `#49D4C6` | 1 | `WidgetClient.cs:1168` fixture SVG | 仅测试夹具 |

### 0.2 令牌落地点（现状：设计令牌文件存在但未参与编译）

`docs/ui-redesign/WidgetTheme.cs`（168 行）已经定义了与本规格完全一致的令牌：

- 色：`Text1 #EDEEF2`、`Text2 #B0B3BF`、`Text3 #9A9EAC`、`TextDisabled #636674`、`Accent #8593FF`、`AccentFill #4A5AD6`、`Success #69D3A2`、`Warning #F8B659`、`Danger #FA8088`、`FocusRing #8593FF`、`Card #1C1D21`、`Inset #0E0F11`、`Raised #24252A`、`Hover #2D2E34`、`BorderSubtle #373941`、`BorderDefault #3F414B`、`Data1 #8F9CFF`、`Data2 #49D4C6`、`Data3 #C08DE2`
- 字号：`Text2Xs=11`、`TextXs=12`、`TextSm=13`、`TextMd=15`、`TextLg=17`、`TextXl=22`、`Text2Xl=28`
- 间距：`Space1=2` … `Space9=32`
- 圆角：`RadiusXs=3`、`RadiusSm=6`、`RadiusMd=10`、`RadiusLg=14`
- 控件高：`ControlSm=24`、`Control=30`、`ControlLg=34`

**为什么没生效**：`scripts/native-widget.ps1:9` 的编译清单是

```
Add-Type -Path (Join-Path $PSScriptRoot 'native/SafeSvg.cs'),(Join-Path $PSScriptRoot 'native/WidgetClient.cs'),
    (Join-Path $PSScriptRoot 'native/BrowserPreview.cs'),(Join-Path $PSScriptRoot 'native/CockpitBrowserGuard.cs'),
    (Join-Path $PSScriptRoot 'native/TrayIcon.cs') -ReferencedAssemblies $refs
```

`WidgetTheme.cs` 不在列表里，所以里面那些常量全是死代码。

> **落地建议（需另行批准，本规格不直接改）**：把 `docs/ui-redesign/WidgetTheme.cs` 移到 `scripts/native/WidgetTheme.cs`，并在 `scripts/native-widget.ps1:9` 的 `Add-Type -Path` 列表首位插入它。之后 `WidgetClient.cs` 里的字面量 `B("#9A9EAC")` 可逐步替换为 `WidgetTheme.Text3`。**本规格提出的五级字号阶梯（28 / 17 / 13 / 12 / 11）恰好全部落在该文件已有的 `Text2Xl / TextLg / TextSm / TextXs / Text2Xs` 上，唯一被废弃的是游标值 10.5。**

---

## 1. 现状诊断（按严重度降序）

每条都给出"为什么在 380×320 里会显得丑"的机制，而非主观评价。

### S1 · 数字层级塌陷：四个"大数字"同时争夺注意力

**现象位**：会话合计 28px SemiBold（`WidgetClient.cs:337`）、缓存命中率 17px Medium（`WidgetClient.cs:339` 第 8 段）、输入 17px Medium、输出 17px Medium（`WidgetClient.cs:346` 第 0 段）、观测均速 17px Medium（`WidgetClient.cs:124` 的 `metrics[3]`）。

**机制**：
1. 这五个数字里，**四个是 17px、且三个字重同为 `Medium`**。字号只差 0（17 vs 17）或 11（28 vs 17）。
2. 28px 与 17px 的比值是 1.65，但两者在**同一水平行**（`heroSurface` 的 `totalPanel`，`WidgetClient.cs:334` 水平 StackPanel，`WidgetClient.cs:339` 第 19 段把 `totalPanel` 装进 `heroSurface`）。眼睛扫一行时会取该行最大的字形作为锚点 → 28px 拿到锚点，但紧接着 17px 的 `93.6%` 就在同一基线上，形成"一大一小并排"，读起来像"主标题 + 括号注"的错位。
3. 真正的致命点是**输入/输出那两个 17px 在下一行**（`WidgetClient.cs:340` 的 `breakdown` Grid）。它们与缓存率同为 17px Medium，于是用户在三行之内看到 28/17/17/17 四个数字，**没有第二眼能确认"哪个才是重点"**。
4. 更糟的是颜色：`WidgetClient.cs:346` 的输入输出是 `#EDEEF2`（一级文字），而 `WidgetClient.cs:339` 第 11 段的缓存率是 `#B0B3BF`（二级文字）。**权重倒挂**——视觉上更"亮"的两个数字（输入/输出）在信息优先级上应该低于缓存率。

**380×320 下的具体后果**：356px 宽的内容区里，`会话合计 371.5M` + `缓存命中率 94.0%` 两个词组挤在同一行（实测渲染见 `output/widget-after-preview-fix.png`），`totalLabel` 的 `Margin=(0,0,8,0)`（`WidgetClient.cs:335` 第 2 段）与 `cacheCaption` 的 `Margin=(14,0,6,0)`（`WidgetClient.cs:339` 第 2 段）合计只给出 22px 横向呼吸，两个大字块几乎贴在一起。

---

### S2 · 标签与数值同字号同颜色，扫读被迫逐字阅读

**现象位**：`lastRequest=Text("上轮请求 · —",10.5)` + `Foreground=B("#9A9EAC")`（`WidgetClient.cs:349` 第 1-2 段），实际内容是 `WidgetClient.cs:585` 拼出的

```
"上轮请求 · 新输入 "+CountFormatter(fresh)+" · 缓存 "+CountFormatter(cached.Value)+" · 输出 "+CountFormatter(last.Output)
```

**机制**：
1. **字号无差**：行首总标签「上轮请求」、组标签「新输入 / 缓存 / 输出」、数值「18,367 / 78,208 / 696」**全部是 10.5px**。同一个 TextBlock 里不存在任何字号台阶。
2. **颜色无差**：整串共用一个 `Foreground`，全部 `#9A9EAC`。WPF 的 `TextBlock` 一旦整体设 Foreground，内部无法再分色。
3. **字重无差**：没有设 `FontWeight`，继承父级 `Normal`（窗口基线 `WidgetClient.cs:111` 未设 FontWeight）。
4. 中文竖排密度的视觉节律和阿拉伯数字的字宽节律完全不同（中文 ≈ 1:1 方块，`18,367` 里逗号几乎不占视觉重量），混在同一字号下，用户必须**从第一个字读到最后一个字**才能把"17,367"对到"新输入"。
5. 三组之间用 `·` 分隔，但 `·` 与中文标签、与数字之间**都是同一字号**，分隔符没有形成任何停顿。

**380×320 下的具体后果**：`10.5px` 是 `UseLayoutRounding=true`（`WidgetClient.cs:111`）下最糟的选择——半像素字号在 100% DPI 会被布局取整到 11、在 125% DPI 会被取整到 13，**同一份代码在不同机器上行高不同**，这行文字的行高在 13~15px 之间随机漂移，导致它和上下元素的间距时而 2px、时而 4px。

**附注（澄清一条常见误判）**：派活单里提到的「新输入 3,796 - 缓存 185.7k - 输出 476」用半角连字符分隔，那是**旧版本截图**。当前 `WidgetClient.cs:585` / `WidgetClient.cs:586` 已经用中点 `·`；全文件正则 `"[^"]* - [^"]*"` **零匹配**。所以「分隔符用错」这一条在现行代码里**已经修好**，剩下的真问题是上面前四条。本规格在此基础上继续深化（§4）。

---

### S3 · 六块全上撑破 300px 可视高度，滚动条吃掉 11px 并切掉右端数字

**现象位**：
- 内容超出：`metricsGrid` 在 `WidgetClient.cs:558` 置 `Visible`、`telemetryMetadata` 在 `WidgetClient.cs:563` 置 `Visible`、`cacheCaption/cacheRate` 由 `WidgetClient.cs:569-570` 成对切 `Visible`、`lastRequest` 由 `WidgetClient.cs:579-580` 切 `Visible` → **数据可用时六块全部同时上屏**，没有一块被降级。
- 滚动条：`WidgetClient.cs:118` 的 `mainViewport` 是 `VerticalScrollBarVisibility=Auto`，一旦溢出就出现竖滚条；滚条宽 **11px**（`WidgetClient.cs:998` 的 `<Setter Property='Width' Value='11'/>`）从 356px 里再扣掉。
- 右端被切：`WidgetClient.cs:124` 的 `detailRow` **第 2 列固定 `new GridLength(178)`**，`speedRow` 在其中 `HorizontalAlignment=Right`，`metrics[3]` 又 `TextAlignment=Right`。

**机制**：`178px` 固定列 + 右对齐 + 滚动条 11px 占位 = 右侧可绘宽度不足，`观测均速 ≈ token/s 41.9` 的 `41.9` 被裁（见 `output/widget-after-preview-fix.png` 右缘）。同期 `用量统计 ↗`（`WidgetClient.cs:147`，`MinHeight=24` + `Margin=(0,6,0,0)`）被压到窗口底边之外。

**根因不是"内容太多"，而是"每块都不肯让"**：`telemetryMetadata` 还额外被钉死为 `Height=46`（`WidgetClient.cs:124` 第 1 段），而它的实际内容 `contextLabel`（11px，`LineHeight=18`）+ `Margin=(0,0,0,5)` + `detailRow`（11px）实测约 39px，**固定高 46 白留 7px**；换成 `MinHeight` 后这 7px 可以还给真正需要的行。

---

### S4 · hero 胶囊负边距外扩 8px，与外壳形成"卡内卡内卡"三级套娃

**现象位**：`WidgetClient.cs:339` 第 19 段

```
var heroSurface=new Border{Background=B("#1C1D21"),BorderBrush=B("#373941"),
    BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(10),
    Padding=new Thickness(8,4,8,4),Margin=new Thickness(-8,0,-8,0),Child=totalPanel}
```

**机制**：
1. `usageSurface` 的内边距是 `Padding=(12,8,12,8)`（`WidgetClient.cs:121`），而 `heroSurface` 用 `Margin=(-8,0,-8,0)` 把它向左右各捅出 8px，于是胶囊左边缘距离 `usageSurface` 边框只有 **4px**，右边缘同样 4px。
2. 这不是对齐，是**故意制造不等宽**：外层卡左右留白 12px，内层胶囊留白 4px，两者不同轴。在 356px 宽的窗口里，读者会看到卡片的"边"在垂直方向上跳了一次。
3. 圆角在同一 8px 距离内遇到三个值：窗口 `14`（`WidgetClient.cs:116`）→ `usageSurface` `8`（`WidgetClient.cs:121`）→ `heroSurface` `10`（`WidgetClient.cs:339`）。**10 比 8 还大，内层圆角比外层圆角更圆**——这是视觉上最刺眼的一种错：内切圆角大于外切圆角时，两弧线之间的空隙会从 4px 变成负的观感（看起来像内层"撑破"了外层）。

---

### S5 · 告警语义被正常状态占用：正常显示成橙色，真故障反而更淡

**现象位**：
- `status` 整行 `Foreground=B("#F8B659")`（`WidgetClient.cs:119` 第 6 段），而 `WidgetClient.cs:565` 往里写的是

  ```
  status.Text = (sample!=null && sample.State=="available" && hasUsage) ? "" : "○ "+state
  ```

  即：**只要"没有已确认用量"就把整条状态串（`已确认 · Codex app-server 事件 · 运行中` 这类）渲染成告警橙**，包括这个串的全部成分。
- 真正的故障「列表陈旧 / 已截断」走 `taskFlags`（`WidgetClient.cs:1186`），同样 `#F8B659`。

**机制**：
1. `#F8B659` 在 `#0E0F11` 深底上的色度差是全窗口最高的（远高于 `#8593FF` 强调色），**它是最贵的视觉资源**。用它渲染一个信息性状态串，等于把最高优先级的信号花在"运行中"三个字上。
2. 于是当真的出故障时，两处橙色同色、同字号（status 12px / taskFlags 11px，仅差 1px），**读者无法分辨哪个是要处理的问题**。
3. `status` 行的 `LineHeight=14` + `MaxHeight=28`（`WidgetClient.cs:119` 第 3、5 段）意味着它最长占两行 28px，而它出现在 `stack` 的第 2 位（`WidgetClient.cs:119` 末尾 `stack.Children.Add(status)`，紧跟 `taskSurface`）——一个可能两行的橙色块被插在卡片顶部，**直接把 S1 的主数字推下去**。

---

### S6 · 字号碎片化：七级字号里有半像素的 10.5

**现象位**：`Text(string,double size)` 的实际调用值集合 = `{10.5, 11, 12, 13, 16, 17, 28}`。半像素值出现在四处：`WidgetClient.cs:335`（会话合计标签）、`WidgetClient.cs:345`（输入/输出标签）、`WidgetClient.cs:349`（上轮请求整行）、`WidgetClient.cs:1026`（设置页）。

**机制**：`WidgetClient.cs:111` 已经设了 `UseLayoutRounding=true` 与 `SnapsToDevicePixels=true`，这两个开关的语义是"把测量结果对齐到整设备像素"。`10.5` 在 96 DPI 下不是整设备像素，WPF 会在测量阶段保留 10.5、在排列阶段取整，**取整方向取决于该元素在垂直方向上的累积偏移**——也就是说，同一个 10.5px 的 TextBlock，往上挪 1px 就可能从 11 变成 10，行高跟着跳。

**380×320 下的具体后果**：`11 → 10` 的跳变只有 1px，但它会连锁改变 `lastRequest` 的行高，进而改变 `usageSurface` 的总高，进而改变 `mainViewport` 是否溢出、**是否出现滚动条**。这解释了为什么"有时候截图不滚动条、有时候有"。

另外 `16px`（`WidgetClient.cs:134` 结果页 `usageRangeTotal`）与 `17px`（数值）只差 1px，构成无效分级——两者视觉上等同，等于多维护了一级。

---

### S7 · 圆角七级并存

同一窗口内实际使用：`14`（`WidgetClient.cs:116` 窗口）、`10`（`WidgetClient.cs:339` heroSurface、`WidgetClient.cs:1185` taskSurface）、`8`（`WidgetClient.cs:121` usageSurface、`WidgetClient.cs:110` 按钮模板）、`6`（`WidgetClient.cs:110` 按钮焦点环、`WidgetClient.cs:234` 滑块拖柄）、`5`（`WidgetClient.cs:998` 滚动条拖柄、ComboBoxItem）、`3`（`WidgetClient.cs:323` 状态圆点）、`2`（`WidgetClient.cs:234` 滑块轨道与填充、`WidgetClient.cs:140` 图例色块）。

**机制**：圆角是"尺寸"的隐喻。7 个不同的值在 356×298 的区域内出现，等价于告诉读者"这里有 7 种尺寸的盒子"，但实际只有 3 种盒子（窗口 / 卡 / 控件）。**信号的冗余度超过了信息本身**，读者最终放弃解读圆角含义，圆角退化为纯装饰——而装饰性的圆角在深色小窗里只会显得"每个角都在抖"。

---

### S8 · `#8593FF` 语义过载：焦点态与内容强调态同色

**现象位**：`#8593FF` 同时用于
- 焦点环：`WidgetClient.cs:110`（按钮模板焦点环，CornerRadius 6）、`WidgetClient.cs:234`（滑块焦点框）、`WidgetClient.cs:941`（ComboBox 焦点）、`WidgetClient.cs:999`（Expander 箭头）
- 正文强调：`WidgetClient.cs:1185`（taskPin「跟随」文字）
- 数据表现：`WidgetClient.cs:136`（滑块填充）、`WidgetClient.cs:234`（滑块拖柄）、`WidgetClient.cs:287`（选中刻度）、`WidgetClient.cs:303`（柱状图焦点框）、`WidgetClient.cs:1048`（结果页当前作品文字）

**机制**：焦点环是**系统级、瞬态、必须无条件可见**的信号；正文强调是**内容级、常驻、可以克制**的信号。两者同值时，`TaskPin` 那个常驻的蓝色「跟随」会被误读成"当前键盘焦点在这里"，尤其在悬浮窗（`Topmost=true`，`WidgetClient.cs:111`）上，用户切走窗口后蓝色仍在，就成了假焦点。

---

### 诊断汇总（实现者按此顺序动手）

| 序 | 问题 | 一句话机制 | 影响面 |
| --- | --- | --- | --- |
| S1 | 数字层级塌陷 | 28/17/17/17 四个数字，两个还是"更亮"的一级文字色 → 权重倒挂 | 卡片全部数值 |
| S2 | 标签数值同质 | 同字号 + 同色 + 同字重 → 必须逐字读 | 上轮请求行 |
| S3 | 六块全上溢出 | 每块都不降级 + 178px 固定列 + 11px 滚条 | 整窗布局 |
| S4 | hero 负边距 | 内层圆角 10 > 外层 8，且左右各捅出 8px | 用量卡 |
| S5 | 告警色被正常态占用 | 橙色给了「运行中」，真故障无法分辨 | 状态行 / taskFlags |
| S6 | 10.5px 半像素 | UseLayoutRounding 下取整方向不定 → 行高抖动 → 滚条忽有忽无 | 四处 |
| S7 | 七级圆角 | 尺寸隐喻冗余 | 全窗 |
| S8 | 强调色过载 | 焦点环 = 内容强调 | 任务行 / 控件 |

---

## 2. 信息架构

### 2.1 九类信息清点

| # | 信息 | 数据来源 | 现状渲染位 | 现值 |
| --- | --- | --- | --- | --- |
| 1 | 任务上下文（当前绑定哪个任务） | `WidgetClient.cs:1185` taskCombo | 任务行 | 11px 下拉 + 蓝「跟随」 |
| 2 | 会话身份（活动/固定对话 + 短 id + 统计范围） | `WidgetClient.cs:548` | `caption` | 11px `#9A9EAC` |
| 3 | 可信度 + 生命周期（已确认/估算 + 事件来源 + 运行中） | `WidgetClient.cs:556-557` | `state` | 11px `#B0B3BF` |
| 4 | 会话合计 | `WidgetClient.cs:554`（`metrics[2]`） | hero 主数字 | **28px** SemiBold `#EDEEF2` |
| 5 | 缓存命中率 | `WidgetClient.cs:573` | hero 次数字 | 17px Medium `#B0B3BF` |
| 6 | 输入 / 输出拆分 | `WidgetClient.cs:554`（`metrics[0]`、`metrics[1]`） | breakdown | **17px Medium `#EDEEF2`** |
| 7 | 上轮请求明细（新输入 / 缓存 / 输出） | `WidgetClient.cs:585-586` | lastRequest | 10.5px `#9A9EAC` |
| 8 | 执行模型 + 推理强度 | `WidgetClient.cs:559-560` | contextLabel / effortLabel | 11px `#B0B3BF` / `#9A9EAC` |
| 9 | 观测均速 | `WidgetClient.cs:561` | speedCaption + `metrics[3]` | 11px `#9A9EAC` / 17px Medium `#B0B3BF` |

非信息层（不是"信息"，是**状态与导航**）：

| — | 状态告警（列表陈旧 / 已截断 / 固定任务日志不可用） | `WidgetClient.cs:119`、`WidgetClient.cs:1186`、`WidgetClient.cs:862`、`WidgetClient.cs:1189` | status / taskFlags | 12px / 11px `#F8B659` |
| — | 用量入口 | `WidgetClient.cs:147` | 底部按钮 | 11px `#9A9EAC` |

### 2.2 分层（四层 + 一个非信息层）

**L1 · 一眼（Anchored）** —— 1 个元素

- **会话合计**：用户打开悬浮窗的第一问题就是"这一场花了多少"。它是唯一的主数字。

**L2 · 一看就懂（Scan）** —— 1 个元素

- **缓存命中率**：决定"这笔钱花得值不值"，是合计的唯一注脚。它是唯一的次数字。

**L3 · 需要时看（Support）** —— 3 组

- **输入 / 输出**：合计的归因，看的时候才需要，平时不抢眼。
- **上轮请求三值**：最小粒度的验证，属于"怀疑数字不对时才看"。
- **观测均速**：性能指标，与花费无关，天然低优先。

**L4 · 确认用（Reference）** —— 4 个元素

- **任务上下文**：一旦绑定就不变，属于"设一次忘掉"。
- **会话身份 + 短 id**：主要用于区分多窗口，不需要常读。
- **可信度 + 生命周期**：信任校准信息，正常时不该占据注意力（见 §1 S5）。
- **执行模型 + 推理强度**：静态配置回显，只在排障时看。

**非信息层 · 状态与导航（Never competes）**

- 告警：只在真异常时使用告警色（`#F8B659`）。正常状态不得染橙。
- 导航：用量入口退到禁用色（`#636674`），它不是内容。

### 2.3 每层权重依据

| 层 | 依据 | 字号 | 颜色 | 是否可省略 |
| --- | --- | --- | --- | --- |
| L1 | "这一场多少钱"是悬浮窗存在的唯一理由；关闭它会让人立刻重开 | **28** | 一级文字 `#EDEEF2` | 否（无数据时显示 `—`） |
| L2 | 合计的语义补充，缺了合计无法解释 | **17** | 二级文字 `#B0B3BF` | 否（未知时显示 `—`） |
| L3 | 需要归因时才有意义，正常扫读会被跳过 | **13**（输入/输出、均速）<br>**12**（上轮请求数值） | 输入/输出 `#EDEEF2`；上轮请求数值 `#B0B3BF` | 输入/输出否；上轮请求可在无数据时整行省略 |
| L4 | 设定/回显类，读者不会反复读 | **11** | 二级 `#B0B3BF`（模型）/ 辅助 `#9A9EAC`（强度、身份、可信度） | 均口可整行省略 |
| 非信息 | 只在异常时抢一次注意力，正常时必须隐身 | **11** | 告警 `#F8B659` / 导航 `#636674` | 导航常驻，告警默认不占位 |

**权重差的分级依据（数字层级原则的落地）**：
- 28 : 17 = 1.65×，构成"主 / 次"的清晰台阶（人眼在 356px 宽内可稳定区分 ≥1.5× 的字号差）。
- 17 : 13 = 1.31×，构成"次 / 支撑"的台阶（低一档但仍可读）。
- 13 : 12 = 1.08×，几乎等同 → **故意如此**：输入/输出与上轮请求数值属于"同为支撑数字"，靠**颜色**（`#EDEEF2` vs `#B0B3BF`）而非字号区分，避免制造第 5 级台阶。
- 12 : 11 = 1.09× → 同样故意：数值与标签靠**颜色 + 字重**区分，不靠字号。
- **禁止**：任何两个"同级数字"使用相同字号 + 相同颜色 + 相同字重（这是 S1 的病根）。

**一条必须提前说清的边界（避免实现者误判"权重又倒挂了"）**：改完后 L3 的输入/输出是 `13px / #EDEEF2`，而 L2 的缓存率是 `17px / #B0B3BF`——**L3 的颜色比 L2 亮**。这不是 S1 的复发，因为判定规则从"颜色优先"变成了"字号优先"：

| 场景 | 现状（S1） | 改后 |
| --- | --- | --- |
| 两者关系 | 同为 17px Medium → 只能靠颜色分主次 → 颜色一错就彻底倒挂 | 17 vs 13（1.31× 台阶）→ **字号先定层级**，颜色只负责"同为支撑层内部的轻重" |
| 谁更抢眼 | 输入/输出（更亮 + 同大） | 缓存率（更大，且紧邻 28px 主数字，共享一个视觉锚点区） |
| 一级文字色的职责 | 到处用（18 处），等于没有层级 | 只保留给"这一层里最需要被读到的数字"：L1 主数字 + L3 的输入/输出（用户真正做归因时要读的两个） |

换句话说：**同层内用颜色分轻重，跨层用字号分主次**。只要字号台阶 ≥1.3×，下层用更亮的颜色不会造成倒挂；反过来，字号相同（现状的 17 vs 17）时任何颜色差异都会变成"越亮的越像重点"，这才是 S1 的真正机制。

---

## 3. 规格表

约定：
- 颜色一律写**角色名**，实现时用 §0.1 的色值。
- 行高（`LineHeight`）统一显式设置，配合 `LineStackingStrategy=BlockLineHeight`，避免字体回退导致行高漂移。
- 间距全部为 4 的倍数。
- 所有 TextBlock 的 `Margin` 改为显式设置（`Text()` 辅助方法默认 `Margin=(0,3,0,3)`，见 `WidgetClient.cs:109`，**必须逐项覆盖**，否则每个文本都会多带 6px 纵向空间）。

### 3.1 窗口与外壳

| 项 | 现值 | 新值 | 依据 |
| --- | --- | --- | --- |
| 窗口尺寸 | `Min(380, WorkArea.Width)` × `Min(320, WorkArea.Height)`（`WidgetClient.cs:111`） | 不变 | 用户已选定尺寸 |
| 外壳底色 | `#141518` 页面色（`WidgetClient.cs:116`） | 不变 | 现行令牌 |
| 外壳边框 | `#3F414B`，`BorderThickness=1`（`WidgetClient.cs:116`） | 不变 | 现行令牌 |
| 外壳圆角 | `CornerRadius(14)`（`WidgetClient.cs:116`） | `14`（= `RadiusLg`） | 保留最大一级 |
| 外壳内边距 | `Padding=(12,10,12,10)`（`WidgetClient.cs:116`） | **`Padding=(12,8,12,8)`**（10 不在 4 栅格上，8 是 `Space2`） | 见 §5 高度预算；上下各收回 2px 共 4px |
| **可用内容区** | 356 × 298（320 − 边框 2 − 上下内边距 20） | **356 × 302**（320 − 边框 2 − 上下内边距 16） | 所有纵向预算的基准 |

### 3.2 标题栏

| 项 | 现值 | 新值 |
| --- | --- | --- |
| 容器 | `DockPanel{Height=26, Margin=(0,0,0,6)}`（`WidgetClient.cs:117`） | `Height=26, Margin=(0,0,0,8)` |
| 标题文字 | `Text("Codex 状态",13)` + SemiBold + `#EDEEF2` + `Margin(0)`（`WidgetClient.cs:117`） | 字号 `13`、字重 `SemiBold`、颜色**一级文字**、`Margin(0)`、`VerticalAlignment=Center` |
| 标题对齐 | 左（DockPanel 默认填充） | 左 |
| 右侧按钮 | 置顶/设置/测试 各 `MinWidth=44, MinHeight=26, Padding=(6,2,6,2), Margin=(4,0,0,0)`；关闭 `Width=26`（`WidgetClient.cs:117`） | 不变。**注意横向占用 = 44×3 + 26 + 4×4 = 174px，标题可用宽度仅 ~182px**，故标题必须保持 `TextTrimming=CharacterEllipsis` |

### 3.3 任务行（L4，但位置在顶部因为它是"设定"）

| 项 | 现值 | 新值 | 依据 |
| --- | --- | --- | --- |
| 容器 | `Border{Height=36, Padding=(4), Margin=(0,0,0,6), Background=#1C1D21, BorderBrush=#3F414B, BorderThickness=1, CornerRadius=10}`（`WidgetClient.cs:1185`） | `Height=36`、`Padding=(4)`、**`Margin=(0,0,0,8)`**、背景**卡片色 `#1C1D21`**、边框**细边框 `#373941`**、`CornerRadius=10`（=`RadiusMd`） | 边框降一级：任务行是容器不是焦点 |
| 下拉框字号 | `FontSize=11`，`Padding=(8,4,27,4)`，背景 `#24252A`，前景 `#EDEEF2`，边框 `#3F414B`（`WidgetClient.cs:1185`） | 字号 `11`、字重 `Normal`、颜色**一级文字**、内边距 `Padding=(8,4,27,4)` 不变、背景**抬升底 `#24252A`**、边框**细边框 `#373941`** | |
| 「跟随」按钮文字 | `Button("跟随","TaskPin")`：`MinHeight=26`、`Padding=(8,0,8,0)`、`Margin=(6,0,0,0)`、背景 `#24252A`、前景 `#8593FF`（`WidgetClient.cs:1185`） | 字号 `11`、字重 `Normal`、前景改为**强调 `#8593FF` 仅表示"已固定"状态**；未固定态改为**辅助 `#9A9EAC`** | 解决 S8 过载：常驻蓝色 = 假焦点 |
| 任务行右侧间距 | `Margin=(6,0,0,0)` | `Margin=(8,0,0,0)` | 归 4 的倍数 |

### 3.4 用量卡外框

| 项 | 现值 | 新值 | 依据 |
| --- | --- | --- | --- |
| 容器 | `usageSurface`：`Background=#0E0F11`、`BorderBrush=#3F414B`、`BorderThickness=1`、`CornerRadius=8`、`Padding=(12,8,12,8)`（`WidgetClient.cs:121`） | 背景**内凹底 `#0E0F11`** 不变、边框**细边框 `#373941`**、`CornerRadius=10`（=`RadiusMd`，**与外层卡统一，消除 S4 的 8 vs 10 错位**）、`Padding=(12,8,12,8)` 不变 | |
| 容器最小高 | `Grid{MinHeight=84, Margin=(0,0,0,4)}`（`WidgetClient.cs:121`） | **删除 `MinHeight=84`**（改由内容自然撑开），`Margin=(0,0,0,12)` | 固定 MinHeight 会与实际内容 130px 打架 |
| 外框下间距 | `Margin=(0,0,0,4)` | `Margin=(0,0,0,12)` | 分组间留白 > 组内留白 |

### 3.5 卡片首行：会话身份 + 可信度（L4）

| 项 | 现值 | 新值 |
| --- | --- | --- |
| 行容器 | `captionRow`，`Margin=(0,0,0,4)`（`WidgetClient.cs:315`） | `Margin=(0,0,0,4)` 不变 |
| 状态圆点 | `6×6`、`CornerRadius 3`、默认 `#636674`、`Margin=(0,0,4,0)`（`WidgetClient.cs:323`） | 尺寸 `6×6`、`CornerRadius=3`（=`RadiusXs`）不变；颜色规则不变（`UsageDotColor`，`WidgetClient.cs:435-440`）；`Margin=(0,0,4,0)` |
| 身份文字 | `caption=Text(title,11)`、`#9A9EAC`、NoWrap+CharacterEllipsis（`WidgetClient.cs:322`） | 字号 **`11`**、字重 `Normal`、颜色**辅助 `#9A9EAC`**、左对齐、`Margin(0)`、`TextWrapping=NoWrap`、`TextTrimming=CharacterEllipsis` |
| 身份文字内容 | `活动对话 · 01a15a05 · 会话累计`（`WidgetClient.cs:548`） | 保留三段结构；**短 id 用等宽数字**（见 §6）；分隔符保持中点 `·` |
| 可信度文字 | `state=Text("",11)`、`#B0B3BF`、`Margin=(0,2,0,0)`、Wrap（`WidgetClient.cs:319`） | 字号 **`11`**、字重 `Normal`、颜色**二级文字 `#B0B3BF`**、左对齐、`Margin=(0,2,0,0)` 不变、**`TextWrapping=NoWrap` + `TextTrimming=CharacterEllipsis`**（原 Wrap 会在 356px 内折成两行，`MaxHeight` 未设 → 不可控） |
| 上下间距 | captionRow `Margin` 下 4 | 上 0 / 下 4 |
| 行高 | 未设（字体默认） | `LineHeight=16`、`LineStackingStrategy=BlockLineHeight` |

### 3.6 hero 主数字区（L1 + L2）

| 项 | 现值 | 新值 | 依据 |
| --- | --- | --- | --- |
| 容器 | `heroSurface=Border{Background=#1C1D21, BorderBrush=#373941, BorderThickness=1, CornerRadius=10, Padding=(8,4,8,4), Margin=(-8,0,-8,0)}`（`WidgetClient.cs:339` 第 19 段） | **`Margin=(0,4,0,0)`（删除负边距，S4 修掉）**、`Padding=(8,4,8,4)`、背景**卡片色 `#1C1D21`**、边框**细边框 `#373941`**、`CornerRadius=10`（=`RadiusMd`） | 内层圆角 10 = 外层圆角 10，不再"内圆大于外圆" |
| 「会话合计」标签 | `Text(selectedCard?"会话合计":"本机合计",10.5)`、`#9A9EAC`、`Margin=(0,0,8,0)`、Center（`WidgetClient.cs:335`） | 字号 **`11`**（废弃 10.5）、字重 `Normal`、颜色**辅助 `#9A9EAC`**、左对齐、**`Margin=(0,0,8,0)`**、`VerticalAlignment=Center`、`LineHeight=16` | |
| **L1 主数字** | `values[2]=Text("—",28)`、`FontFamily="Segoe UI"`、`SemiBold`、`#EDEEF2`、`Margin(0)`、NoWrap（`WidgetClient.cs:337`） | 字号 **`28`**、字重 **`SemiBold`**、颜色**一级文字 `#EDEEF2`**、数字字体 `Segoe UI`、**`LineHeight=32`**、`Margin(0)`、`VerticalAlignment=Center`、`TextAlignment=Right`、`MinWidth=76`、tabular 数字（§6） | 保留唯一主数字 |
| 「缓存命中率」标签 | `cacheCaption=Text("缓存命中率",11)`、`#9A9EAC`、`Margin=(14,0,6,0)`（`WidgetClient.cs:339` 第 0-7 段，整行共 22 段） | 字号 **`11`**、字重 `Normal`、颜色**辅助 `#9A9EAC`**、`Margin=(16,0,6,0)`（与主数字拉开到一个明确的 16px 分隔）、`VerticalAlignment=Center` | |
| **L2 次数字** | `cacheRate=Text("—",17)`、`Segoe UI`、`Medium`、`#B0B3BF`、`TextAlignment=Right`（`WidgetClient.cs:339` 第 8-18 段） | 字号 **`17`**、字重 **`Medium`**、颜色**二级文字 `#B0B3BF`**（保持现状；**不做提升**，它与 L1 必须差一档）、右对齐、`MinWidth=44`、tabular 数字 | |
| hero 下间距 | 无（`Grid` 行自动） | `Margin=(0,0,0,8)` | |
| hero 高度 | 实测约 42 | 目标 **42**（`28px` 行高 32 + 上下 padding 4+4 + 边框 2） | 见 §5 |

### 3.7 输入 / 输出拆分（L3）

| 项 | 现值 | 新值 | 依据 |
| --- | --- | --- | --- |
| 容器 | `breakdown=Grid{Margin=(0,2,0,0)}`，两等分列（`WidgetClient.cs:340-342`） | `Margin=(0,0,0,8)`，两列 `Width=*` 等分 | |
| 组标签 | `Text(i==0?"输入":"输出",10.5)`、`#9A9EAC`、`Margin=(0,0,8,0)`（`WidgetClient.cs:345`） | 字号 **`11`**（废弃 10.5）、字重 `Normal`、颜色**辅助 `#9A9EAC`**、左对齐、`Margin=(0,0,6,0)`、`VerticalAlignment=Center`、`LineHeight=16` | |
| **数值** | `values[i]=Text("—",17)`、`Segoe UI`、`Medium`、`#EDEEF2`（`WidgetClient.cs:346`） | **字号 `13`**（从 17 降档，解决 S1 的"同级大数字并排"）、字重 **`Medium`**、颜色**一级文字 `#EDEEF2`**、**左对齐**（原为默认左）、`Margin(0)`、`LineHeight=18`、tabular 数字、`MinWidth=64` | 降到 13 后与 17 拉开 1.31×，视觉上归入"支撑层" |
| 行高 | 未设 | `LineHeight=18`、`LineStackingStrategy=BlockLineHeight` | |
| 两列数值对齐 | 各列内 左对齐，自然不齐 | **每列内部改为：标签左对齐 + 数值左对齐，两列同锚点。因为两列等宽且各自左对齐，两个数值的左边缘天然在同一条隐式栅格上**；若要"数值右端对齐"，则把每列改成 `标签 + * + 右对齐数值` | 见 §6 对齐结论 |

### 3.8 上轮请求行（L3）—— 详见 §4

| 项 | 现值 | 新值 |
| --- | --- | --- |
| 容器 | 单个 `TextBlock`（`WidgetClient.cs:349`） | **改为水平 `StackPanel`**，内含 1 个行首标签 + 3 组（标签 + 数值）+ 2 个中点分隔符（见 §4） |
| 整行高 | 未设 | `LineHeight=16`（数值用 `LineHeight=16`，标签同） |
| 上间距 | `Margin=(0,2,0,0)` | `Margin=(0,0,0,0)`（上方的 breakdown 已有 `Margin` 下 8） |
| 溢出 | `TextTrimming=CharacterEllipsis` | 同（保留兜底） |

### 3.9 遥测元数据块（L4）

| 项 | 现值 | 新值 | 依据 |
| --- | --- | --- | --- |
| 容器 | `metadata=new StackPanel{Height=46}`（`WidgetClient.cs:124` 第 1 段） | **`Height=46` 改为不设高（自然撑开）**，并给 `Margin=(0,0,0,4)` | S3：固定高 46 与实测内容 39px 不匹配 |
| 执行模型 | `contextLabel=Text("模型 · 未知",11)`、`#B0B3BF`、`Margin=(0,0,0,5)`、`LineHeight=18`、NoWrap+Ellipsis（`WidgetClient.cs:124` 第 2-8 段） | 字号 **`11`**、字重 `Normal`、颜色**二级文字 `#B0B3BF`**、左对齐、`Margin=(0,0,0,4)`（5→4）、`LineHeight=16`（18→16）、NoWrap+CharacterEllipsis | |
| 元数据行容器 | `detailRow` 两列，**第 2 列 `GridLength(178)`**（`WidgetClient.cs:124` 第 15 段） | **第 1 列 `Auto`，第 2 列 `*`**（删除 178px 固定列，S3 修掉）；`speedRow` 保持 `HorizontalAlignment=Right` | 178 固定列 + 11px 滚条 = 数字被切 |
| 推理强度 | `effortLabel=Text("推理强度 · 未知",11)`、`#9A9EAC`、`Margin(0)`、Center（`WidgetClient.cs:124` 第 16-17 段） | 字号 **`11`**、字重 `Normal`、颜色**辅助 `#9A9EAC`**、左对齐、`Margin(0)`、`VerticalAlignment=Center`、`LineHeight=16` | |
| 均速标签 | `speedTitle=Text("上轮均速 token/s",11)`、`#9A9EAC`、`Margin=(0,0,8,0)`（`WidgetClient.cs:124` 第 29-32 段） | 字号 **`11`**、字重 `Normal`、颜色**辅助 `#9A9EAC`**、右对齐、`Margin=(0,0,6,0)`、Center | 文案改为「观测均速」（见下方注意） |
| 均速数值 | `metrics[3]=Text("—",17)`、`Segoe UI`、`Medium`、`#B0B3BF`、`TextAlignment=Right`（`WidgetClient.cs:124` 第 36-43 段） | **字号 `13`**（从 17 降档，与输入/输出同级）、字重 **`Medium`**、颜色**二级文字 `#B0B3BF`**、右对齐、`MinWidth=44`、tabular 数字 | 它和 L2（17px）同级会误读为次重点 |
| 块下间距 | 无 | `Margin=(0,0,0,12)`（元数据块之后进入底部行） | |

> **注意（文案正确性问题，非纯样式）**：`speedCaption.Text` 有 3 种取值（`WidgetClient.cs:561`）：`观测均速 ≈ token/s` / `请求均速 token/s` / `观测均速 · 待采样`。只有 `SpeedSource=="observed_window"` 时才允许出现「≈」符号；「请求均速」不应带「≈」。这条不在本规格的样式改动范围，但建议实现时顺手核对文案与 `SpeedSource` 的一致性。

### 3.10 底部行：告警槽 + 用量入口（非信息层）

| 项 | 现值 | 新值 | 依据 |
| --- | --- | --- | --- |
| 结构 | 两处独立：`status`（`WidgetClient.cs:119`，stack 第 2 位）+ `usageButton`（`WidgetClient.cs:147`，stack 第 5 位）+ `taskFlags`（`WidgetClient.cs:1186`，stack 最后） | **合并为一个 24px 高的 `Grid` 底部行**：第 1 列 `*`（告警文本）、第 2 列 `Auto`（用量入口） | 现状三处分散且 taskFlags 排最后，告警远离被异常对象；合并后**告警永不额外增加高度** |
| 告警文本字号 | `status` 12px / `taskFlags` 11px（两套） | **统一 `11`** | 同为告警不应有两级 |
| 告警字重 | `Normal` | **`Medium`** | 与相邻的 L4 文本（`Normal`）拉开字重差 |
| 告警颜色 | `#F8B659`（`WidgetClient.cs:119`、`WidgetClient.cs:1186`） | **告警 `#F8B659`**，但**仅在真异常时出现**（见下） | S5 |
| 告警对齐 | 左（status）/ 左上 | 左对齐、`VerticalAlignment=Center`、`LineHeight=14` | |
| 告警内容规则 | `status.Text` 可能是整条状态串（`WidgetClient.cs:565`） | **改为只放"需要用户处理"的短句**：`列表已截断` / `历史任务列表不可用` / `固定任务日志不可用`。正常状态（`已确认 · Codex app-server 事件` 这类）**不进入告警槽**，已在 L4 的可信度行显示，不重复 | S5 的核心修复 |
| 告警位置 | `stack` 第 2 位（`WidgetClient.cs:119`） | **移到卡片之后、窗口底部之前**（即底部行左列） | 异常靠近"用量入口"这条唯一的操作路径 |
| 告警占位 | 独立 18~28px | 无告警时该列空置，**不占额外高度**（高度由同行右侧的 24px 导航按钮决定） | S3 |
| 用量入口 | `Button("用量统计 ↗","Usage")`、`Margin=(0,6,0,0)`、`MinHeight=24`、`Padding=(0,2,0,2)`、`Foreground=#9A9EAC`、`HorizontalContentAlignment=Right`（`WidgetClient.cs:147`） | 字号 **`11`**、字重 `Normal`、颜色**禁用 `#636674`**（导航不该与内容争注意力）、右对齐、`MinHeight=24`、`Padding=(0,2,0,2)`、`Margin(0)`、透明底、无边框 | 导航层级降到最低可见 |

### 3.11 圆角收敛表（S7）

| 用途 | 现值 | 新值 | 令牌 |
| --- | --- | --- | --- |
| 窗口外壳 | 14（`WidgetClient.cs:116`） | **14** | `RadiusLg` |
| 卡片（taskSurface / usageSurface / heroSurface） | 10 / 8 / 10 | **10 全部** | `RadiusMd` |
| 按钮 / 下拉框 | 8（`WidgetClient.cs:110`、`WidgetClient.cs:1185`） | **6** | `RadiusSm` |
| 焦点环 | 6（`WidgetClient.cs:110`） | **6**（不变，与外框同心留 2px） | `RadiusSm` |
| 状态圆点 | 3（`WidgetClient.cs:323`） | **3** | `RadiusXs` |
| 滚动条拖柄 | 5（`WidgetClient.cs:998`） | **3** | `RadiusXs` |
| 滑块轨道 / 填充 / 图例色块 | 2（`WidgetClient.cs:234`、`WidgetClient.cs:140`） | **0**（直角） | 见下 |

**从 7 级压到 4 级（14 / 10 / 6 / 3），并把 2 与 5 消灭**。滑块与图例色块不是本卡片元素，但同一窗口内出现会破坏一致性；若不便改动，至少保证卡片区域内只用 14 / 10 / 6 / 3。

### 3.12 强调色收敛（S8）

| 用途 | 现值 | 新值 |
| --- | --- | --- |
| 焦点环 | `#8593FF` | **`#8593FF`**（保留专用于焦点，唯一） |
| 内容强调（正文） | `#8593FF` | **`#8593FF`** 但**只允许 1 处**：TaskPin「已固定」态 |
| 未固定态 / 次要交互 | `#8593FF` | **`#9A9EAC`**（辅助文字） |
| 数据表现（滑块/柱状图） | `#8593FF` | 结果页，不在本卡范围。但需与焦点环区分 → 选 `Data1 #8F9CFF` |

---

## 4. 上轮请求行重构方案

### 4.1 现状（回顾）

`WidgetClient.cs:585` 拼串：

```
"上轮请求 · 新输入 " + CountFormatter(fresh) + " · 缓存 " + CountFormatter(cached.Value) + " · 输出 " + CountFormatter(last.Output)
```

渲染成 `上轮请求 · 新输入 18,367 · 缓存 78,208 · 输出 696`，整串 10.5px / `#9A9EAC`（`WidgetClient.cs:349`）。

**已有优点**：分隔符已经是中点 `·`，不是半角连字符。全文件正则 `"[^"]* - [^"]*"` **零匹配**，这一点现行代码是对的。

**真问题**：标签与数值**同字号（10.5）+ 同颜色（`#9A9EAC`）+ 同字重（Normal）**，扫读无法把数字对上标签。

### 4.2 最终方案（推荐实现）

**结构**：把单个 `TextBlock` 换成水平 `StackPanel`，7 个孩子节点。

```
[行首标签「上轮请求」]  8px  [组1: 标签 4px 数值]  8px [·] 8px  [组2: 标签 4px 数值]  8px [·] 8px  [组3: 标签 4px 数值]
```

**逐项规格**

| # | 元素 | 字号 | 字重 | 颜色角色 | 色值 | 对齐 | 上下 | 左右 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 行首标签「上轮请求」 | **11** | `Normal` | 辅助 | `#9A9EAC` | 左 | `Margin(0)`，`VerticalAlignment=Center` | 右间距 **8** |
| 2 | 组标签「新输入」「缓存」「输出」 | **11** | `Normal` | 辅助 | `#9A9EAC` | 左 | `Margin(0)`，`LineHeight=16`，`VerticalAlignment=Center` | **右间距 4** |
| 3 | 组数值（三组） | **12** | **`Medium`** | 二级文字 | `#B0B3BF` | **右**（`TextAlignment=Right`） | `Margin(0)`，`LineHeight=16`，`VerticalAlignment=Center` | 左 0 |
| 4 | 分隔符「·」 | **11** | `Normal` | 禁用 | `#636674` | 居中 | `Margin(0)`，`VerticalAlignment=Center` | **左右各 8** |

**这个组合解决三件事**：

1. **标签与数值的三重区分**：字号 11 vs 12（1.09× 的克制差）、颜色 辅助 vs 二级（`#9A9EAC` vs `#B0B3BF`，明度差约 12%）、字重 `Normal` vs `Medium`。**三者叠起来就够扫读，而任何一项单独拉大都会显得吵**。这是"小窗里不要靠大幅字号差做层级"的具体落地。
2. **分隔符是视觉最弱的一环**：`·` 用禁用色 `#636674` + 左右各 8px 留白。它退到背景里，读者看到的是"三块内容 + 一块留白"，而不是"一个长句里三个点"。中点不会像半角连字符那样被读成负号或破折号——这是派活单硬性约束的正面理由，而不只是风格偏好。
3. **数值右对齐 + 固定 MinWidth，杜绝跳动**：`新输入 18,367` → `195` 这种位数变化（`CountFormatter` 在 `WidgetClient.cs:823`，≥1e5 才加 `k`），若数值左对齐，后面所有元素会横向移动。给每组数值设 `MinWidth`：

   | 组 | 最长形态示例 | 12px Segoe UI 实测宽 | `MinWidth` |
   | --- | --- | --- | --- |
   | 新输入 | `18,367` / `1.2M` | ≈ 40px | **46** |
   | 缓存 | `78,208` / `144.4k` | ≈ 42px | **46** |
   | 输出 | `696` / `1.1M` | ≈ 30px | **34** |

   `TextAlignment=Right` 让数字贴住 `MinWidth` 的右边缘 → 位数变化时**左边界动、右边界不动**，三组的数值右端在一条隐式竖线上对齐。

**宽度核算（356px 内容区，卡片内左右各 12px padding → 332px 可用）**

| 元素 | 宽 |
| --- | --- |
| 「上轮请求」4 字 × 11px | ≈ 44 |
| 右间距 | 8 |
| 「新输入」3 字 × 11 = 33 + 4 + 数值 46 | 83 |
| `·` 11px ≈ 4 + 左右 8+8 | 20 |
| 「缓存」2 字 × 11 = 22 + 4 + 数值 46 | 72 |
| `·` | 20 |
| 「输出」2 字 × 11 = 22 + 4 + 数值 34 | 60 |
| **合计** | **307** ≤ 332 ✓ |

留 25px 余量，足够容纳 `Example/...` 这类 locale 差异或 DPI 缩放。

### 4.3 兜底方案（当数值形态超长时）

若某次 `CountFormatter` 输出 ≥ 8 字符（如 `1.234E+12`，见 `WidgetClient.cs:823` 的 `"0.#E+0"` 分支），307px 会涨到 ~340px 越界。此时**不缩字号、不换分隔符**，改为：

- 把行首标签「上轮请求」独立成一行（`11px` 辅助色，`Margin=(0,0,0,4)`），三组数值独占第二行。
- 该两行结构只在越界时启用，用 `Measure()` 判断；`LineHeight` 仍为 16，两行共 36px（比单行多 36px，需从 `usageSurface` 下方元素让出，见 §5 的弹性项）。

**禁止的三件事**（明确写出来，避免实现者自由发挥）：
1. **不得**用半角连字符 `-`、短破折号 `–` 或长破折号 `—` 做分隔（后者在中文语境里会被读成"空值"，而 `RenderCacheRate` 的未知态正用 `—`，会混淆）。
2. **不得**用竖线 `|`：`|` 在 11px 下字重很重，且与 `TextBlock` 的 `LineHeight=14` 组合会长出上下不对称的视觉重量。
3. **不得**给这一行加背景色或边框：它会与 `heroSurface`/`breakdown` 形成第四个"盒子"，加剧 S4 的套娃。

### 4.4 与前两行的垂直关系

```
         heroSurface   （会话合计 28 + 缓存率 17）       下间距 8
         breakdown     （输入 13 + 输出 13）             下间距 8
→        lastRequest   （上轮请求 11 + 三值 12）         上间距 0
```

- `breakdown` 下间距 **8**，`lastRequest` 上间距 **0** → 实际间距 8，是"组内"级别。
- `heroSurface` 下间距也是 **8**，但 L1/L2 与 L3 之间的语义跨度更大 → **这就是为什么 hero 的下间距视觉上"不够"**：正确做法不是加间距，而是让 `breakdown` 的 13px 数字与 hero 的 28px 形成足够大的字号差（1× vs 1.65× 已经够），间距保持 8 即可。**若实现后仍觉得挤，改的应该是颜色对比（把 breakdown 数值从 `#EDEEF2` 降为 `#B0B3BF`），而不是加间距**——加间距会直接吃掉 §5 预算里只剩的 8px。

---

## 5. 纵向节奏

### 5.1 预算基准

- 窗口 320px 高，外壳 `BorderThickness=1`（`WidgetClient.cs:116`）→ 可绘 318
- 外壳 `Padding=(12,8,12,8)`（§3.1 从 `10` 收到 `8`）→ **可用内容高 = 302px**
- 宽度同理：380 − 2 − 24 = **356px**

### 5.2 间距栅格

| 级 | 值 | 用途 |
| --- | --- | --- |
| G1 | **4** | 行内（标签与数值、圆点与文字） |
| G2 | **8** | 组内（同一卡片内的元素之间）、分区分隔 |
| G3 | **12** | 块间（卡片之间、卡片与元数据之间） |

**为什么是可舒服的**：4/8/12 是 4 的整数倍，与 `WidgetClient.cs:111` 已有的 `UseLayoutRounding=true` 完全兼容——整数倍的间距在 100% / 125% / 150% DPI 下都能落到整设备像素上，不会出现"这个 3px 在某些缩放比例下变成 4px、而隔壁那个还是 3px"的错位。同时 8 : 4 的 2 倍关系让"组内 / 组间"有一个明确的视觉分级（读者能感到"这是一组的"vs"这是下一组的"），而 12 : 8 的 1.5 倍关系让"块间"再上一个台阶，但不至于像 16 或 20 那样把 302px 的高度吃穿。

### 5.3 纵向序列（自上而下，累计高度）

| # | 元素 | 元素高 | 下间距 | 累计 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 标题栏 | 26 | 8 | 34 | `WidgetClient.cs:117`，`Margin` 从 6 改 8 |
| 2 | 任务行 | 36 | 8 | 78 | `WidgetClient.cs:1185`，`Margin` 从 6 改 8 |
| 3 | 用量卡 · 上内边距 | 8 | — | 86 | `usageSurface` `Padding=(12,8,12,8)` |
| 4 | 卡片首行（身份 + 可信度） | 16 | 4 | 106 | `captionRow` + `caption`（`LineHeight=16`） |
| 5 | hero 主数字区 | 42 | 8 | 156 | 28px 行高 32 + padding 4+4 + 边框 2 |
| 6 | 输入 / 输出 | 18 | 8 | 182 | 13px 行高 18 |
| 7 | 上轮请求 | 16 | 0 | 198 | 12px 行高 16 |
| 8 | 用量卡 · 下内边距 | 8 | — | 206 | |
| 9 | 用量卡 · 边框 | 2 | — | 208 | `BorderThickness=1` × 2 |
| 10 | 卡片后间距 | — | 12 | 220 | G3 |
| 11 | 执行模型 | 16 | 4 | 240 | `LineHeight=16` |
| 12 | 元数据行（强度 + 均速） | 18 | 12 | 270 | `LineHeight=18`，G3 下间距 |
| 13 | 底部行（告警槽 + 用量入口） | 24 | — | **294** | `MinHeight=24` |
| | **余量** | | | **8** | 302 − 294 |

### 5.4 这套节奏为什么"舒服"

1. **间距是单调的**：4 → 8 → 12 三级，且**相邻级的比值不小于 1.5**（8/4 = 2，12/8 = 1.5）。人的视觉分组遵循"间距越小越像一组"，只要比值 ≥ 1.5 就能稳定分出组来；比值 < 1.3 时（比如现状的 5 vs 6、2 vs 4）分组就模糊了。
2. **没有任何一处间距是"为了填满"**：全部 4 的倍数，且每一项都能在 §5.3 的表里算出累计。现状的问题是间距散落在 1/2/3/4/5/6/8/14 八个值上（`WidgetClient.cs:124` 的 5、`WidgetClient.cs:349` 的 2、`WidgetClient.cs:121` 的 4、`WidgetClient.cs:1185` 的 6、`WidgetClient.cs:335` 的 8、`WidgetClient.cs:339` 的 14 …），读者的眼睛在每一个新元素前都要重新判断"这次的距离是什么意思"。
3. **分组留白明显大于组内**：G2（8）把「hero」和「breakdown」和「上轮请求」隔成三段，但 G2 也用在「身份行」与「hero」之间——因为它们同属"这一张卡片"；G3（12）只用在"卡片 → 元数据"和"元数据 → 底部行"，这是真正的换区。**读者看到 12px 就知道"换话题了"**。
4. **底部行永远贴底**：把告警和导航合成一行 24px 后，无论是否出现告警，底部占位都固定在 270 之后。现状是 `status` 可能占 0 或 28px（`WidgetClient.cs:119` 的 `MaxHeight=28`），导致"有告警时整卡被推下去、出滚动条"，这正是 S3 的直接触发点。**告警不再有"高度代价"，这是本次重构对可用性最大的实际改善。**

### 5.5 弹性规则（数据状态变化时）

| 状态 | 变化 | 处理 |
| --- | --- | --- |
| 无任何用量数据 | hero / breakdown / 上轮请求 全部显示 `—`（`CountFormatter` 不返回空，`RenderLivePresentation` `WidgetClient.cs:554` 写 `"—"`） | **高度不变**，不隐藏块（隐藏会导致布局跳动，比显示 `—` 更丑）。`—` 用禁用色 `#636674`（沿用 `EmptyValue` 的规则，`WidgetClient.cs:441`） |
| 缓存率未知 | `cacheRate` 显示 `—`、`cacheCaption` 仍显示（`WidgetClient.cs:569-570` 的成对切换**改为始终 Visible**） | 高度不变 |
| 上轮请求无数据 | `lastRequest` 显示 `上轮请求 · —`（`WidgetClient.cs:584`） | 高度不变 |
| 均速无数据 | `metrics[3]` 显示 `—`、`speedCaption` 为「观测均速 · 待采样」（`WidgetClient.cs:561`） | 高度不变 |
| 有真告警 | 底部行左列出现橙色文本 | **高度不变（24px 已被导航按钮撑住）** |
| 三个 L4 元数据全空 | 可整块 `Collapsed` | 释放 34px（16+4+18 减去 12 的 G3 改为 0），**作为唯一的伸缩项** |

**核心原则：默认状态下所有块的高度必须与"有数据"时完全一致。** 唯一允许改变总高的是 L4 元数据块的整体隐藏（因为它是最不重要的层）。

---

## 6. 数字排版结论

### 6.1 结论

| 问题 | 结论 |
| --- | --- |
| 是否用等宽字体？ | **不换字体族。** 继续用 `Segoe UI`（现状已用：`WidgetClient.cs:337`、`WidgetClient.cs:339`、`WidgetClient.cs:346`、`WidgetClient.cs:134`）。中文界面里把数字换成 `Consolas` / `Cascadia Mono` 会和「Microsoft YaHei UI」（`WidgetClient.cs:111`）产生字面高度差，在 11/12px 上尤其明显，得不偿失。 |
| 是否用 tabular 数字？ | **是，必须显式开。** 用 WPF 的 OpenType 附加属性把 `Segoe UI` 的数字锁定为 tabular（等宽）lining figures。 |
| 小数/千分位的对齐由什么保证？ | **两层**：tabular 锁住单个数字的字宽，`MinWidth` + `TextAlignment=Right` 锁住整串的边界。**只做其中一层不够**——tabular 解决"8 比 1 宽"的个位抖动，固定宽度解决"696 比 18,367 短"的整体位移。 |

### 6.2 WPF 具体写法

```csharp
// 前提：所有数字 TextBlock 已有 FontFamily = new FontFamily("Segoe UI")
// 现状见 WidgetClient.cs:337 / 339 / 346 / 124(metrics[3])

static TextBlock Numeric(TextBlock tb, double minWidth, TextAlignment align)
{
    // 1) 锁定 tabular（等宽） + lining 数字
    System.Windows.Documents.Typography.SetNumeralAlignment(tb, FontNumeralAlignment.Tabular);
    System.Windows.Documents.Typography.SetNumeralStyle(tb, FontNumeralStyle.Lining);

    // 2) 固定宽度右对齐，防止位数变化导致横向跳动
    tb.MinWidth = minWidth;
    tb.TextAlignment = align;
    tb.TextWrapping = TextWrapping.NoWrap;
    tb.TextTrimming = TextTrimming.None;
    return tb;
}
```

调用点与参数：

| 位置 | 现状锚点 | `minWidth` | `align` |
| --- | --- | --- | --- |
| 会话合计（28px） | `WidgetClient.cs:337` | **76** | `Right` |
| 缓存命中率（17px） | `WidgetClient.cs:339` 第 8 段 | **44** | `Right` |
| 输入 / 输出（13px） | `WidgetClient.cs:346` | **64** | `Right` |
| 观测均速（13px） | `WidgetClient.cs:124` 的 `metrics[3]` | **44** | `Right` |
| 上轮请求三值（12px） | 新结构，见 §4 | 46 / 46 / 34 | `Right` |

### 6.3 为什么这样就够（机制说明）

1. **`Segoe UI` 的默认数字本来就是 tabular lining**，但这是"当前版本的字体文件如此"，不是契约。设了 `NumeralAlignment.Tabular` 之后：
   - 系统把 `Segoe UI` 换成 `Segoe UI Variable` 或回退到其他字体时，tabular 特性会由 WPF 尝试应用，若字体支持就保持等宽。
   - 字体不支持时，该附加属性**静默无效，不会报错、不会改变外观**——所以这是一个零风险的加固，值得加。
2. **真正的跳动来源不是字宽，是位数**。`CountFormatter`（`WidgetClient.cs:823`）在 1e5 处从 `18,367` 跳到 `185.7k`，字符数从 6 变成 6 但字面宽度差很多（`k` 比 `,` 宽）。tabular 让每个数字格等宽，`MinWidth` 让整串的盒子不变 → 后面所有元素位置绝对稳定。
3. **右对齐是这套方案的前提**：如果保持左对齐，`MinWidth` 只能保证盒子不变，数字本身仍会在盒子里左右浮动。右对齐让数字的"末尾"固定，读多个数值时末位对齐，这才是纵向可比的关键——尤其 `输入 474.8M` 与 `输出 2.1M` 这类量级不同的数字，右对齐后能立刻看出 `2.1` 只有 `474.8` 的两百分之一。
4. **短 id（`01a15a05`）也要 tabular**：它在 L4 身份行里与另外两段文字用 `·` 拼接（`WidgetClient.cs:548`），是十六进制串，`0/1/7` 宽度不同会让整行在 id 变化时抖动。

### 6.4 明确不要做的事

| 不要 | 原因 |
| --- | --- |
| 不要给中文标签设 `FontFamily="Segoe UI"` | `Segoe UI` 不含 CJK，WPF 会回退到 `Microsoft YaHei UI`（`WidgetClient.cs:111`），但回退后的**基线与 `Segoe UI` 数字的基线不同**，混排会看到文字高低不平。现状 `WidgetClient.cs:335`/`345`/`349` 的中文标签没有设字体族，是对的。 |
| 不要用 `10.5px` 这类半像素字号 | `UseLayoutRounding=true`（`WidgetClient.cs:111`）下取整方向取决于累积偏移，同一元素挪位就变行高（§1 S6）。数字字号一律取整数：**28 / 17 / 13 / 12 / 11**。 |
| 不要给数值设 `FontWeight=Bold` | `Bold` 在 `Segoe UI` 11~17px 上会加粗笔画到 2px，在深色底上产生眩光（halation）。现有 `Medium` / `SemiBold` 两级（`WidgetClient.cs:346` / `WidgetClient.cs:337`）已经是正确上限。 |
| 不要用 `String.Format` 里的 `:N0` 生成后手动补空格 | 现状 `CountFormatter` 已统一（`WidgetClient.cs:823`），补空格会让 tabular 失去意义。 |
| 不要把 `—`（U+2014）当数值占位以外的东西用 | `—` 已是未知态占位符（`WidgetClient.cs:441`、`WidgetClient.cs:574`、`WidgetClient.cs:584`）。若用它做分隔符，会和"数据缺失"混淆。 |

---

## 7. 实现清单（按此顺序改，每步可独立验证）

| 步 | 改动 | 锚点 | 验证方式 |
| --- | --- | --- | --- |
| 1 | 字号 10.5 → 11（4 处） | `WidgetClient.cs:335`、`:345`、`:349`、`:1026` | 全文件搜 `10.5` 应为 0 命中 |
| 2 | 删掉 `heroSurface` 的负边距，改 `Margin=(0,4,0,0)` | `WidgetClient.cs:339` 第 19 段 | 截图里胶囊左右边缘与 `usageSurface` 边框距离一致 |
| 3 | `usageSurface` 圆角 8 → 10 | `WidgetClient.cs:121` | 与 `heroSurface` 的 10 同心 |
| 4 | 输入/输出 17 → 13，均速 17 → 13 | `WidgetClient.cs:346`、`WidgetClient.cs:124` 第 36 段 | 四个大数字变两个（§1 S1） |
| 5 | `telemetryMetadata` 去掉 `Height=46` | `WidgetClient.cs:124` 第 1 段 | 元数据块高由内容决定（应≈34） |
| 6 | `detailRow` 第 2 列 178 → `*` | `WidgetClient.cs:124` 第 15 段 | 均速数字不再被裁 |
| 7 | 上轮请求改为 §4.2 的 StackPanel 结构 | `WidgetClient.cs:349`（容器）+ `WidgetClient.cs:585-586`（文本写入改为分字段赋值，需要新增 3 个 `TextBlock` 字段，声明处 `WidgetClient.cs:82` 现有 `lastRequest` 旁） | 截图里标签浅、数值亮、中点为最暗 |
| 8 | 告警合并进底部行，`status.Text` 只放真异常 | `WidgetClient.cs:119`、`WidgetClient.cs:565`、`WidgetClient.cs:1186` 的 `taskFlags` | 正常态无橙色文本；滚条不出现 |
| 9 | 所有 `Margin` 归到 4/8/12，`LineHeight` 显式设置 | §3 全表 | 截图量像素 |
| 10 | 数值 TextBlock 加 `Typography.NumeralAlignment=Tabular` + `MinWidth` + 右对齐 | §6.2 | 数据刷新时数字右端不动 |
| 11 | （可选，需额外批准）`docs/ui-redesign/WidgetTheme.cs` → `scripts/native/WidgetTheme.cs`，并加进 `scripts/native-widget.ps1:9` 的 `Add-Type -Path` | `scripts/native-widget.ps1:9` | `WidgetTheme.Text3` 等常量可编译引用 |

### 验收标准（客观、可截图核对）

1. 主悬浮窗在 1920×1080 / 100% DPI 下**不出现竖向滚动条**（当前会出现，见 `output/widget-after-preview-fix.png` 右缘）。
2. 卡片区域内**数字字号只有 28 / 17 / 13 / 12 四种，标签只有 11 一种**。
3. 「上轮请求」行里，**标签与数值在字号、颜色、字重三项上至少有两项不同**。
4. 分隔符中 `·` 的颜色比它两侧的文字都暗（`#636674` vs `#9A9EAC` / `#B0B3BF`）。
5. 正常数据状态下**没有 `#F8B659` 的文本**（橙色只在真异常出现）。
6. 卡片区域内**圆角只有 14 / 10 / 6 / 3 四种**。
7. 全文件搜 `10.5` 为 0 命中；搜 `" - "` 为 0 命中（后者现状已是 0，作为回归保护）。
8. 连续两次刷新（如 `1,234` → `18,367` → `696`）时，上轮请求三组的**数值右端不横向移动**。

---

## 附录 A：本文引用的全部行号索引

| 行号 | 内容 |
| --- | --- |
| `scripts/native/WidgetClient.cs:82` | 字段声明：`StackPanel telemetryMetadata, speedPanel`；`TextBlock speedCaption, cacheCaption, cacheRate, lastRequest` |
| `scripts/native/WidgetClient.cs:108` | `B(string)` 画刷辅助，每次 new `BrushConverter`，不缓存 |
| `scripts/native/WidgetClient.cs:109` | `Text(string,double)`：默认前景 `#EDEEF2`、`Margin=(0,3,0,3)`、`TextWrapping=Wrap` |
| `scripts/native/WidgetClient.cs:110` | `Button(string,string)`：`MinHeight=28`、`FontSize=11`、模板圆角 8、焦点环圆角 6 色 `#8593FF` |
| `scripts/native/WidgetClient.cs:111` | 窗口：380×320、`Microsoft YaHei UI`、`FontSize=11`、`#EDEEF2`、`UseLayoutRounding`、`SnapsToDevicePixels`、`Topmost` |
| `scripts/native/WidgetClient.cs:116` | 外壳 Border：圆角 14、`#141518`、边框 `#3F414B`、`Padding=(12,10,12,10)` |
| `scripts/native/WidgetClient.cs:117` | 标题栏：`Height=26, Margin=(0,0,0,6)`；标题 13px SemiBold；四按钮 44×3 + 26 |
| `scripts/native/WidgetClient.cs:118` | `stack` + `mainViewport`（竖滚 Auto）；`stack.Children.Add` 第 1 项是任务行 |
| `scripts/native/WidgetClient.cs:119` | `status`：12px、`#F8B659`、`LineHeight=14`、`MaxHeight=28`、Collapsed，且是 stack 第 2 项 |
| `scripts/native/WidgetClient.cs:121` | `metricsGrid` `MinHeight=84`；`usageSurface`：`#0E0F11`、圆角 8、`Padding=(12,8,12,8)` |
| `scripts/native/WidgetClient.cs:124` | `telemetryMetadata`：`Height=46`、`contextLabel` 11px `#B0B3BF` `LineHeight=18` `Margin=(0,0,0,5)`；`detailRow` 第 2 列固定 178；`speedCaption` 11px `#9A9EAC`；`metrics[3]` 17px Medium `#B0B3BF` 右对齐 |
| `scripts/native/WidgetClient.cs:134` | 结果页 `usageRangeTotal` 16px（16 vs 17 的无效分级） |
| `scripts/native/WidgetClient.cs:140` | 图例色块：`#8F9CFF`、`#C08DE2`，圆角 2 |
| `scripts/native/WidgetClient.cs:147` | `usageButton`：`MinHeight=24`、`Margin=(0,6,0,0)`、`#9A9EAC`、右对齐内容 |
| `scripts/native/WidgetClient.cs:234` | 滑块：轨道/填充圆角 2、拖柄圆角 6、焦点圆角 5、色 `#8593FF` |
| `scripts/native/WidgetClient.cs:287` | 选中刻度 `#8593FF` |
| `scripts/native/WidgetClient.cs:303` | 柱状图焦点框 `#8593FF` |
| `scripts/native/WidgetClient.cs:310` | `BuildUsageCard(string,out,out,out)` 签名 |
| `scripts/native/WidgetClient.cs:314` | `selectedCard = title != "Codex 总用量"` |
| `scripts/native/WidgetClient.cs:315` | `captionRow` `Margin=(0,0,0,4)` |
| `scripts/native/WidgetClient.cs:319` | `state`：11px `#B0B3BF`、selectedCard 时 `Margin=(0,2,0,0)`、Wrap、无 Trim |
| `scripts/native/WidgetClient.cs:322` | `caption`：11px `#9A9EAC`、NoWrap+Ellipsis |
| `scripts/native/WidgetClient.cs:323` | `captionDot`：6×6、圆角 3、`#636674`、`Margin=(0,0,4,0)` |
| `scripts/native/WidgetClient.cs:335` | `totalLabel`：10.5px `#9A9EAC` `Margin=(0,0,8,0)` |
| `scripts/native/WidgetClient.cs:337` | `values[2]`：28px Segoe UI SemiBold `#EDEEF2` |
| `scripts/native/WidgetClient.cs:339` | 整行 22 段。第 0-7 段 `cacheCaption` 11px `#9A9EAC` `Margin=(14,0,6,0)`；第 8-18 段 `cacheRate` 17px Segoe UI Medium `#B0B3BF` 右对齐；第 19 段 `heroSurface`（圆角 10、`Padding=(8,4,8,4)`、`Margin=(-8,0,-8,0)`）；第 20 段 `body.Children.Add(heroSurface)` |
| `scripts/native/WidgetClient.cs:340` | `breakdown` `Grid{Margin=(0,2,0,0)}` |
| `scripts/native/WidgetClient.cs:345` | 输入/输出标签 10.5px `#9A9EAC` `Margin=(0,0,8,0)` |
| `scripts/native/WidgetClient.cs:346` | 输入/输出数值 17px Segoe UI Medium `#EDEEF2` |
| `scripts/native/WidgetClient.cs:349` | `lastRequest`：10.5px `#9A9EAC`、`Margin=(0,2,0,0)`、NoWrap+Ellipsis |
| `scripts/native/WidgetClient.cs:435-440` | `UsageDotColor`：空→`#636674`；含估算/快照/陈旧等→`#F8B659`；含已核实→`#69D3A2` |
| `scripts/native/WidgetClient.cs:441` | `EmptyValue`：`—`→`#636674`；否则字号 ≥24 给 `#EDEEF2`，其余 `#B0B3BF` |
| `scripts/native/WidgetClient.cs:544` | `RenderLivePresentation()` 入口 |
| `scripts/native/WidgetClient.cs:548` | 身份串：`identity · ShortId · scope` |
| `scripts/native/WidgetClient.cs:552` | `selectedUsageCaption.ToolTip=tip` + `SetHelpText`（不是 `speedPanel`；派活单举的 `:552 的 speedPanel` 实际在 `:82` 声明、`:124` 构建、`:563`/`:737`/`:851` 控制可见性） |
| `scripts/native/WidgetClient.cs:553-554` | `labels={"输入","输出","合计"}`；`metrics[i].Text` |
| `scripts/native/WidgetClient.cs:556-557` | 可信度串与生命周期串 |
| `scripts/native/WidgetClient.cs:559-561` | 模型 / 强度 / 均速三条赋值；`speedCaption` 三种形态 |
| `scripts/native/WidgetClient.cs:565` | `status.Text = … ? "" : "○ "+state` + 可见性联动 |
| `scripts/native/WidgetClient.cs:567-576` | `RenderCacheRate`；`:573` `"0.0"` 百分比 |
| `scripts/native/WidgetClient.cs:577-588` | `RenderLastRequest`；`:584` 无数据、`:585` 有缓存、`:586` 无缓存 |
| `scripts/native/WidgetClient.cs:822-823` | `Number` / `CountFormatter`：≥1e12 `0.#E+0`、≥1e9 `G`、≥1e6 `M`、≥1e5 `k`、其余 `N0` |
| `scripts/native/WidgetClient.cs:862` | `status.Text="○ 固定任务日志不可用"` |
| `scripts/native/WidgetClient.cs:935` | 同上第二处 |
| `scripts/native/WidgetClient.cs:941` | ComboBox 模板圆角 8 / 焦点 6、`#8593FF` |
| `scripts/native/WidgetClient.cs:995-999` | Expander 模板，`:999` 箭头 `#8593FF` |
| `scripts/native/WidgetClient.cs:998` | `DarkScrollBarStyle()`：滚动条 `Width=11`、`MinHeight=18`、拖柄 `#373941` 圆角 5、悬停 `#9A9EAC`、拖动 `#B0B3BF` |
| `scripts/native/WidgetClient.cs:1026` | 设置页 10.5px |
| `scripts/native/WidgetClient.cs:1048` | 结果页当前作品文字 `#8593FF` |
| `scripts/native/WidgetClient.cs:1051` | 「开始生成」按钮 `#4A5AD6` + `#FFFFFF` |
| `scripts/native/WidgetClient.cs:1185` | `taskSurface`：`Height=36`、`Padding=(4)`、`Margin=(0,0,0,6)`、`#1C1D21`、边框 `#3F414B`、圆角 10；taskCombo 11px `#24252A`；taskPin 前景 `#8593FF`；是 stack 第 1 项 |
| `scripts/native/WidgetClient.cs:1186` | `BuildTaskDetailUi`：`taskFlags` 11px `#F8B659` `MaxHeight=14`；是 stack 第 6 项（最后） |
| `scripts/native/WidgetClient.cs:1189` | `status.Text="○ 正在读取任务…"` |
| `scripts/native/WidgetClient.cs:1190` | `UpdateTaskFlags`：组内用 `" / "` 连接 |
| `scripts/native/WidgetClient.cs:1191` | `UpdateTaskUi`：`taskTitle` 恒 Collapsed（任务标题行永不显示） |
| `scripts/native-widget.ps1:9` | `Add-Type -Path` 清单，**不含 `WidgetTheme.cs`** |
| `docs/ui-redesign/WidgetTheme.cs` | 168 行设计令牌，值与本规格全部对得上，但未参与编译 |
| `docs/ui-redesign/impl-notes-2026-10-20.md:48` | `#9DE5D0 → #8593FF` 换代对照 |
| `docs/ui-redesign/codex-stateline-ui-redesign.md:718-726` | 旧 `#9DE5D0` 17 处逐处映射 |

## 附录 B：被废弃的表达式（实现者直接搜这些替换）

| 搜这个 | 现值 | 改为 |
| --- | --- | --- |
| `10.5` | 4 处半像素字号 | `11` |
| `new Thickness(-8,0,-8,0)` | heroSurface 负边距 | `new Thickness(0,4,0,0)` |
| `new GridLength(178)` | 元数据第 2 列固定宽 | `new GridLength(1,GridUnitType.Star)` |
| `Height=46` | telemetryMetadata 固定高 | 删除（自然撑开） |
| `MinHeight=84` | metricsGrid | 删除 |
| `Foreground=B("#F8B659")` 于 `status` | 正常态染橙 | 移到告警槽，且只在真异常时赋值 |
| `Text("—",17)` 与 `FontWeight=FontWeights.Medium` 组合于输入/输出数值 | 17px 支撑数字 | 字号 `13`，字重保留 `Medium` |
| `Text("—",17)` 于 `metrics[3]` | 17px 均速 | 字号 `13` |
| `CornerRadius=new CornerRadius(8)` 于 usageSurface | 内层 8 < 外层 10 | `10` |
| `#9DE5D0`、`#E6EDF4` | 已不存在 | 不要新增；如从旧文档复制请替换为 `#8593FF` / `#EDEEF2` |
