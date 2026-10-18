# Native Codex usage records omitted from global totals

## Archive record

- Archived: 2026-10-18, after the user's explicit acceptance of this version and authorization to commit locally and archive the plans.
- Evidence filenames below refer to repository-root `Temp/usage-live-today-20261018/`. Evidence remains local and is excluded from Git.

## Root cause

The collector accepted response-local token_usage_record records only. Native
event_msg/token_count cumulative usage was ignored. A directory containing only
older native records could therefore have no usable total despite containing
valid usage. Larger directories also need progressive background scanning, so a
short empty snapshot cannot establish that all history is unsupported.

Read-only aggregate inspection found native-only archived files and files with
both formats. Repeated token_count snapshots were common. Some last_token_usage
triples were inconsistent on repeated snapshots, so summing last values would
double count or introduce invalid usage.

A real 202-second fallback scan exposed a second cause of disappearing totals.
After the global bookkeeping budget was exhausted, scanExhausted stopped the
background scheduler. The last partial total aged past staleMs and both usage
and timeline were cleared. This is recorded as a failed verification, not as
successful real-data delivery.

## Accepted repair

- Keep response_id deduplication and response-local usage authoritative.
- Parse validated native cumulative snapshots with verified file/thread identity.
- Add only provable monotone counter intervals not covered by modern responses.
- Do not add an unverified inherited/fork baseline, decreasing counters, or
  ambiguous mixed-format overlaps. Retain explicit partial coverage.
- Revoke contributions when their source file is replaced, removed or invalid.
- Bound all new bookkeeping with the existing limits.
- Report native intervals separately from real responses. Preserve old clients
  and snapshots by making nativeIncrementsCounted optional with a zero default.
- Account for usage at the source record's confirmation timestamp. Native
  intervals use their endpoint timestamp, not an inferred per-token creation
  time. UI help and documentation must state this calendar accounting basis.
- Keep Codex-wide and selected-conversation totals independent of live state.
- After a hard budget stops new discovery and decoding, maintain the already
  counted sources with bounded metadata verification. Revoke changed, missing,
  unsafe or unreadable sources without re-reading them. Only a complete source
  verification cycle may renew freshness; stalled verification remains stale.
  Keep the existing limits and the explicit partial/budget_exceeded state.

## Verification

Before this repair, a bounded real 90-second scan produced a partial global
total and local-today timeline, but excluded native records. The fallback
version passed 81 collector tests, 39 HTTP tests, the full backend suite
(363 pass, 0 fail, 1 platform skip), native compilation and 1621 native fixture
checks. Independent review found no additional issue in that frozen version.

The subsequent real scan counted 46129 native increments and 5181 responses,
with today data available by 30 seconds. It then hit the shared bookkeeping
limit and became snapshot_stale after 111 seconds. real-global-after-fallback.log
and .json preserve that failure, with collector_stopped cleanup. These partial
observations do not prove complete history or a successful final interface.
The bounded maintenance correction passed 90 collector checks and its final
first-cap extension passed 10 targeted checks. The final source passed the
complete backend suite: 374 tests, 373 pass, 0 fail and 1 Windows symlink skip.
build-delivery-final.log records a successful build. Native compilation and
1621 fixture checks pass; render-current-state.log records 31 successful WPF
checks with real public aggregate and event-counter replay.

real-global-maintained.log records a 203-second read-only scan. Global usage
and local today stayed visible beyond the original failure point. The final
snapshot contains 4646443475 global tokens and 87575612 today tokens in
Asia/Shanghai, based on 4091 responses plus 46129 native increments. Coverage
remains partial/budget_exceeded (1204 discovered, 1181 complete, 23 failed,
667 invalid records). This does not establish a complete local or billing total.
The collector was stopped; there were no model calls or history writes.

The long real scan used source FF288E2C, before the one-line initial freshness
correction. Final source 6F081640 initializes that clock once so a blocked first
maintenance cycle can become stale; the final targeted test covers the real
reachable first-cap path and the final full suite covers that source.
Independent review verified the correction and reported no unresolved finding.

## Status

Implemented and verified within the explicit partial-coverage limits. The user
accepted this version on 2026-10-18 and requested archival. The existing user
service has not been restarted, so the running older instance has not loaded
these changes. Acceptance does not add OS-input or multi-DPI test evidence.
