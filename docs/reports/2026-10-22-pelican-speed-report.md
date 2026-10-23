# 鹈鹕 Cockpit 生图速度实测报告

> **归档说明（仓库整理时追加）**
>
> 这是一份历史测量记录，保留当时的原始结论与数据。为便于仓库发布，配套资产已重新归位；
> 下文出现旧路径时以本说明为准：
>
> - 测量脚本 `output/*.mjs`、`output/*.ps1` → **`docs/reports/tools/`**
> - 测量日志（`output/speed-*.log`、`output/pelican-*.log`）与调试截图 → **已删除**（关键数据已摘录入本文表格）
> - 正文中的 `output/...` 一律指整理前的旧位置
>
> 报告里的耗时来自特定机器、特定时段的实测，不是可复现的性能承诺。

**测量对象**：`pelican-cockpit-v1`（`caseId: pelican-cockpit`，prompt 为 `src/benchmark/cases.js:36` 的一句话：「创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制」）
**测量时间**：2026-10-22 10:54 – 11:33（本地 UTC+8）
**测量手段**：4 次服务内真实运行（`POST /api/benchmark/run` → 轮询）+ 5 次隔离 runner 对照 + 裸 codex CLI A/B + 中转侧 usage 交叉验证
**一句话结论**：**慢不在本地，几乎全在上游**。但"上游慢"有两种形态：**① 挂死**——HTTP 200 但 0 token，单次空转 165–332 秒（#3/#4；#4 里占其总耗时的 59.8%）；**② 有产出但端到端极慢**——#2 拿 5 408 答案 token 花了 264.6 s（端到端 20.4 tok/s）。另外 #1 的 77.7% 输出 token 花在看不见的推理上。可消除的本地等待只有两处：「零输出挂死」看门狗（#3 可省 235 s）+ 缩短尾部等待（每次省 3–10 s）。

---

## 1. 总表

| # | 模型 / effort | 状态 | 总耗时（wall） | `elapsedMs` | 首事件 | 末事件 | 尾部（末事件→完成） | 错误事件 | turnFailed | 重试次数 | lastErrorClass | exitCode | 输出 token | answer 字节 | 端到端吞吐 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `example-provider/deepseek-v4.1-flash` / `low` | completed | **142.8 s** | 140 335 ms | 1 255 ms | 124 954 ms | **15 381 ms** | 0 | 0 | 0 | null | 0 | 29 010（其中推理 22 544，答案 6 466） | 17 404 | 46.1 tok/s |
| 2 | `example-provider/gpt-6.1-sol` / `max` | completed | **278.9 s** | 277 100 ms | 1 119 ms | 267 073 ms | **10 027 ms** | 0 | 0 | 0 | null | 0 | 8 124（推理 2 716，答案 5 408） | 17 235 | 19.5 tok/s |
| 3 | `configured` / `configured` | **timed_out** | **901.2 s** | 900 856 ms | 947 ms | 665 313 ms | **235 543 ms** | 2 | 0 | 0 | `reconnect_notice` | 1 | **0**（三次请求全部 0 token） | 0 | 0 tok/s |
| 4 | `configured` / `configured` | completed | **832.5 s** | 831 631 ms | 1 750 ms | 821 560 ms | **10 071 ms** | 2 | 0 | 0 | `reconnect_notice` | 0 | 72 856（推理 61 812，答案 11 044） | 34 098 | 13.3 tok/s |

> `configured`/`configured` 的真实含义（读 `~/.codex/config.toml`）：`model = "example-provider/deepseek-v4.1-flash"`、`model_reasoning_effort = "max"`。**即 #3/#4 实际是「flash + max」**，不是另一个模型。
> 「端到端吞吐」= 答案 token ÷ `elapsedMs`；推理 token 不计入，因为用户拿不到。
> 「重试次数」为 attempt 级重试（`src/benchmark/service.js:12-13` 的 `MAX_ATTEMPTS = 2`）。**本次 4 次运行都是单 attempt**：历史 seq=41/42/43 的 `upstream_stream_lost` 断流未复现，#3 的失败态是 `timed_out` 而非可重试码，所以重试机制一次都没被触发——**这本身是个发现：当前的自动重试救不了「挂死」这种最常见的失败模式**（见 5.1）。

---

## 2. 时间都花在哪

### 2.1 上游 vs 本地（用中转侧 `ms` 逐行对账）

