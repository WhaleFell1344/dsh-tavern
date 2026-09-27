# Native archive opening window (2026-09-27)

## Contract and changes

New clients opt into `openingWindow: 1`. For eligible native story/script saves, the first `getSession` response projects only the latest 48 messages, at a pinned revision, and sends absolute message coordinates plus the total count. Legacy clients, legacy storage, explicit full reads, and saves requiring configuration adoption retain the complete-view path.

The storage window is a read-only wrapper, never a writable Chat or a full-view cache entry. Historical pages can be selected against the same immutable revision. Client compatibility placeholders are built locally instead of transferring one placeholder per historical message.

Startup recovery no longer unconditionally materializes every native Chat. It reads one message and header metadata, preserving checkpoint references for index recovery; actual legacy preset migration still obtains a complete writable Chat. Regeneration recovery remains unchanged.

Shared script iframes now receive their initial context through the authenticated parent message channel, rather than serializing it into executable iframe HTML. Companion modules wait for the original Helper readiness contract. Standalone preview documents retain their existing bootstrap.

## Remaining boundary

This is a bounded first-paint path, not a completed history-independent gameplay architecture. The client still requests a full compatibility view after publishing recent content; script execution waits for that complete view. This preserves synchronous historical Helper APIs and historical display behavior, but still incurs full reads/copies. Header operations and local compatibility placeholders also still scale with history. Settlement startup and general updates remain separate bottlenecks.

## Verification

Storage regressions verify bounded tail-page reads, no old-body materialization, pinned revisions across concurrent writes, and preserved startup checkpoint metadata. Protocol tests cover opt-in/fallback behavior, explicit full reads, immutable compact transport baselines, and first publication before compatibility hydration. Bootstrap tests cover authenticated one-time initialization and readiness ordering.

Performance uses isolated real DSH, native Session, official MVU, and Chromium with a fixed model. Fixture construction is outside the opening timer. Native Session fixtures are prepared as v3 before reopening, separating migration from native-format performance. The harness now forwards and asserts actual long model output; earlier `historyReady` runs without that forwarding were only 67 MB and must not be treated as 175 MB comparisons. Persistence assertions pin both sides to the same revision to avoid racing display writes.

### Large run: `output/e2e-gameplay/run-DrkaNu/report.json`

10,000 rounds / 19,999 messages; fixture JSON 391,573,699 bytes; estimated Chat JSON 451,036,312 bytes (above the complete-Chat cache ceiling); native Session v3; actual long model bodies.

- Runtime boot: 8,434 ms (reported separately).
- First window: positions 19,951–19,998, 793,527 response bytes. Server `getSession` 248 ms: window read 126 ms, window projection 117 ms.
- Session click to visible synthetic body: 10,977 ms. Reopening phase to visible body: 11,749 ms.
- Reopening phase to status iframe ready: 64,778 ms.
- Recalculation: failed at the 120,000 ms status update timeout. No completed settlement/persistence latency is claimed. Whole test failed, 257,532 ms.

No startup `recoverRuntimeHistory` complete-Chat read appeared before the first window in this trace. There is still a delay before the first `getSession` reaches the server. Later complete reads recur through conversation resolution, `runSettlement`, background-task begin, and the general update transaction. `syncSession` also recorded multi-second state/candidate work. These are remaining measured bottlenecks; the 248 ms response is not an end-to-end opening claim.

Earlier intermediate 1,000-round run `run-at0KQq` (17.46 MB) passed: first body 1,467 ms; status ready 3,205 ms; MVU completion to persistence 902.7 ms. Its fixture/implementation differ from the final large run, so it is not a controlled scaling comparison. Intermediate 67 MB runs and the earlier 175 MB failure are retained as diagnostic evidence, not directly comparable final benchmarks.

Final targeted regression suite: 175 passed, 0 failed. Generated client freshness check passed.

Final functional E2E: `output/e2e-gameplay/run-BeNzkc/report.json`, **passed in 38,823 ms**, `node tests/e2e/gameplay.mjs --native-format --mvu-incremental`. Covers native creation, real gameplay, refresh, old/latest-floor incremental variables, independent chat/script persistence, second-page synchronization, restart recovery, and continued writes. No uncaught browser exceptions.
