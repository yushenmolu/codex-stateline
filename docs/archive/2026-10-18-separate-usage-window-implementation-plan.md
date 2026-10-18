# Separate Usage Window

## Archive record

- Archived: 2026-10-18. The user accepted the version containing this stage and authorized a local commit and plan archival.
- Evidence filenames and original-file references below resolve under repository-root `Temp/usage-window-20261018/`; local evidence is excluded from Git.
- The four-range chart in this historical stage was subsequently extended to five local-calendar ranges. Historical scope restrictions describe that stage, not the later commit authorization.

## Goal

Move the complete local usage card into one independent native window, opened from the compact main widget. Preserve the current four-range chart, counts, progress, unknown-value semantics and background updates.

## Stages

| Stage | Goal | Success Criteria | Tests | Status |
| --- | --- | --- | --- | --- |
| 1 | Separate the native view | Main contains one entry; usage window is nonmodal, owned, bounded and singleton | Native compilation and source inspection | Complete |
| 2 | Preserve lifecycle and data | Close/reopen retains range and latest data; Escape closes only usage; closing main closes usage | Native fixture regression and actual WPF rendering | Complete |
| 3 | Verify and document | Existing chart/Cockpit checks pass; independent review findings addressed; README current | Native selftest, screenshots, scoped read-only review | Complete |

## Ownership And Limits

Root owns WidgetClient.cs, README, this evidence directory and the single GUI test session. native_test_migration owns only tests/native-widget.selftest.ps1. final_state_review provides the read-only final review. No backend contract, collector, preview engine, dependencies, credentials, live services or user data changes are required. Originals are retained here; apply only scoped diffs for rollback and preserve later edits. No commit or deployment is authorized.

## Evidence

- Native compilation passed (exit 0): compile.log.
- Actual isolated WPF rendering passed 27 checks: render-usage-window.log; eight PNGs show compact main, all four ranges, short-window scrolling, disconnected reopen and restored 30-day range.
- Rendering used the preceding stage's read-only partial local aggregate snapshot (28,697,429 tokens). The current-conversation card is fixture example data; no live model calls, service restarts or OS-level input verification occurred.
- Native selftest passed 1,462 checks (exit 0): native-widget.log and native-widget-result.json; tests preserved chart error/focus checks and added singleton, hide, Close/Escape, retained range, closed updates, owned-window cleanup and no-extra-request checks.
- Final compilation and npm build passed (exit 0): compile-final-result.json, build-result.json and build.log.
- README describes the independent window and lifecycle. Independent read-only review found no confirmed defects; see review.md.
- Implementation and automated verification are complete; the user accepted the containing version on 2026-10-18 and requested archival. Human OS-input, multi-DPI and multi-monitor checks have no new test evidence from archival.