中转 API 每个请求一行，`ms` 是上游该次请求的完整生命周期。把一次运行对应 session 的所有行加起来，与本地 `elapsedMs` 对比：

| # | 上游请求数 | 上游 `ms` 合计 | 本地 `elapsedMs` | **本地额外开销** | 本地占比 |
|---|---|---|---|---|---|
| 1 | 1 | 122 389 ms | 140 335 ms | **17 946 ms** | 12.8% |
| 2 | 1 | 264 642 ms | 277 100 ms | **12 458 ms** | 4.5% |
| 3 | 3 | 897 958 ms | 900 856 ms | **2 898 ms** | 0.3% |
| 4 | 3 | 817 324 ms | 831 631 ms | **14 307 ms** | 1.7% |

**上游占比 87.2% / 95.5% / 99.7% / 98.3%。**

### 2.2 更关键的分解：上游时间里有多少是「空转」

这是本报告最重要的发现。中转侧每行都有 `in / out / reasoning`，可以区分「产出了内容」和「挂着不动」：

| # | 请求 | 中转行时间 | `in` | `out` | `reasoning` | 答案 token | 判定 |
|---|---|---|---|---|---|---|---|
| 1 | 唯一一行 | 122 389 ms | 397 | 29 010 | 22 544 | 6 466 | **有产出** |
| 2 | 唯一一行 | 264 642 ms | 20 204 | 8 124 | 2 716 | 5 408 | **有产出** |
| 3 | 第 1 行 | 331 186 ms | 0 | 0 | 0 | 无 | **零输出挂死** |
| 3 | 第 2 行 | 331 781 ms | 0 | 0 | 0 | 无 | **零输出挂死** |
| 3 | 第 3 行 | 234 991 ms（`status=499` 客户端中止） | 0 | 0 | 0 | 无 | **零输出挂死** |
| 4 | 第 1 行 | 331 980 ms | 0 | 0 | 0 | 无 | **零输出挂死** |
| 4 | 第 2 行 | 165 641 ms | 0 | 0 | 0 | 无 | **零输出挂死** |
| 4 | 第 3 行 | 319 703 ms | 11 913 | 72 856 | 61 812 | 11 044 | **有产出** |

**占比：**

- **#4（用户默认配置的真实体感）**：总 831.6 s 中，**497.6 s（59.8%）花在两次零输出挂死上**，319.7 s（38.4%）花在唯一一次有产出的请求上，本地开销 14.3 s（1.7%）。
- **#3**：总 900.9 s 中 **898.0 s（99.7%）全部是零输出挂死**，一个 token 都没拿到，最终超时失败。
- #1/#2 没有挂死，两个请求都有产出。

> 结论：**「生图慢」的主体不是模型"写代码写得慢"，而是中转/上游把请求挂在那里不吐字，codex 侧重连后重新挂，如此往复。**（注意：见第 3 节的字段口径说明——"有产出"的那几次里，无法进一步区分排队与 decode 各占多少。）

### 2.3 本地开销明细（可测量的四段）

| 段 | 测量值 | 来源 | 说明 |
|---|---|---|---|
| spawn → 首个 JSON 事件（`thread.started`） | **660–3 385 ms**（24 个历史 run：中位 1 451 ms；本次 4 次为 947 / 1 119 / 1 255 / 1 750 ms） | `diagnostics.firstEventElapsedMs` | 主要是 `codex.exe` 自身启动；隔离跑同口径 763–1 081 ms，无可消除空间 |
| 末事件 → run 标记完成（尾部） | **9 887–15 381 ms**（4 次服务内运行）；隔离对照：`low` **345–449 ms**、`max` **6 919 ms** | `elapsedMs - lastEventElapsedMs`；#4 用 250 ms 高频轮询实测 `turn.completed → completed` = **9 887 ms** | 分两段：与 effort 相关的 ~6.9 s + 服务进程内特有的 ~3.2–9.6 s，详见 4.2② |
| 子进程退出 → run 标记完成 | `close` 与 `exit` 相差 **1–3 ms** | 裸 CLI 实验 `exitToCloseMs` | 管道本身不是瓶颈 |
| `execute()` 串行阻塞 | **无** | `src/benchmark/service.js:61-112` | 单 case、无 sleep、无 case 间等待；`POST /api/benchmark/run` 实测 **26 ms** 即返回（`:185-193` 异步启动 + 立即 `return snapshot()`） |

