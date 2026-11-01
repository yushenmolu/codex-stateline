# 原生动画预览加载竞态修复计划归档

## 归档记录

- 归档日期：2026-10-31。用户重启后反馈结果预览已能成功显示，并要求提交未提交的修复与归档修改计划。
- 状态：本次代码与回归检查完成；代码提交为 `a66f10a`（`Fix native preview loading races`）。本文件记录本次修复，不代表其他工作区改动一并提交。
- 范围：修复原生 Cockpit 预览切换时的旧状态泄漏与后台帧回调线程安全问题；不扩展到无关的工作区整理或 Web 界面改动。

## 根因与修复

| 问题 | 修复 | 状态 |
| --- | --- | --- |
| 新预览操作递增代次后仍暂存上一代快照；目标、错误状态与当前阶段可能交叉，界面会短暂读到不属于新操作的状态。 | 每次调度时以新的代次、目标和 `starting`/`closing` 状态初始化快照；仅当快照代次仍是当前代次时才把当前阶段附加到快照。 | 完成；`BrowserPreview` 回归覆盖新操作及 Stop 的快照身份、状态和阶段一致性。 |
| 浏览器帧事件可能在线程池线程触发；回调读取 WPF 图片控件，且帧诊断字段会被回调、UI 定时器并发读写。 | 后台回调只更新锁保护的帧队列和诊断信息，不读取 WPF 控件；诊断信息的 UI 线程读写统一经锁保护访问器。 | 完成；`WidgetWindow` 回归从后台线程发布帧并验证首帧仍可解码显示。 |

## 验证与审查

| 检查 | 结果 |
| --- | --- |
| `tests/native-preview.selftest.ps1` | 468 项检查通过。 |
| `tests/native-widget.selftest.ps1` | 1788 项检查通过。 |
| `git diff --check` | 通过。 |
| `tests/native-preview.selftest.ps1 -ProductionEdge`（最终修改后） | 两次尝试均未完成：一次遇到 Edge `Network.enable` 超时，另一次遇到预览 fixture 超时；不记为通过，也不据此断言根因仍存在。 |
| 独立只读复核 | 原发现已封闭，未发现直接的新问题。 |
| 用户端反馈 | 用户重启后反馈预览显示成功；此为用户观察，不能代替最终修改后的 ProductionEdge 验收。 |

## 验收边界

- 最终版本的真实 Edge `-ProductionEdge` 验收仍未确认；以上两个超时需在稳定环境下重试，不能用更早版本的通过结果替代。
- 本次提交只包含 `scripts/native/BrowserPreview.cs`、`scripts/native/WidgetClient.cs`、`tests/native-preview.selftest.ps1` 与 `tests/native-widget.selftest.ps1`。其余工作区修改保持未提交、未回退。
- 归档仅记录这次修改与验证状态，不表示未验证场景已通过，也不触及服务、认证或用户数据。

## 2026-11-01 补充：清理退出确认修复与 ProductionEdge 验收

### 根因

| 问题 | 修复 | 状态 |
| --- | --- | --- |
| `Members()` 在 Edge 辅助进程退出过程中，Job 的已分配数与列出数不一致时会抛错；清理随之失败并把 `exitUnconfirmed` 永久置位，此后每次预览都返回 `cleanup_failed`，只能重启小组件恢复，并在 `%TEMP%` 留下 `codex-html-preview-*` 目录。修复前 ProductionEdge 在 `tests/native-preview.selftest.ps1` 的 inline production cleanup 断言处失败。 | `Members()` 容忍计数变化；清理等待改用 Job 记账信息的 `ActiveProcesses`（`Active()`/`ActiveIn`）；终止后用 `ExitedNow` 同时确认 Job 与已固定进程句柄的退出。无法在预算内确认时保留 Job 句柄（`retainedJob`）与配置目录，返回 `retained_process_exit_unconfirmed`；之后的操作调用 `ConfirmRetainedExit()` 重新终止并确认退出，确认后删除旧目录并继续，无需重启小组件。删除目录的逻辑拆为 `RemoveDirectory`；工作线程退出与 `Dispose` 时终止并释放保留的 Job。 | 完成；新增回归：固定一个 Job 外的存活进程，验证停止时保留、进程存活时重开被拒、进程结束后重开成功且旧目录被删除。 |

### 验证

| 检查 | 结果 |
| --- | --- |
| `tests/native-preview.selftest.ps1` | 473 项检查通过。 |
| `tests/native-preview.selftest.ps1 -ProductionEdge` | 第一次在首次真实 Edge 启动时遇到 `Network.enable` 命令超时（5000ms，`CockpitBrowserGuard.Arm`），清理按设计返回 `retained_process_exit_unconfirmed`；随后重跑通过，754 项检查通过。该超时为间歇性的 Edge 环境问题，未在本次修改范围内。 |
| `tests/native-widget.selftest.ps1` | 1788 项检查通过。 |
| `npm run build` | 通过。 |
| `npm test` | 473 项测试：472 通过，0 失败，1 跳过（含 `tests/web-ui-regression.test.js`）。 |
| `git diff --check` | 通过。 |

本次提交同时包含 2026-10-26 Web 审计修复包（见 `docs/audit-2026-10-26/fix-report.md`）。
