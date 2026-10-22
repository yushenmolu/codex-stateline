# Codex Stateline 界面重设计：配色、主题与视觉系统

> **归档说明（仓库整理时追加）**：
>
> - `Temp/ui-audit/` 下的审计脚本已归档至 **`docs/ui-redesign/tools/`**（`analyze.py`、`collect-dom.js`）；
>   其余审计原始数据（`_tables.md`、`*.json`）已删除。
> - 文中引用的 `proposed-styles.css` / `proposed-preview.css` 已删除——其内容与整理后提交的
>   `src/public/styles.css` / `src/public/preview.css` 完全一致（该设计已应用并上线），现以实际文件为准。
> - 正文中的 `Temp/...`、`docs/ui-redesign/proposed-*.css` 均指整理前的旧位置。


> 结论先说：问题不在"审美偏好"，而在**结构**——这个 UI 没有 token 层。
> 同一个"深色底"在三处各写了一遍（三套互不相同的中性色），同一个强调色在 17 处重复写字面值，
> 10 个"层级"里有 6 个彼此只差 1.07–1.20:1（肉眼不可分辨），于是所有层次都靠 1px 描边硬撑，
> 看起来就是"一堆灰盒子套灰盒子"。下面的方案把颜色收进 44 个语义 token，把层级改成等步长的明度阶梯，
> 并给出可直接替换的代码。

测量口径：所有对比度按 WCAG 2.1 相对亮度计算（`(L1+0.05)/(L2+0.05)`）；
所有数值来自对 `scripts/native/WidgetClient.cs`（229 KB）、`src/public/styles.css`、
`src/public/preview.css` 的静态扫描 + 脚本复算，脚本见 `Temp/ui-audit/`（可重跑，见 §11）。

| 交付物 | 路径 | 状态 |
| --- | --- | --- |
| 设计 token（Web，深/浅两套） | `src/public/tokens.css` | 已生成，可直接引入 |
| 设计 token（WPF 常量类） | `docs/ui-redesign/WidgetTheme.cs` | 已生成，编译通过待接入 |
| 对比度实测表 | 本文 §5（原始数据 `Temp/ui-audit/_tables.md`） | 66 组全部通过 |
| 逐文件改动清单 | 本文 §9 | 含行号 |

---

## 1. 诊断清单（按严重度排序）

严重度定义：
**P0** = 直接导致"丑"的观感，或违反无障碍硬指标，必须改；
**P1** = 系统不一致，会持续制造新的丑；
**P2** = 打磨项，改完 P0/P1 后再做。

### P0-1　一个产品三套互不相干的"黑"

| 界面 | 底色 | 色相 |
| --- | --- | --- |
| Web 状态面板 | `#18202A` | H213 |
| HTML 预览页 | `#11151C` | H222 |
| 原生悬浮窗 | `#131A21` | H202 |

三者的对比度：Web vs 预览 **1.11:1**，Web vs 悬浮窗 **1.07:1**，Web 卡片 `#212C38` vs 预览状态条 `#1B2430` **1.10:1**。
也就是说三个界面切来切去看不出是同一个产品——因为它们在明度上几乎是同一个颜色，只在色相上偷偷差 20°。
用户说的"配色怪"，第一条就是这个：**没有主色基准，每个界面各自即兴调了一个近黑**。
证据位置：`src/public/styles.css:1`（`--bg:#18202a`）、`src/public/preview.css:1`（`#11151c`）、
`scripts/native/WidgetClient.cs:106`（`#131A21`）。
修法：§4 的 `--bg-page / --bg-card / --bg-raised …` 单一阶梯，三端共用同一组十六进制值。

### P0-2　层级失效：6 / 10 个"更高层"的填充肉眼分不出来

以窗口底 `#131A21` 为基准，`WidgetClient.cs` 里 10 个深色填充的实测对比度：

| 填充 | 用在 | 与 `#131A21` 对比 | 判定 |
| --- | --- | --- | --- |
| `#16212A` | :259 heroSurface | 1.07:1 | 不可辨 |
| `#18232B` | :117 usageSurface | 1.10:1 | 不可辨 |
| `#1B252E` | :104 卡片 / :1071 任务条 | 1.13:1 | 不可辨 |
| `#1D2930` | :111 metrics 区 | 1.18:1 | 不可辨 |
| `#202A34` | :104 按钮 / :834 输入框 | 1.20:1 | 不可辨 |
| `#253B39` | :939 / :1071 | 1.47:1 | 勉强 |
| `#2B3A43` | :131 网格线 | 1.49:1 | 勉强 |
| `#303C46` | 分隔 | 1.55:1 | 勉强 |
| `#35414C` | :106 窗口描边等 15 处 | 1.68:1 | 可辨 |

深色主题的层级**本来就应该**靠小步长（1.06–1.20 是对的），错不在步长小，
错在**步长不稳定且在 1.07–1.20 里塞了 5 个不同值**——它们彼此之间的差（1.13 vs 1.18 = 1.04:1）等于没有差。
结果：卡片、按钮、输入框、任务条全都"浮"在同一个平面上，只能靠 1px 描边区分，
于是整个窗口看起来像**网格纸**而不是一个有纵深的界面。这正是"丑"的第二个来源。
修法：§7 的 6 级等步长阶梯（L\* 4.0 / 6.8 / 10.8 / 14.8 / 19.1 / 24.1），级间恒定约 4 L\*。

### P0-3　同一组堆叠里混进一个青色，色相跳 34°

`#253B39` 的色相是 **H175（青绿）**，而同窗口其余 9 个填充都是 **H202–H210（藏蓝）**。
它出现在 `WidgetClient.cs:939`、`:1071`（结果头部、任务条内部），紧邻 `#1B252E`（H207），
两者对比只有 **1.31:1**——看不清楚，但**看得出来"颜色不一样"**。
这就是那种说不清哪里脏的浑浊感：不是渐变浑浊，是**色相在同一个平面上打架**。
修法：中性色全部锁死 H228、饱和度 6–10 %（石墨灰），色相不再参与表达层级；青绿降级为纯数据序列色 `--data-2`。

### P0-4　强调色和成功色几乎是同一个颜色（语义失效）

- 薄荷绿 `#9DE5D0`（强调，17 处）vs 成功绿 `#6FBF9E`（`:356`）：色相差仅 **7.2°**，互相对比 **1.51:1**。
- 也就是说"链接/当前值"和"成功状态"在视觉上是同一个信号。用户无法从颜色判断"这是可点的"还是"这是成功的"。
- 更糟：`#9DE5D0` 同时被用作**控件边框**（`:130` `:832` `:833`）、**文字**（`:939`）、**背景填充**（`:1071`）——
  同一个色号横跨三种用途，任何一处的明度调整都会破坏另外两处。

修法：强调色改 **indigo H233**（文字 `#8593FF` / 填充 `#4A5AD6`），成功色保留在 **H152**，两者色相差 81°、对比 2.4:1。

### P0-5　两个琥珀色，差 3.4°，实际不可区分

`#EBC58D`（5 处，`:109` `:130` `:225` `:355` `:1072`）与 `#F1C778`（`:1054`），
色相差 **3.4°**、对比 **1.02:1**——这是同一个颜色的两次手滑，不是两个层级。
而且琥珀同时承担了三种语义：警告文字、数据序列、状态徽标。
修法：琥珀**只**保留给警告 `--warning`，数据序列改用紫 `--data-3`。

### P0-6　72 % 的字号 ≤ 11 px，密而碎

WPF 侧 54 处字号只有 10 个取值，其中 **39 处（72 %）≤ 11 px**：
`10px`×13、`10.5px`×5、`11px`×21；`11.5px` 只出现 1 次（`:939`）——这个半像素字号没有任何理由存在。
Web 侧 11 处 `font-size` 里 `11px` 出现 7 次。
密度本身不是错（信息面板就该密），错在**相邻层级差距太小**：10 / 10.5 / 11 / 11.5 / 12 五档挤在 2 px 内，
读者分不出主次，只能感到"密密麻麻一片小字"。
修法：§6 的 7 档阶梯 `11 / 12 / 13 / 15 / 17 / 22 / 28`，相邻比 ≥ 1.09，且**删除所有 .5 字号**。

### P0-7　零阴影、零渐变、零过渡

静态扫描结果（整个产品）：

| 特性 | WPF (`WidgetClient.cs`) | Web (`styles.css`) |
| --- | --- | --- |
| 阴影（`DropShadowEffect` / `box-shadow`） | **0** | **0** |
| 渐变（`LinearGradientBrush` / `*-gradient`） | **0** | **0** |
| 过渡（`transition`） | — | **0** |
| 悬停态（`:hover`） | — | **0** |
| 响应式（`@media`） | — | **0** |

