# Codex Stateline 修复交付报告

**日期**：2026-10-26\
**对应审查**：[功能与 UI 审查报告](report.md)\
**执行方式**：后续实现、集成和验证均由主智能体完成；未新增第三方运行依赖。

## 结论

原审查确认的 **10 项 Web 功能与 UI 问题已逐项处理**，并新增 15 项 Web 回归测试。最终执行结果：

| 检查 | 结果 |
|---|---|
| `node --experimental-vm-modules --test tests/web-ui-regression.test.js` | **15 通过，0 失败** |
| `npm run build` | **通过，exit 0** |
| `npm test` | **436 项：435 通过、0 失败、1 跳过** |
| `git diff --check` | **通过，exit 0** |
| 独立合成 API 浏览器验收 | 动态目录、任务辨识、局部不可用状态、代理展开、评分焦点、未知提交对账与同 ID 重试均已操作或观察验证 |
| 真实页面刷新后的浏览器 console | **无 JavaScript 错误、0 warning**；另有 favicon 404 静态资源提示 |

完整测试的 1 个跳过项是已有的 Windows file symlink privilege 限制；同一测试中的 junction 分支仍执行。该跳过项不是本次修改引入的失败。精确计数来自最后一次测试输出；中间调试轮次的失败计数不作为交付结果。

## 原问题与修复对照

| 编号 | 修复结果 | 验证 |
|---|---|---|
| F-01：静态模型/推理目录 | 由 `defaults.availableModels` / `availableEfforts` 生成真实选项；校验、去重，保留仍有效的选择；目录不可用或选项消失时明确提示并限制选择，不再用静态示例冒充真实目录。 | 动态目录和草稿回归；合成浏览器选项与合成目录一致；真实页面读取最新目录无 console 错误。 |
| F-02：未知提交后换新 requestId | 保存待对账的 requestId 与原 payload；先用 GET 对账。确认没有对应运行后，重试仍使用**同一 requestId、同一参数**；同 ID 对应不同参数时停止重试。明确 HTTP 拒绝不误标为未知提交。 | 未知提交、同 ID 重试、对账失败、旧响应失败和 HTTP 拒绝共 5 项回归。合成浏览器两次 run 请求的 ID 和 payload 一致。 |
| F-03：挂起 GET 永久阻断轮询 | 基准快照请求使用 8 秒超时、代次和 flight；清理过期请求，并保留一次待处理刷新。失败时显示旧状态过期提示，后续轮询可恢复。 | 注入时钟验证“挂起—超时—恢复”，已确认 timeout 返回 timedOut；回归验证旧 GET 失败不能覆盖新提交。 |
| F-04：局部任务不可用误报整体断连 | 服务连接与任务级数据状态分离；任务有效而会话用量不可用时，顶部保持“已连接”，任务区域显示“局部不可用”。 | 有效 task + `state: unavailable` 回归及合成浏览器实际显示。 |
| U-05：同名/同短 ID 不可辨识 | 对可见标签相同的**不同完整 ID**追加稳定序号；保留完整 ID 的辅助信息。同一完整 ID 的重复项按首次出现去重，避免产生无法稳定选择的重复 option。 | 同名、同短 ID 与精确重复 ID 回归；合成页面显示“任务 1/2”“任务 2/2”，完整 ID 重复项只出现一次。 |
| U-06：代理详情只在 title | 改为原生 `details` / `summary`，可用 Enter/Space 和触控展开；完整详情支持换行，不再仅依赖 tooltip。 | 回归及浏览器真实点击验证展开、焦点和跨遥测保持。 |
| U-07：评分刷新丢焦点 | 按 run/case 与分数状态计算 cases key；非 progress 快照且内容未变时不重建评分控件；确实重建时保存并恢复逻辑焦点与展开状态。 | 未保存草稿值 5、焦点 select、activeElement 和 run/case 标识跨快照保持；浏览器同步观察。 |
| U-08：按钮与相邻控件错位 | `.controls > button { align-self: end; }`，让按钮与相邻表单控件的底边对齐。 | 静态回归与桌面/窄屏截图检查。 |
| U-09：高频遥测整体进入 live region | 删除整个遥测面板的 `aria-live`；仅保留连接状态和精简任务/错误状态的 polite 通知。 | 静态回归。尚未用 NVDA/JAWS 做人工播报验收。 |
| U-10：浅色 token 未接入 | 使用现有 `app.js` 初始化和监听系统浅色/深色偏好，不新增需要旧服务注册的路由；补齐粗指针下的 44px 控件高度 token。 | 系统偏好和 change 事件回归；320px、浅色、触控模拟的真实页面截图；320/375px 布局检查。 |

