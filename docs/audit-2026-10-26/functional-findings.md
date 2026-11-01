# Codex Stateline 功能问题审查

- 审查日期：2026-10-26
- 范围：`src/public/`、`src/server.js`、`src/telemetry/`、`src/benchmark/`、`scripts/native*`、`scripts/native/` 及相关测试。
- 原则：只审查，不修复；不因测试数量推断没有缺陷，也不把防御性截断、旧数据保留或轮询折中直接当作 bug。
- 结论：确认 **3 项中高价值主流程问题和 1 项低级状态反馈问题**。按严重度排序；F-01 为“高”，F-02/F-03 为“中”，F-04 为“低”。

## 验证方法与安全边界

独立探针：[web-functional-fixture.mjs](web-functional-fixture.mjs)。它通过 Node `vm.SourceTextModule` 执行未修改的 `src/public/app.js`，用内存 DOM 和内存 `fetch` 模拟响应；不启动服务、不连接 `4173`、不读取个人配置/日志、不发网络请求、不触发真实模型，也不调用任何业务写入端点。

在工作区根目录运行：

```bash
node --experimental-vm-modules docs/audit-2026-10-26/web-functional-fixture.mjs
```

结果：**exit code 0，PASS 3/3 目标场景**。分别验证目录不绑定、提交结果未知后的重试、状态 GET 挂起阻断轮询。必须带 `--experimental-vm-modules`；Node 未启用该接口时的 `vm.SourceTextModule is not a constructor` 是探针环境要求，不是产品缺陷。探针的 DOM 是行为替身，不据此声称像素级页面现象。

F-01 另有 lead 对现有页面的独立只读复核：`GET /api/benchmark` 返回 8 个 `defaults.availableModels`，而 Web 模型下拉仍只有 `configured` 和 3 个 `example-provider` 静态项；返回的 `persistent`/`none` 推理强度也未出现。该证据不使用旧页面实时读数。F-04 也采用 lead 的真实页面只读观察，不把任务元数据仍存在误写成详情丢失。

没有重跑或改写既有业务测试。审计未启动或停止现有服务，未调用真实生成、评分、基线、取消或关闭接口，未读取/复述个人日志内容，未修改业务源码、个人数据/配置、共享计划或其他成员文件。

---

## F-01｜高｜Web 基准配置与实时模型目录脱节，真实模型不可选，静态示例会被拒绝

**验证状态：实测（隔离 fixture）＋真实页面只读复核＋代码验证。**

**定位**