这不是"极简"，是**没有纵深语言**：唯一能表达"浮起来"的手段是 1 px 描边，
于是 P0-2 的层级问题无解。同时 Web 端**没有任何悬停反馈**，可点的东西和不可点的东西长得一样。
修法：深色用 `--shadow-1/2/3` 三级（深色阴影靠"加黑 + 1px 内高光"而不是靠大扩散），
Web 补齐 `:hover` / `:active` / `:focus-visible` 与 120/160/240 ms 三档过渡。

### P0-8　同一个颜色既当边框、又当文字、又当图标

`#ADB8C4` 出现 **22 次**，分布在 `:114 :130 :131 :132 :133 :137 :208 :225 :243 :256 :265 :892 :905 :917 :918 :939 :940 :941 :942 :952 :1068`，
其中既做 `BorderBrush`，又做 `Foreground`，又做图标的 `Fill`。
`#F2F5F7`（19 次）同样横跨文字与背景（`:104` 按钮背景 vs `:258` 数值文字）。
**这是整个文件最难维护的地方**：调一次对比度，22 处一起变，其中一半会变错。
修法：`--border-*` / `--text-*` / `--data-*` 三族彻底分开，`#ADB8C4` 在 §9 里被拆成
`--border-strong`（边框）+ `--text-2`（标签）+ `--text-3`（注释）三个不同值。

### P0-9　`#6B7A86` 被当正文色用，对比度 3.52:1，不达 AA

`:354` 与 `:357` 是 `StateColor()` 的默认返回值和兜底返回值，`:359` 用它给"空值"上色，
`:244` 用它画状态圆点。在卡片 `#1B252E` 上实测 **3.52:1**——低于 4.5:1 的正文门槛。
同一族里还有 `#73828E`（3.93:1，`:889` 滚动条）与 `#52616D`（2.44:1）。
滚动条可以豁免，**被 `StateColor()` 返回并显示为状态文字的颜色不能**。
修法：`--text-3` 提到 5.06:1，状态文字改用 `--success/--warning/--danger`（5.4–9.5:1）。

### P0-10　`EmptyValue()` 用字号决定颜色

`WidgetClient.cs:359`：`value.FontSize >= 24 ? "#F2F5F7" : "#D9E6E9"`——
**颜色由字号推导**。这意味着任何人调大字号就会意外改变颜色语义，也让"主数值/次数值"的规则藏在数字 24 里。
修法：改成显式的 `--text-1`（主数值）/`--text-2`（次数值）传参。

### P1-1　13 种字号、61 种 `Thickness`、5 种圆角，没有比例

- 字号：Web 5 种 + WPF 10 种，去重后 **13 种**（11, 11.5, 12, 13, 14, 16, 17, 19, 22, 25, 28, 10, 10.5）。
- `Thickness`：**61 个不同值**、129 次使用。高频的是 `0`×20、`1`×15、`(4,0,0,0)`×4、`(0,2,0,0)`×4、`(0,1,0,0)`×4、`(6,2,6,2)`×3、`(0,0,0,8)`×3、`(0,0,8,0)`×3、
  其余大量一次性值（`(12,7,12,7)`×2、`(14,12,14,12)`×2…）。**1 px 和 2 px 的内边距混用**是最常见的"手工感"来源。
- `CornerRadius`：`8`×5、`10`×3、`12`×1、`2`×1、`3`×1。嵌套关系是错的：窗口 12 → 内部卡片 8 → 再内部 2/3，步长 4/6/1 不规律。

修法：4 px 网格（`--space-1..9` = 2/4/6/8/12/16/20/24/32），圆角 4 档 `3/6/10/14` 且**嵌套时内 = 外 − 间距**。

### P1-2　禁用态用滤镜，结果不可预测

`styles.css:1`（`button:disabled`）：`filter: saturate(.4) brightness(.75)`。
对深色按钮这是"变亮"，对浅色按钮是"变暗"，对强调色按钮会同时改变色相感知。
禁用态必须是**显式颜色**（`--ctl-bg-disabled` + `--text-disabled`），而不是算法。

### P1-3　焦点环在悬停背景上不够亮

Web 现有 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px }` 思路是对的，
但强调色 `#9bc8ff` 一旦放到被 hover 提亮的行背景上，对比度会掉到 3:1 以下（WCAG 2.4.11 / 2.4.13 要求非文本对比 ≥ 3:1）。
WPF 侧**完全没有焦点视觉**（`ComboBox` / `Button` 只用模板，没有 `IsKeyboardFocused` 触发器）。
修法：`--focus-ring` 单独取一档亮度，并**默认规定 2 px 环 + 2 px 偏移环**（`--focus-ring-offset` 用页面底色，保证在任意背景上都断开）。

### P1-4　HTML 预览页把白色 iframe 嵌在深色壳里

`preview.css:1` 中 `iframe{background:white}` 且 `#preview-status{background:#1b2430}` 与页面底 `#11151c` 只有 **1.17:1**。
结果是页面里最大的一块面积是刺眼的白，而唯一的"状态条"看不出是状态条。
修法：壳层用 `--bg-page` / `--bg-card`，iframe 外圈加 `--border-default` 描边 + `--shadow-2`，白底承载的是"文档内容"，靠描边和阴影把它和 chrome 分开。

### P1-5　状态色只有两档，`warn` 没进圆点

`.connection.ok .dot` / `.connection.error .dot` 有颜色，`warn` 没有对应规则（`--warn` 只用于文字）。
修法：`--success / --warning / --danger` 三档齐全，圆点用 6 px 实心 + 2 px 同色 20 % 外环（在深色底上更稳）。

### P2-1　数字与文字混排没有字体契约

`.metric strong` 用 `Consolas`，`.current-turn` 用 `12px/1.4 Consolas`，`.agent-row` 用 `11px/1.35 Consolas`，
正文却是 `'Segoe UI','Microsoft YaHei'`。Consolas 在 11 px 上偏窄偏淡，且中文与数字混排时基线不齐。
修法：`--font-mono: "Cascadia Mono", Consolas, …`，只在**纯数字/ID/代码**上使用，且最小 12 px。

### P2-2　`h1` 的 `letter-spacing:.2px` 是孤例

`styles.css:1` 里 `h1{letter-spacing:.2px}` 是全文件唯一一处字距调整，且 `.2px` 这个量级在 19 px 字号上无意义。
修法：字距只用于**大写小标签**（`--tracking-caps: .04em`），标题用 `--tracking-tight: -.01em`。

### P2-3　`h1 span` 的 14 px 灰字挂在 19 px 标题后面

层级靠"字号减 5 px + 变灰"实现，但 14 px 与正文 13 px 只差 1 px，读起来像被压扁的副标题。
修法：`--text-md`(15) 正文 + `--text-xl`(22) 标题，副标题用 `--text-3` 而不是靠字号。

### P2-4　`.agents` 固定 60 px 高 + 11 px 等宽

`styles.css:8-9`：`max-height:60px`、`font:11px/1.35 Consolas`、`white-space:nowrap` + 省略号。
60 px 里最多放 4 行，且每行都被截断。修法：`max-height` 提到 3 行 × `--text-xs` 行高（约 72 px），保留省略号但整行可 `title` 悬停显示全文。

---

## 2. 设计方向（为什么是这套值）

1. **中性色不参与表达。** 所有灰锁在 H228 / S6–10 %。层级只由明度表达，色相只在语义处出现。
   旧版之所以"浑浊"，是因为中性色自己带色相（H202 藏蓝 vs H175 青绿），眼睛一直在判断"这两个是不同颜色吗"。
2. **层级用等步长，不用等比。** 深色 UI 的感知是非线性的：L\* 每 +4 大约是 1.06–1.18:1 的对比，
   正好是"能分辨但不刺眼"的量。旧版在 1.07–1.20 里塞了 5 个值，等于把可用的一档切成五份无效档。
3. **一个色相只做一件事。** indigo = 可交互（链接/焦点/选中/主按钮）；teal = 数据；amber = 警告；绿 = 成功；红 = 错误。
   旧版薄荷绿同时是链接、边框、数据、成功邻居，导致颜色失去指示能力。
