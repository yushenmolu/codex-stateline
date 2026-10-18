# Cockpit inline results and local usage repair

## Archive record

- Archived: 2026-10-18. The user accepted the version containing this repair and authorized a local commit and plan archival.
- Evidence filenames, result.md and original-file references below resolve under repository-root `Temp/cockpit-inline-20261018/`; local evidence is excluded from Git.
- Historical test results and the intermittent Edge timeout remain unchanged. Acceptance does not establish that a running older service has loaded this source.

## Goal

Native pelican runs offer Cockpit only. Completed artwork opens inside the result dialog, including after reopening the dialog. Local aggregate usage must make progress across the user's stored sessions without silently treating unknown data as zero.

## Evidence and decisions

- WidgetClient switches Cockpit to Detached through OpenHtmlPreview. Closing that preview calls StopHtml and clears the dialog image.
- Initial history selection only authorizes inline preview after another explicit OpenResults call. Ordinary ready history transitions can remain blank.
- The running /api/usage endpoint returns partial/budget_exceeded with null usage. Two compressed-frame staging checks promoted a single-file limit to a global budget stop, preventing discovery of later valid logs. The file now fails locally and retains a budget gap while discovery continues.
- Preserve old artwork history formats, preview isolation, identity/generation checks, and all prior conversation-state fixes.
- Use fixture HTTP and synthetic artwork for verification. Do not invoke a model, restart the user's services/windows, or alter settings/dependencies.

## Stages

| Stage | Goal | Success criteria | Verification | Status |
| --- | --- | --- | --- | --- |
| 1 | Diagnose both paths and snapshot originals | Concrete lifecycle cause and usage scan cause; original files retained | Source inspection, read-only local API, headless fixture | Complete |
| 2 | Repair native result lifecycle | Cockpit-only controls; automatic inline completion/history/reopen; explicit inline retry; failed preview does not loop | Updated native-widget selftest and C# compilation | Complete |
| 3 | Repair aggregate scan progress | Valid totals or accurately labelled partial totals; one large file cannot halt unrelated sessions; bounds and deduplication retained | Focused aggregate tests and source-level integration | Complete |
| 4 | Verify and review | Final relevant tests pass; real headless and WPF preview evidence; independent read-only final review; limitations recorded | Native 1411 checks; usage 61 tests; Node 245 pass/1 skip; build; Edge 533 checks; WPF 15 checks | Complete |

## Ownership

- Root owns WidgetClient.cs, the plan, integration and serialized GUI/test execution.
- native_test_migration owns tests/native-widget.selftest.ps1.
- native_state_repair owns usage-summary.js and usage-summary.test.js; file-local frame cap repair and budget regressions.
- final_state_review performs a read-only final review after implementation and verification.

## Final verification

- Final native-widget selftest compiled the current C# sources and passed 1411 checks. A final legacy HTML closed-message regression exposed a fixture initialization omission; setting the preview intent before the simulated open repaired that test. The reviewer confirmed the correction and no remaining findings.
- Usage collector tests passed 61/61, including distinguishing regressions that fail against the original source. Other Node regression tests passed 245 with one Windows file-symlink privilege skip; the junction case ran. Build passed.
- Real Edge verification first timed out on the legacy Inline-to-Detached switch; the complete rerun passed 533 checks. The first failure remains recorded and its intermittent cause is unresolved. BrowserPreview.cs and CockpitBrowserGuard.cs are unchanged.
- A real WPF dialog with synthetic HTTP artwork passed 15 checks for automatic completion, live reload deduplication, Hide/Show and Close/Open. Final cleanup reported zero browser members and all three profiles removed.
- No real model calls or benchmark runs were made. The existing user service and widget were not reloaded, and the full real session archive was not rescanned. File-local budget failures remain partial coverage; no claim of a complete live total is made.
- The independent review found no remaining confirmed defects in the final changes. Details and evidence links are in result.md.

## Rollback and limits

Original file snapshots remain in `Temp/cockpit-inline-20261018/` as *.before. Restore only individual changes from this repair if requested; do not replace earlier user or agent changes. This plan was archived after explicit user acceptance on 2026-10-18. Source changes require a later authorized reload of existing processes to affect the running app.
