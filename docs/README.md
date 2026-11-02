# 文档与仓库整理记录

本目录收纳设计规格、实测报告与已验收的计划归档，同时保存 2026-10-24 的仓库整理清单。

## 整理结论

整理按"标准整理"档执行：只移动和归置文件，删除仅限一处可再生的生成物，未删除任何源码、文档或会话数据。整理前仓库已处于干净状态（Git 无未跟踪文件、无未提交改动），因此改动集中在少量遗留物上。

**整理前**：100 个文件（不含 `.git`），98 个受 Git 跟踪，0 个未跟踪。
**整理后**：99 个文件，98 个受 Git 跟踪，1 个按既有规则忽略。

文件总数减少的 1 个就是被删除的生成物；受跟踪文件数不变，因为全部移动都是重命名而非新增。

## 移动清单

| 原路径 | 新路径 | 理由 | 同步的引用 |
| --- | --- | --- | --- |
| `scripts/probe-codex-ipc.mjs` | `docs/reports/tools/probe-codex-ipc.mjs` | 一次性只读 IPC 探针，零处代码引用，不在 `npm` 脚本链路上；与同目录其余测量脚本性质一致 | 根 `README.md` 文档索引段补充说明 |
| `scripts/probe-codex-threads.mjs` | `docs/reports/tools/probe-codex-threads.mjs` | 同上 | 同上 |
| `scripts/probe-effort-frames.mjs` | `docs/reports/tools/probe-effort-frames.mjs` | 同上 | 同上 |
| `open-pelican-animation.vbs` | `scripts/open-pelican-animation.vbs` | 根目录只应保留唯一双击入口；它只是 `scripts/open-pelican-animation.ps1` 的启动壳，与目标脚本同目录更合理 | `.vbs` 内部相对路径已改为同级解析；根 `README.md` 仓库结构段补充说明 |
| `tmp-one/archived_sessions/rollout-2026-07-22T23-41-15-019f8a7c-....jsonl.zst` | `tests/fixtures/rollout-archive/archived-rollout-2026-07-22-sample.jsonl.zst` | 从"疑似临时垃圾目录"变为有据可查的测试样本；文件名去掉过长的时间戳与 UUID，保留日期以便对照 | 根 `README.md` 文档索引段补充说明 |

## 删除清单

| 路径 | 理由 |
| --- | --- |
| `output/pelican-latest.svg` | 可再生的基准生成物。`.gitignore` 的 `/output/*` 规则本就把整个目录排除在版本控制之外，仅放行交付用的 `pelican-362f3c3d-animated.svg`；后者保留且被 `scripts/open-pelican-animation.ps1:27` 引用 |

## 一并清理的空目录

`tmp-one/sessions/` 与 `tmp-one/archived_sessions/`：前者从来就是空的，后者在归档文件移走后变空。整个 `tmp-one/` 目录随之移除。

## 未动的项

| 路径 | 原因 |
| --- | --- |
| `Start-Codex-Widget.vbs` | 必须留在根目录。桌面快捷方式 `Codex 小组件.lnk` 的 `Arguments` 硬编码了这个绝对路径，`scripts/install-widget-shortcuts.ps1:13` 也按根目录拼路径。移动会同时打断已创建的 `.lnk` 和快捷方式生成脚本 |
| `src/`、`tests/`、`scripts/native/`、`assets/` | 结构已符合 `README.md` 的仓库结构说明，无需调整 |
| `.git/` | 整理只做工作区改动。所有移动用 `git mv` 完成，保留了文件历史，但未提交 |

## 路径解析的验证方式

`scripts/open-pelican-animation.vbs` 移动后，第 6 行由 `"scripts\open-pelican-animation.ps1"` 改为 `"open-pelican-animation.ps1"`，因为基准已从仓库根变为 `scripts/`。验证用临时 `cscript` 探针放在同一目录下执行，复现其表达式：

- 新表达式解析到 `scripts\open-pelican-animation.ps1`，文件存在。
- 旧表达式从新位置解析会失败，证明这一行必须改。
- 根目录 `Start-Codex-Widget.vbs` 的 `scripts\start-floating-widget.ps1` 表达式仍然成立。

`scripts/open-pelican-animation.ps1` 未移动，其 `$PSScriptRoot` 仍是 `scripts/`，第 27 行的 `../output/pelican-362f3c3d-animated.svg` 因此不受影响，`-SelfTest` 返回 `{"status":"PASS"}`。

## 整理后的验证

```
npm run build        exit 0
node --test tests/*.test.js    421 tests, 420 pass, 1 skipped, 0 fail
powershell ...open-pelican-animation.ps1 -SelfTest    {"status":"PASS"}
```