**#3 的 235.5 s 尾部是异常值**：最后事件在 665.3 s，但预算到 900.9 s 才收（`terminationReason: budget_exhausted`）。中间 235.6 s **完全静默**——本地在干等一个已经死掉的上游。

### 2.4 预览加载耗时

**无法测量，且当前不存在 Web 预览路径。** 证据：

- `src/public/preview.js:3` `VERSION = 'pelican-html-animated-v1'`，`:44` `validPreview` 要求 `d.caseId === 'pelican-html-animated'` → **Cockpit（`pelican-cockpit-v1`）永远校验失败**。
- `src/public/app.js:301-305` 对 Cockpit 分支**不渲染任何预览链接**，只显示 prompt、来源链接和一句说明「Web 仅展示源码与运行结果；请使用原生桌面的受控预览」。
- 因此「预览加载竞态」这条在本项目当前版本**不成立**，不是慢的原因。

---

## 3. 与中转侧 `ttft_ms` / `ms` 的交叉验证

**要证明的是：慢在首字延迟（provider 排队/连接）还是生成速度（decode）？**

| # | `ttft_ms` | 上游 `ms` | ttft 占比 | `flow_ms` | `own_ms` | 确定事实 | 判定 |
|---|---|---|---|---|---|---|---|
| 1 | 6 923 | 122 389 | 5.7% | 16 061 | 132 | `out` 29 010 中 `reasoning` 22 544，答案仅 6 466 | 有产出；**主体是长推理** |
| 2 | **27 486** | 264 642 | 10.4% | 141 831 | 34 | `out` 8 124（答案 5 408），单请求 264.6 s | 有产出，但**单请求耗时最长**；首字 27.5 s 偏高 |
| 3 | 2 075 / 11 802 / 11 499 | 331 186 / 331 781 / 234 991 | — | 325 453 / 323 035 / 221 952 | 69 / 125 / 294 | 三行 **`out=0` 且 `reasoning=0`** | **零输出挂死**（有 HTTP 响应，无任何 token） |
| 4 | 13 472 / 2 613 / 2 306 | 331 980 / 165 641 / 319 703 | — | 317 930 / 162 203 / 27 628 | 120 / 294 / 161 | 前两行 `out=0`；第三行 `out=72 856`（答案 11 044） | 前两次**零输出挂死**；第三次**有产出** |

**字段口径必须先说清**（这决定了哪些结论站得住）：`ttft_ms + flow_ms + own_ms + sent_ms` **加总不等于** `ms`。逐行验算：#1 覆盖 23 252 / 122 389 ms（缺 99.1 s）、#2 覆盖 180 885 / 264 642 ms（缺 83.8 s）、#4 第三行覆盖 30 259 / 319 703 ms（缺 289.4 s）。**缺失部分是中转侧未细分的区间**（排队 / 等待上游 / 其它处理），无法从这些字段区分。

**因此本报告只依据这些"确定事实"：**
- `out` / `reasoning` 的 token 数 → **是否产出、产出多少**（可靠）。
- `out = 0 且 reasoning = 0` → **零输出挂死**（可靠，且是本次的核心发现）。
- `ttft_ms` → **首个 token 的时间下界**（可靠）。
- `ms` → **单请求完整生命周期**（可靠）。

**不做的事**：不用 `flow_ms` 反推 tok/s（分母不完整，会算出 1 800 tok/s 这类荒谬值），也不用 `ms − ttft` 断言"decode 慢"（分子里混着未细分的排队时间）。

**交叉验证结论：**

1. **不是 provider 首字延迟问题**。#3/#4 的空转请求 `ttft_ms` 只有 2–13 s，说明**连接和首字节都正常返回**；之后 300+ s 里 `out` 和 `reasoning` 始终为 0。这是**流建立后挂死**，不是排队慢、也不是首字慢。
2. **#1 的"慢"主要是长推理，不是回答慢**：`out = 29 010` 里 `reasoning = 22 544`，真正答案只有 6 466 token——**77.7% 的输出 token 用户看不见**。这是不同模型/effort 之间体感差异的主要来源，也是"降 effort 立刻变快"的机制解释。
3. **"上游慢"有两种形态，对策不同**：
   - **挂死（0 token）**：#3 全部、#4 前两次。→ 只能靠超时看门狗 + 重试（见 5.1）。
   - **有产出但单请求耗时长**：#2（264.6 s 才拿到 5 408 答案 token）、#4 第三次（319.7 s 拿到 11 044）。→ 换模型或降 effort，本地无法优化。
   - **本次数据无法进一步区分"有产出"这一类的耗时里，多少是排队、多少是 decode**（受上述字段口径限制）。**这一点如实标注为未定论。**
