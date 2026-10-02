# Browser backend selection

The existing Browser executor dynamically lists the official `agent.browsers.list()` inventory. It preserves provider identity internally and uses `agent.browsers.get(exactId)` for every selected backend. No new Browser framework, raw CDP transport, Chrome process manager, profile-directory scan, extension installer, or durable backend configuration is introduced.

## Public contract

`codex.browser_status` exposes up to 64 backends through `connectedBrowsers`. Each entry contains an ephemeral opaque `browser_backend_<uuid>` ref, `name`, `family`, `profileName`, `type`, `supported`, and detected browser-handle capabilities. Provider IDs and `metadata.extensionInstanceId`/`metadata.codexSessionId` stay private. An invalid, duplicate-ID, or oversized inventory fails closed instead of truncating away possible ambiguity.

`codex.browser_tabs` and `codex.browser_prepare_open_tab` accept optional `backendRef`. The existing family choice remains `chrome|edge`; new-tab preparation still requires an explicit family and http(s) URL. With one compatible backend, omission remains automatic. With multiple compatible backends, omission returns `BROWSER_FAMILY_BACKEND_AMBIGUOUS` and bounded safe choices. No selection by profile name, index, provider ID, or remembered default is accepted.

The fixed public tool count and allowlist remain unchanged. This is an additive input/output contract within the current preview version; package/server/surface versions are unchanged. The repository release manifest is regenerated for the changed source tree. Installed release identity is never edited.

Each tab ref binds the exact backend ref, Workbench generation, family, and provider tab identity. Map keys contain backend ref plus provider tab ID, so identical provider tab IDs in two profiles cannot collide. Tab, prepared action, bulk-close set, element action and WebMCP bindings retain that selection. Bulk-close preparation rejects mixed backends even within one family. Later operations cannot change backend; they re-enumerate and validate the exact ID, type, family, optional metadata identity and returned handle identity before claiming or dispatching.

Runtime generation changes clear backend/tab/action maps. A disappeared backend or changed extension/session identity retires its backend ref. Rediscovery creates a new ref if a removed identity later reappears. Renaming a profile changes display data without redirecting its ref. Refs must never be persisted as durable configuration.

## Capability matrix

Only official Chrome/Edge `extension` backends are eligible for operations in this patch. `cdp`, `iab`, and `mcpapps` inventory entries remain discoverable but unsupported for this extension-oriented executor. Capability discovery checks documented method availability on the exact handle, rather than granting operations from the type string alone. Tab methods are checked on the claimed/created tab; inventory does not claim tabs to speculate about tab capabilities. A missing API fails explicitly before dispatch when that can be proven; errors after a possible mutation retain uncertainty and no replay.

| Operation | Official extension API | Executor behavior / current runtime catch |
|---|---|---|
| Agent-tab listing | `browser.tabs.list()` | Documented; existing public tab list uses external/user listing |
| Existing external/user tabs | `browser.user.openTabs()`, `claimTab(exactReturnedObject)` | Method-detected; provider tab IDs stay private |
| Open tabs | `browser.tabs.new()`, `tab.goto(url)` | Exact backend stored at prepare time; tab methods checked after creation; later failure remains uncertain |
| Reading | `tab.playwright.domSnapshot()` | Method checked; existing password redaction retained |
| Screenshots | `tab.screenshot({fullPage:false})` | Method checked; existing viewport and size constraints retained |
| Navigation | `tab.goto(url)` | Existing exact URL and page binding retained |
| Playwright locators | `getByRole`, `getByText`, `getByPlaceholder`, `locator` | Required tab entry methods checked; existing semantic-target restrictions retained |
| Click / fill | Official locator `click()` / `fill()` and existing narrow compatibility paths | Existing prepared action, exact-target and post-write verification retained |
| Fixed keypress | Current docs expose locator `press()`; older runtimes expose `dom_cua.keypress()` | This upstream-main feature branch retains main's existing fixed DOM CUA path and explicitly detects its absence. PR #8's separate compatibility change is not copied into this branch or removed from the install |
| Cleanup / finalization | Current runtime: `markDeliverable()` / `markHandoff()` and turn cleanup; older runtime: `tabs.finalize()` | Existing lifecycle adapter retained. Both live extension profiles lack explicit `tabs.finalize()`; operations needing proven explicit release, including existing-tab close/bulk-close, remain blocked. Read cleanup may be deferred |
| WebMCP | Optional `tab.capabilities.get("webmcp").fetchTools()` | Existing bounded descriptor/call API retained, with backend added to server/node-side binding; backend type alone never grants it |
| Raw CDP | No public raw endpoint | No new support. The pre-existing bounded model-route diagnostic is unaffected |

## Live diagnosis (2026-10-02/03, Asia/Bangkok)