- `src/public/index.html:14`：模型下拉固定为 `configured` 与 `example-provider/gpt-6.1-sol`、`example-provider/gpt-6-astra`、`example-provider/deepseek-v4.1-flash`；推理强度固定为 `configured`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`。
- `src/public/app.js:328-340`、`src/public/app.js:353-362`：快照渲染和 `benchmarkRenderKey` 只保留/使用运行状态与 `defaults.model`、`defaults.reasoningEffort` 摘要，没有把 `defaults.availableModels`、`defaults.availableEfforts` 写入控件。
- `src/public/app.js:364`：提交直接使用 `$('model').value` 和 `$('effort').value`。
- `src/server.js:128-144`、`src/server.js:282-294`：后端实时读取目录，在 GET 中返回 `defaults`，并在运行 POST 前按当前目录校验。
- `src/server.js:89-91`：不在 allowlist 内的模型/推理强度返回 `schema_invalid`。
- `src/benchmark/service.js:140-144`：服务层也会以当前目录拒绝非法配置。
- 对照：`scripts/native/WidgetClient.cs:1063-1109` 的原生设置已有读取目录并更新草稿选择的逻辑；问题在 Web 绑定，不是后端没有目录。

**复现**

1. 只读打开 Web 面板，读取同源 `GET /api/benchmark`。
2. 比较响应的 `defaults.availableModels` / `defaults.availableEfforts` 与页面模型、推理强度下拉。
3. 选择一个仅存在于静态 HTML 的示例模型；在隔离 fixture 中确认提交值原样进入请求。真实服务会执行上述 allowlist 校验；本次没有发送该真实 POST。

**实际**

- fixture 的服务端快照提供 `fixture-provider/new-model`，初始化后的模型 `<select>` 没有重建，实际静态选项中仍没有它；提供 `persistent` 和 `none` 时，Web 推理强度选项也仍未更新。
- lead 的独立只读复核观察到真实目录的 8 个模型中，除 `configured` 外的 7 个真实模型均未出现在 Web 中；页面仍是 `configured + 3 example-provider` 静态项。3 个静态示例经纯 `isAllowedModel` 校验均为 false，未执行真实 POST。
- 因提交时后端按同一实时目录校验，静态示例不在当前 allowlist 时会直接以 `schema_invalid` 被拒绝；页面通用提示又未明确说明模型目录不匹配。

**预期**

Web 应从同一快照构建可用模型/推理强度选项，保留合法的未提交选择，并在目录更新或服务不可用时明确说明状态。目录应与服务端校验一致，不能由示例数据充当生产配置入口。

**影响**

Web 的模型选择主流程与真实环境脱节：真实模型无法通过 Web 选择，保留下来的示例模型看似可选却可能提交即失败。默认“沿用配置”路径不受此项影响；不涉及修改用户配置。

**修复方向**

在快照渲染路径中验证并消费 `defaults.availableModels` / `defaults.availableEfforts`，以独立目录版本/键更新 `<select>`，同时保存和恢复合法草稿；目录读取失败时禁用明确选择而非回退到静态示例。错误提示应区分“配置不在当前目录”和一般服务失败。补充 Web DOM 初始化及目录变化测试，并用纯校验 fixture 覆盖非法静态项，不需要真实生成。

---

## F-02｜中｜运行提交结果未知时，Web 恢复“启动”并为下次点击生成新 requestId

**验证状态：实测（隔离 fixture）＋代码验证。没有触发真实生成或业务 POST。**

**定位**

- `src/public/app.js:233-238`：POST 封装在响应丢失/解析失败时抛出异常；仅 nonce 403 才自动重试。
- `src/public/app.js:364`：每次 `runBenchmark()` 先覆盖 `state.requestId='ui_'+crypto.randomUUID().replaceAll('-','')`；异常分支只显示 `safeError`，`finally` 根据旧 `state.displayed` / `benchmarkAvailable` 恢复按钮，没有先 GET 对账，也没有 `submissionUnknown` 状态。
- `src/benchmark/service.js:152-157`：活动运行的相同 `requestId`、相同 payload 是幂等返回；不同 `requestId` 返回 `run_active`。
- `src/benchmark/service.js:167-176`、`src/benchmark/service.js:188-192`：运行 reservation 以 `requestId` 去重，但活动记录在结束后会清除；新 ID 不会与刚完成的提交自动去重。
- 对照：`scripts/native/WidgetClient.cs:1051` 已有 `busy || submissionUnknown || !serviceAvailable` 防重入逻辑。

**复现（fixture）**

1. 初始化 idle 快照，令启动按钮可用。
2. 内存 `fetch` 在收到 `/api/benchmark/run` 的合法 payload 后模拟“响应连接丢失”；这代表服务端可能已接受，但客户端无法知道结果。
3. 等异常分支结算、按钮恢复后，再触发一次有效点击。
4. 比较两次捕获的 payload。

**实际**

- 第一次失败后没有“结果未知/请先刷新对账”状态，按钮在旧 idle 状态下恢复可用。
- 两次有效点击产生：
  - `ui_aaaaaaaaaaaa4aaa8aaa000000000001`
  - `ui_aaaaaaaaaaaa4aaa8aaa000000000002`
- 第二次请求并未复用第一次的幂等键，也没有先通过 GET 确认前次运行。
- 仍活动时，第二次请求会被 `run_active` 拒绝，用户看到“已有运行”；若第一次已完成/失败且活动状态已清理，新 ID 不再提供同一提交的幂等保护，可能创建第二次运行。

**预期**

提交失败若不能确定服务端未接受，应进入“提交结果未知”状态，禁用再次启动并先读取当前快照；需要重试时复用同一 `requestId` 和相同 payload。只有确认不存在该次运行或用户明确开始新运行时才生成新 ID。

**影响**

网络响应丢失时，用户无法区分“未提交”“正在运行”“已结束”；重试可能得到误导性的“已有运行”错误，或在前次已结束后造成非预期重复运行。这里是恢复/幂等语义缺陷，不声称每次重试都必然执行两次模型调用。

**修复方向**

将提交事务状态与旧 `state.displayed` 分离：POST 前保存 requestId/payload；网络异常后设置 `submissionUnknown`，强制 `await loadBenchmark()` 对账并保留未知提示。未确认前禁用启动；重试沿用相同 ID。补充“请求接受后响应丢失、活动快照、完成后快照、重试同 ID”测试。

---

## F-03｜中｜一次无期限的状态 GET 可永久冻结全部后续基准刷新

**验证状态：实测（隔离 fixture）＋代码验证。**

**定位**

- `src/public/app.js:358-362`：`state.polling` 在整个 `capabilities()` 和 `/api/benchmark` GET 期间为 true；入口遇 true 直接 return，只有 await 结算后才在 `finally` 清除。
- `src/public/app.js:360`：`fetch('/api/benchmark',{cache:'no-store'})` 没有 `AbortController`、超时或独立失败期限。
- `src/public/app.js:361`：错误分支虽然能清理状态，但永不 resolve/reject 的请求到不了 catch/finally。
- `src/public/app.js:391`：每 1.5 秒再次调用同一 `loadBenchmark`，不能绕过仍置位的 `polling`。
- 对照：`src/public/app.js:192-194`、`src/public/app.js:386-388` 的遥测和 capabilities 分别有 8 秒、5 秒超时；原生 `scripts/native/WidgetClient.cs:42` 的请求也有 deadline。

**复现（fixture）**

1. 初次快照返回 idle，界面显示“未启动”，启动按钮可用。
2. 下一轮 `/api/benchmark` GET 返回一个刻意保持 pending 的 Promise。
3. 再触发三轮相同的定时轮询并等待 50ms。
4. 最后手动释放 pending 请求，以“运行中”快照作为对照。

**实际**

- 挂起期间 `/api/benchmark` 实际请求总数保持为 2；后续三次轮询全被 `state.polling` 跳过。
- 界面继续显示“未启动”，按钮保持可用；没有超时、过期或不可用反馈。
- 若请求永久不结算，该状态无限持续；fixture 手动释放后能更新为“运行中”，证实阻塞点正是这次未结算请求，而非后续快照无效。

**预期**

状态请求必须有明确期限。超时后应释放单 flight、停止把旧快照当作当前状态，并允许后续轮询恢复；可在合理短时间保留最后数据，但不能无限期无提示冻结。这里的问题不是“保留旧数据”本身，而是**永久无期限等待导致刷新机制失效**。

**影响**

服务仍在运行时，连接半开或请求悬挂会让运行进度、取消入口、完成结果和基准可用性长期不更新。用户可能在服务已有活动运行时仍看到旧 idle 页面；刷新页面成为唯一显式恢复手段。

**修复方向**

给状态 GET 增加与现有遥测类似的 AbortController 超时；在 `finally` 清理计时器和 flight 标志，超时进入明确的不可用/过期状态。防止超时后的旧响应覆盖新快照（使用请求序号或代次），并覆盖“挂起—超时—后续成功”测试。

---

## F-04｜低｜固定任务遥测不可用时，把有效任务状态误显示成整体连接不可用

**验证状态：真实页面只读复核＋代码验证。属于反馈层级错误，不是任务详情丢失或网络请求错误。**

**定位**

- `src/public/app.js:38-58`：`setTelemetry` 只把 `ok`、`empty`、`ambiguous` 或 `bootstrap_in_progress` 视为 connected；`state==='unavailable'` 一律令顶部 `#connection` 显示“不可用”。
- `src/public/app.js:222-227`：固定任务成功响应把同一对象交给 `setTelemetry` 和 `setTaskTelemetry`。
- `src/server.js:241-267`：固定任务接口可以先成功返回有效的 `task`、`stale`、`sampledAt`，同时对不是当前 follow 会话的任务明确返回 `state:'unavailable'`；这是避免把另一会话计数错配给固定任务的保护。

