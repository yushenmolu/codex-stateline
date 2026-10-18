# Accepted plans

The user accepted this version and authorized a local Git commit and plan archival on 2026-10-18. Archival records that decision; it does not turn previously untested behavior into verified behavior or establish that an older running service has loaded the source.

## Current delivery

- [Live status and local-day usage](2026-10-18-live-today-usage-implementation-plan.md)
- [Native usage omission and freshness repair](2026-10-18-native-usage-bugfix.md)

## Preceding stages included in this version

- [Separate native usage window](2026-10-18-separate-usage-window-implementation-plan.md)
- [Usage chart and scan scheduling](2026-10-18-usage-chart-implementation-plan.md)
- [Usage discovery repair](2026-10-18-usage-discovery-bugfix.md)
- [Cockpit inline results](2026-10-18-cockpit-inline-results-implementation-plan.md)
- [Initial project plan](2026-10-18-initial-companion-status-plan.md)

Preceding specifications remain historical. The initial plan's review accepted a design, not a completed implementation. The original four UTC chart ranges and main-window chart were later superseded by five local-calendar ranges in a separate window. See the project [README](../../README.md) for current behavior.

## Verification and local evidence

Final automated evidence already recorded before archival: backend 374 tests (373 pass, 0 fail, 1 Windows symlink-permission skip), native widget 1621 checks, launcher 46 assertions, first-cap focused regression 10 checks, WPF render 31 checks, JavaScript build and native compilation exit 0. Documentation archival does not rerun those checks.

Detailed logs, screenshots, original-file backups and read-only local aggregates remain in their original repository-root `Temp/...` directories, identified in each archived document. Those directories are intentionally excluded from Git because they contain machine-specific diagnostics and verification data. A source checkout includes the tests and verification instructions, not those local evidence files.

The 203-second real scan retained partial global and today totals after budget exhaustion. It used maintenance source `FF288E2C`, before the final one-line initial-freshness correction; final source `6F081640` has focused and full-suite verification. Partial coverage is not a complete history or a billing total. Application-owned WPF rendering is not OS-input or multi-DPI verification. The existing service was not restarted, and the historical intermittent Edge timeout remains recorded in the Cockpit plan.

## Archival checks

Seven plans/repair records were moved here, all nine relative documentation links resolved, and the six business/test files in the final verification manifest retained their hashes. Only README.md and archival/Git metadata changed during archival. The initial snapshot retains existing end-of-line whitespace and final blank lines, including whitespace inside multiline C# regular expressions. Default `git diff --cached --check` reports those formatting warnings; a check excluding `blank-at-eol` and `blank-at-eof` found no other patch errors. No business source was reformatted for the commit.
