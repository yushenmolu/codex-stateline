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
