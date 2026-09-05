import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerBrowserPreviewTools(server, browser, { elicitationBridge = null } = {}) {
  if (!browser) return;
  if (elicitationBridge) server = browserElicitationRegistrationServer(server, elicitationBridge);

  server.registerTool(
    "codex.browser_status",
    {
      title: "Check Existing-Login Chrome Browser",
      description:
        "Read-only Browser status probe. Check whether the current Codex Chrome Skill, node_repl body, and connected Chrome extension/backend are available for existing-login browser work. This starts no Codex model turn and inspects no page content. Website authentication is site-specific and is not inferred merely from extension connectivity.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Skill/MCP context; it is not browser navigation or a permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.status(input))
  );

  server.registerTool(
    "codex.browser_confirmation_policy",
    {
      title: "Read Codex Browser Confirmation Policy",
      description:
        "Read-only Browser authority helper. Dynamically read the current Codex Chrome Skill's maintained `confirmations` policy so the caller can apply the same default risk taxonomy instead of maintaining a parallel hard-coded permission table. The response also carries this product's task-level verbal-confirmation guidance: ask at most once for a bounded browser task when the Codex policy indicates confirmation is needed, unless the task materially expands or a higher-level rule requires action-time confirmation. This tool does not start a Codex model turn, grant permission, inspect a page, or mutate browser state.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Chrome Skill/runtime. It is not a permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => browser.confirmationPolicy(input))
  );

  server.registerTool(
    "codex.browser_emergency_reset",
    {
      title: "Emergency Reset Browser Control State",
      description:
        "Explicit administrator fallback for Browser claim/session deadlock. Restart only the dedicated Codexless Browser Workbench/control plane, advance its generation, and invalidate all prior Browser tabRef/prepared-action bindings. This never closes, navigates, reloads, clicks, fills, submits, or otherwise mutates a real Chrome tab, and it never replays a prior mutation. Before reset, Codexless refuses while this Browser runtime can prove any mutation is still in flight; new mutations are blocked while reset runs. The reset may interrupt a Browser session that is still doing read/control work, so apply the current Browser confirmation policy and explicit user/admin instruction before calling it. This is an emergency fallback, not a substitute for normal handback/stale-owner recovery.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to address the current dedicated Browser runtime. It does not select a tab, claim, URL, browser profile, or authority scope."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.emergencyResetControlState(input))
  );

  server.registerTool(
    "codex.browser_tabs",
    {
      title: "List Existing Browser Tabs",
      description:
        "Read-only Browser tab-list tool. List tabs already open in one connected stock Codex Browser family (`chrome` by default, or `edge`) and return family-bound opaque tabRef values plus visible title/url/lastOpened. The Browser runtime automatically supplies the Codex Browser turn metadata required by the current runtime. This tool does not open, navigate, click, submit, or modify any tab, and a tabRef minted for one family cannot be used against another family.",
      inputSchema: z.object({
        family: z.enum(["chrome", "edge"]).default("chrome")
          .describe("Connected stock Codex Browser family to list. This selects only `chrome` or `edge`; it is not a profile/backend id or authority selector."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve the current Codex Browser runtime; it does not choose a browser profile or widen authority."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.listTabs(input))
  );

  server.registerTool(
    "codex.browser_read",
    {
      title: "Read Existing Browser Tab",
      description:
        "Read-only Browser DOM tool. Read a DOM snapshot from exactly one existing browser-family tabRef returned by codex.browser_tabs. The tab is claimed through the current Codex Browser body only for read access; the Browser runtime does not navigate, click, type, submit, open a new tab, or expose raw provider tab IDs. The response includes the tab's current title/url so site-specific login redirects remain visible instead of being guessed.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw browser/provider tab IDs are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve the current Codex Browser runtime; it is not a browser navigation target or permission selector."),
        maxChars: z.number().int().min(1_000).max(200_000).default(80_000)
          .describe("Maximum DOM snapshot characters returned. The Browser runtime reports the original character count and whether truncation occurred."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.readTab(input))
  );

  server.registerTool(
    "codex.browser_discover_elements",
    {
      title: "Discover Opaque Browser Elements",
      description:
        "Read-only Browser semantic-target fallback. On exactly one existing family-bound tabRef, read the stock visible DOM and return only short-lived opaque elementRef values plus bounded visible semantic descriptors. Raw stock node ids, provider ids, CSS selectors, item indexes, coordinates, JavaScript, and the full raw visible-DOM snapshot are not returned and are not accepted as later target authority. Prefer the existing role/name/text Browser path or direct URL navigation when those already identify the intended action; use this fallback only when a real page exposes a needed target that the narrower semantic path cannot bind reliably.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque family-bound tabRef returned by codex.browser_tabs."),
        maxNodes: z.number().int().min(1).max(256).default(128)
          .describe("Maximum number of fresh visible element descriptors to project. Raw node identity remains server-side."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Browser runtime; it is not a target or permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.discoverElements(input))
  );

  server.registerTool(
    "codex.browser_prepare_element_action",
    {
      title: "Prepare Opaque Browser Element Action",
      description:
        "Prepare exactly one click or double-click on one opaque elementRef returned by codex.browser_discover_elements. Preparation is read-only: the Browser runtime freshly revalidates the same family-bound tab, URL, Workbench generation, server-held raw node identity, and semantic fingerprint before minting one single-use actionApprovalRef. The ref binds an exact target/action but is not evidence of user approval. Apply codex.browser_confirmation_policy plus current user-authored task context before execution. No raw node id, provider id, selector, index, coordinate, JavaScript, text replacement, navigation, or arbitrary action is accepted.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Exact tabRef used for the fresh opaque-element discovery."),
        elementRef: z.string().min(1).max(256)
          .describe("Short-lived opaque elementRef returned by codex.browser_discover_elements."),
        action: z.enum(["click", "double_click"])
          .describe("Only the first reviewed opaque-target slice is exposed: click or double_click."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Browser runtime; it is bound into the prepared action."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareElementAction(input))
  );

  server.registerTool(
    "codex.browser_element_action",
    {
      title: "Execute Prepared Opaque Browser Element Action",
      description:
        "Execute exactly one previously prepared opaque Browser click or double-click using only its single-use actionApprovalRef. Before dispatch the runtime revalidates the same browser family, provider identity, URL, Workbench generation, server-held raw node identity, and semantic fingerprint; the ref is consumed before mutation dispatch. Any post-dispatch uncertainty fails visibly and is never auto-replayed. No tabRef, elementRef, raw node id, provider id, selector, index, coordinate, JavaScript, action replacement, or permission field is accepted at execution time.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Single-use exact-action ref returned by codex.browser_prepare_element_action."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.elementAction(input))
  );

  server.registerTool(
    "codex.browser_webmcp_discover",
    {
      title: "Discover Page WebMCP Tools",
      description:
        "Read-only Browser WebMCP discovery. For exactly one existing server-bound Browser tabRef, borrow the stock Codex Browser tab.capabilities.get(\"webmcp\") capability from that tab family and fetch its current page-defined tools. Returns the upstream tools.description() plus an opaque webMcpRef that preserves the actual fetched upstream tool handle server-side; Codexless does not implement a second WebMCP protocol, parse registration IDs, or invent a site registry. The returned ref is single-dispatch: a successful or uncertain page-defined call consumes it, so a later distinct call must rediscover from the current page. If no WebMCP tool fits, use the existing DOM Browser path.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque family-bound tab reference returned by codex.browser_tabs. Raw provider tab IDs, URLs, family selectors, DOM selectors, and indexes are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Browser runtime for discovery; it does not select a page, profile, or WebMCP tool."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.discoverWebMcp(input))
  );

  server.registerTool(
    "codex.browser_webmcp_call",
    {
      title: "Call Listed Page WebMCP Tool",
      description:
        "Call exactly one page-defined tool through the opaque stock WebMCP handle returned by codex.browser_webmcp_discover. The caller supplies only that handle, an exactly listed tool name, and the tool's JSON input; raw WebMCP registration IDs, page/provider IDs, protocol messages, and execute-time tab selectors are not accepted. Once dispatch is attempted, that ref is consumed even when the result is uncertain, preventing same-ref replay of a possible side effect. Stock Browser confirmation/security and page-defined side-effect semantics stay authoritative; Codexless adds no second approval layer and never blindly replays an uncertain call.",
      inputSchema: z.object({
        webMcpRef: z.string().min(1).max(256)
          .describe("Opaque WebMCP handle reference returned by codex.browser_webmcp_discover."),
        toolName: z.string().min(1).max(256)
          .describe("Exact tool name listed in the existing WebMCP description. Do not guess unlisted names."),
        input: z.unknown()
          .describe("JSON input for the listed page-defined tool. Its schema comes from the stock WebMCP description."),
        timeoutMs: z.number().int().min(1).max(120_000).optional()
          .describe("Optional bounded timeout forwarded to the stock WebMCP tool handle."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.callWebMcp(input))
  );

  server.registerTool(
    "codex.browser_screenshot",
    {
      title: "Screenshot Existing Browser Tab",
      description:
        "Read-only Browser screenshot tool. Capture exactly the current visible viewport of one existing browser-family tabRef returned by codex.browser_tabs using the official tab.screenshot() API. The capture is viewport-only: callers cannot request full-page capture, crop rectangles, coordinates, selectors, JavaScript, viewport changes, or scrolling. The Browser runtime releases the claimed user tab after capture, validates a bounded JPEG/PNG payload from the official runtime, returns compact tab/image metadata as structured content, and returns the screenshot itself as MCP image content rather than base64 inside JSON. Use this when visual confirmation matters and a DOM snapshot alone is insufficient.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw browser/provider tab IDs are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve the current Codex Browser runtime; it is not a navigation target or permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => imageResult(() => browser.screenshotTab(input))
  );

  server.registerTool(
    "codex.browser_prepare_close_tab",
    {
      title: "Prepare Exact Browser Tab Close",
      description:
        "Browser lifecycle Preview. Prepare closing exactly one existing user-visible browser-family tab without closing or otherwise changing it. The tab must be identified only by an opaque tabRef returned by codex.browser_tabs; raw provider tab IDs, URLs, titles, indexes, selectors, and window targets are not accepted. The Browser runtime re-reads the current open-tab record and binds its provider identity, current URL, and current Workbench generation into a legacy-named single-use actionApprovalRef. Closing an existing tab can discard unsaved page input or other in-tab state, so the ref is only an exact-action binding and is not evidence of user approval. Apply codex.browser_confirmation_policy plus the current user-authored task context before execution; this tool itself is read-only and does not claim or close the tab.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw browser/provider tab IDs, URLs, titles, and indexes are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareCloseTab(input))
  );

  server.registerTool(
    "codex.browser_close_tab",
    {
      title: "Execute Prepared Browser Tab Close",
      description:
        "Browser lifecycle Preview. Close exactly one previously prepared existing browser-family tab using only the single-use actionApprovalRef returned by codex.browser_prepare_close_tab. The ref is not user-approval evidence. Before dispatch, apply codex.browser_confirmation_policy plus current user-authored task context; ordinary tabs may contain unsaved input, so preserve conservative confirmation semantics rather than assuming that close is harmless. The Browser runtime consumes the ref before dispatch, revalidates the same Workbench generation, provider identity, and current URL, claims that exact current open-tab object, calls the official Browser Tab.close() exactly once, and then removes the Browser runtime's local tabRef/provider mapping after confirmed success. No raw provider id, tabRef, URL, title, index, window target, selector, JavaScript, reload/back/focus action, or replacement target is accepted at execution time. If the close dispatch result is uncertain, the Browser runtime fails visibly and never auto-retries the close.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_close_tab. It binds one exact tab close but does not itself prove user approval."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.closeTab(input))
  );

  server.registerTool(
    "codex.browser_prepare_bulk_close_tabs",
    {
      title: "Prepare Exact-Set Browser Bulk Tab Close",
      description:
        "Destructive Browser administrator capability, preparation phase only. Accept an exact set of 1..100 opaque tabRef values returned by codex.browser_tabs, with no duplicates. The Browser runtime re-reads current open-tab state and server-binds each tabRef to its current provider identity, exact URL, and Browser Workbench generation, then returns only the visible tabRef/title/url manifest plus one opaque single-use actionApprovalRef. Caller URL/domain filters, regex, titles, indexes, raw provider ids, selectors, JavaScript, and coordinates are not accepted. Preparing does not claim or close any tab. Because closing tabs may discard unsaved page input, apply the current Browser confirmation policy and explicit user/admin authorization before execution.",
      inputSchema: z.object({
        tabRefs: z.array(z.string().min(1).max(256)).min(1).max(100)
          .describe("Exact set of opaque browser_tab_ refs returned by one current codex.browser_tabs result. Duplicates are rejected; URLs/titles/indexes/provider ids are not accepted as substitutes."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareBulkCloseTabs(input))
  );

  server.registerTool(
    "codex.browser_bulk_close_tabs",
    {
      title: "Execute Exact-Set Browser Bulk Tab Close",
      description:
        "Execute one previously prepared exact-set bulk tab close using only its opaque single-use actionApprovalRef. For each prepared tab in order, Codexless revalidates the same Browser Workbench generation, server-bound provider identity, and exact current URL before one official Tab.close() dispatch. At the first drift, busy claim, pre-dispatch release problem, uncertain close, or partial outcome, execution stops immediately and returns a partial receipt identifying only confirmed-closed tabs, the stopped tab, and unprocessed tabs. It never auto-retries any target or continues past uncertainty. No tabRef list, URL/domain filter, regex, title, index, raw provider id, selector, JavaScript, coordinates, or replacement target is accepted at execution time.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Opaque single-use exact-set action reference returned by codex.browser_prepare_bulk_close_tabs. It binds the full set but is not user-approval evidence."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.bulkCloseTabs(input))
  );

  server.registerTool(
    "codex.browser_prepare_open_tab",
    {
      title: "Prepare Exact Browser-Family New Tab",
      description:
        "Browser Operate Preview. Prepare opening exactly one new Chrome or Edge tab to one explicit http(s) URL without creating or navigating any tab. The caller must explicitly choose family=chrome|edge so the creation target is never decided by a hidden default. When the user goal is simply to reach/read a page and the exact destination is already reliably available from Browser-derived evidence, this direct route is preferred over simulating an intermediate click; do not guess route patterns. The exact normalized destination plus browser family are stored in a legacy-named single-use actionApprovalRef. That ref is only an exact-action binding and is not evidence of user approval. Apply codex.browser_confirmation_policy plus current user-authored task context; do not ask for confirmation merely because a prepared ref exists. No existing tab, selector, JavaScript, click, fill, or scroll target is accepted.",
      inputSchema: z.object({
        family: z.enum(["chrome", "edge"])
          .describe("Exact browser family to create the new tab in. Required so the prepared action cannot hide or change the creation target."),
        url: z.string().min(1).max(8192)
          .describe("Exact destination URL. The Browser runtime accepts only explicit http:// or https:// URLs and binds the normalized URL into the prepared action."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareOpenTab(input))
  );

  server.registerTool(
    "codex.browser_open_tab",
    {
      title: "Execute Prepared Browser-Family New Tab",
      description:
        "Browser Operate Preview. Create exactly one new Chrome or Edge tab for a previously prepared explicit http(s) URL. The action receives only the single-use actionApprovalRef; browser family and destination are both server-bound at prepare time and cannot be changed at execution. It uses official browser.tabs.new() + tab.goto(), reads back title/url/DOM, and finalizes the new tab as a user-visible deliverable. Call codex.browser_tabs afterward with the same family to obtain its normal opaque tabRef. Never auto-retry an uncertain new-tab result.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_open_tab. It binds the destination but does not itself prove user approval; apply the current Browser confirmation policy and task context before dispatch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.openTab(input))
  );

  server.registerTool(
    "codex.browser_scroll",
    {
      title: "Scroll Existing Browser Tab",
      description:
        "Browser Operate Preview. Scroll exactly one existing browser-family tab up or down by one bounded small/page step using an official Playwright keypress targeted at the fixed document body, then perform a separate read-only DOM readback. Page steps use PageDown/PageUp; small steps use a bounded ArrowDown/ArrowUp sequence. This intentionally avoids the Chrome Input.synthesizeScrollGesture path that can time out on real pages such as Reddit. The scroll receipt is independent from the readback: once the keypress scroll returns successfully, a later DOM-read failure is reported as readbackStatus=unavailable rather than turning the confirmed scroll into an uncertain mutation. No caller-supplied selectors, coordinates, node ids, or keys are accepted. It never clicks, types text, submits, or requests a new URL, but scrolling may naturally trigger lazy-loaded page content or site-side network activity.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs."),
        direction: z.enum(["down", "up"]).default("down")
          .describe("Scroll direction."),
        amount: z.enum(["small", "page"]).default("page")
          .describe("Bounded scroll step: small uses a fixed ArrowDown sequence; page uses PageDown/PageUp."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime."),
        maxChars: z.number().int().min(1_000).max(200_000).default(80_000)
          .describe("Maximum fresh DOM snapshot characters returned after the scroll."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.scrollTab(input))
  );

  server.registerTool(
    "codex.browser_keypress",
    {
      title: "Press Fixed Key in Existing Browser Tab",
      description:
        "Browser Operate Preview. Press exactly one fixed Enter, Tab, or Escape key at the currently focused element in one existing browser-family tabRef using the official Browser DOM CUA keypress API, then perform a separate read-only DOM readback. Callers cannot supply arbitrary key names, text, modifiers, repeats, selectors, coordinates, node ids, or JavaScript. Use an existing exact click/fill first when a specific control must be focused. Tab and Escape are ordinary bounded UI controls; Enter can activate or submit the focused control, so apply codex.browser_confirmation_policy plus the current task context before calling and ask only when that exact bounded task/action class requires confirmation. Once the keypress returns successfully, a later readback failure does not make the keypress uncertain and The Browser runtime never repeats it automatically.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs."),
        key: z.enum(["Enter", "Tab", "Escape"])
          .describe("Exactly one supported fixed key. Arbitrary keys, text and modifiers are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime."),
        maxChars: z.number().int().min(1_000).max(200_000).default(80_000)
          .describe("Maximum fresh DOM snapshot characters returned after the keypress."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.keypressTab(input))
  );

  server.registerTool(
    "codex.browser_model_route_probe",
    {
      title: "Probe ChatGPT Actual Model Route",
      description:
        "Household Browser diagnostic. The user's request may originate from any normal client or Main Road entry, but actual verification runs on the Chrome connected to the current Codexless Browser Host. Before using this probe, require a healthy Chrome Browser extension/backend and a usable ChatGPT login state; if those prerequisites are missing, stop and tell the user exactly what must be connected or logged in instead of falling back to manual DevTools or guessing. The verifier has only two product modes: (A) use the user-selected current/opened ChatGPT Web conversation and submit one extra fixed probe turn there; or (B) use a newly opened ChatGPT Web chat, where Temporary vs normal and project vs non-project are chosen by the user/task flow before this tool is called. Do not attempt brittle automatic reconstruction of an arbitrary phone conversation or claim to recover the actual route of an already-completed phone turn from persisted history. On exactly one selected chat tabRef, ask the fixed non-sensitive question '你现在是什么模型？' and use the tab's bounded CDP capability internally to observe that same new Web generation transport. Return only the bounded assistant self-report for that fixed question, requested_model_experience, resolved_model_slug, server_ste_metadata.model_slug, minimal response identity/status, verification-context flags including the actually observed Chat/Work surface mode when available, and evidence flags. This tool does not expose raw CDP, cookies, Authorization, full headers, full response bodies, or unrelated conversation content. It refuses non-chat chatgpt.com pages and never auto-retries after the probe message may have been submitted. After success, present the caller-facing result as a short visually distinct evidence block with 'model self-report' and 'actual route' side by side, and state the actual verified surface as Chat, Work, or unknown. Do not mechanically call a naming-layer difference a lie; only flag a clear mismatch when a reliable mapping exists. On failure, present the missing prerequisite/blocker just as visibly. Exact wording is flexible; do not bury the result or blocker inside a long paragraph and do not imitate the formal Codex approval/result presentation.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs for the exact user-selected ChatGPT Web chat surface: either the current/opened conversation or a newly opened chat in the chosen Temporary/normal and project/non-project context."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it does not widen CDP or website authority."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.modelRouteProbe(input))
  );

  server.registerTool(
    "codex.browser_prepare_navigate",
    {
      title: "Prepare Exact Browser Navigation",
      description:
        "Browser Operate Preview. Prepare one direct navigation of exactly one existing browser-family tab to one explicit http(s) URL without dispatching it. When the user goal is simply to reach/read another page and the exact destination is already reliably available from Browser-derived evidence, this is the preferred path over clicking an intermediate UI element; do not guess route patterns. The tab must come from codex.browser_tabs. Preparing binds the current tab URL plus the exact destination into a legacy-named single-use actionApprovalRef and does not navigate, click, type, submit, open a new tab, or accept JavaScript/selectors. The ref is an exact-action binding, not a permission token. Apply codex.browser_confirmation_policy plus current user-authored task context; ordinary navigation must not trigger a redundant confirmation just because it uses prepare/execute.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw browser/provider tab IDs are not accepted."),
        url: z.string().min(1).max(8192)
          .describe("Exact destination URL. The Browser runtime accepts only explicit http:// or https:// URLs and binds the normalized URL into the prepared action."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareNavigate(input))
  );

  server.registerTool(
    "codex.browser_navigate",
    {
      title: "Execute Prepared Browser Navigation",
      description:
        "Browser Operate Preview. Execute exactly one previously prepared existing-tab navigation identified only by a legacy-named single-use actionApprovalRef. The ref is not user-approval evidence. Before dispatch, the caller applies codex.browser_confirmation_policy plus current user-authored task context and asks only when that policy/task actually requires confirmation. The Browser runtime consumes the ref, revalidates the same current tab URL, calls the official Browser tab.goto() for the bound http(s) destination, reads back the resulting URL/title/DOM, releases the claimed user tab, and never auto-retries an uncertain navigation. No tab, URL, selector, JavaScript, click, fill, scroll, or permission fields are accepted at execution time.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_navigate. It binds the exact navigation but is not itself user-approval evidence; apply the current Browser confirmation policy and task context before dispatch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.navigate(input))
  );

  server.registerTool(
    "codex.browser_prepare_click",
    {
      title: "Prepare Exact Browser Click",
      description:
        "Browser Operate Preview. Resolve exactly one visible enabled element in an existing browser-family tab and prepare one single left or right click without dispatching it. Do not use click merely to imitate human navigation when the actual goal is page arrival and an exact destination URL is already reliably available from Browser-derived evidence; prefer direct navigate/open-tab in that case. Preferred targeting remains accessible role + exact accessible name. When a page repeats the same role/name control for many local items, role/name may additionally use one exact visible http(s) scopeUrl observed from the current Browser DOM: the Browser runtime finds exactly one visible link with that resolved URL, walks only a bounded server-fixed ancestor range, and selects the nearest ancestor containing exactly one matching local control. For real sites whose clickable cards expose only ordinary DOM text, callers may instead provide exact visible text. Exact-text preparation filters visibility candidate-by-candidate (so hidden duplicates do not create false ambiguity) and then requires one stable server-derived binding: link/button/menuitem role, bounded onclick-property ancestor, an accepted server-read structured identity such as `.thread-card[data-thread-id]`, or a unique custom `<a>` whose server-observed stable DOM id and narrow tag/role/href/disabled fingerprint are persisted and revalidated before execution. Caller input still exposes no CSS selector/JavaScript/coordinates/node ids/item indexes/ancestor depth/DOM id; callers also cannot supply any server-recognized class, structured id, or stable DOM id. Exact-text and role/name modes are mutually exclusive; scopeUrl belongs only to role/name mode. The target tab must come from codex.browser_tabs. This tool is read-only, reuses the existing-login Browser body, and returns a legacy-named single-use actionApprovalRef plus the exact target descriptor. The ref is only an exact-action binding. Use codex.browser_confirmation_policy and current task context to decide whether this click needs user confirmation; do not ask merely because the action is a click.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw browser/provider tab IDs are not accepted."),
        role: z.string().min(1).max(128).optional()
          .describe("Accessible role observed in current Browser DOM state, for example button or link. Use together with name, and omit text. Role/name remains the preferred semantic target mode."),
        name: z.string().min(1).max(2048).optional()
          .describe("Exact accessible name for role mode. Use together with role, and omit text. The target must resolve to exactly one visible enabled element, either globally or inside the optional scopeUrl."),
        scopeUrl: z.string().min(1).max(8192).optional()
          .describe("Optional exact visible http(s) link URL observed from the current Browser DOM, used only with role+name to bind one repeated local control to the nearest bounded ancestor scope. This is not a selector, node id, item index, or permission token."),
        button: z.enum(["left", "right"]).default("left")
          .describe("Exact mouse button for the prepared semantic click. Only ordinary left click and context-menu right click are exposed; middle click, coordinates, modifiers, double-click, and arbitrary mouse injection remain unavailable."),
        text: z.string().min(1).max(2048).optional()
          .describe("Exact visible text fallback for clickable cards or other elements that expose no useful accessibility role. Use text alone without role/name; the Browser runtime uses exact getByText matching and still requires exactly one visible enabled target."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareClick(input))
  );

  server.registerTool(
    "codex.browser_click",
    {
      title: "Execute Prepared Browser Click",
      description:
        "Browser Operate Preview. Execute exactly one previously prepared browser-family left or right click identified only by a legacy-named single-use actionApprovalRef. The ref is not permission evidence. Before dispatch, apply codex.browser_confirmation_policy plus current user-authored task context: ordinary navigation/expansion clicks should not cause redundant prompts, while policy-covered external-side-effect clicks use the task-level verbal confirmation flow unless a higher-level rule requires otherwise. The Browser runtime consumes the action ref, revalidates the same tab URL plus the same unique visible enabled target (role/name or exact visible text) immediately before clicking, reads back current page state, releases the claimed user tab, and never auto-retries an uncertain click result. No tab, URL, selector, target text, role/name, coordinates, JavaScript, double-click, typing, scroll, navigation, or permission fields are accepted here; execution receives only the prepared opaque ref.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_click. It binds the exact target but is not itself user-approval evidence; apply the current Browser confirmation policy and task context before dispatch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.click(input))
  );

  server.registerTool(
    "codex.browser_prepare_download",
    {
      title: "Prepare Exact Browser Download",
      description:
        "Browser Operate Preview. Resolve exactly one visible enabled semantic download target in an existing browser-family tab and prepare one local download without clicking it. Targeting keeps the established narrow role+exact accessible name or existing exact visible-text bindings; the click-only server-derived stable-id custom-anchor compatibility fallback is deliberately not inherited by download. Callers cannot provide CSS selectors, JavaScript, coordinates, DOM/node ids, or a local destination path. The tab must come from codex.browser_tabs. Preparing returns a legacy-named single-use actionApprovalRef that binds the current tab URL and exact target but is not permission evidence. Apply codex.browser_confirmation_policy plus current task context before dispatch; preparing does not create a local file.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs."),
        role: z.string().min(1).max(128).optional()
          .describe("Accessible role observed in current Browser DOM state, normally link or button. Use together with name and omit text."),
        name: z.string().min(1).max(2048).optional()
          .describe("Exact accessible name for role mode. The target must resolve to exactly one visible enabled element."),
        text: z.string().min(1).max(2048).optional()
          .describe("Exact visible-text fallback when the download control exposes no useful accessible role/name. Use text alone without role/name."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareDownload(input))
  );

  server.registerTool(
    "codex.browser_download",
    {
      title: "Execute Prepared Browser Download",
      description:
        "Browser Operate Preview. Execute exactly one prepared semantic download target and wait for the official Browser Playwright download event. The execution receives only the single-use actionApprovalRef, revalidates the same tab URL and exact target before clicking, and never accepts a caller-supplied filesystem destination. When the runtime exposes download.path(), the Browser runtime returns the browser family's managed local download path; it never opens, parses, executes, uploads, or trusts the downloaded file. If dispatch may have happened but no reliable download receipt returns, the result is fail-visible and must not be auto-retried because a local file may already exist.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_download. It binds the exact target but is not user-approval evidence."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.download(input))
  );

  server.registerTool(
    "codex.browser_prepare_upload",
    {
      title: "Prepare Exact Browser Upload",
      description:
        "Browser Operate Preview. Prepare one authority-bounded local file for one exact semantic file-input/upload target in an existing browser-family tab. The local file path is resolved through the Browser runtime's Codex authority layer and its real path must remain inside the current trusted authority root; files above 100 MiB are refused in this Preview, and canonical path + byte length + SHA-256 are bound into the prepared record. This tool must not become an arbitrary host-file exfiltration path. Targeting keeps role+exact accessible name or the established exact visible-text bindings; the click-only server-derived stable-id custom-anchor compatibility fallback is deliberately not inherited by upload. No caller CSS selector, JavaScript, coordinates, DOM/node ids, or native-picker automation is exposed. The returned actionApprovalRef binds the current tab URL, exact target, and canonical authorized file. Preparing is read-only with respect to the webpage and does not expose file contents to it.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs."),
        role: z.string().min(1).max(128).optional()
          .describe("Accessible role for the current file input/upload control, commonly button. Use with name and omit text."),
        name: z.string().min(1).max(2048).optional()
          .describe("Exact accessible name for role mode. The target must resolve to exactly one visible enabled element."),
        text: z.string().min(1).max(2048).optional()
          .describe("Exact visible-text fallback for an upload control that exposes no useful role/name. Use text alone without role/name."),
        filePath: z.string().min(1).max(32_768)
          .describe("One existing local file path. The Browser runtime resolves it through Codex authority and refuses any real path outside the current trusted authority root."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve both Browser runtime context and Codex file authority; it is not a permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareUpload(input))
  );

  server.registerTool(
    "codex.browser_upload",
    {
      title: "Execute Prepared Browser Upload",
      description:
        "Browser Operate Preview. Execute one prepared authority-bounded local file handoff through the official Browser filechooser/setFiles flow. Execution accepts only the single-use actionApprovalRef, revalidates the same tab URL and exact semantic target, then waits for a filechooser before applying the server-bound canonical file path. It never accepts an arbitrary local path at execution time. The Browser runtime revalidates the prepared canonical path + byte length + SHA-256 immediately before Browser dispatch and again after setFiles returns; this detects ordinary source drift but is not an OS write lock against an actively malicious concurrent writer. setFiles returning proves browser-side file selection/change delivery, not remote server acceptance; stronger upload-complete claims require page-state evidence. Uploading personal or sensitive files follows codex.browser_confirmation_policy and the user's bounded task authorization. Uncertain upload results are fail-visible and never auto-retried.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_upload. It binds the exact target and authorized file but is not user-approval evidence."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.upload(input))
  );

  server.registerTool(
    "codex.browser_prepare_fill",
    {
      title: "Prepare Exact Browser Fill",
      description:
        "Browser Operate Preview. Prepare one exact text fill into an existing browser-family textbox/searchbox without changing the page. Preferred targeting is exact accessible role+name; when a real page exposes no useful accessible name, callers may instead provide either the exact visible placeholder or one exact visible http(s) scopeUrl observed from the current Browser DOM. For role=textbox + exact placeholder only, when the ARIA textbox path yields no semantic match, the server may additionally admit one unique visible enabled native input[type=password] with that exact placeholder as the same bounded text-entry target class; this password compatibility fallback is not used for role+name or searchbox. The Browser runtime first proves exactly one semantic textbox/searchbox from that binding, then normalizes only inside that already-bound target: a writable input/textarea, a standards-valid contenteditable target, one unique visible supported editable descendant, or the pre-existing direct semantic-shell path used by activation-only editors. Multiple visible editable descendants, explicitly non-editable descendants, or ambiguous semantic targets fail closed. scopeUrl mode remains bounded to the nearest ancestor containing exactly one visible textbox/searchbox of the requested role. Name, placeholder, and scopeUrl modes are mutually exclusive. Callers still cannot provide selectors, node ids, item indexes, ancestor depth, JavaScript, or coordinates. They also cannot provide arbitrary DOM-write keys. The exact text is stored server-side in a legacy-named single-use actionApprovalRef. Preparing validates the current tab/URL and target but does not fill, click, press Enter, navigate, or submit. The ref is not permission evidence. Apply codex.browser_confirmation_policy plus task context: ordinary non-sensitive typing should not trigger a redundant prompt merely because it is Fill, while sensitive-data transmission or other policy-covered cases must follow the task confirmation rule before typing.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw browser/provider tab IDs are not accepted."),
        role: z.enum(["textbox", "searchbox"])
          .describe("Text-entry role observed in current Browser DOM state. Browser fill intentionally supports only textbox/searchbox."),
        name: z.string().min(1).max(2048).optional()
          .describe("Exact accessible name for preferred role/name mode. Supply name or placeholder, never both."),
        placeholder: z.string().min(1).max(2048).optional()
          .describe("Exact placeholder fallback for a textbox/searchbox that exposes no useful accessible name. Supply placeholder, name, or scopeUrl; never more than one target mode."),
        scopeUrl: z.string().min(1).max(8192).optional()
          .describe("Optional exact visible http(s) link URL observed from the current Browser DOM, used instead of name/placeholder to bind one locally unique unnamed textbox/searchbox to the nearest bounded ancestor scope. This is not a selector, node id, item index, or permission token."),
        text: z.string().max(20_000)
          .describe("Exact text to bind into the prepared action. No Enter, click, navigation, or submit is implied."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareFill(input))
  );

  server.registerTool(
    "codex.browser_fill",
    {
      title: "Execute Prepared Browser Fill",
      description:
        "Browser Operate Preview. Execute exactly one previously prepared textbox/searchbox fill identified only by a legacy-named single-use actionApprovalRef. The ref is not permission evidence. Before dispatch, apply codex.browser_confirmation_policy plus current user-authored task context; ask only when the policy/task actually requires confirmation, and use the task-level verbal flow rather than per-action prompting unless a higher-level rule requires otherwise. The Browser runtime consumes the action ref, revalidates the same tab URL plus the original exact semantic binding, and proves the same prepared editable-resolution class before the first dispatch. A native password action prepared through role=textbox + exact placeholder additionally revalidates the same input tag/type/placeholder plus visibility/enabled state, calls the official fill API exactly once, never reads or returns the password value or prepared text body, and never enters the activation-repair path. It fills only the bound text, then freshly re-resolves that same role/name, role/placeholder, or bounded scope binding and verifies exact value/rendered rich text only on the editable node resolved inside that semantic target. It never treats text on another same-role control or an editable found by walking outside the bound semantic target as success. If the first dispatch only activates a replacement editor, one internal repair fill is allowed only when a fresh execution re-proves the original semantic binding, the newly resolved bound target is blank, and the exact prepared text is absent from fresh DOM. Partial/ambiguous states, URL drift, pre-dispatch editable-shape drift, failed fresh execution, or already-present text never auto-repair. Deterministic empty/no-write returns BROWSER_FILL_NOT_APPLIED; text-visible-but-bound-target-unproven returns BROWSER_FILL_VERIFICATION_UNAVAILABLE; true mutation uncertainty remains BROWSER_FILL_RESULT_UNCERTAIN. Multiple matches remain fail-closed and arbitrary matching page text is never accepted as proof. It then reads back current page state and releases the claimed user tab. It does not click, press Enter, navigate, submit, or implement website-specific Save/dirty/blur persistence behavior.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_fill. It binds the exact target/text but is not itself user-approval evidence; apply the current Browser confirmation policy and task context before dispatch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.fill(input))
  );
}

function browserElicitationRegistrationServer(server, elicitationBridge) {
  return {
    registerTool(name, ...args) {
      const handlerIndex = args.length - 1;
      const handler = args[handlerIndex];
      if (typeof handler === "function") {
        args[handlerIndex] = async (input, ctx) => {
          try {
            return await elicitationBridge.run({
              toolName: name,
              input,
              mcpReq: ctx?.mcpReq ?? null,
              task: () => handler(input, ctx),
            });
          } catch (error) {
            const payload = browserErrorPayload(error);
            return {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              structuredContent: payload,
              isError: true,
            };
          }
        };
      }
      return server.registerTool(name, ...args);
    },
  };
}

function boundedBrowserDiagnostic(error) {
  const diagnostic = error?.diagnostic;
  if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return null;
  const bounded = {};
  if (["browser-use-persisted-state", "codex-network-policy"].includes(diagnostic.source)) {
    bounded.source = diagnostic.source;
  }
  if (["conversation", "global"].includes(diagnostic.scope)) {
    bounded.scope = diagnostic.scope;
  }
  if (typeof diagnostic.origin === "string" && diagnostic.origin.length <= 2048) {
    try {
      const parsed = new URL(diagnostic.origin);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === diagnostic.origin) {
        bounded.origin = diagnostic.origin;
      }
    } catch {}
  }
  if (diagnostic.failureLayer === "pre_dispatch_discovery") {
    bounded.failureLayer = diagnostic.failureLayer;
    if (diagnostic.preDispatch === true) bounded.preDispatch = true;
    if (diagnostic.safeToRetry === true) bounded.safeToRetry = true;
    if (diagnostic.actionRefRetained === true) bounded.actionRefRetained = true;
    if (Number.isInteger(diagnostic.internalRediscoveryAttempts)
      && diagnostic.internalRediscoveryAttempts >= 0
      && diagnostic.internalRediscoveryAttempts <= 1) {
      bounded.internalRediscoveryAttempts = diagnostic.internalRediscoveryAttempts;
    }
  }
  return Object.keys(bounded).length > 0 ? bounded : null;
}

function browserErrorPayload(error) {
  const payload = { error: error instanceof Error ? error.message : String(error) };
  if (typeof error?.code === "string") payload.errorCode = error.code;
  if (Array.isArray(error?.nextActions) && error.nextActions.every((value) => typeof value === "string")) {
    payload.nextActions = error.nextActions;
  }
  const diagnostic = boundedBrowserDiagnostic(error);
  if (diagnostic) payload.diagnostic = diagnostic;
  return payload;
}

async function imageResult(task) {
  try {
    const payload = await task();
    const data = payload?.dataBase64;
    const mimeType = payload?.mimeType;
    if (typeof data !== "string" || !data || typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
      throw new Error("browser screenshot handler received no valid image payload");
    }
    const { dataBase64: _omitted, ...metadata } = payload;
    return {
      content: [
        { type: "text", text: JSON.stringify(metadata) },
        { type: "image", data, mimeType },
      ],
      structuredContent: metadata,
      isError: false,
    };
  } catch (error) {
    const payload = browserErrorPayload(error);
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}

async function structured(task) {
  try {
    const payload = await task();
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    };
  } catch (error) {
    const payload = browserErrorPayload(error);
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