4. **填充色和文字色是两套。** `--accent`(#8593FF) 用于文字/图标，`--accent-fill`(#4A5AD6) 用于按钮底。
   一个颜色不可能同时在深底上做可读文字、又承载白字——旧版试图用 `#9DE5D0` 一色通吃，两边都不达标。
5. **深色主题的阴影靠"加深 + 1 px 亮边"，浅色主题的阴影靠"柔化 + 扩散"。** 两套 `--shadow-*` 值不同，这是必须的，不是重复。
6. **密度不等于小字号。** 保留 11 px 给最次要的注释，但正文从 13 提到 15，数值从 17/28 提到 17/28 但**字重与字距**参与层级（SemiBold + `-.01em`）。

---

## 3. 色板结构（三层）

```
原始色（ramp）        →   语义 token            →   组件
n950 … n100 (灰)           --bg-page/card/…          .panel  .metric  .case
a700 … a100 (indigo)       --accent/-fill/…          button.primary  a  summary
ok/warn/err 400-600        --success/warning/danger  .dot  .message  StateColor()
d1/d2/d3 (数据)            --data-1/2/3              .usageProgress  图表
```

组件**只能**引用语义层。原始 ramp 只出现在 `tokens.css` 与 `WidgetTheme.cs` 里。
深色与浅色是**两张各自完整的语义表**（不是一套值加 `filter: invert`），因为浅色主题需要
更暗的强调色、更弱的边框、更强的阴影——这些无法由深色推导。

---

## 4. 设计 Token 表

> 唯一真源：`src/public/tokens.css`（Web）与 `docs/ui-redesign/WidgetTheme.cs`（WPF）。
> 两份由同一脚本 `Temp/ui-audit/emit.py` 生成，数值保证一致，改一处重跑即可。

### 4.1 表面（Surface）

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--bg-inset` | `#0E0F11` | `#F1F2F6` | 图表底、进度槽、禁用填充（比页面更深/更暗） |
| `--bg-page` | `#141518` | `#F7F8FA` | 窗口/页面底 |
| `--bg-card` | `#1C1D21` | `#FFFFFF` | 卡片、面板、分组 |
| `--bg-raised` | `#24252A` | `#FFFFFF` | 输入框、可选中的块（浅色靠边框与阴影区分） |
| `--bg-hover` | `#2D2E34` | `#F1F2F6` | 悬停底 |
| `--bg-active` | `#373941` | `#EEEFF4` | 按下/选中底 |
| `--bg-inverse` | `#EDEEF2` | `#181B25` | tooltip、反色徽标 |

深色阶梯与 `--bg-page` 的对比依次为 **1.05 / 1.00 / 1.08 / 1.19 / 1.35 / 1.59**：
前三级刻意只在 1.05–1.08（"几乎同一个平面，只有一条边界"），后三级拉开到 1.19–1.59（真正的悬浮与按下）。
旧版的问题正是把 5 个不同的值塞进 1.07–1.20 这一段——等于把"一档"切成五份。

### 4.2 描边（Border）

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--border-subtle` | `#373941` | `#E8EAEF` | 装饰性分隔线、表格行线 |
| `--border-default` | `#3F414B` | `#CBCED8` | 卡片描边、分组边界 |
| `--border-strong` | `#6F7485` | `#878CA1` | 输入框边框、可交互边界（3.62 / 3.34:1，满足 1.4.11） |

### 4.3 文字（Text）

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--text-1` | `#EDEEF2` | `#181B25` | 正文、数值、标题 |
| `--text-2` | `#B0B3BF` | `#4E515F` | 标签、次要说明 |
| `--text-3` | `#9A9EAC` | `#676B79` | 注释、轴标签、占位符 |
| `--text-disabled` | `#636674` | `#9699A6` | 禁用文字（WCAG 豁免，仅需可辨） |
| `--text-on-accent` | `#FFFFFF` | `#FFFFFF` | 主按钮文字 |
| `--text-on-inverse` | `#141518` | `#F7F8FA` | tooltip 文字 |

### 4.4 强调（Accent，indigo H233）

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--accent` | `#8593FF` | `#2637BA` | 链接、图标、选中态文字、当前值 |
| `--accent-hover` | `#B2BBFF` | `#1C2887` | 链接悬停（深色变亮、浅色变暗） |
| `--accent-active` | `#D6DBFF` | `#151E66` | 链接按下 |
| `--accent-subtle` | `#2B2E40` | `#EEEFF9` | 选中行底、选中菜单底 |
| `--accent-fill` | `#4A5AD6` | `#3043CF` | 主按钮底 |
| `--accent-fill-hover` | `#5869E4` | `#2637BA` | 主按钮悬停 |
| `--accent-fill-active` | `#394AD0` | `#1C2887` | 主按钮按下 |
| `--accent-on-fill` | `#FFFFFF` | `#FFFFFF` | 主按钮文字（白字在三级填充上都 ≥4.6:1） |

**关键区别**：`--accent` 是"文字色"，`--accent-fill` 是"填充色"。深色主题里前者亮（6.11:1 可读）、后者暗（白字 5.64:1 可读）。
旧版用一个 `#9DE5D0` 同时做这两件事，所以要么文字太浅、要么按钮上的白字不可读。

### 4.5 状态（Status）

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--success` | `#69D3A2` | `#1E714A` | 成功文字/图标（9.17 / 5.97） |
| `--success-subtle` | `#273633` | `#EDF4F1` | 成功提示底 |
| `--warning` | `#F8B659` | `#8E4C0B` | 警告文字/图标（9.48 / 6.59） |
| `--warning-subtle` | `#3B3229` | `#F6F1EB` | 警告提示底 |
| `--danger` | `#FA8088` | `#AB212A` | 错误文字/图标（6.82 / 7.04） |
| `--danger-subtle` | `#3B2B2F` | `#F8EDEE` | 错误提示底 |

### 4.6 数据与图表（Data）

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--data-1` | `#8F9CFF` | `#2D3EBE` | 输入量序列（indigo 系，但与文字强调色不同亮度） |
| `--data-2` | `#49D4C6` | `#1A7F75` | 输出量序列（青，**唯一**保留青色的位置） |
| `--data-3` | `#C08DE2` | `#7636A1` | 第三序列（紫） |
| `--chart-grid` | `#373941` | `#DDE0E9` | 网格线（装饰性，≥1.2 即可） |
| `--chart-track` | `#24252A` | `#F1F2F6` | 柱/进度槽底 |

### 4.7 焦点与反色

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--focus-ring` | `#8593FF` | `#3043CF` | 聚焦环（6.11 / 7.42，在悬停底上仍 ≥5） |
| `--focus-ring-offset` | `#141518` | `#FFFFFF` | 环外断开层，任何背景上都能看清 |
| `--focus-ring-w` | `2px` | `2px` | 环宽 |
| `--focus-ring-offset-w` | `2px` | `2px` | 偏移 |

---

## 5. 对比度实测（66 组断言全部通过）

要求列：正文/标签 ≥4.5，图形对象与控件边界 ≥3.0（WCAG 1.4.11），禁用态豁免（仅记录）。
完整 66 组见 `Temp/ui-audit/_tables.md`，可执行 `python Temp/ui-audit/emit.py` 复现。

| 元素 | Token 对 | 深色 | 浅色 | 要求 |
| --- | --- | --- | --- | --- |
| 正文 / 页面 | `--text-1` on `--bg-page` | **15.75** | **16.17** | ≥4.5 |
| 正文 / 卡片 | `--text-1` on `--bg-card` | **14.52** | **17.18** | ≥4.5 |
| 正文 / 悬停行 | `--text-1` on `--bg-hover` | **11.67** | **15.36** | ≥4.5 |
| 标签 / 卡片 | `--text-2` on `--bg-card` | **8.06** | **7.88** | ≥4.5 |
| 注释 / 卡片 | `--text-3` on `--bg-card` | **6.30** | **5.31** | ≥4.5 |
| 注释 / 悬停行 | `--text-3` on `--bg-hover` | **5.06** | **4.75** | ≥4.5 |
| 禁用文字 | `--text-disabled` on `--bg-card` | **2.95** | **2.84** | 豁免 |
| 链接 | `--accent` on `--bg-card` | **6.11** | **8.98** | ≥4.5 |
| 链接 / 页面 | `--accent` on `--bg-page` | **6.62** | **8.45** | ≥4.5 |
| 选中行文字 | `--accent` on `--accent-subtle` | **4.86** | **7.85** | ≥4.5 |
| 主按钮文字 | `--text-on-accent` on `--accent-fill` | **5.64** | **7.42** | ≥4.5 |
| 主按钮 hover | `--text-on-accent` on `--accent-fill-hover` | **4.61** | **8.98** | ≥4.5 |
| 主按钮 active | `--text-on-accent` on `--accent-fill-active` | **6.85** | **12.33** | ≥4.5 |
| 成功文字 | `--success` on `--bg-card` | **9.17** | **5.97** | ≥4.5 |
| 警告文字 | `--warning` on `--bg-card` | **9.48** | **6.59** | ≥4.5 |
| 错误文字 | `--danger` on `--bg-card` | **6.82** | **7.04** | ≥4.5 |
| 错误提示底 | `--danger` on `--danger-subtle` | **5.41** | **6.15** | ≥4.5 |
| tooltip | `--text-on-inverse` on `--bg-inverse` | **15.75** | **16.17** | ≥4.5 |
| 数据序列 1 | `--data-1` on `--bg-inset` | **7.64** | **7.38** | ≥3.0 |
| 数据序列 2 | `--data-2` on `--bg-inset` | **10.52** | **4.33** | ≥3.0 |
| 数据序列 3 | `--data-3` on `--bg-inset` | **7.44** | **6.67** | ≥3.0 |
| 输入框边界 | `--border-strong` on `--bg-card` | **3.62** | **3.34** | ≥3.0 |
| 聚焦环 | `--focus-ring` on `--bg-card` | **6.11** | **7.42** | ≥3.0 |

最紧的三处（设计上刻意压到底线，但仍有余量）：深色主按钮 hover 文字 4.61、深色"选中行上的强调文字" 4.86、深色注释在悬停行上 5.06。
如果后续有人把 `--accent-fill-hover` 再调亮 1 档，白字就会跌破 4.5——`emit.py` 的断言会直接失败，这是刻意的护栏。

---

## 6. 字体与字号阶梯

| Token | 尺寸 | 行高 | 字重 | 字距 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `--text-2xs` | 11 px | 1.45 | 400 | 0 | 轴标签、脚注、`.agent-row` |
| `--text-xs` | 12 px | 1.5 | 400/500 | 0 | 次要说明、`.message`、`.case-state` |
| `--text-sm` | 13 px | 1.5 | 400 | 0 | 表单标签、`h2`、正文小号 |
| `--text-md` | 15 px | 1.5 | 400 | 0 | **正文基准**、`select`/`button` |
| `--text-lg` | 17 px | 1.35 | 500 | 0 | 单元格数值、`.metric strong` 的次值 |
| `--text-xl` | 22 px | 1.2 | 600 | -.01em | 对话框标题、`h1` |
| `--text-2xl` | 28 px | 1.1 | 600 | -.01em | 主数值（`.metric.accent strong`、total） |

字体族：

```css
--font-ui:   "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
--font-mono: "Cascadia Mono", Consolas, "Courier New", monospace;
```

规则：
- **等宽只用于纯数字、ID、代码片段**，最小 12 px；中文绝不进等宽。
- 字重只用 **400 / 500 / 600** 三档（旧版 9 处 SemiBold 与 2 处 Medium 混用且与字号不匹配）。
- 字距只在**大写小标签**上用 `--tracking-caps: .04em`，标题用 `--tracking-tight: -.01em`，正文 0。
- 删除所有 `.5` 字号（旧版有 `10.5px`×5、`11.5px`×1）。

与旧版的映射（迁移时照此替换）：

| 旧值 | 出现次数 | 新值 |
| --- | --- | --- |
| 10 px | 13 | `--text-2xs`（11）或 `--text-xs`（12），视是否正文 |
| 10.5 px | 5 | `--text-xs`（12） |
| 11 px | 21 | `--text-2xs`（11，注释）/ `--text-sm`（13，正文/控件） |
| 11.5 px | 1 | `--text-xs`（12） |
| 12 px | 5 | `--text-xs`（12）或 `--text-sm`（13） |
| 13 px | Web 正文 | `--text-md`（15） |
| 14 px | 3 | `--text-md`（15） |
| 16 px | 2 | `--text-lg`（17） |
| 17 px | 2 | `--text-lg`（17） |
| 19 px（Web h1） | 1 | `--text-xl`（22） |
| 22 / 25 / 28 | 3 | `--text-xl`（22）/ `--text-2xl`（28） |

---

## 7. 间距、圆角、阴影、动效

### 7.1 间距（4 px 网格）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--space-1` | 2 px | 图标与文字、行内微调 |
| `--space-2` | 4 px | 标签与控件之间 |
| `--space-3` | 6 px | 紧凑行内间距 |
| `--space-4` | 8 px | 组件内部（按钮上下、卡片内小节） |
| `--space-5` | 12 px | 卡片内边距、网格间隙 |
| `--space-6` | 16 px | 区块之间 |
| `--space-7` | 20 px | 分组之间 |
| `--space-8` | 24 px | 主区块之间 |
| `--space-9` | 32 px | 页面级留白 |

旧版 `Thickness` 有 61 个不同值、其中 `1` 用了 15 次、`0` 用了 20 次。
**`1 px` 内边距全部升到 `--space-1`(2) 或 `--space-2`(4)**：1 px 是"手工微调"的痕迹，在 96 dpi 上极不稳定。

### 7.2 圆角

| Token | 值 | 用途 |
| --- | --- | --- |
| `--radius-xs` | 3 px | 徽标、标签、6 px 圆点容器 |
| `--radius-sm` | 6 px | 输入框、按钮、小卡片 |
| `--radius-md` | 10 px | 面板、卡片、弹层 |
| `--radius-lg` | 14 px | 窗口外壳、对话框 |
| `--radius-full` | 999 px | 药丸徽标、圆点 |

嵌套规则：**内层 = 外层 − 内边距**。窗口 14 + 内边距 12 → 内层 2（用 `--radius-xs` 3 已足够），
旧版窗口 12 → 卡片 8 → 内部 2/3，步长 4/6/1，看起来"圆角乱跳"。

### 7.3 阴影（三级）

深色（靠"加深 + 1 px 内高光"，不用大扩散）：

```css
--shadow-1: 0 1px 2px rgb(0 0 0 / .32);
--shadow-2: 0 6px 16px -4px rgb(0 0 0 / .55), 0 0 0 1px rgb(255 255 255 / .04);
--shadow-3: 0 18px 48px -12px rgb(0 0 0 / .72), 0 0 0 1px rgb(255 255 255 / .06);
```

浅色（靠"柔化 + 扩散"，颜色带一点蓝避免灰脏）：

```css
--shadow-1: 0 1px 2px rgb(16 24 40 / .06);
--shadow-2: 0 6px 16px -4px rgb(16 24 40 / .12), 0 0 0 1px rgb(16 24 40 / .04);
--shadow-3: 0 18px 48px -12px rgb(16 24 40 / .20), 0 0 0 1px rgb(16 24 40 / .06);
```

用法：`--shadow-1` 卡片/表格行；`--shadow-2` 下拉、弹层、任务条；`--shadow-3` 对话框、tooltip。
**不要**给静态卡片加 hover 阴影抬升又同时改 `translateY`（旧版 `styles.css` 里 `.card:hover` 就是这么写的），
深色主题里这两者叠加会让卡片"抖动"。

WPF 对应物：`DropShadowEffect { ShadowDepth = 0, BlurRadius = 12, Opacity = 0.45, Color = Black }`
（深色主题下用 `BlurRadius` 12/24/40 三档，`Opacity` 0.45/0.55/0.7）。旧版 `DropShadowEffect` 出现 **0 次**。

### 7.4 动效

| Token | 值 | 用途 |
| --- | --- | --- |
| `--dur-fast` | 120 ms | 颜色/背景（hover） |
| `--dur-base` | 160 ms | 展开、位移 |
| `--dur-slow` | 240 ms | 弹层进出 |
| `--ease-standard` | `cubic-bezier(.2,0,0,1)` | 进入 |
| `--ease-exit` | `cubic-bezier(.4,0,.2,1)` | 退出 |

`@media (prefers-reduced-motion: reduce)` 下全部归零（已写入 `tokens.css:166`）。
**只过渡 `background-color` / `border-color` / `color` / `box-shadow` / `opacity`**，
不要 `transition: all`（旧版没有过渡，属于"零反馈"，同样不可取）。

### 7.5 控件尺寸与命中区

| Token | 值 | 说明 |
| --- | --- | --- |
| `--control-h-sm` | 24 px | 图标按钮、`.task-bar button` |
| `--control-h` | 30 px | 输入框、下拉、普通按钮 |
| `--control-h-lg` | 34 px | 主操作按钮 |

WCAG 2.5.5（AAA）要求 44×44，2.5.8（AA）要求 24×24。桌面悬浮窗用 30 px 高是合理的，
但**相邻控件的间隙必须 ≥ 4 px**，且图标按钮的实际命中区用透明外扩补到 24×24（`::before` 绝对定位）。

---

## 8. 组件状态矩阵

所有状态都只引用 §4 的 token，不允许出现字面值。

### 8.1 主按钮（`.primary` / WPF Button 模板）

| 状态 | 背景 | 文字 | 边框 | 其他 |
| --- | --- | --- | --- | --- |
| default | `--accent-fill` | `--accent-on-fill` | 无 | `--shadow-1` |
| hover | `--accent-fill-hover` | 同 | 无 | `--shadow-1`，`--dur-fast` |
| active | `--accent-fill-active` | 同 | 无 | 内阴影 `inset 0 1px 2px rgb(0 0 0/.3)` |
| focus-visible | 同 default | 同 | 无 | `0 0 0 2px --focus-ring-offset, 0 0 0 4px --focus-ring` |
| disabled | `--bg-inset` | `--text-disabled` | `--border-subtle` | 无阴影，`cursor: not-allowed` |

### 8.2 次按钮（`.secondary`）

| 状态 | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| default | `--bg-raised` | `--text-1` | `--border-strong` |
| hover | `--bg-hover` | `--text-1` | `--accent` |
| active | `--bg-active` | `--text-1` | `--accent` |
| focus-visible | 同 default | 同 | 双环 |
| disabled | `--bg-inset` | `--text-disabled` | `--border-subtle` |

### 8.3 输入框 / 下拉（`select`、`ComboBox`、`TextBox`）

| 状态 | 背景 | 文字 | 边框 | 其他 |
| --- | --- | --- | --- | --- |
| default | `--ctl-bg` | `--text-1` | `--border-strong` | 占位符 `--text-3` |
| hover | `--ctl-bg` | 同 | `--accent` | |
| focus | `--ctl-bg` | 同 | `--accent` | 双环 + `box-shadow: inset 0 0 0 1px --accent` |
| invalid | `--ctl-bg` | 同 | `--danger` | 下方 `--text-xs --danger` 说明 |
| disabled | `--bg-inset` | `--text-disabled` | `--border-subtle` | |

### 8.4 行 / 列表项 / `.case`

| 状态 | 背景 | 文字 |
| --- | --- | --- |
| default | transparent | `--text-1` |
| hover | `--bg-hover` | `--text-1` |
| selected | `--accent-subtle` | `--text-1`（6.30:1 以上），左侧 2 px `--accent` 竖条 |
| focus-visible | hover + 双环 | 同 |

### 8.5 状态徽标 / `.dot`

`6 px` 实心圆 + `2 px` 同色 20 % 外环（深色底上这圈外环比纯色更稳）：

| 状态 | 圆点 | 外环 | 文字 |
| --- | --- | --- | --- |
| ok / 连接正常 | `--success` | `color-mix(in srgb, --success 22%, transparent)` | `--text-2` |
| warn / 进行中 | `--warning` | 同法 | `--text-2` |
| error / 断开 | `--danger` | 同法 | `--danger` |
| idle / 未连接 | `--text-disabled` | 无 | `--text-3` |

旧版只有 `ok` / `error` 两档，且 `.dot` 是 6×6 纯色无外环，在 `#1B252E` 上边界不清。

### 8.6 链接与可交互文字

| 状态 | 颜色 | 装饰 |
| --- | --- | --- |
| default | `--accent` | none |
| hover | `--accent-hover` | underline（`text-underline-offset: 2px`） |
| active | `--accent-active` | underline |
| visited | `--accent`（**不另设色**，产品内链不需要区分） | none |
| focus-visible | `--accent` | 双环 |

---

## 9. 逐文件改动清单

### 9.0 总览

| 文件 | 改动性质 | 风险 | 前置 |
| --- | --- | --- | --- |
| `src/public/tokens.css` | **新增**（已生成） | 无 | — |
| `docs/ui-redesign/WidgetTheme.cs` | **新增**（已生成，含 Brush/Pen/Shadow 助手） | 无 | 编译时加入 Add-Type 列表 |
| `docs/ui-redesign/proposed-styles.css` | **新增**（待应用） | 低 | 替换 `styles.css` L1+L3–L10 |
| `docs/ui-redesign/proposed-preview.css` | **新增**（待应用） | 低 | 替换 `preview.css` L1 |
| `src/public/index.html` | 改 1 行（L3 前插 1 行） | 无 | — |
| `src/public/preview.html` | 改 L2（插 1 个 `<link>`） | 无 | 顺序敏感，见 9.4 |
| `scripts/native/WidgetClient.cs` | 改约 130 处字面值 + 若干字号 | **中**（自检断言） | 分层实施，见 §10 |
| `scripts/native-widget.ps1` | 改 L9（文件列表加 1 项） | 低 | 仅用 WidgetTheme.cs 时 |
| `tests/*` | **不动** | — | 断言即验收标准 |

`src/public/app.js`、`preview.js`、`preview-frame.js` 无需改动：已核验它们不写任何颜色或内联样式。

---

### 9.1 `src/public/styles.css` — 整体替换

现状：10 行，其中 **L1 是 3,575 字符的压缩单行**，承载全部组件规则；L3–L10 是后续追加的补充规则。

改动：用 `docs/ui-redesign/proposed-styles.css` 全文替换。**选择器一个不改**，只改声明值，
所以 `app.js` 依赖的 `#task-select` / `#run` / `.hidden` / `.primary` / `.metric.accent` 全部继续工作。

因为 L1 是单行，无法给"行号"，下表用 `.temp-styles-readable.css`（L1 的可读展开，一行一条规则）
定位。应用后建议直接删除 `.temp-styles-readable.css`。

#### L1 展开后逐条映射（`.temp-styles-readable.css` 行号 → 新值）

| 行 | 选择器 | 旧声明 | 改为 |
| --- | --- | --- | --- |
| L3 | `body` | `font:13px/1.45 'Segoe UI','Microsoft YaHei'` | `font-size: var(--text-md)`(15) `+ var(--font-ui)`、`background: var(--bg-page)`、`color: var(--text-1)` |
| L4 | `.shell` | `max-width:540px;padding:12px` | `560px` / `padding: var(--space-6)` |
| L5 | `.topbar,.section-head` | `gap:10px` | `gap: var(--space-4)` + `align-items:center` |
| L6 | `.topbar` | `margin-bottom:10px` | `var(--space-6)` + `justify-content:space-between` |
| L8 | `h1` | `font-size:19px;letter-spacing:.2px` | `var(--text-xl)`(22) `+ var(--tracking-tight)` |
| L9 | `h1 span` | `font-size:14px;color:var(--muted)` | `var(--text-sm)`(13) `+ var(--text-3)` |
| L10 | `h2` | `font-size:13px` | `var(--text-sm)`(13) `+ var(--text-2)` + 大写 + `--tracking-caps` |
| L11 | `.connection,.state-badge` | `font-size:11px;color:var(--muted)` | `var(--text-xs)`(12) `+ var(--text-2)` |
| L12 | `.dot` | `6×6;background:var(--muted)` | `7×7` + `--text-disabled` + 过渡 |
| L13 | `.connection.ok .dot` | `background:var(--accent)` | `var(--success)` + 外环 `var(--success-subtle)` |
| L14 | `.connection.error .dot` | `background:var(--danger)` | 保留 + 外环 `var(--danger-subtle)`；**新增** `.connection.loading .dot` → `--warning` |
| L15 | `.panel` | `bg var(--panel);border 1px var(--line);radius:10px;padding:12px`（**无阴影**） | `--bg-card` + `1px var(--border-default)` + `--radius-md` + `--space-5` + **`var(--shadow-1)`** |
| L17 | `.metrics` | `gap:1px;background:var(--line)`（用缝隙冒充分割线） | `gap: var(--space-4)`，删除容器背景 |
| L18 | `.metric` | `background:var(--panel);padding:8px 12px` | `--bg-raised` + `1px var(--border-subtle)` + `--radius-sm` + `--space-4 --space-5` |
| L19 | `.metric span` | `font-size:11px;color:var(--muted)` | `var(--text-2xs)`(11) `+ var(--text-3)` + 大写 |
| L20 | `.metric strong` | `font:600 25px/1.25 Consolas` | `var(--text-2xl)`(28) `+ var(--font-mono)` + `tabular-nums` |
| L23 | `summary/button/select/a:focus-visible` | `outline:2px solid var(--accent);offset:3px` | 双环 `box-shadow`（内 `--focus-ring-offset` 外 `--focus-ring`），见 §8.6 |
| L24 | `.session-details` | `font-size:11px` | `var(--text-xs)` |
| L26 | `.benchmark` | `margin-top:8px` | `var(--space-6)` |
| L28–L29 | `summary` 的 ▸/▾ 标记 | 两个**不同字符**、独立着色 | 统一 `::before` + `rotate(90deg)` 过渡 |
| L30 | `.muted,.message` | `font-size:12px;color:var(--muted)` | `var(--text-xs)` `+ var(--text-3)` |
| L32 | `.message.error` | 仅改文字色 | 加 `--danger-subtle` 底 + `--danger` 32% 描边 |
| L33 | `.message.warn` | 仅改文字色 | 加 `--warning-subtle` 底 + 描边 |
| L34 | `.prompt` | `12px/1.5 Consolas` | `var(--text-xs)` `+ --font-mono` + `--bg-inset` + 描边 + `padding` |
| L36 | `.controls` | `gap:8px;margin-top:12px` | `var(--space-4) var(--space-5)` / `var(--space-6)` |
| L37 | `label` | `font-size:11px;color:var(--muted)` | `var(--text-2xs)` `+ var(--text-3)` + 大写 |
| L38 | `select,button` | `height:32px;border:1px solid var(--line);background:var(--bg);font:12px` | `--control-h`(30) / `--ctl-border` / `--ctl-bg` / `var(--text-sm)`(13) |
| L40 | `button:disabled` | `filter:saturate(.4) brightness(.75)` | **删除 filter**，改 `--ctl-bg-disabled` + `--ctl-text-disabled` + `--border-subtle` |
| L41 | `.primary` | `background:var(--accent);color:#16283d` | `--accent-fill` + `--accent-on-fill`(白) + `--shadow-1`；hover/active 三档 |
| L49 | `.svg-preview` | `background:#fff;radius:5px`（无描边） | 保留白 + `1px var(--border-default)` + `--radius-sm` |
| L50 | `.score-grid,.comparison-grid` | `gap:6px` | 保留 3 列；`gap: var(--space-3)` |
| L54 | `.comparison-item strong` | `display:block;color:var(--text)` | `+ font-weight:600` |

新增（旧版缺失）：`.secondary`（`index.html` L7/L14 已在用这个类，但样式表里没有定义——
现在只是一个裸 `<button>`，与 `.primary` 只差背景色，**这是 L7 按钮看起来"没做完"的直接原因**）。

#### L3–L10 补充规则映射

| 行 | 选择器 | 旧 | 新 |
| --- | --- | --- | --- |
| L3 | `.html-preview-link` | `padding:8px;radius:5px` | `--space-4` / `--radius-sm` / `--bg-raised` / `--border-default` / 悬停态 |
| L4 | `.task-bar` | `gap:8px;margin-top:8px` | `var(--space-4)` / `var(--space-4)` |
| L5 | `.task-bar button` | `padding:0 14px` | `height:var(--control-h-sm)` / `padding:0 var(--space-6)` |
| L6 | `.task-title` | `font-weight:600`（无字号） | `+ var(--text-sm)` |
| L7 | `.current-turn` | `color:var(--accent);font:12px/1.4 Consolas` | `--text-2` + 左侧 2 px `--accent` 竖条（降权，见 §1 P2-3） |
| L8 | `.agents` | `max-height:60px` | `72px` + `--border-subtle` |
| L9 | `.agent-row` | `color:var(--muted);font:11px/1.35 Consolas` | `--text-3` + `var(--text-2xs)` + 悬停 `--row-hover` |
| L10 | `.diagnostics` | `font-size:11px` | `var(--text-2xs)` `+ --text-3` |

---

### 9.2 `src/public/preview.css` — 整体替换

现状：**1 行**，含 `background:#11151c`、`color:#e6edf5`、`#1b2430`、`color-scheme:dark` 四个硬编码值，
与主面板 `#18202a` / `#212c38` 完全无关（两者互比 1.11:1，肉眼可辨是"两个产品"）。

改动：用 `docs/ui-redesign/proposed-preview.css` 全文替换。要点：

| 位置 | 旧 | 新 |
| --- | --- | --- |
| `:root` | `color-scheme:dark;background:#11151c;color:#e6edf5;font:14px/1.6 system-ui` | 删除 `color-scheme`（交给 tokens.css），其余改 `var(--bg-page)` / `var(--text-1)` / `var(--text-md)` / `var(--font-ui)` |
| `main` | `max-width:1000px;padding:24px` | `1080px` + `var(--space-8) var(--space-6) var(--space-9)` |
| `h1` | `font-size:22px` | `var(--text-xl)` |
| `#preview-status` | `padding:12px;background:#1b2430`（比页面亮 1.17:1，既不像提示也不像卡片） | 卡片底 + 左边框 3 px 状态色；新增 `[data-state=ok/warn/error]` 三态 |
| `button` | `padding:8px 16px`（无边框无背景） | 完整控件规格 + hover + focus-visible 双环 |
| `iframe` | `background:white`（无描边） | 保留白 + `1px var(--border-default)` + `--radius-md` + `--shadow-2` |
| `pre` | 无视觉容器 | `--bg-inset` + 描边 + `--font-mono` + `var(--text-xs)` |
| 新增 | — | `summary` 展开标记、`[hidden]{display:none!important}`、`details` 分隔线 |

`preview.js` 会切换 `#preview-status` 的文本与 `#preview-retry` 的 `hidden` 属性，都靠类名/属性选择器，
不用改 JS。若要让状态条变色，`preview.js` 需在某处补 `status.dataset.state = "ok"|"warn"|"error"`
（一处赋值，不影响逻辑）——这一步可选，不补则一直显示中性灰。

---

### 9.3 `src/public/index.html` — 插入 token 链接

```diff
- L3:  <link rel="stylesheet" href="/styles.css">
+ L3:  <link rel="stylesheet" href="/tokens.css">
+ L4:  <link rel="stylesheet" href="/styles.css">
```

**顺序必须是 `tokens.css` → `styles.css`**。CSS 变量在运行期解析，顺序不影响 `var()` 求值结果，
但把 token 放前面有两个实际好处：`styles.css` 里任何拼错的变量名会立刻计算为空值从而暴露，
而不是被后面加载的 token 文件"救回来"；调试时逐行看计算值也更符合阅读顺序。

若要做浅色主题切换，在 `<html>` 上加 `data-theme="light"` 即可（`tokens.css:103` 已备好选择器）；
建议由 `app.js` 早期读取 `localStorage.theme` 并写 `document.documentElement.dataset.theme`，
在首屏渲染前执行以免闪烁（`index.html` L16 的 `<script type="module">` 若是 `defer` 语义，
首帧可能已绘制——稳妥做法是在 `<head>` 内联 3 行同步脚本设置 `data-theme`）。

---

### 9.4 `src/public/preview.html` — 插入 token 链接（顺序敏感）

L2 是整页压缩单行：

```diff
- <link rel="stylesheet" href="/preview.css">
+ <link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/preview.css">
```

与 9.3 不同，这里 **`preview.css` 必须后置**：它用 `var(--bg-page)` 等覆盖 `:root` 的
`background`/`font`，若在 token 之前加载，虽然 `var()` 仍会解析，但 `preview.css` 里
`:root{font-size:var(--text-md)}` 这类**依赖前面文件已定义变量**的写法在 DevTools 里会先报一轮
"invalid property value"红字（求值顺序无关，报错顺序有关），调试时很吵。

---

### 9.5 `scripts/native/WidgetClient.cs` — 130 处字面值 + 字号

这是改动量最大、也是用户"丑"感受的主要来源（WPF 悬浮窗，占屏幕时间最长）。

#### 9.5.1 颜色：28 个不同 hex → 20 个 token

按"旧值 → 新值"聚合，行号是该 hex 出现的**全部位置**（脚本 `Temp/ui-audit/inv_cs.py` 可复现）：

| 旧值 | 出现次数 | 行号 | 语义（实测发现） | 新值 |
| --- | --- | --- | --- | --- |
| `#131A21` | 7 | 106,148,155,923,935,942,943 | 窗口/对话框底 | `WidgetTheme.Page` `#141518` |
| `#1B252E` | 9 | 104,832,832,833,833,889,941,943,1071 | 卡片/浮层底 | `WidgetTheme.Card` `#1C1D21` |
| `#202A34` | 4 | 104,834,835,1071 | 输入控件底 | `WidgetTheme.Raised` `#24252A` |
| `#18232B` | 1 | 117 | 用量图底（比卡片更暗） | `WidgetTheme.Inset` `#0E0F11` |
| `#1D2930` | 1 | 111 | 指标网格容器底 | `WidgetTheme.Inset` `#0E0F11` |
| `#16212A` | 1 | 259 | hero 数值块底 | `WidgetTheme.Card` `#1C1D21` |
| `#253B39` | 2 | 939,1071 | 任务条底（**H175 青，比邻居偏 34°**） | `WidgetTheme.Card` `#1C1D21` |
| `#35414C` | 15 | 边界用全部位置 | 通用描边 | `WidgetTheme.BorderDefault` `#3F414B` |
| `#2C3A44` | 1 | 259 | hero 描边 | `WidgetTheme.BorderSubtle` `#373941` |
| `#303C46` | 2 | — | 次级描边 | `WidgetTheme.BorderSubtle` `#373941` |
| `#2B3A43` | 1 | 131 | 图表网格线 | `WidgetTheme.ChartGrid` `#373941` |
| `#94A2AF` | 4 | 104,832,832,833 | **控件边框**（对比 5.96，当边框太亮） | `WidgetTheme.BorderStrong` `#6F7485` |
| `#405A55` | 2 | 939,1071 | 任务条描边（青调） | `WidgetTheme.BorderSubtle` `#373941` |
| `#293E54` / `#294C51` | 各 1 | 833 | 下拉悬浮底（**两套蓝绿不一致**） | `WidgetTheme.Hover` `#2D2E34` |
| `#ADB8C4` | **22** | 114,130,131,132,133,137,208,225,243,256,265,892,905,917,918,939,940,941,942,952,1068 | **同时充当边框、正文、图标三职** | 文字→`Text3` `#9A9EAC`；边框→`BorderDefault`；图标→`Text3` |
| `#D9E6E9` | 4 | 114,114,240,359 | 状态文字 | `WidgetTheme.Text2` `#B0B3BF` |
| `#E6EDF4` | 1 | 103 | `Text()` 助手硬编码前景 | `WidgetTheme.Text1` `#EDEEF2` |
| `#F2F5F7` | **19** | 104,105,107,124,143,155,224,258,266,359,833×3,834,835,924,935,941,1071 | **文字 + 背景双职**（`833`/`835` 是背景） | 文字→`Text1`；背景→`Card`/`Raised` |
| `#6B7A86` | 4 | 244,354,357,359 | 空值/未知状态（**3.52:1 不达 AA**） | `TextDisabled` `#636674`（圆点）/ `Text3`（文字） |
| `#9DE5D0` | **17** | 104,126,130,155,155,208,225,832,832,833,833,890,890,939,942,942,1071 | 薄荷色，**同时是强调文字、滑块、选中底、图标** | 文字/图标→`Accent` `#8593FF`；填充→`AccentFill` `#4A5AD6`；底→`AccentSubtle` `#2B2E40` |
| `#6FBF9E` | 1 | 356 | 成功（**与 `#9DE5D0` 仅差 7.2°**） | `WidgetTheme.Success` `#69D3A2` |
| `#EBC58D` / `#F1C778` | 5 / 2 | 109,130,225,355,1072 / 1054 | 两个琥珀（互比 1.02:1，等于重复） | `WidgetTheme.Warning` `#F8B659` |
| `#67D6CB` | 1 | 1054 | fixture 用青 | `WidgetTheme.Data2` `#49D4C6` |
| `#52616D` | 1 | 889 | 滚动条轨道 | `WidgetTheme.BorderSubtle` `#373941` |
| `#73828E` | 1 | 889 | 滚动条滑块（**3.93:1，当文字不达标**） | `WidgetTheme.Text3` `#9A9EAC` |
| `#8E9DA9` | 1 | 889 | 滚动条悬停 | `WidgetTheme.Text2` `#B0B3BF` |

**`#9DE5D0` 的 17 处必须逐处判断，不能全局替换**——这是最容易出错的一步。判断规则：

- 作为 `TextBlock.Foreground` / `Stroke` → `Accent`
- 作为 `Background` / `BorderBrush` 且面积较大 → `AccentFill`（但白字可读性需 5.64:1，已达标）
- 作为 `Background` 且是选中行/弱强调 → `AccentSubtle`
- 作为 `Slider` 已填充部分 → `Accent`（细长图形，用亮色更清楚）

#### 9.5.2 三个"颜色即逻辑"的坏味道（重构，非换色）

| 行 | 现状 | 问题 | 建议 |
| --- | --- | --- | --- |
| `:354-357` | `StateColor(text)` 用字符串匹配返回 `#6B7A86` / `#6FBF9E` / 兜底 `#6B7A86` | 颜色由**中文文案**决定，改文案就改配色 | 改为 `StateColor(WidgetState state)` 枚举入参；文案与颜色解耦 |
| `:359` | `Foreground = value.FontSize >= 24 ? "#F2F5F7" : "#D9E6E9"` | **颜色由字号推导**——字号一改，颜色跟着变 | 直接指定 `Text1` / `Text2`，删除条件 |
| `:103` | `Text(string s, double size)` 硬编码 `Foreground = B("#E6EDF4")` | 所有调用点无法区分主次文字 | 加可选参 `Brush fg = null`，默认 `Text1` |

#### 9.5.3 字号：54 处 → 阶梯

| 旧 | 次数 | 行号 | 新 | 风险 |
| --- | --- | --- | --- | --- |
| 10 | 13 | 114,129,130,132,133,240,243,1068,1072 | `Text2Xs`(11) | 低 |
| 10.5 | 5 | 109,892,905,917,918 | `TextXs`(12) | **中**：`109` 的 `MaxHeight=28` 需同步 +2 |
| 11 | 21 | 104,105,114,124,131,143,834,835,940,941,942,943,952,1071,1072 | `TextXs`(12)（控件）/ `Text2Xs`(11)（注释） | **中**：`834/835` 是 `MinHeight=30` 的 ComboBox，字号 11→12 需确认不裁切 |
| 11.5 | 1 | 939 | `TextXs`(12) | 低 |
| 12 | 5 | 107,939,941,942,952 | `TextSm`(13) | 低 |
| 14 | 3 | 145,903,943 | `TextMd`(15) | 低 |
| 16 | 2 | 124,826 | `TextLg`(17) | 低 |
| 17 | 2 | 114,266 | `TextLg`(17) | **锁定**：`selftest:1359` 断言 17 |
| 22 | 1 | 939 | `TextXl`(22) | **锁定**：`selftest:952` 断言 22 |
| 28 | 1 | 258 | `Text2Xl`(28) | **锁定**：`selftest:1359` 断言 28 |

`WidgetTheme.cs` 里 `TextLg == 17`、`TextXl == 22`、`Text2Xl == 28` 已用探测程序验证，
改色不会碰到这三条断言；改字号时**这三个值绝对不能动**。

#### 9.5.4 间距 / 圆角 / 内边距

现状：`Thickness` 有 **61 个不同值**（`0`×20、`1`×15），`CornerRadius` 5 个不同值
（8×5、10×3、12×1、2×1、3×1）。建议：

| 位置 | 旧 | 新 |
| --- | --- | --- |
| 窗口外壳 `:106` | `CornerRadius(12)` + `Padding(12,11,12,11)` | `RadiusLg`(14) + `WidgetTheme.CardPadding`(12,10,12,10) |
| 卡片/浮层 `:117` `:259` `:923` | 8 / 8 / 10 | `RadiusMd`(10) / `RadiusMd` / `RadiusMd` |
| 内部小块 `:832` `:833` `:1071` | 2 / 3 / 3 | `RadiusSm`(6) |
| 所有 `Thickness(1,...)`（15 处） | 1 px 微调 | `Space2`(4) 或 `Space1`(2)——**1 px 在 96 dpi 上不稳定，且看起来像没对齐** |

规律：**嵌套 = 外层 − 内边距**。窗口 14 − 内边距 12 → 内层 2（用 3 已够圆），
旧版 12 → 8 → 2，步长 4/6，视觉上"圆角跳变"。

#### 9.5.5 阴影

全文件 `DropShadowEffect` **0 次**、`LinearGradientBrush` **0 次**、`GradientStop` **0 次**。
这不是"极简"，是"没有层级"——所有面靠 1.07–1.20:1 的背景差区分，等于没有。

建议只加三处（不要给所有元素加）：

| 元素 | 行 | 阴影 |
| --- | --- | --- |
| 设置/结果对话框 | `:923` `:935` | `WidgetTheme.Shadow(3)` |
| 下拉弹层 | `:889` 附近 | `WidgetTheme.Shadow(2)` |
| 任务条悬浮 | `:1071` | `WidgetTheme.Shadow(1)` |

`Shadow(int)` 助手已实现 4 档并做了越界钳制（`Shadow(9)` → 40、`Shadow(-3)` → null），
返回的 `DropShadowEffect` 未 `Freeze`（WPF 效果对象不可冻结到可跨线程使用前需注意，
但同一 UI 线程内共享无碍）。

---

### 9.6 接入 `WidgetTheme.cs`

`scripts/native/WidgetClient.cs` 是运行时 `Add-Type` 编译的，**没有 csproj**，
所以新文件必须显式登记：

```diff
 scripts/native-widget.ps1:9
- Add-Type -Path (Join-Path $PSScriptRoot 'native/SafeSvg.cs'),(Join-Path $PSScriptRoot 'native/WidgetClient.cs'),...
+ Add-Type -Path (Join-Path $PSScriptRoot 'native/SafeSvg.cs'),(Join-Path $PSScriptRoot '../docs/ui-redesign/WidgetTheme.cs'),(Join-Path $PSScriptRoot 'native/WidgetClient.cs'),...
```

两个约束（在 `native-widget.ps1:8` 的注释里已写明"each compilation unit has its own imports"）：

1. `WidgetTheme.cs` 自带 `using System.Windows; using System.Windows.Media;`，不与别的文件共享；
2. 文件顺序无关（同一编译单元），但 `WidgetTheme.cs` 内的所有引用都写全了命名空间，
   不依赖 `WidgetClient.cs` 的 `using`。

若希望源码树更整洁，也可把文件移到 `scripts/native/WidgetTheme.cs`——**但目录移动会让
`tests/native-preview.selftest.ps1:267` 那条独立编译路径需要同步更新**（它只编译
`BrowserPreview.cs` + `CockpitBrowserGuard.cs`，不含 `WidgetClient.cs`，因此目前不受影响；
一旦 `WidgetTheme.cs` 被 `BrowserPreview.cs` 引用，就必须加进去）。

**验证方式**（已实测通过）：在 PowerShell 5.1 STA 下把 `WidgetTheme.cs` 与 `WidgetClient.cs`
一起 `Add-Type -Path`，编译成功即说明无冲突。探测程序 `Temp/ui-audit/ThemeProbe.cs`
的输出为：

```
page=#FF141518;cached=True;frozen=True;card=#FF1C1D21;text1=#FFEDEEF2;accentFill=#FF4A5AD6;
pen=#FF3F414B/1/True;shadow0null=True;shadow2=24/0.55;shadow3=40/0.7;
sizes=11,12,13,15,17,22,28;testSizes=True;radius=3,6,10,14;control=24,30,34;
font=Segoe UI, Microsoft YaHei UI, Microsoft YaHei;clamp=40;negClamp=True;
```

`testSizes=True` 表示自检断言依赖的 22/28/17 三个字号在 token 里得到保留。

---

### 9.7 不能碰的断言（改动前必读）

`tests/native-widget.selftest.ps1`（2,557 行）里与视觉强相关的硬断言：

| 行号 | 断言 | 对改动的约束 |
| --- | --- | --- |
| `:952` | `resultTitle.FontSize -eq 22` | 标题字号锁定 22 |
| `:1359` | `total.FontSize -eq 28`、`MetricControls[0].FontSize -eq 17`、`SemiBold`/`Medium` 字重 | 28/17 与两个字重锁定 |
| `:1352` | `$contextBottom -le $effortTop -and $mainContext.ActualWidth -gt 300` | 往上加高会顶掉 effort 行 |
| `:1353` | effort 与 speed 控件必须可见 | 不能隐藏 |
| `:1354-1356` | 每个控件必须完全落在窗口内（`+1` 容差） | **任何字号/内边距放大都可能溢出失败** |
| `:419-420` | `FormattedText.Width -le $metric.ActualWidth` | 数值文本不得溢出控件宽度 |
| `:413`/`:414` | 数值文本形如 `1G`/`2G` 且 ≤8 字符 | 不要引入更长的格式 |
| `:324` | 设置窗 `WindowStyle=None`、`NoResize`、`AllowsTransparency`、`Background=Transparent` | 外壳属性不可改 |

固定几何（这些是"改字号的硬天花板"）：`:107` 头部 `Height=26`；`:143`/`:924` 窗 `MinWidth=Math.Min(360,width)`；
`:935` 结果窗 `MinWidth=Math.Min(610,resultWidth)`；`:1071` 任务条 `Height=36`。

→ 结论：**先改颜色（零布局风险），再改字号（每改一处跑一次自检），最后才考虑几何**。

---

## 10. 实施顺序与回归验证

### 阶段 A — 纯颜色（零布局风险，1 次提交）

1. 新增 `src/public/tokens.css`（已完成）；
2. 新增 `Docs/ui-redesign/WidgetTheme.cs`（已完成）；
3. `index.html` L3 前插 `<link>`；`preview.html` L2 插 `<link>`；
4. 用 `proposed-styles.css` / `proposed-preview.css` 替换两个样式表；
5. `WidgetClient.cs` 按 §9.5.1 只替换颜色字面值为 `WidgetTheme.*`（不动任何 `Thickness`/`FontSize`）。

验收：`powershell.exe -STA -File scripts/native-widget.ps1 -SelfTest` 全绿；
浏览器打开 `http://127.0.0.1:<port>` 目视四个区块。

### 阶段 B — 字号（每步跑自检）

按 §9.5.3 的"低风险"行先改（10/10.5/11/11.5/12/14/16），
每改一个簇立刻跑：

```powershell
powershell.exe -STA -File scripts/native-widget.ps1 -SelfTest
```

若 `:1354-1356` 报 `main data or action extends beyond the fixed window`，
说明该簇放大后溢出——回退该簇，或同步把对应容器的 `MinWidth`/`Margin` 减小。
**不要为了塞下大字号去改断言**。

### 阶段 C — 间距与圆角

`Thickness(1,...)` → `Space2`、`CornerRadius` 归并到 4 档、三处阴影。
这一步视觉收益中等、回归成本最高，建议单独提交。

### 阶段 D — 语义化重构（可选）

§9.5.2 的 `StateColor` 枚举化、删除"字号决定颜色"的逻辑。

### 回归清单

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| JS 语法 | `npm run build` | 全部 `node --check` 通过 |
| 原生自检 | `powershell.exe -STA -File scripts/native-widget.ps1 -SelfTest` | 0 failure |
| 预览页自检 | `powershell.exe -STA -File tests/native-preview.selftest.ps1` | 0 failure |
| HTML 预览冒烟 | `npm run test:html-preview` | 通过 |
| 单测 | `npm test` | 全部通过 |
| 对比度护栏 | `python Temp/ui-audit/emit.py` | `FAILURES: 0` |

`emit.py` 会重写 `tokens.css` / `WidgetTheme.cs` / `_tables.md` 三个文件。
若在阶段 C 之后手工改过 token，重跑 `emit.py` 会覆盖——那时应改 `emit.py` 里的字典而不是改产物。

---

## 11. 复现与工具

| 文件 | 作用 |
| --- | --- |
| `Temp/ui-audit/emit.py` | **真源**：定义全部 token、断言 66 组对比度、生成 token 文件与表格 |
| `Temp/ui-audit/inv_cs.py` | 扫 `WidgetClient.cs` 的 hex 字面值（出现次数 + 行号 + 上下文） |
| `Temp/ui-audit/inv2.py` | 扫 `Thickness`/`CornerRadius`/`FontSize`/字体/阴影/渐变的频次 |
| `Temp/ui-audit/inv3.py` | 字号生命周期 + Web CSS 特性审计 |
| `Temp/ui-audit/evidence.py` | 旧设计的层级/对比度实测（§1 里所有数字的来源） |
| `Temp/ui-audit/probe2.py` | 按钮填充候选、wash、焦点环的对比度探针 |
| `Temp/ui-audit/contrast.py` | 通用 WCAG 对比度计算器 |
| `Temp/ui-audit/rows.py` | 重新打印 §5 的关键行（不写文件） |
| `Temp/ui-audit/ThemeProbe.cs` | `WidgetTheme.cs` 的编译+行为探测 |
| `Temp/ui-audit/verify_css.py` | 校验两份建议样式表里每个 `var(--x)` 都在 `tokens.css` 有定义，并检查括号配对 |

`verify_css.py` 当前输出 `FAILURES: 0`：`proposed-styles.css` 引用 66 个变量、
`proposed-preview.css` 引用 41 个，**全部有定义**。另有 28 个 token 未被两张 Web 表引用，
它们是**故意保留**的，不是死代码：

- 供 WPF 侧使用：`--chart-grid`、`--chart-track`、`--data-1/2/3`、`--shadow-3`、
  `--radius-lg`、`--border-strong`、`--row-selected`、`--row-selected-text`、`--control-h-lg`；
- 语义别名，供 JS 或未来组件使用：`--text-on-accent`（与 `--accent-on-fill` 同值）、
  `--text-on-inverse`、`--accent-subtle`、`--bg-active`、`--bg-inverse`；
- 阶梯完整性：`--space-0`、`--space-7`、`--text-lg`、`--leading-*`、`--dur-slow`、`--ease-exit`。

运行环境（本机路径）：

```powershell
python docs/ui-redesign/tools/analyze.py
```

`analyze.py` 里的对比度断言是**设计护栏**：任何人把 `--accent-fill-hover` 调亮一档、
或把 `--text-3` 调暗一档，脚本会直接 `FAILED` 并打印 `need ≥4.5`。这是刻意的——
配色方案的价值在于"不能被后人无意识地改坏"。

> 原文这里写的是 `Temp/ui-audit/emit.py`，该目录未纳入 Git；归档脚本现为
> `docs/ui-redesign/tools/analyze.py`，用系统 `python` 即可运行。若本机没有 `python`，
> 用任意 Python 3 解释器执行同一文件即可。

---

## 附：诊断数字一览（速查）

| 指标 | 旧值 | 新值 |
| --- | --- | --- |
| WPF 不同 hex 字面值 | 28 | 20 个 token |
| WPF 字面值出现次数 | 130 | 0（全部走 `WidgetTheme`） |
| 深色背景档位数在 1.07–1.20 内的数量 | 6 / 10 | 0（前三级 1.05–1.08 为刻意贴合） |
| 不同字号 | 10 种（WPF）+ 6 种（Web）= 13 | 7 档 |
| ≤11 px 的字号占比 | 39/54 = 72% | 0（正文最小 12） |
| 不同圆角 | 5 种 | 4 档 + full |
| 不同 `Thickness` | 61 种 | 6 个 space token + 4 个预设 |
| 阴影 / 渐变 | 0 / 0 | 3 档阴影（深色用内高光） |
| 强调色与成功色色相距离 | 7.2° | 跨色相（indigo 233° vs green 152°） |
| 正文最低对比度 | 3.52:1（`#6B7A86`） | 5.06:1（`--text-3` 最差用例） |
| Web 正文与面板对比 | 12.69:1（本就达标） | 14.52:1 |
| 三套深色底互比 | 1.07–1.11:1（"三个产品"） | 同一套 token，0 分歧 |
