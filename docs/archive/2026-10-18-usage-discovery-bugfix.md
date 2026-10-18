# Local usage stays empty during discovery

## Archive record

- Archived: 2026-10-18. The user accepted the containing version and authorized a local commit and plan archival.
- This record retains the preceding stage's test results and UTC chart specification; current behavior is documented in README.md and the live/local-day plan.
- Evidence remains under repository-root `Temp/usage-chart-20261018/` and is excluded from Git.

## Root Cause

Discovery pauses after finding a new file. Once that file has been read, the scheduler only checked file work and chose the one-second idle delay even while the discovery sweep was unfinished. Initial live observations advanced about one old file per second with zero response-level records, although bounded samples of recent logs contained valid modern usage. File-local failures also take precedence in the status reason, obscuring ongoing discovery. Later observations of the unchanged old process did yield valid partial totals, confirming that a failure reason alone does not prove the whole scan stopped.

## Repair

Treat an unfinished discovery sweep as pending work. Keep the existing per-round and global limits, response deduplication and file-local failure handling. Display discovered/completed file and counted-response progress in the native usage card. Add the bounded UTC timeline needed for the requested chart without rescanning files on HTTP GET.

## Validation

- Scheduler regression fails before the change (1000ms instead of 5ms) and passes after it.
- Collector: 66 tests passed, including UTC ranges, timestamp rollback, partial/zero, overflow, stale, stop, no GET file IO and public projection.
- Related Node suite: 249 passed, zero failed, one Windows file-symlink test skipped for missing privilege. The 32 HTTP tests are included in this suite. Build syntax checks passed.
- Native compilation and selftest: 1435 checks passed, including repeated-snapshot keyboard focus retention after independent review identified that issue.
- Independent read-only real collector: 549 valid responses and 28,697,429 tokens after about 10 seconds. This is partial coverage, not the full local total.
- Actual WPF controls rendered that aggregate for all four slider positions, short-window scrolling and disconnect: 15 checks passed. Screenshots inspected. OS-level input could not be exercised because the installed Computer Use helper pipe was unavailable.
- Independent final review: the sole focus-retention finding was repaired and its targeted recheck closed; no other confirmed findings.

Evidence and exact commands: `Temp/usage-chart-20261018/result.md`. Source originals remain in that directory for a scoped rollback.

## Status

Implemented and verified; the user accepted the containing version on 2026-10-18 and requested archival. Loading into the existing desktop session remains a separate action: the existing service has not been restarted or taken over. Closing the original launcher-owned main window permits its normal identity-checked service cleanup; reopening `Start-Codex-Widget.vbs` loads the new source only when its service also starts from that source. A reused older service does not reload automatically. If a service is reused and remains running, confirm its owner before stopping it. Do not force-stop unknown processes.
