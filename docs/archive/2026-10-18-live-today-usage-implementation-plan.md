# Codex live status and local-day usage

## Archive record

- Archived: 2026-10-18, after the user's explicit acceptance of this version and authorization to commit locally and archive the plans.
- Status: implementation, automated verification and version acceptance complete. The documented limits remain applicable.
- Evidence filenames below refer to repository-root `Temp/usage-live-today-20261018/`. Evidence remains local and is excluded from Git.

## Scope

- Keep the separate usage window and the existing Cockpit result preview.
- Show live request/conversation state only from an actual event source. Do not relabel session-log polling as live telemetry.
- Keep Codex-wide usage independent of selected conversation statistics.
- Add today before 7d / 30d / 90d / all, using the machine's calendar and time zone.
- Do not alter Codex authentication, configuration, user history, or existing services.

## Stage 1: Establish sources and contracts

- Goal: identify a usable live source and freeze the usage timeline contract.
- Success criteria: distinguish event timestamps from sampling time, conversation from request identity, and live counters from historical totals.
- Tests: inspect installed protocol and Magpie client code; bounded read-only connection checks without exposing payloads or credentials.
- Status: complete. Inspected Magpie's sequenced event trace and the installed Codex desktop protocol. The default daemon socket was unavailable, but the existing desktop IPC supports passive owner discovery and thread-state subscriptions. A bounded real check confirmed pinned and follow snapshots without creating/resuming a thread or calling a model. Collector contract uses five local-calendar ranges; old four-range UTC payloads remain readable.

## Stage 2: Implement independent data paths

- Goal: preserve Codex-wide aggregation and add local today buckets; connect live status through its own API/UI state.
- Success criteria: history cannot overwrite live state; null/partial/zero retain their meaning; source disconnects cannot present stale data as live.
- Tests: collector tests, API tests, native fixture smoke, and explicit old-service compatibility.
- Status: complete. Independent live core, IPC connector, HTTP route and native state are implemented. Real event source is available; history cannot overwrite live data. Today/DST aggregation and the conservative native token_count fallback are implemented, with separate nativeIncrementsCounted metadata. Budget exhaustion now starts bounded verification of retained sources; it does not extend any limits or admit new usage. Changed or unsafe sources are revoked, complete verification cycles renew freshness, and a stalled cycle remains stale.

## Stage 3: Verify and deliver

- Goal: verify normal and unavailable states, calendar boundaries, cross-conversation totals, and separate-window behavior.
- Success criteria: appropriate tests/build pass with actual logs; screenshots show today and accurate source labels; independent read-only review is addressed.
- Tests: bounded unit/API/native tests, local read-only source probe, WPF fixture screenshots, independent final review.
- Status: complete; the user accepted this version on 2026-10-18. Final source backend-delivery-final.log: 374 tests, 373 pass, 0 fail, 1 Windows symlink-permission skip; native fixture 1621 checks pass; launcher 46 assertions pass; build and native compilation exit 0. Real read-only IPC probe confirmed pinned and follow sources. The 203-second maintained scan retained global and today usage after the previous failure point, with explicit partial/budget_exceeded coverage. WPF rendering passed 31 checks using the public real aggregates and event counters, including five ranges, independent scope, reopen/disconnect/recovery and short-screen scrolling. Independent review verified the IPC and freshness fixes. No live user service was restarted. User acceptance does not add OS-input, multi-DPI or multi-monitor test evidence.

## Final evidence

- Final backend: backend-delivery-final.log; build: build-delivery-final.log; native: compile-native-final.log and native-widget-final.log; launcher: native-launcher.log.
- Event probe: real-live-final.log and real-live-public.json. Metadata-only; follower stopped; no model calls or history writes.
- Real maintained scan: real-global-maintained.log and .json. At 203 seconds: 1204 discovered files, 1181 complete, 23 failed, 4091 responses and 46129 native increments. Global total 4646443475 tokens; local-today total 87575612; Asia/Shanghai. Both totals are verified subsets, not complete history.
- The real scan ran maintenance source FF288E2C. The final source 6F081640 differs only by one-time initial freshness setup; budget-first-cap-focused.log covers that boundary (10/10), and backend-delivery-final.log tests the final source.
- Render: render-current-state.log and nine PNG files. Application-owned WPF rendering and commands with real-data replay; no OS mouse/keyboard automation, no live service restart.
- Prior failed verification is preserved in real-global-after-fallback.log and .json. It must not be reported as a successful final scan.

## Known limits

- Provider usage is confirmed when the upstream source reports it; request activity does not prove precise per-token streaming.
- Only verified source identities may populate a selected conversation. An unmapped route/session must not be guessed from recent activity.
- Complete historical coverage depends on the collector's explicit coverage state; partial totals remain labelled partial.
- The OS-level computer-use channel was unavailable in the previous stage; application-internal WPF events and screenshots must be reported as such if that remains unchanged.
- Existing user services have not been restarted or taken over. Source changes are not proof that an older running instance has loaded them.
- Independent review verified the IPC fixes, bounded maintenance and first-cap freshness correction; no unresolved confirmed finding remains. Budget-mode deletion of only a modern source lacks a separate combination regression, although the dynamic overlap and rollback paths are covered individually.
- The existing 4173 service was observed to lack live-telemetry-v1. Loading the changed files requires replacing that older service through its normal owner; this work does not terminate it or claim the running widget is updated.
- The user explicitly confirmed this version on 2026-10-18 and requested plan archival; this plan is now archived under `docs/archive/`.