4. **本地侧几乎完全对齐上游**：4 次运行的「上游 `ms` 合计」与「本地 `elapsedMs`」差 2.9–17.9 s（0.3%–12.8%），且这部分差值**已逐项归因**（首事件 1–1.8 s + 尾部 3.2–15.4 s），没有无法解释的残留。**本地没有藏时间。**

---

## 4. 结论：瓶颈在哪，哪些本地等待可以消除

### 4.1 瓶颈判定

**瓶颈在上游，不在本地。** 量化依据：

- 上游占比 87.2%–99.7%。
- 在默认配置（#4）下，**59.8% 的总耗时是上游零输出挂死**（497.6 s / 831.6 s），只有 38.4% 的请求真正产出了内容。
- 最坏情况（#3）**100% 空转**，一个 token 都没拿到，还耗满了 900 s 预算。
- 本地全部可测开销（spawn、清理、store 写入、HTTP）合计每次 < 20 s，且大部分不可压缩。
- **补充**：#2 证明"上游慢"不必是挂死——它能正常产出，但单请求 264.6 s 才拿到 5 408 答案 token。**这类慢本地无能为力。**

### 4.2 可消除的本地等待（逐条给证据与收益）

#### ① 死等挂死的上游：**可安全省 235 s**（最有价值，但判别信号必须选对）

- **证据**：#3 的 `lastEventElapsedMs = 665 313`，但 `elapsedMs = 900 856`——最后 **235.6 s 无任何事件**，且此前已出现 2 次 `reconnect_notice`（`firstErrorElapsedMs = 333 228`、`lastErrorElapsedMs = 665 313`）。runner 只受总预算约束（`src/benchmark/runner.js:432` `setTimeout(() => stop('timed_out'), budgetMs)`，`budgetMs` 默认 900 000 ms，见 `:12`），**没有任何静默看门狗**。
- **一个必须先排除的陷阱**（我最初的设计会误杀成功运行）：**#4 是成功运行，但它有 287.7 s 的完全静默**——error2 在 501.3 s，`item.completed` 直到 789.0 s 才出现（250 ms 高频轮询实测）。因此：
  - **单纯按「静默时长」设阈值是不可靠的**：要抓住 #3 的第一次静默需阈值 < 332 s（#3 的 error1→error2 间隔 332.1 s），要不误杀 #4 需阈值 > 288 s。窗口只有 288–332 s，两边余量各约 4%，**太脆弱，不建议**。
- **正确的判别信号是「有没有产出过任何输出」**。runner 已有现成的 `outputStarted` 状态（`src/benchmark/runner.js:330`：收到 `item.*` 且 `item.type` 为 `reasoning` 或 `agent_message` 时置真；`:341` 据此决定 stage 是 `generating` 还是 `waiting`）：
  - **#3：上游三次请求 `out` 与 `reasoning` 全程为 0** → 不可能产生 `item.*` 事件 → `outputStarted` 必为 false；同时 `errorEventCount = 2`。**这是「零输出挂死」的确定特征。**
  - **#4：第一次 error 出现在 335.3 s，而 250 ms 采样在 335.3 s 那一行已显示 `stage=generating`**（= `outputStarted` 为 true，见 `:341` 的三元式）→ **不会误判**。
- **改法**：见 5.1。
- **预估收益**（两档，风险不同）：
  - **保守档（推荐）**：条件 `outputStarted === false && errorEventCount >= 2` → #3 在第 2 次 error（665.3 s）时被掐，**从 901 s 降到 665 s，省 235.5 s（26%）**，错误码从含糊的 `timed_out` 变成准确的 `upstream_stalled`。对 #4 零影响（其 `outputStarted` 早在 335 s 前就已为 true，见上）。
  - **激进档**：条件 `outputStarted === false && errorEventCount >= 1` → #3 在 **333.2 s** 被掐，**省 567.6 s（63%）**。风险：若某次运行先报一次瞬时错误、之后又能正常出字，会被误杀。**本次数据中无此反例，但样本仅 4 次，不建议直接采用。**
  - 无论哪档，都应把 `'upstream_stalled'` 加入 `src/benchmark/service.js:12-13` 的 `RETRYABLE_CODES`，让这种失败能触发已有的 attempt 级重试（当前 `timed_out` 不可重试，**重试机制对最常见的失败模式完全无效**）。

