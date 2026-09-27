# Native Helper history on demand (2026-09-27)

## Changes

Eligible native saves publish the latest 48 messages and current header state. Both initial `getSession` and subsequent bounded-view refreshes use this path. The live view does not automatically request a complete compatibility view before starting scripts. Legacy clients, old storage/configuration, and explicit full-view requests retain their previous path.

Helper APIs preserve synchronous return values. Reading current/recent messages uses local data. Explicitly reading an unloaded message with `getChatMessages`, `getVariables`, or the shared script `SillyTavern.chat[index]` fetches just that message, at the revision of the visible context, and caches it locally. It never treats a placeholder as an empty historical message. `SillyTavern.chat.length` remains the full logical length.

The fallback uses synchronous XHR because these existing APIs return synchronously. A historical cache miss therefore blocks that script while the selected row loads; ordinary recent reads do not perform network I/O. Scripts deliberately scanning all historical rows still incur history-sized work. This does not claim all operations are O(1).

A per-process HMAC capability limits the read endpoint to one Chat revision and count; the client cannot substitute a different Chat or revision. The route is read-only, limits requests to at most 48 rows, is usable from opaque sandbox origins without cookies, and returns no-store JSON. Restart invalidates old capabilities; normal runtime-generation recovery obtains a new view.

The mutable native chat facade remains a real array (including structuredClone support), with accessors that load old rows only when accessed. Untouched placeholders are excluded from saveChat snapshots; loaded unsaved plugin edits retain their existing conflict and merge behavior. Held arrays from another Chat cannot resolve into the new Chat.

## Deliberate compatibility fallback

When an older assistant message outside the projected window enters the visible viewport, the browser requests a complete historical display view and retains complete-view mode for that session in this page. This preserves historical regex/template/receipt presentation. It is explicit historical browsing, not initial full hydration. Paging these display projections is still unfinished. Background settlement and general mutation paths can also still request complete Chat state.

## Validation

- Red-capable client test initially failed because the on-demand reader was absent; it now checks zero initial reads, no network for recent rows, exact synchronous old values, and one cached old-floor request.
- Capability tests verify pinned revision/range and reject forged or other-process grants.
- View tests cover no automatic hydration and bounded refreshes with an existing synchronization cursor.
- Mutable facade regression covers no placeholder writes, retained unsaved edits, and held old-Chat array isolation.
- First real browser sample: `output/e2e-gameplay/run-fHQCzE/report.json`, 100 rounds/199 messages, passed in 43,972 ms. Opening requested zero complete views and zero historical rows; an explicit old-floor read made one history request and matched disk for Helper text/variables and native chat text. Status ready 1,275 ms; MVU completion to persistence 726.8 ms. This small sample is functional evidence, not a large-archive performance claim.


Intermediate large run `run-Ajv8Go`: same 10,000-round / 391.57 MB fixture as the prior stage. Opening requested zero complete compatibility views and zero old-floor reads; an explicit historical read made one request. First body after session click 11,276 ms; status ready 41,774 ms (previous stage 64,778 ms). Settlement still failed at the 120 s timeout; this run is not a gameplay pass.

`run-RLSCbH` and `run-fvzQMW` isolated the opening phase only (no settlement or second restart). The former exposed the remaining full Chat read in `getUserPreferenceProfile`; the latter passed the then-narrow full-Chat cache assertion after changing that endpoint to a header projection. Later tracing showed that this assertion missed full Helper-context recovery reads and delayed display-capture reads; it was insufficient to establish bounded initialization. Status readiness nevertheless remained about 40 s. Runtime diagnostic/compatibility reports were then found to scan every message summary just to resolve session identity, and switched to the same header-only read. Helper worldbook reads also use a header projection; all worldbook write paths still use complete writable Chats.

`run-NxOUT3` passed the 100-round functional flow in 44,646 ms, adding historical plugin save/delete and an explicitly opaque sandbox iframe: invalid capabilities returned 403 and a valid capability returned the exact pinned historical row. These tests do not claim mobile/WebView coverage.

## Additional initialization paths