**复现**

1. 在任务 API 正常时固定一个非当前 follow 会话的任务。
2. 使该任务的会话级计数不可用，但任务详情仍有效；lead 已在真实页面观察到该状态。
3. 查看顶部连接指示与任务元数据。

**实际**

HTTP 与任务详情可用，`task.id`、`stale`、`sampledAt` 等仍有有效内容，但顶部连接区域显示“不可用”。这把“该任务没有可发布的会话级遥测”混同于“本地服务整体不可连接”。

**预期**

整体连接状态应与本次请求/服务可达性一致；任务级遥测不可用应在会话/任务区域单独表达，并保留有效任务元数据。对跨会话固定任务，可以继续不展示不可归属的 token/速度数据。

**影响**

误导故障定位，用户可能去检查本地服务连接，而实际上只是当前固定任务没有可归属的会话计数。严重度低：没有证据表明任务元数据被清除或服务端数据错配。

**修复方向**

把连接指示与业务 `state` 解耦，按请求成功/失败及任务数据可用性分别渲染；补充“有效 task + unavailable 会话遥测”和真正断连两种 DOM 测试。

---

## 未列为问题的候选与未验证风险

- **整体用量时序（未证实为 bug）**：`scripts/native/WidgetClient.cs:904-930` 的渲染与 `sampledAt` 检查顺序曾被怀疑可能显示旧 overall；但同 kind 请求单 flight，服务替换有 generation，出队/应用还会校验代次。`scripts/native/WidgetClient.cs:869-890`、`scripts/native/WidgetClient.cs:1050` 以及 `tests/native-widget.selftest.ps1:2476-2560` 覆盖 held/stale usage 与服务换代。没有构造出合法乱序序列，故不作为确凿问题。
- **pin/follow 与跨任务数据合并（未发现错误）**：`src/public/app.js:192-230` 有任务代次检查，`src/server.js:259-267` 对跨会话固定任务主动清除不可归属字段。F-04 仅是此防护产生的展示语义问题，不是跨任务计数串用。
- **窗口生命周期、键盘与短屏布局（未发现问题）**：`scripts/native/WidgetClient.cs:1118-1168` 对设置/结果窗清理、预览停止及代次失效有防护；`tests/native-widget.selftest.ps1:1898-1939` 覆盖窗口复用、关闭、Esc、焦点和关闭期间更新。lead 的独立原生 fixture 显示正常主窗 `extent 226 < viewport 269`，无滚动且设置/用量控件可见，属于正常布局，不是 bug。
- **旧数据保留与有界截断**：它们本身是可接受的防御性/轮询设计。本报告只将“无限等待且不再轮询”的 F-03 和“静态目录与服务端规则相反”的 F-01 判为缺陷，没有把快照 `truncated`、保留最后合法值或暂时旧状态凑成问题。
- **真实提交后的最终执行次数**：F-02 已证明客户端换了幂等键，未用真实模型验证完成边界下是否实际产生第二次模型调用；影响按代码中的活动记录清理条件限定，不夸大为必然重复扣费。

## 交付文件

- 报告：`docs/audit-2026-10-26/functional-findings.md`
- 安全复现：`docs/audit-2026-10-26/web-functional-fixture.mjs`（PASS 3/3，exit code 0）