#### ② 尾部等待：**每次省 3–10 s**（服务内特有部分）

- **证据链**（这是本次测量中最反直觉的一条，逐条列出以证明归因）：
  - 服务内 4 次运行的 `elapsedMs - lastEventElapsedMs` = 15 381 / 10 027 / 10 071 / 9 887 ms（#4 的 9 887 是 250 ms 高频轮询直接测到的 `turn.completed → completed`）。
  - **同一个 `createRunner`、同一个 `pelican-cockpit` 用例，在独立进程里跑：**
    - `configured/low` → tail **345 / 372 / 403 / 449 ms**（4 次）
    - `configured/configured`（= max）→ tail **6 919 ms**（1 次）
  - 所以尾部**不是一个固定的常数**，它由两部分组成：**① 与 effort 相关的一段**（low→0.4 s，max→6.9 s，隔离环境下同样存在）；**② 服务进程内额外的一段**（max 场景：服务内 10.1 s vs 隔离 6.9 s，多出 ~3.2 s；low 场景：服务内 10.0–15.4 s vs 隔离 0.4 s，多出 ~9.6 s）。
  - 已排除：`notify` 钩子（`~/.codex/config.toml` 的 `codex-computer-use.exe turn-ended`，A/B 六轮：带 notify 中位 3.4 s，不带 4.0 s，**带反而更快**）；答案体积（234 KB 答案尾部仅 525 ms）；管道 close（`exit→close` 恒 1–3 ms）；store 写放大（`mutate` 6.91 ms）；`onProgress`（无 IO）；`execute()` 串行（无等待）；面板轮询负载（隔离跑 + 250 ms 持续打 `/api/benchmark`，尾部仍 345 ms）；`/api/telemetry`（9 ms / 884 B，不构成负载）。
  - **唯一未排除的差异**：服务进程是长期运行的 node（pid 42172），且 `codex.exe` 会派生子进程 `node_repl.exe`（实测 pid 33100 → 18272）。runner 只监听 `child.once('close')`（`src/benchmark/runner.js:410`），而 `close` 要求**所有 stdio 管道关闭**；若孙进程继承了 stdout 管道，`close` 会被推迟到孙进程退出。这与「隔离跑更快」（孙进程生命周期不同）和「服务内约 10 s 的紧致聚集（10 027 / 10 071 / 10 073 / 10 075）」都吻合。
  - **诚实标注**：此归因是强证据支持的**主要嫌疑**，但未取得直接证明（未抓到孙进程持管道的句柄快照）。**②（与 effort 相关的那段）目前无法进一步归因**——它发生在 `turn.completed` 之后、`close` 之前，落在我无法插桩的 `codex.exe` 内部。
- **改法**：见 5.2。
- **预估收益**：每次运行省 **3.2–9.6 s**（服务内多出的那一段）。对 140 s 的 flash-low 运行最高相当于 **~7%**，对 832 s 的默认配置约 1%。

#### ③ 面板轮询把 20 份完整 answer 每秒搬一遍：**不影响基准，但白白压着服务进程**

- **证据**：`/api/benchmark` 单次响应 **295 KB**（含最近 20 个 run 的完整 `answer`），热态耗时 7.4–14.4 ms；`src/public/app.js:387` `setInterval(loadBenchmark, 1500)` → **每秒约 200 KB**；`:349-352` `benchmarkRenderKey` 每次把整个响应 `JSON.stringify` 做比较键；`store.snapshot()` 的 `structuredClone` 全量 **18.05 ms**，`JSON.stringify` 2.48 ms / 633 KB。
- **改法**：见 5.3。
- **预估收益**：轮询流量从 295 KB 降到 <10 KB，`benchmarkRenderKey` 从 ~2.5 ms 降到 <0.1 ms，降低服务进程 GC 与事件循环压力（**可能顺带缓解②**，但未验证，不作为收益承诺）。

#### ④ `store.mutate` 全量重写：**每次运行省约 14 ms**

- **证据**：`src/benchmark/store.js:17` 每次 `mutate` 都 `JSON.stringify(整个 data)` + 写文件 + rename；`src/benchmark/service.js:106-110` 一次运行末尾连续两次 `await store.mutate`，实测 **6.91 ms/次**。且这两次在 `elapsedMs` 之外，不计入已报告的耗时。
- **预估收益**：可忽略（<0.02%），仅作为整洁度建议，优先级最低。