## 关键实现位置

- `src/public/app.js:2-5`：跟随系统主题及偏好变化。
- `src/public/app.js:44-61`：会话用量局部不可用的独立状态表达。
- `src/public/app.js:76-135`：稳定 select、代理展开、任务序号和完整 ID 去重。
- `src/public/app.js:378-410`：动态目录、合法草稿和不可用提示。
- `src/public/app.js:412-442`：提交对账、请求身份与启动条件。
- `src/public/app.js:483-514`：有期限的 GET、代次与恢复机制。
- `src/public/app.js:516-563`：运行提交与未知结果处理。
- `src/public/index.html:6-17`：语义、精简 live region 与目录初始状态。
- `src/public/styles.css:246-250`：控件底边与粗指针目标尺寸。
- `src/public/styles.css:466-494`：代理展开、正常页面流与详情换行。
- `src/public/tokens.css:86-90`：44px 触控尺寸 token。
- `tests/web-ui-regression.test.js:46-346`：15 项 Web 回归。
- `tests/helpers/web-ui-fixture.js`：纯内存 DOM、请求和时钟替身。
- `package.json:11`：`npm test` 为 VM fixture 启用 Node 的 `--experimental-vm-modules`。

## 安全与兼容性边界

- 未调用真实模型，未触发真实基准、评分、基线、取消或其他业务 POST；运行与网络故障场景全部由合成数据完成。
- 未停止或替换既有 `http://127.0.0.1:4173/` 服务，未启动替代常驻服务；前端静态文件已由现有服务重新读取并验证。
- 没有新增 `/theme.js` 或其他静态路由；主题在已有 `app.js` 中执行，避免旧 Node 进程没有新路由时的 404。
- 未修改原生 WPF 跟随逻辑。原审查中“CLI 终端宿主是否被识别”仍是待实机验证风险，不作为已修复问题。
- 保留用户原有 README、docs/reports 和文件移动等无关改动；没有回滚或格式化它们。
- 合成验收使用独立浏览器页与内存 API，页面已关闭；没有写入 localStorage 或留下影响真实页面的请求拦截。

## 尚需人工验证

1. 真实 CLI 终端前台切换、多 DPI、多显示器和极矮工作区；本轮没有为了未证实的风险修改原生跟随规则。
2. NVDA/JAWS 实际播报；减少 live region 的范围已通过结构验证，但不能替代读屏人工测试。
3. 真实模型运行、评分与取消的业务链路；本轮刻意只验证合成请求与既有测试，避免实际模型调用。
4. 实体触屏设备；44px 目标尺寸在浏览器粗指针模拟中验证，未宣称覆盖全部实体设备。

## 复现验证

```powershell
npm test
npm run build
```

单独的 Web 回归：

```powershell
node --experimental-vm-modules --test tests/web-ui-regression.test.js
```

原审查目录中的 `web-functional-fixture.mjs` 是**旧缺陷复现脚本**，仍刻意断言旧行为；修复后不应将它当作通过性回归或产品失败。新的通过性测试以 `tests/web-ui-regression.test.js` 为准。
