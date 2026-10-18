# Native usage chart and scan scheduling

## Archive record

- Archived: 2026-10-18. The user accepted the version containing this stage and authorized a local commit and plan archival.
- Evidence filenames and original-file references below resolve under repository-root `Temp/usage-chart-20261018/`; local evidence is excluded from Git.
- This is the historical main-window, four-range UTC specification. Later stages moved the chart into a separate window and added local-calendar today. Stage-specific restrictions remain historical.

## Goal

Show local usage in the native main window with a four-position range slider and stacked input/output bars. Make unfinished discovery continue promptly so valid modern records reach the total.

## Decisions

- Keep the lifetime input/output/total counters independent of the selected chart range.
- Chart ranges are 7, 30, 90 days and all observed history, using UTC day boundaries. The HTTP snapshot contains four precomputed ranges with at most 14 buckets each.
- Unknown buckets remain unknown. Partial totals are labelled as a subset; only complete coverage proves a zero bucket.
- The scanner uses its busy delay while discovery is unfinished, preserving all byte, file, response and discovery-operation limits.
- Preserve the existing Cockpit preview lifecycle, conversation continuity, service identity checks and public endpoint restrictions.

## Stages

| Stage | Goal | Success Criteria | Tests | Status |
| --- | --- | --- | --- | --- |
| 1 | Diagnose and freeze data contract | Live progress distinguished from a stopped scan; originals retained; timeline bounded | Read-only API samples and bounded record-shape checks | Complete |
| 2 | Implement collector and main-window chart | Deduplicated time buckets, prompt discovery, slider and accessible chart in the main window | Collector 66 pass, HTTP 32 pass, native 1435 checks | Complete |
| 3 | Verify actual behavior | Build and related tests pass; native rendering inspected; current source produces a real local partial total | Related Node 249 pass/1 privilege skip; build pass; WPF 15 checks; real collector yields partial total in 10s | Complete |
| 4 | Review and document | Independent review findings addressed; evidence and deployment limits recorded | Sole focus finding fixed and targeted recheck closed; result.md and BUGFIX updated | Complete |

## Ownership

- Root: WidgetClient.cs, native-widget.selftest.ps1, README.md, evidence and serialized desktop validation.
- native_state_repair: usage-summary.js and usage-summary.test.js, including public projection.
- native_test_migration: server.test.js.
- final_state_review: independent read-only review of the final delta and evidence.

## Limits

No model calls, configuration changes, dependencies, commits or changes to unknown running processes. Existing services are observed; the new collector can be exercised independently against local files without running another benchmark or server. Originals are retained as *.before in this directory. Do not restore a whole file over subsequent edits.

## Acceptance And Loading

Implementation, automated checks and scoped review are complete; the user accepted the containing version on 2026-10-18 and requested archival. OS-level desktop input remains unverified because the installed helper pipe was unavailable; native WPF rendering and application commands were exercised instead. The user's service observed during this stage had no timeline field and was not restarted. Loading the new version into that session remains separate from archival; no live deployment is claimed.