#### ⑤ 首事件前的 ~1.5 s：**不可消除**

- `firstEventElapsedMs` 中位 1 451 ms（24 个历史 run），主要是 `codex.exe` 冷启动。隔离跑同口径 763–1 081 ms，说明服务环境还要多 ~0.5 s（进程启动 + 临时目录 `mkdtemp`，`src/benchmark/runner.js:293`）。**没有可压缩空间，不建议动。**

---

## 5. 建议的代码改动（**未修改任何源码，交 lead 决策**）

> 按「收益 / 风险」排序。所有行号基于当前工作区 `src/` 实际内容。

### 5.1 加「零输出挂死」看门狗，提前掐掉已死的上游 —— 收益最大

**位置**：`src/benchmark/runner.js:432` 附近（现有超时定时器）

```js
timer = setTimeout(() => { void stop('timed_out'); }, budgetMs);
```

**改法**：复用 runner 已有的 `outputStarted` 状态（`src/benchmark/runner.js:330`），在 `observeLine()` 末尾加一条判定：

```js
// 零输出挂死：上游反复重连但一个 token 都没产出
if (!outputStarted && diagnostics.errorEventCount >= 2) { void stop('upstream_stalled'); }
```

同时在 `src/benchmark/service.js:12-13` 的 `RETRYABLE_CODES` 里加入 `'upstream_stalled'`，让这种失败能触发已有的 attempt 级重试。

**为什么不用「静默时长」阈值**（这是本次测量最重要的反直觉发现）：**#4 是成功运行，却有过 287.7 s 的完全静默**（error2@501.3 s → `item.completed`@789.0 s，250 ms 高频轮询实测）。要抓 #3 的第一次静默需阈值 < 332 s，要不误杀 #4 需阈值 > 288 s——**可行窗口只有 288–332 s，两边余量各约 4%，不可靠**。而「有没有产出过任何输出」是二值信号：#3 全程 false，#4 在第一次 error 之前就已为 true，**不存在模糊地带**。

**理由**：#3 的证据表明，上游挂死后本地会**完全静默地空等 235 s**，而 `codex` 侧的重连事件（`reconnect_notice`）早已告诉我们可以判定为异常。
**预期收益**：
- **保守档（推荐）**：`outputStarted === false && errorEventCount >= 2` → #3 从 901 s 降到 **665 s**，**省 235.5 s（26%）**；#4 零影响。配合重试，把「耗满 900 s 拿 0 token」变成「665 s 判定 + 一次重试」。
- **激进档**：`errorEventCount >= 1` → #3 在 333 s 被掐，**省 567.6 s（63%）**；样本仅 4 次，有误杀先报错后恢复的运行的风险，**不推荐直接采用**。
- **这是唯一一条能显著改变用户体感的本地改动。**
**风险**：仅当上游先报错又完全不产出时才触发；已用 #4 证明不会误伤正常运行。仍需在真实长推理场景上回归验证。

### 5.2 不要只等 `close`，改用 `exit` + 短宽限 —— 省约 3–10 s/次

**位置**：`src/benchmark/runner.js:410`

```js
child.once('close', (code, signalName) => { exitConfirmed = true; ... });
```

**改法**：同时监听 `child.once('exit')`，在 `exit` 触发后给 stdio 一个短宽限（如 500 ms）就收尾，而不是无限等 `close`。即 `await Promise.race([exited, stopped, exitThenGrace])`。

**理由**：见 4.2②。服务内固定 ~10 s、隔离跑（`max`）6.9 s /（`low`）0.4 s，且 `exit→close` 在裸 CLI 下只有 1–3 ms——说明延迟发生在「孙进程持有管道」这一路径上，而 runner 对它是无限等待。
**预期收益**：每次运行省 **3.2–9.6 s**（服务内多出的那一段）。对 140 s 的 flash-low 运行最高相当于 **~7%**；对 `max` 约 1%。**注意**：与 effort 相关的那 6.9 s（isolated max 实测）落在 codex 自身收尾里，runner 改不掉，必须接受。
**风险**：若 stdout 还有未读完的尾行，可能截断 answer。必须保留现有 `consumeChunk(decoder.end())` + `consumeLine(remainder)` 冲刷逻辑（`src/benchmark/runner.js:446-448`），且只在 `turnCompleted === true` 时才允许提前收尾。