The initial official inventory had only Enigmaballz open. After the user opened the additional profiles, direct `await agent.browsers.list()` was rerun, including after confirmation that the extensionless profile identified as Koala and Jogalern was open.

| Name | Family | Profile name | Type | ID exists | Extension instance ID exists | Codex session ID exists |
|---|---|---|---|---|---|---|
| Chrome | chrome | Enigmaballz | extension | yes | yes | no |
| Chrome | chrome | Chell | extension | yes | yes | no |
| Codex In-app Browser | absent | absent | iab | yes | no | yes |
| Codex MCP Apps | absent | absent | mcpapps | yes | no | yes |

`agent.browsers.get(exactId)` selects the two Chrome backends distinctly; each returned `browserId` matches its inventory identity. Both expose `user.openTabs`, `user.claimTab`, and `tabs.new`, and neither exposes `tabs.finalize`. No backend corresponding to Koala or Jogalern, and no backend of type `cdp`, appears in this session. This establishes that extensionless control is not exposed through this API here; it does not prove that the official runtime can never support it elsewhere. There is no workaround in this patch.

The official product documentation describes extension setup in the intended profile: [Browser extension](https://learn.chatgpt.com/docs/chrome-extension). Implementation-specific authority is the installed official Browser API reference and packaged tab-claiming, cleanup and WebMCP documentation, plus the live inventory; general product documentation is not evidence of a CDP backend.

## Validation and update safety

`test/browser-backend-selector.mjs` executes the generated executor bodies in a VM with official-shaped Browser handles. It covers automatic single-profile behavior, two profiles with colliding provider tab IDs, exact selection, ambiguity, name duplication/renaming, backend disappearance/metadata replacement, runtime generation changes, stale prepared refs, unknown/raw selectors, missing APIs, no speculative backend support, mixed-backend bulk-close rejection, pre-dispatch races, malformed/bounded inventory, wrong returned handles, and post-creation uncertainty. The maintained Browser operator and full npm suites include it.

Live validation uses the fresh executor's generated inventory/tab-list code against the already initialized official agent. It permits only inventory and tab-list calls, never claims tabs or dispatches page actions. It checks both exact profile selections, ambiguity, opaque tab binding and local executor-generation invalidation. This is repository-harness validation, not a deployed installed-server test.

The installed runtime status initially reported `BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED`. Its executor, Browser tool, package and release-manifest hashes are recorded outside the install. The install is not patched or restarted; PR #8's keypress hotfix remains intact. No automatic patch helper is created. Future releases can replace local hotfixes normally. The durable result is this feature branch/commit and any later approved upstream PR.

Backend/profile counts, names, provider IDs, extension IDs, tab IDs, paths and ports are not baked into implementation. The only type/family limits are the explicit supported contract. Runtime APIs may change; the existing compatibility fingerprint gate and capability checks remain authoritative. The feature must be retested against a real supported CDP backend before that type could be enabled.

Validation results: the 14 new selector regressions pass; the focused Browser operator/selector set passes 117/117, and the Browser reader/elicitation adapter suite passes. Repository-harness live validation passed for both Enigmaballz and Chell with one user tab each, exact backend/tab binding, ambiguity rejection and stale-generation rejection, with zero claims and zero page mutations. `npm run test:contract` and full `npm test` stop at the unchanged `test/codex-version-gate.mjs`: Codex 0.159.2 reports `windows sandbox: CreateProcessWithLogonW failed: 2`. The full run passed release identity, lifecycle, Windows installer E2E, bootstrap archive and bootstrap persistence before that failure. Permission/sandbox environment controls were not removed. Remaining focused checks are run separately; this is not represented as a fully green npm run.

Additional final checks passed: Browser runtime compatibility resolver, public runtime Browser guardrails, doctor Browser/core health, public registration allowlist (44 tools unchanged), stock prompt catalog, recent-call diagnostics/HTTP, metered consent, task consent cards, reasoning effort and public command policy. `git diff --check` passed. Public-contract integration reached the runtime tool-list/schema assertions, then failed at consent preparation after Codex authentication reported `invalid_refresh_token`/401 and the same Windows sandbox process-launch error. The failing version-gate/public-contract tests and authority executor have no diff from upstream main. No authentication repair, permission change or installed-runtime restart was performed.

PR #8 was verified through GitHub API to remain open on `fix/browser-keypress-compat` at `cf4d388b5894cff0009ef6c378dcdd53dbd53fc6`. Its worktree remains clean at the same commit. This feature is ready for code review, but full integration validation remains blocked; it is not represented as fully PR-ready until the maintained npm/public-contract gates can run successfully in a working Codex sandbox/authentication environment. No push or new PR is authorized or performed.