Global/character variable writes and extension-settings writes now validate Chat permission/lifecycle from the header; their existing independent resource persistence remains unchanged. Stale variable writes retain full recovery context. The narrow slice router always includes configuration identity fields, avoiding accidental full fallback when a caller requests only MVU fields.

Native session summaries share a bounded cache keyed by immutable snapshot identity (up to four entries, 16 MiB total, 8 MiB per entry). Concurrent readers share a load. Public arrays and scoped rows remain detached. Revision changes invalidate by identity; bodies and variable trees are not cached here. The first summary scan still scales with history length.

Nontransaction Helper context recovery opts into the same compact latest-window protocol. Transaction event recovery retains the old contract. Native display-runtime capture reads summary coordinates and only the selected diagnostic field at one pinned snapshot, preserving absolute indices and compare-and-swap revision.

The opening E2E assertion now runs after initialization and a three-second settling period, and checks both full Chat reads and full Helper-context reads. Earlier opening-only passes did not cover the latter and must not be interpreted as proof of zero complete historical materialization.

## Regression found during final validation

`run-x6FJVl` reached status readiness at 38,447 ms, but was deliberately terminated after a historical probe became blocked behind thousands of row reads (209,917 ms total; failed, not a performance pass). The facade was eagerly refreshing every previously loaded row when a compact context arrived. It now invalidates clean old rows without I/O and only eagerly merges rows with unsaved plugin edits; an explicit later read resolves the latest pinned row. A regression test covers full-to-window transitions with zero automatic reads.

`run-wHGxz1` completed the 100-round variable write, persistence and restart checks (browser completion to persistence 756.3 ms), but failed the final browser-error assertion with `Failed to fetch`. This run remains recorded as failed.


`run-LRrnWU` failed after 161,810 ms: the first facade fix was insufficient, and tracing identified lodash `slice(0, end).findLastIndex(...)` in bundled MVU's prior-snapshot lookup. That copied the entire prefix and triggered 19,953 historical requests including probes. The host build now searches backward directly with identical predicate/index semantics. Restoration eligibility is likewise bounded to the existing recent-floor threshold; restoration itself remains enabled. Transform tests compare slice boundary semantics and exercise 20,000-row arrays with read counters. Upstream source is unchanged; the host artifact and pinned SHA are rebuilt.

`run-kCoBpl` then had zero initial historical reads and three explicit requests (one old-floor read plus valid/invalid capability checks); status readiness was 39,644 ms. It still failed the stronger opening assertion because `getFullPromptTemplateState` subsequently materialized the complete Chat. This is the remaining measured initialization path. Do not call this a successful bounded-initialization or large-gameplay test.

The E2E cold-restart harness now closes the old page before stopping its isolated server, so an old page's background polling cannot race the deliberate server shutdown. Browser errors remain a failing assertion.

## Final functional result

`output/e2e-gameplay/run-AisSYx/report.json`: **passed**, 44,646 ms total, 100 rounds / 199 messages / 951,193 bytes. Status ready 2,221 ms, browser MVU completion to authoritative persistence 777.3 ms. This includes historical Helper/native reads, old-floor plugin data save/delete, opaque-origin valid/invalid capability checks, settlement, and server restart with persisted variables. Browser errors remain asserted empty.

A prior retry (`run-a5Ey12`) failed when the status iframe was replaced during initialization. The test now reacquires a detached frame within the same overall deadline; it still fails other errors and timeouts.

**Remaining work:** the full-template runtime initializes through `getFullPromptTemplateState`, which still reads the complete archive. Historical display paging and large-archive settlement are unfinished. The stricter 10,000-round opening check is intentionally still red. The latest complete 10,000-round settlement attempt in this stage timed out at 120 s. Small functional success does not establish large-gameplay readiness. Even with these changes, cold summary scans and client placeholder/index construction still scale with logical history length.

Final targeted suite: **226 passed, 0 failed** (`/tmp/lazy-all-final.log`). Generated client `--check` and `git diff --check` passed. The deterministic host build reproduced the committed MVU artifact (`ed62e955a79e3d464c9150c27c4d7f5b6d65324d9644270dcb314d5e41460ad9`). No mobile/WebView run, production migration validation, push or release was performed in this stage.