### 5.3 列表接口不要带完整 answer

**位置**：`src/benchmark/service.js:19-23`（`snapshotFromState` 取 `state.runs.slice(-20)`）+ `src/server.js:282-289`

**改法**：列表只返回 `answerBytes` / `contentDigest` / 前 200 字符摘要，完整 answer 走新增的 `GET /api/benchmark/answer?runId=`；前端 `src/public/app.js:312-314` 改为按需拉取，`benchmarkRenderKey`（`:349-352`）相应简化。

**预期收益**：轮询 295 KB → <10 KB，`structuredClone` 18 ms 与 `JSON.stringify` 2.5 ms 的每秒重复开销基本消失。**对基准运行时间无直接收益**，但能降低服务进程压力（可能与 4.2② 的尾部相关）。
**风险**：改动面较大（service + server + 前端三处），建议单独排期。

### 5.4 让 Cockpit 也能预览（非速度项，但影响「生图」体感）

**位置**：`src/public/preview.js:3`（`VERSION = 'pelican-html-animated-v1'`）、`:44`（`validPreview` 要求 `caseId === 'pelican-html-animated'`）

**改法**：把版本白名单与 caseId 校验扩展为 `['pelican-html-animated-v1', 'pelican-cockpit-v1']` / 对应 caseId，并在 `src/public/app.js:301-305` 的 Cockpit 分支补上预览链接。

**理由**：现在跑完一件 Cockpit 作品，Web 面板**只能读源码，看不到动画**（`app.js:304` 的文案就是这个意思）。用户感知的「生图慢」里，有一部分其实是「生成了但看不见」。
**预期收益**：不影响耗时，但直接改善体感。

---

## 6. 附：测量口径与可复现命令

| 脚本（现位于 `docs/reports/tools/`） | 用途 |
|---|---|
| `node output/run-pelican-cockpit.mjs <model> <effort>` | 正式驱动：`/api/nonce` → `POST /api/benchmark/run` → 3 s 轮询到终态 |
| `node output/speed-wrap.mjs <model> <effort> <log>` | 在驱动外套一层 `[+NNNms]` 时间戳与 `EXIT wallMs=`，用于 wall-clock 计时 |
| `node output/speed-extract.mjs <seq\|runId>` | 从 `%LOCALAPPDATA%\codex-companion\benchmark.json` 精确提取单个 run 的 diagnostics |
| `node output/speed-upstream.mjs <startISO> <endISO> [model]` | 按时间窗口从中转 usage 里筛出 codex 的行 |
| `node output/speed-pollfast.mjs <log> [250]` | 250 ms 高频轮询 `/api/benchmark`，记录状态翻转时刻（测尾部的关键） |
| `node output/speed-runner-tail.mjs <label> <caseId> [model] [effort]` | 隔离跑 `createRunner`，证明 runner 自身开销 |
| `node output/speed-cli-tail.mjs <label> [--no-notify]` | 裸 codex CLI 尾部 A/B（notify 钩子影响） |
| `node output/speed-sampler.ps1` | 单进程快速进程采样（必须用 `powershell -NoProfile -ExecutionPolicy Bypass -File` 启动） |
| `node output/speed-load.mjs <durationMs> <intervalMs>` | 持续打 `/api/benchmark` 模拟面板轮询负载（用于排除轮询对尾部的影响） |

**中转 API 使用要点（踩过的坑）**：只有 `period=30d` 有数据；`page` 参数**完全被忽略**，必须用 `offset`；定位某次运行最可靠的方式是先按时间窗口找到 `session`，再用 `q=<sessionId>` 精确取行。同一 codex session 每次重试都记一行，不能靠行数估算请求数。

**口径说明**：
- `elapsedMs - lastEventElapsedMs` = 「最后一个 SAFE_PROGRESS 事件 → run 标记完成」，因为 `finish()`（`src/benchmark/runner.js:269-277`）在所有 `finally` 清理（含 `rm` 临时目录，`:455-467`）之后才调用。
- 「上游 `ms` 合计」直接取中转行，与本地 `elapsedMs` 的差值即本地额外开销。
- 4 次运行期间服务未重启（node pid 42172），`codex-cli` 实际为 0.163.0（`benchmark.json` 里 `cliVersion` 记为 0.162，是服务自身的版本记录口径，不影响测量）。
