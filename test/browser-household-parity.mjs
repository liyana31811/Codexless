import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  CodexBrowserExecutor,
  assertBrowserExistingTabReleaseAvailable,
  browserFillEditableElementProfile,
  canonicalizeContentEditableParagraphText,
  cleanupBrowserClaim,
  markBrowserDeliverable,
  markBrowserHandoff,
  normalizeBrowserLifecycleShape,
  releaseBrowserClaim,
  resolveBoundContentEditableParagraphText,
  resolveBoundFillEditableElement,
  sanitizePasswordDomSnapshot,
} from "../src/codex-browser-executor.mjs";
import { registerBrowserPreviewTools } from "../src/browser-tools.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fakeSkillPath = "C:\\Users\\Test\\.codex\\plugins\\cache\\openai-bundled\\chrome\\99.1\\skills\\control-chrome\\SKILL.md";
function makeAuthorityExecutor() {
  return {
    async resolveAuthority() {
      return {
        effectiveCwd: projectRoot,
        trustedAncestor: projectRoot,
        permissionProfile: ":read-only",
      };
    },
  };
}

const fakeJpegBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z";

function textNode(text) {
  return { nodeType: 3, textContent: text };
}

function elementNode(tagName, childNodes = [], { textContent = null } = {}) {
  const node = {
    nodeType: 1,
    tagName,
    childNodes,
    children: childNodes.filter((child) => child?.nodeType === 1),
  };
  node.textContent = textContent ?? childNodes.map((child) => child?.textContent ?? "").join("");
  return node;
}

test("Browser rich-editor paragraph canonicalizer preserves paragraph semantics without collapsing genuine text differences", () => {
  const paragraph = (text) => elementNode("P", [textNode(text)]);
  const emptyParagraph = elementNode("P", [elementNode("BR")], { textContent: "" });
  const root = {
    isContentEditable: true,
    childNodes: [paragraph("TOOLWIRE_FILL_REPRO_20260819_A"), emptyParagraph, paragraph("SECOND_PARAGRAPH_20260819")],
  };
  assert.equal(
    canonicalizeContentEditableParagraphText(root),
    "TOOLWIRE_FILL_REPRO_20260819_A\n\nSECOND_PARAGRAPH_20260819",
    "Reddit-style P / empty-P / P structure must canonicalize to the original two-newline paragraph semantics"
  );

  const different = {
    isContentEditable: true,
    childNodes: [paragraph("TOOLWIRE_FILL_REPRO_20260819_A"), emptyParagraph, paragraph("DIFFERENT_PARAGRAPH")],
  };
  assert.equal(canonicalizeContentEditableParagraphText(different), "TOOLWIRE_FILL_REPRO_20260819_A\n\nDIFFERENT_PARAGRAPH");
  assert.notEqual(
    canonicalizeContentEditableParagraphText(different),
    "TOOLWIRE_FILL_REPRO_20260819_A\n\nSECOND_PARAGRAPH_20260819",
    "canonicalization must not turn genuinely different rich-editor content into a match"
  );
  assert.equal(canonicalizeContentEditableParagraphText({ isContentEditable: false, childNodes: root.childNodes }), null);
  assert.equal(canonicalizeContentEditableParagraphText({ isContentEditable: true, childNodes: [elementNode("DIV", [textNode("A")])] }), null);

  const brRoot = {
    isContentEditable: true,
    childNodes: [elementNode("P", [textNode("  LEADING "), elementNode("BR"), textNode("TRAILING  ")])],
  };
  assert.equal(
    canonicalizeContentEditableParagraphText(brRoot),
    "  LEADING \nTRAILING  ",
    "known inline BR structure must preserve soft line breaks and leading/trailing text exactly"
  );

  const unknownInline = {
    isContentEditable: true,
    childNodes: [elementNode("P", [textNode("A"), elementNode("CUSTOM-WIDGET", [textNode("B")])])],
  };
  assert.equal(
    canonicalizeContentEditableParagraphText(unknownInline),
    null,
    "unknown block/custom descendants must fail closed instead of being silently flattened"
  );
});

test("Browser rich-editor proof accepts explicit contenteditable attributes even when the DOM property is false", () => {
  const paragraph = (text) => elementNode("P", [textNode(text)]);
  const emptyParagraph = elementNode("P", [elementNode("BR")], { textContent: "" });
  const attrOnlyEditor = {
    isContentEditable: false,
    childNodes: [paragraph("A"), emptyParagraph, paragraph("B")],
    getAttribute: (name) => name === "contenteditable" ? "true" : null,
    querySelectorAll: () => [],
  };
  assert.equal(canonicalizeContentEditableParagraphText(attrOnlyEditor), "A\n\nB");
  assert.deepEqual(
    resolveBoundContentEditableParagraphText(attrOnlyEditor, () => true),
    { source: "direct", editableCount: 1, canonicalRichText: "A\n\nB" },
    "the already-bound textbox itself remains the proof identity when its explicit contenteditable attr is true"
  );

  const disabled = {
    ...attrOnlyEditor,
    getAttribute: (name) => name === "contenteditable" ? "false" : null,
  };
  assert.equal(canonicalizeContentEditableParagraphText(disabled), null);
  assert.deepEqual(
    resolveBoundContentEditableParagraphText(disabled, () => true),
    { source: null, editableCount: 0, canonicalRichText: null },
    "contenteditable=false must never be promoted into rich-editor proof"
  );
});

test("Browser bound rich-editor resolver accepts exactly one visible nested contenteditable and rejects ambiguity", () => {
  const paragraph = (text) => elementNode("P", [textNode(text)]);
  const emptyParagraph = elementNode("P", [elementNode("BR")], { textContent: "" });
  const nestedEditor = {
    isContentEditable: true,
    childNodes: [paragraph("A"), emptyParagraph, paragraph("B")],
  };
  const shell = {
    isContentEditable: false,
    querySelectorAll: () => [nestedEditor],
  };
  assert.deepEqual(
    resolveBoundContentEditableParagraphText(shell, () => true),
    { source: "unique-visible-descendant", editableCount: 1, canonicalRichText: "A\n\nB" },
    "a semantic textbox shell may prove its own unique nested rich editor without page-global search"
  );

  const secondEditor = {
    isContentEditable: true,
    childNodes: [paragraph("A"), emptyParagraph, paragraph("B")],
  };
  const ambiguousShell = {
    isContentEditable: false,
    querySelectorAll: () => [nestedEditor, secondEditor],
  };
  assert.deepEqual(
    resolveBoundContentEditableParagraphText(ambiguousShell, () => true),
    { source: null, editableCount: 2, canonicalRichText: null },
    "multiple visible nested editors must fail closed"
  );
  assert.deepEqual(
    resolveBoundContentEditableParagraphText({ isContentEditable: false, querySelectorAll: () => [] }, () => true),
    { source: null, editableCount: 0, canonicalRichText: null }
  );
});

test("Browser fill editable normalization stays inside the semantic target and rejects ambiguous or explicitly non-editable shapes", () => {
  const editableNode = (tagName, {
    attrs = {},
    descendants = [],
    isContentEditable = false,
    disabled = false,
    readOnly = false,
    inert = false,
    visible = true,
  } = {}) => ({
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    isContentEditable,
    disabled,
    readOnly,
    inert,
    visible,
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.hasOwn(attrs, name); },
    querySelectorAll() { return descendants; },
  });
  const visible = (candidate) => candidate?.visible !== false;

  const input = editableNode("input");
  const textarea = editableNode("textarea");
  assert.deepEqual(resolveBoundFillEditableElement(input, visible), { source: "direct", editableCount: 1, kind: "input" });
  assert.deepEqual(resolveBoundFillEditableElement(textarea, visible), { source: "direct", editableCount: 1, kind: "textarea" });
  assert.equal(browserFillEditableElementProfile(editableNode("input", { attrs: { type: "checkbox" } })).supported, false);

  const directContentEditable = editableNode("div", { isContentEditable: true });
  assert.deepEqual(resolveBoundFillEditableElement(directContentEditable, visible), { source: "direct", editableCount: 1, kind: "contenteditable" });
  const nestedIndependentEditor = editableNode("div", { attrs: { contenteditable: "true" } });
  const directWithNestedEditor = editableNode("div", { isContentEditable: true, descendants: [nestedIndependentEditor] });
  assert.deepEqual(
    resolveBoundFillEditableElement(directWithNestedEditor, visible),
    { source: null, editableCount: 2, kind: null },
    "a directly editable semantic target plus another visible independently editable descendant is ambiguous"
  );
  const attrOnlyContentEditable = editableNode("div", {
    attrs: { contenteditable: " PlainText-Only " },
    isContentEditable: false,
  });
  assert.deepEqual(
    resolveBoundFillEditableElement(attrOnlyContentEditable, visible),
    { source: "direct", editableCount: 1, kind: "contenteditable" },
    "non-boolean but standards-valid plaintext-only contenteditable must be normalized without depending on isContentEditable"
  );

  const nestedTextarea = editableNode("textarea");
  const wrapper = editableNode("div", { descendants: [nestedTextarea] });
  assert.deepEqual(
    resolveBoundFillEditableElement(wrapper, visible),
    { source: "unique-visible-descendant", editableCount: 1, kind: "textarea" },
    "a semantic textbox wrapper may resolve only its own unique visible supported editable descendant"
  );

  const hiddenExtra = editableNode("div", { attrs: { contenteditable: "true" }, visible: false });
  assert.deepEqual(
    resolveBoundFillEditableElement(editableNode("div", { descendants: [nestedTextarea, hiddenExtra] }), visible),
    { source: "unique-visible-descendant", editableCount: 1, kind: "textarea" },
    "hidden editable templates do not create false ambiguity"
  );
  const secondEditable = editableNode("div", { attrs: { contenteditable: "true" } });
  assert.deepEqual(
    resolveBoundFillEditableElement(editableNode("div", { descendants: [nestedTextarea, secondEditable] }), visible),
    { source: null, editableCount: 2, kind: null },
    "multiple visible writable descendants must fail closed rather than picking an index"
  );

  const semanticShell = editableNode("div");
  assert.deepEqual(
    resolveBoundFillEditableElement(semanticShell, visible),
    { source: "semantic-shell", editableCount: 0, kind: "semantic-shell" },
    "the pre-existing exact textbox semantic-shell dispatch remains available for activation-only editors"
  );
  assert.deepEqual(
    resolveBoundFillEditableElement(editableNode("div", { attrs: { "aria-disabled": "true" } }), visible),
    { source: null, editableCount: 0, kind: null },
    "aria-disabled semantic shells must not inherit the activation fallback"
  );
  assert.deepEqual(
    resolveBoundFillEditableElement(editableNode("div", { attrs: { "aria-readonly": "true" } }), visible),
    { source: null, editableCount: 0, kind: null },
    "aria-readonly semantic shells must not inherit the activation fallback"
  );
  const explicitlyNotEditable = editableNode("div", { attrs: { contenteditable: "false" } });
  assert.deepEqual(resolveBoundFillEditableElement(explicitlyNotEditable, visible), { source: null, editableCount: 0, kind: null });
  const wrapperWithReadonly = editableNode("div", { descendants: [editableNode("textarea", { readOnly: true })] });
  assert.deepEqual(
    resolveBoundFillEditableElement(wrapperWithReadonly, visible),
    { source: null, editableCount: 0, kind: null },
    "a visible readonly descendant must not fall back to writing the wrapper"
  );
});

test("Browser API shape legacy explicit-finalize supports repeated existing-tab claim/read/release/reclaim", async () => {
  const calls = [];
  let claimed = false;
  let claimCount = 0;
  const tab = {
    id: "legacy-tab",
    async title() { return "Legacy tab"; },
  };
  const browser = {
    tabs: {
      async finalize(options) {
        calls.push(options);
        claimed = false;
      },
    },
    user: {
      async claimTab() {
        if (claimed) throw new Error("Tab legacy-tab is already part of browser session synthetic-session");
        claimed = true;
        claimCount += 1;
        return tab;
      },
    },
  };
  assert.deepEqual(normalizeBrowserLifecycleShape(browser, tab), {
    shape: "legacy-explicit-finalize",
    existingTabRelease: "explicit-finalize",
    deliverable: "explicit-finalize",
  });
  assert.equal(assertBrowserExistingTabReleaseAvailable(browser).shape, "legacy-explicit-finalize");

  const first = await browser.user.claimTab();
  assert.equal(await first.title(), "Legacy tab");
  assert.deepEqual(await cleanupBrowserClaim(browser, first), {
    cleanupStatus: "released",
    cleanupReason: "explicit-finalize",
    lifecycleShape: "legacy-explicit-finalize",
  });

  const second = await browser.user.claimTab();
  assert.equal(await second.title(), "Legacy tab");
  assert.deepEqual(await releaseBrowserClaim(browser, second), {
    cleanupStatus: "released",
    cleanupReason: "explicit-finalize",
    lifecycleShape: "legacy-explicit-finalize",
  });
  assert.equal(claimCount, 2);
  assert.deepEqual(calls, [{ keep: [] }, { keep: [] }]);
});

test("Browser API shape finalize-absent turn-cleanup reports turn-boundary release and optional later-turn handoff", async () => {
  let claimed = false;
  let handoffMarks = 0;
  let deliverableMarks = 0;
  const tab = {
    id: "turn-cleanup-tab",
    async markDeliverable() { deliverableMarks += 1; },
    async markHandoff() { handoffMarks += 1; },
  };
  const browser = {
    tabs: {},
    user: {
      async claimTab() {
        if (claimed) throw new Error("Tab turn-cleanup-tab is already part of browser session synthetic-session");
        claimed = true;
        return tab;
      },
    },
  };
  assert.deepEqual(normalizeBrowserLifecycleShape(browser, tab), {
    shape: "finalize-absent-turn-cleanup",
    existingTabRelease: "turn-boundary-auto-release",
    continuation: "markHandoff",
    deliverable: "markDeliverable",
  });
  const first = await browser.user.claimTab();
  assert.deepEqual(await cleanupBrowserClaim(browser, first), {
    cleanupStatus: "deferred",
    cleanupReason: "turn-boundary-auto-release",
    lifecycleShape: "finalize-absent-turn-cleanup",
  });
  assert.equal(handoffMarks, 0, "ordinary turn-end cleanup must not mark unfinished handoff");
  assert.equal(deliverableMarks, 0, "ordinary existing-tab cleanup must not mark deliverable");
  await assert.rejects(
    () => browser.user.claimTab(),
    /already part of browser session/,
    "the maintained release occurs at turn boundary, not inside the same turn"
  );
  claimed = false;
  const second = await browser.user.claimTab();
  assert.equal(second, tab, "a later turn can reclaim the still-open user tab after turn-boundary handback");
  assert.equal(await markBrowserHandoff(browser, second), "finalize-absent-turn-cleanup");
  assert.equal(handoffMarks, 1, "unfinished later-turn workflow explicitly marks handoff");
  assert.throws(
    () => assertBrowserExistingTabReleaseAvailable(browser),
    /TOOLWIRE_BROWSER_EXISTING_TAB_RELEASE_UNAVAILABLE:finalize-absent-release-unproven/
  );
});

test("Browser API shape finalize-absent fresh new-tab uses markDeliverable", async () => {
  let marked = 0;
  const browser = { tabs: {} };
  const tab = {
    async markDeliverable() {
      marked += 1;
    },
    async markHandoff() {},
  };
  assert.equal(await markBrowserDeliverable(browser, tab), "finalize-absent-turn-cleanup");
  assert.equal(marked, 1);
});

function makeWorkbench({ chromeConnected = true, skillAvailable = true, nodeReplAvailable = true, skillPath = fakeSkillPath, browserBackends = null } = {}) {
  const calls = [];
  const state = {
    skillPath,
    browserBackends: browserBackends ?? (chromeConnected
      ? [{ name: "Chrome", family: "chrome", type: "extension" }]
      : [{ name: "Edge", family: "edge", type: "extension" }]),
    expectedBrowserClientUrl: null,
    tabs: [{
      providerTabId: '["browser-instance","123"]',
      title: "Inbox - Example Mail",
      url: "https://mail.example.test/inbox",
      lastOpened: "2026-08-13T00:00:00.000Z",
    }],
    stale: false,
    openTabsErrorText: null,
    claimTabErrorText: null,
    simulateClaimLifecycle: false,
    syntheticClaimHeld: false,
    syntheticClaimAttempts: 0,
    cleanupReceipt: {
      cleanupStatus: "released",
      cleanupReason: "explicit-finalize",
      cleanupError: null,
    },
    locatorCount: 1,
    locatorVisible: true,
    locatorEnabled: true,
    textVisibleCount: 1,
    textHiddenDuplicateCount: 0,
    textSemanticCount: 1,
    textSemanticKind: "role",
    textSemanticRole: "link",
    textClickBinding: { kind: "onclick-property", depth: 2, tagName: "div", role: null, id: null },
    textThreadCardBinding: { kind: "thread-card-data", depth: 1, tagName: "div", threadId: "2811" },
    textStableIdBinding: { kind: "stable-element-id", depth: 0, tagName: "a", id: "sendPasswordButton", role: null, href: null, ariaDisabled: null },
    scopeLinkCount: 1,
    scopedTargetCount: 1,
    textBindingChanged: false,
    pageChanged: false,
    clickUncertain: false,
    fillUncertain: false,
    navigateUncertain: false,
    navigatePostDispatchFailure: false,
    navigateTransportThrow: false,
    navigateGenerationChangeAfterDispatch: false,
    closeUncertain: false,
    closeTransportThrow: false,
    closeDispatches: 0,
    bulkCloseDispatches: 0,
    bulkCloseUncertainProviderTabId: null,
    workbenchRestarts: 0,
    clickPostDispatchFailure: false,
    clickFinalizeFailure: false,
    clickTransportThrow: false,
    clickEmptyResponse: false,
    clickGenericIsErrorAfterDispatch: false,
    fillPostDispatchFailure: false,
    fillFinalizeFailure: false,
    fillTransportThrow: false,
    fillNonJsonResponse: false,
    fillNotApplied: false,
    fillVerificationUnavailable: false,
    fillActivationRepair: false,
    fillTargetChanged: false,
    fillEditableErrorCount: null,
    fillVerificationSource: "fresh-target",
    fillRoleBoundCount: 1,
    fillNativePasswordCount: 0,
    fillNativePasswordVisible: true,
    fillNativePasswordEnabled: true,
    clicks: 0,
    downloads: 0,
    downloadUncertain: false,
    uploads: 0,
    uploadUncertain: false,
    uploadPostDispatchHook: null,
    fills: 0,
    navigations: 0,
    openedTabs: 0,
    openedTabFamilies: [],
    openTabUncertain: false,
    screenshots: 0,
    screenshotReportedByteLengthDelta: 0,
    keypresses: [],
    keypressUncertain: false,
    scrolls: 0,
    lastScrollDelta: null,
    scrollUncertain: false,
    scrollReadbackFailure: false,
    domSnapshotOverride: null,
    visibleDom: '<button node_id=17 role="button" aria-label="Compose">Compose</button>\n<button node_id=23 role="button" aria-label="Compose">Compose</button>',
    elementVisibleDomReads: 0,
    elementClicks: 0,
    elementDoubleClicks: 0,
    elementActionUncertain: false,
    passwordSnapshotDescriptors: [],
    fieldValue: "",
    fieldRenderedText: null,
    fillStrategy: "fill",
    fillTargetMeta: {
      tag: "input",
      inputType: "text",
      placeholder: "Search Reddit",
      contentEditable: false,
      customHost: null,
      editableSource: "direct",
      editableKind: "input",
      semanticTag: "input",
      semanticContentEditable: false,
    },
    bumpGenerationBeforeMutationDispatch: false,
    bumpGenerationBeforeReadDispatch: false,
    skillPathAfterReadRestart: null,
    mcpCatalogCalls: 0,
    mcpCatalogFailuresRemaining: 0,
    bumpGenerationOnMcpCatalogFailure: false,
    webMcpFetches: 0,
    webMcpCalls: 0,
    webMcpDrops: 0,
    webMcpDescription: "WebMCP tools available: save_note",
    webMcpResult: { saved: true },
    webMcpDiscoverErrorText: null,
    webMcpCallErrorText: null,
  };
  return {
    generation: 1,
    calls,
    state,
    async restart() {
      state.workbenchRestarts += 1;
      state.syntheticClaimHeld = false;
      this.generation += 1;
      return { status: "restarted", generation: this.generation };
    },
    async catalog({ kind }) {
      if (kind === "skills") {
        return { skills: skillAvailable ? [{ name: "chrome:control-chrome", path: state.skillPath, enabled: true }] : [] };
      }
      if (kind === "mcp") {
        state.mcpCatalogCalls += 1;
        if (state.mcpCatalogFailuresRemaining > 0) {
          state.mcpCatalogFailuresRemaining -= 1;
          if (state.bumpGenerationOnMcpCatalogFailure) this.generation += 1;
          throw new Error("simulated transient node_repl discovery failure");
        }
        return {
          servers: nodeReplAvailable
            ? [{ name: "node_repl", error: null, tools: [{ name: "js" }] }]
            : [{ name: "node_repl", error: "offline", tools: [] }],
        };
      }
      throw new Error(`unexpected catalog kind ${kind}`);
    },
    async mcpCall(input) {
      calls.push(input);
      const meta = input.meta?.["x-codex-turn-metadata"];
      assert.equal(typeof meta?.session_id, "string");
      assert.equal(typeof meta?.turn_id, "string");
      assert.equal(Object.hasOwn(input.meta ?? {}, "session_id"), false, "turn metadata must not be flat");
      assert.match(input.arguments?.code ?? "", /setupBrowserRuntime/);
      assert.match(input.arguments?.code ?? "", /scripts\/browser-client\.mjs/);
      if (state.expectedBrowserClientUrl) {
        assert.ok(
          (input.arguments?.code ?? "").includes(JSON.stringify(state.expectedBrowserClientUrl)),
          "Browser bootstrap must import the startup-bound canonical browser client URL"
        );
      }
      assert.match(input.arguments?.code ?? "", /\n\{\n/, "Browser body must be isolated in a block scope for persistent node_repl sessions");

      const code = input.arguments?.code ?? "";
      const title = input.arguments?.title ?? "";
      if (input.expectedGeneration !== null && input.expectedGeneration !== undefined) {
        assert.equal(input.expectedGeneration, this.generation, "Browser must bind Workbench calls to the current generation");
      }
      if (state.bumpGenerationBeforeReadDispatch && title === "Check connected browser backends") {
        state.bumpGenerationBeforeReadDispatch = false;
        if (state.skillPathAfterReadRestart) state.skillPath = state.skillPathAfterReadRestart;
        this.generation += 1;
        throw new Error(`WORKBENCH_GENERATION_STALE: expected=${input.expectedGeneration} current=${this.generation}`);
      }
      if (state.bumpGenerationBeforeMutationDispatch && /^Execute prepared Chrome (navigate|click|download|fill|tab close)$/.test(title)) {
        state.bumpGenerationBeforeMutationDispatch = false;
        this.generation += 1;
        throw new Error(`WORKBENCH_GENERATION_STALE: expected=${input.expectedGeneration} current=${this.generation}`);
      }
      if (code.includes("user.claimTab(")) {
        if (typeof state.claimTabErrorText === "string") {
          return { isError: true, text: state.claimTabErrorText };
        }
        if (state.simulateClaimLifecycle) {
          state.syntheticClaimAttempts += 1;
          if (state.syntheticClaimHeld) {
            return { isError: true, text: "Tab 123 is already part of browser session synthetic-session" };
          }
          if (state.cleanupReceipt?.cleanupStatus !== "released") state.syntheticClaimHeld = true;
        }
      }
      if (title === "Probe ChatGPT actual model route") {
        assert.match(code, /documentation\.get\("capabilities\/tab\/cdp"\)/);
        assert.match(code, /你现在是什么模型？/);
        assert.match(code, /getByRole\("radio", \{ name, exact: true \}\)/);
        assert.match(code, /\[\["chat", "Chat"\], \["work", "Work"\]\]/);
        assert.match(code, /TOOLWIRE_BROWSER_MODEL_ROUTE_CHAT_SURFACE_REQUIRED/);
        assert.doesNotMatch(code, /TOOLWIRE_BROWSER_MODEL_ROUTE_TEMP_CHAT_REQUIRED/);
        return {
          isError: false,
          text: JSON.stringify({
            status: "ok",
            submitted: true,
            responseObserved: true,
            streamFinished: true,
            streamFailed: false,
            response: { origin: "https://chatgpt.com", pathname: "/backend-api/f/conversation", status: 200, mimeType: "text/event-stream" },
            assistantClaim: { text: "我是 GPT-5.6 Sol。", truncated: false },
            surfaceMode: "chat",
            fields: {
              resolved_model_slug: "gpt-5-6-thinking",
              server_ste_metadata: { model_slug: null },
              requested_model_experience: null,
              observedValues: {
                resolved_model_slug: ["gpt-5-6-thinking"],
                server_ste_metadata_model_slug: [],
                requested_model_experience: [],
              },
            },
            evidence: {
              cdpCapability: true,
              networkEnabledBeforeSubmit: true,
              eventBaselineBeforeSubmit: true,
              websocketFramesObserved: true,
              responseBodyAvailable: true,
              responseBodyError: null,
            },
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Read Codex Browser confirmation policy") {
        assert.match(code, /documentation\.get\("confirmations"\)/);
        assert.doesNotMatch(code, /user\.openTabs\(\)/);
        return {
          isError: false,
          text: JSON.stringify({
            policy: "# Browser Use Confirmations Policy\n### Always Confirm at Action-Time\n- Representational communication\n### No Confirmation Needed\n- Any action outside this taxonomy",
          }),
        };
      }
      if (title === "Capture existing Chrome tab screenshot") {
        assert.match(code, /user\.openTabs\(\)/);
        assert.match(code, /user\.claimTab\(/);
        assert.match(code, /\.screenshot\(\{ fullPage: false \}\)/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/, "existing-tab screenshot must route cleanup through the capability-shape adapter");
        assert.doesNotMatch(code, /clip\s*:/);
        if (state.stale) return { isError: true, text: "TOOLWIRE_BROWSER_TAB_STALE" };
        state.screenshots += 1;
        return {
          isError: false,
          text: JSON.stringify({
            title: state.tabs[0].title,
            url: state.tabs[0].url,
            lastOpened: state.tabs[0].lastOpened,
            byteLength: Buffer.from(fakeJpegBase64, "base64").length + state.screenshotReportedByteLengthDelta,
            dataBase64: fakeJpegBase64,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Prepare exact-set Chrome bulk tab close") {
        assert.match(code, /user\.openTabs\(\)/);
        assert.doesNotMatch(code, /user\.claimTab\(/, "bulk-close prepare must remain read-only and unclaimed");
        assert.doesNotMatch(code, /\.close\(\)/, "bulk-close prepare must not close any tab");
        const requestedMatch = code.match(/const __twRequested = (\[[^\n]+\]);/);
        assert.ok(requestedMatch, "bulk-close prepare must bind an exact server-side provider set");
        const requested = JSON.parse(requestedMatch[1]);
        const rows = [];
        for (let index = 0; index < requested.length; index += 1) {
          const tab = state.tabs.find((candidate) => candidate.providerTabId === requested[index].providerTabId);
          if (!tab) return { isError: true, text: `TOOLWIRE_BROWSER_BULK_CLOSE_TAB_STALE:${index}` };
          if (typeof tab.url !== "string" || !tab.url) return { isError: true, text: `TOOLWIRE_BROWSER_BULK_CLOSE_URL_UNAVAILABLE:${index}` };
          rows.push({ ...tab });
        }
        return { isError: false, text: JSON.stringify({ rows }) };
      }
      if (title.startsWith("Execute prepared Chrome bulk tab close ")) {
        assert.match(code, /user\.openTabs\(\)/);
        assert.match(code, /user\.claimTab\(/);
        assert.match(code, /__twTab\.close\(\)/);
        assert.match(code, /TOOLWIRE_BROWSER_BULK_CLOSE_URL_CHANGED/);
        assert.match(code, /TOOLWIRE_BROWSER_BULK_CLOSE_RESULT_UNCERTAIN/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        const providerMatch = code.match(/providerTabId === ("(?:[^"\\]|\\.)*")/);
        assert.ok(providerMatch, "bulk-close execute must bind one prepared provider identity per item");
        const providerTabId = JSON.parse(providerMatch[1]);
        const expectedUrlMatch = code.match(/__twObservedUrl !== ("(?:[^"\\]|\\.)*")/);
        assert.ok(expectedUrlMatch, "bulk-close execute must bind one exact prepared URL per item");
        const expectedUrl = JSON.parse(expectedUrlMatch[1]);
        const index = state.tabs.findIndex((candidate) => candidate.providerTabId === providerTabId);
        if (index < 0) return { isError: true, text: "TOOLWIRE_BROWSER_BULK_CLOSE_TAB_STALE" };
        const tab = state.tabs[index];
        if (tab.url !== expectedUrl) return { isError: true, text: "TOOLWIRE_BROWSER_BULK_CLOSE_URL_CHANGED" };
        state.bulkCloseDispatches += 1;
        if (state.bulkCloseUncertainProviderTabId === providerTabId) {
          return { isError: true, text: "TOOLWIRE_BROWSER_BULK_CLOSE_RESULT_UNCERTAIN:simulated lost receipt after close dispatch" };
        }
        state.tabs.splice(index, 1);
        return { isError: false, text: JSON.stringify({ beforeUrl: expectedUrl, closed: true }) };
      }
      if (title === "Prepare exact Chrome tab close") {
        assert.match(code, /user\.openTabs\(\)/);
        assert.doesNotMatch(code, /user\.claimTab\(/, "prepare close must not claim the tab");
        assert.doesNotMatch(code, /\.close\(\)/, "prepare close must remain read-only");
        assert.equal(state.closeDispatches, 0, "prepare close must not dispatch a close");
        if (state.stale) return { isError: true, text: "TOOLWIRE_BROWSER_TAB_STALE" };
        const providerMatch = code.match(/providerTabId === ("(?:[^"\\]|\\.)*")/);
        assert.ok(providerMatch, "prepare close must bind one providerTabId literal from the opaque tabRef map");
        const providerTabId = JSON.parse(providerMatch[1]);
        const tab = state.tabs.find((candidate) => candidate.providerTabId === providerTabId);
        if (!tab) return { isError: true, text: "TOOLWIRE_BROWSER_TAB_STALE" };
        return {
          isError: false,
          text: JSON.stringify({
            title: tab.title,
            url: tab.url,
            lastOpened: tab.lastOpened,
          }),
        };
      }
      if (title === "Execute prepared Chrome tab close") {
        assert.match(code, /user\.openTabs\(\)/);
        assert.match(code, /user\.claimTab\(/);
        assert.match(code, /__twTab\.close\(\)/, "execute close must use the official Tab.close primitive");
        assert.match(code, /TOOLWIRE_BROWSER_ACTION_URL_CHANGED/);
        assert.match(code, /__twDispatchAttempted = true/);
        assert.match(code, /TOOLWIRE_BROWSER_CLOSE_RESULT_UNCERTAIN/);
        assert.match(code, /if \(__twTab && !__twDispatchAttempted\)/, "cleanup is allowed only for a pre-dispatch close claim");
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/, "pre-dispatch close cleanup must route through the capability-shape adapter");
        const providerMatch = code.match(/providerTabId === ("(?:[^"\\]|\\.)*")/);
        assert.ok(providerMatch, "execute close must bind the prepared provider identity");
        const providerTabId = JSON.parse(providerMatch[1]);
        const expectedUrlMatch = code.match(/__twBeforeUrl !== ("(?:[^"\\]|\\.)*")/);
        assert.ok(expectedUrlMatch, "execute close must bind the prepared current URL");
        const expectedUrl = JSON.parse(expectedUrlMatch[1]);
        const index = state.tabs.findIndex((candidate) => candidate.providerTabId === providerTabId);
        if (index < 0) return { isError: true, text: "TOOLWIRE_BROWSER_TAB_STALE" };
        const tab = state.tabs[index];
        if (tab.url !== expectedUrl) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        state.closeDispatches += 1;
        if (state.closeUncertain) {
          return { isError: true, text: "TOOLWIRE_BROWSER_CLOSE_RESULT_UNCERTAIN:timeout after close dispatch" };
        }
        const [closed] = state.tabs.splice(index, 1);
        if (state.closeTransportThrow) {
          throw new Error("simulated MCP transport lost after close dispatch");
        }
        return {
          isError: false,
          text: JSON.stringify({ beforeUrl: closed.url, closed: true }),
        };
      }
      if (title === "Prepare exact Chrome navigation") {
        assert.match(code, /user\.openTabs\(\)/);
        assert.doesNotMatch(code, /\.goto\(/, "prepare navigation must remain read-only");
        assert.equal(state.navigations, 0);
        if (state.stale) return { isError: true, text: "TOOLWIRE_BROWSER_TAB_STALE" };
        return {
          isError: false,
          text: JSON.stringify({
            title: state.tabs[0].title,
            url: state.tabs[0].url,
            lastOpened: state.tabs[0].lastOpened,
          }),
        };
      }
      if (title === "Execute prepared Chrome navigation") {
        assert.match(code, /\.goto\(/);
        assert.match(code, /TOOLWIRE_BROWSER_ACTION_URL_CHANGED/);
        assert.match(code, /__twDispatchAttempted = true/);
        assert.match(code, /TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        if (state.navigateUncertain) return { isError: true, text: "TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN:timeout after dispatch" };
        const targetMatch = code.match(/\.goto\(("(?:[^"\\]|\\.)*")\)/);
        assert.ok(targetMatch, "navigate body must bind a JSON URL literal");
        const targetUrl = JSON.parse(targetMatch[1]);
        const beforeUrl = state.tabs[0].url;
        state.navigations += 1;
        state.tabs[0] = { ...state.tabs[0], url: targetUrl, title: "Navigated Page" };
        if (state.navigateGenerationChangeAfterDispatch) {
          this.generation += 1;
          throw new Error("simulated transport loss after navigation dispatch and Workbench restart");
        }
        if (state.navigateTransportThrow) throw new Error("simulated MCP transport lost after navigation dispatch");
        if (state.navigatePostDispatchFailure) {
          return { isError: true, text: "TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN:domSnapshot failed after dispatch" };
        }
        return {
          isError: false,
          text: JSON.stringify({
            beforeUrl,
            requestedUrl: targetUrl,
            afterUrl: targetUrl,
            afterTitle: state.tabs[0].title,
            snapshot: "POST_NAVIGATE_OK",
            ...state.cleanupReceipt,
          }),
        };
      }
      if (/^Execute prepared (Chrome|Edge) new tab$/.test(title)) {
        const family = title.includes("Edge") ? "edge" : "chrome";
        assert.ok(code.includes(`browsers.get(${JSON.stringify(family)})`), "new-tab dispatch must use the prepared browser family");
        assert.match(code, /\.tabs\.new\(\)/);
        assert.match(code, /\.goto\(/);
        assert.match(code, /markBrowserDeliverable\(__twBrowser, __twTab\)/, "new-tab cleanup must route through the normalized lifecycle adapter");
        assert.match(code, /await tab\.markDeliverable\(\)/, "finalize-absent new-tab shape must keep the exact created tab through Tab.markDeliverable()");
        assert.match(code, /TOOLWIRE_BROWSER_DELIVERABLE_API_UNAVAILABLE/, "unknown cleanup APIs must fail visibly after dispatch rather than guessing");
        assert.match(code, /TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN/);
        const targetMatch = code.match(/\.goto\(("(?:[^"\\]|\\.)*")\)/);
        assert.ok(targetMatch, "new-tab body must bind a JSON URL literal");
        const targetUrl = JSON.parse(targetMatch[1]);
        state.openedTabs += 1;
        state.openedTabFamilies.push(family);
        if (state.openTabUncertain) {
          return { isError: true, text: "TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN:simulated lost receipt after create dispatch" };
        }
        state.tabs.unshift({
          providerTabId: `["browser-instance","new-${state.openedTabs}"]`,
          title: "Opened Page",
          url: targetUrl,
          lastOpened: `2026-08-13T00:00:0${state.openedTabs}.000Z`,
        });
        return {
          isError: false,
          text: JSON.stringify({
            requestedUrl: targetUrl,
            afterUrl: targetUrl,
            afterTitle: "Opened Page",
            snapshot: "POST_OPEN_TAB_OK",
          }),
        };
      }
      if (title === "Dispatch bounded Chrome scroll") {
        assert.match(code, /playwright\.locator\("body"\)/);
        assert.match(code, /\.press\(__twKey, \{ timeoutMs: 3000 \}\)/);
        assert.doesNotMatch(code, /dom_cua\.scroll/);
        assert.match(code, /TOOLWIRE_BROWSER_ACTION_URL_CHANGED/);
        assert.match(code, /TOOLWIRE_BROWSER_SCROLL_RESULT_UNCERTAIN/);
        assert.match(code, /__twScrollReturned/);
        assert.doesNotMatch(code, /domSnapshot\(/, "scroll dispatch receipt must not depend on DOM readback");
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        const keysMatch = code.match(/for \(const __twKey of (\[[^\]]*\])\)/);
        assert.ok(keysMatch, "scroll body must bind a fixed JSON key sequence");
        const keys = JSON.parse(keysMatch[1]);
        assert.ok(keys.length >= 1);
        assert.ok(keys.every((key) => ["PageDown", "PageUp", "ArrowDown", "ArrowUp"].includes(key)));
        const firstKey = keys[0];
        const deltaY = firstKey === "PageDown" ? 800 : firstKey === "PageUp" ? -800 : firstKey === "ArrowDown" ? 400 : -400;
        state.scrolls += 1;
        state.lastScrollDelta = deltaY;
        if (state.scrollUncertain) {
          return { isError: true, text: "TOOLWIRE_BROWSER_SCROLL_RESULT_UNCERTAIN:timeout before scroll receipt" };
        }
        return {
          isError: false,
          text: JSON.stringify({
            beforeUrl: state.tabs[0].url,
            scrollReturned: true,
            inputMethod: "body-keypress",
            keypresses: keys,
            settleCompleted: true,
            settleError: null,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Dispatch fixed Chrome keypress") {
        assert.match(code, /dom_cua\.keypress\(\{ keys: \[/);
        assert.match(code, /TOOLWIRE_BROWSER_ACTION_URL_CHANGED/);
        assert.match(code, /TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        assert.doesNotMatch(code, /playwright\.locator\(/);
        assert.doesNotMatch(code, /__twTab\.cua\.keypress\(/, "P1b should use DOM CUA current-focus keypress, not coordinate CUA");
        assert.doesNotMatch(code, /domSnapshot\(/, "keypress dispatch receipt must not depend on DOM readback");
        const keyMatch = code.match(/key: ("(?:Enter|Tab|Escape)")/);
        assert.ok(keyMatch, "keypress body must bind one fixed supported key");
        const key = JSON.parse(keyMatch[1]);
        state.keypresses.push(key);
        if (state.keypressUncertain) {
          return { isError: true, text: "TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN:timeout before keypress receipt" };
        }
        return {
          isError: false,
          text: JSON.stringify({
            beforeUrl: state.tabs[0].url,
            afterUrl: state.tabs[0].url,
            afterTitle: state.tabs[0].title,
            keypressReturned: true,
            inputMethod: "focused-keypress",
            key,
            settleCompleted: true,
            settleError: null,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Prepare exact Chrome click") {
        const exactTextMode = code.includes("playwright.getByText(");
        const scopedRoleMode = code.includes("const __twScopeLinks =");
        if (exactTextMode) {
          assert.match(code, /getByText/);
          assert.match(code, /getByText/);
          assert.match(code, /__twRawTextLocator\.all\(\)/);
          assert.match(code, /__twCandidate\.isVisible\(\)/);
          assert.match(code, /__twVisibleTextCandidates\.length/);
          assert.doesNotMatch(code, /getByText[\s\S]*filter\(\{ visible: true \}\)/);
          assert.match(code, /getByRole/);
          assert.match(code, /filter\(\{ has: __twTextLocator \}\)/);
          assert.match(code, /TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT/);
          if (state.textVisibleCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.textVisibleCount };
          if (state.textSemanticKind === "stable-element-id" && /if \(__twSemanticCount === 0 && false\)/.test(code)) {
            return { isError: true, text: "TOOLWIRE_BROWSER_TEXT_NO_BINDING:[]" };
          }
          if (state.textSemanticCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + state.textSemanticCount };
        } else if (scopedRoleMode) {
          assert.match(code, /getByRole\("link"\)\.filter\(\{ visible: true \}\)/);
          assert.match(code, /__twScopeLinks\.evaluateAll/);
          assert.match(code, /document\.baseURI/);
          assert.match(code, /__twDepth <= 8/);
          assert.match(code, /__twScope\.locator\("\.\."\)/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_LINK_COUNT/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT/);
          if (state.scopeLinkCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + state.scopeLinkCount };
          if (state.scopedTargetCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:3:" + state.scopedTargetCount };
        } else {
          assert.match(code, /getByRole/);
        }
        assert.match(code, /exact: true/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        assert.equal(state.clicks, 0, "prepare must not dispatch a click");
        if (!scopedRoleMode && state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        return {
          isError: false,
          text: JSON.stringify({
            title: state.tabs[0].title,
            url: state.tabs[0].url,
            count: 1,
            visible: true,
            enabled: true,
            resolvedKind: exactTextMode ? state.textSemanticKind : scopedRoleMode ? "role-scope-url" : "role",
            resolvedRole: exactTextMode && state.textSemanticKind === "role" ? state.textSemanticRole : "button",
            resolvedClickBinding: exactTextMode && (state.textSemanticKind === "onclick-property" || state.textSemanticKind === "label-control" || state.textSemanticKind === "local-radio" || state.textSemanticKind === "flair-template-option")
              ? state.textClickBinding
              : exactTextMode && state.textSemanticKind === "thread-card-data"
                ? state.textThreadCardBinding
                : exactTextMode && state.textSemanticKind === "stable-element-id"
                  ? state.textStableIdBinding
                  : null,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Prepare exact Chrome fill") {
        const scopedFillMode = code.includes("const __twScopeLinks =");
        const placeholderFillMode = code.includes("__twPlaceholderRoleLocator");
        const nativePasswordFillMode = code.includes("__twNativePasswordCandidates");
        assert.match(code, /getByRole/);
        assert.match(code, /__twResolveBoundEditableLocator/);
        assert.match(code, /locator\('input, textarea, \[contenteditable\]'\)/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_EDITABLE_COUNT/);
        assert.match(code, /editableSource/);
        assert.match(code, /editableKind/);
        assert.match(code, /semantic-shell/);
        if (placeholderFillMode) {
          assert.match(code, /__twPlaceholderRoleCandidates/);
          assert.match(code, /__twPlaceholderSemanticMatches/);
          assert.match(code, /getAttribute\("placeholder"\)/);
          assert.match(code, /descendantPlaceholderMatches/);
          assert.doesNotMatch(code, /getByPlaceholder/);
        }
        if (nativePasswordFillMode) {
          assert.match(code, /__twNativePasswordInputs/);
          assert.match(code, /__twNativePasswordCandidates/);
          assert.match(code, /__twCandidate\.isVisible\(\)/);
          assert.match(code, /__twCandidate\.isEnabled\(\)/);
          assert.match(code, /type === "password"/);
          assert.match(code, /placeholder === __twPasswordBinding\?\.expectedPlaceholder/);
        }
        if (scopedFillMode) {
          assert.match(code, /__twScopeLinks\.evaluateAll/);
          assert.match(code, /__twDepth <= 8/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_LINK_COUNT/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT/);
          if (state.scopeLinkCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + state.scopeLinkCount };
          if (state.scopedTargetCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:3:" + state.scopedTargetCount };
        } else if (!placeholderFillMode) {
          assert.match(code, /exact: true/);
        }
        assert.doesNotMatch(code, /inputValue\s*\(/);
        assert.match(code, /isContentEditable/);
        assert.match(code, /customHost/);
        assert.match(code, /__twFillStrategy/);
        assert.match(code, /__twTargetStructure/);
        assert.match(code, /directParagraphCount/);
        assert.match(code, /editableDescendantCount/);
        assert.match(code, /outerHtmlByteLength/);
        assert.doesNotMatch(code, /targetStructure:[\s\S]*outerHTML/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        assert.equal(state.fills, 0, "prepare fill must not mutate the field");
        const nativePasswordEligibleCount = nativePasswordFillMode && state.fillNativePasswordVisible && state.fillNativePasswordEnabled
          ? state.fillNativePasswordCount
          : 0;
        const placeholderResolvedCount = state.fillRoleBoundCount !== 0 ? state.fillRoleBoundCount : nativePasswordEligibleCount;
        if (placeholderFillMode && placeholderResolvedCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + placeholderResolvedCount };
        if (!scopedFillMode && !placeholderFillMode && state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (Number.isInteger(state.fillEditableErrorCount)) return { isError: true, text: "TOOLWIRE_BROWSER_FILL_EDITABLE_COUNT:" + state.fillEditableErrorCount };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        const currentValue = state.fillTargetMeta?.inputType === "password"
          ? null
          : typeof state.fieldRenderedText === "string"
            && /^\s*$/.test(state.fieldValue)
            && !/^\s*$/.test(state.fieldRenderedText)
            ? state.fieldRenderedText
            : state.fieldValue;
        return {
          isError: false,
          text: JSON.stringify({
            title: state.tabs[0].title,
            url: state.tabs[0].url,
            role: "textbox",
            name: scopedFillMode ? null : "Search",
            count: 1,
            visible: true,
            enabled: true,
            currentValue,
            fillStrategy: state.fillStrategy,
            targetMeta: state.fillTargetMeta,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Execute prepared Chrome fill") {
        const scopedFillMode = code.includes("const __twScopeLinks =");
        const placeholderFillMode = code.includes("__twPlaceholderRoleLocator");
        const nativePasswordFill = code.includes("const __twNativePasswordFill = true;");
        const nativePasswordBindingMatch = code.match(/const __twPreparedNativePasswordBinding = (\{[^\r\n]+\}|null);/);
        const nativePasswordBinding = nativePasswordBindingMatch ? JSON.parse(nativePasswordBindingMatch[1]) : null;
        assert.match(code, /getByRole/);
        if (scopedFillMode) {
          assert.match(code, /__twScopeLinks\.evaluateAll/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_LINK_COUNT/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT/);
          if (state.scopeLinkCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + state.scopeLinkCount };
          if (state.scopedTargetCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:3:" + state.scopedTargetCount };
        } else if (!placeholderFillMode) {
          assert.match(code, /exact: true/);
        }
        assert.match(code, /\.fill\(/);
        assert.match(code, /\.type\(/);
        assert.doesNotMatch(code, /inputValue\s*\(/);
        assert.match(code, /isContentEditable/);
        assert.match(code, /__twFillStrategy/);
        assert.match(code, /TOOLWIRE_BROWSER_ACTION_URL_CHANGED/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH/);
        assert.match(code, /target-rendered-text/);
        assert.match(code, /canonicalizeContentEditableParagraphText/);
        assert.match(code, /resolveBoundContentEditableParagraphText/);
        assert.match(code, /unique-visible-descendant/);
        assert.match(code, /querySelectorAll\(["']\[contenteditable\]["']\)/);
        assert.match(code, /fresh-target-rich-paragraphs/);
        assert.match(code, /canonicalRichText/);
        assert.match(code, /inlineTags/);
        assert.match(code, /\.innerText\(\{ timeoutMs: 1000 \}\)/);
        assert.match(code, /\.textContent\(\{ timeoutMs: 1000 \}\)/);
        assert.match(code, /__twResolveBoundEditableLocator/);
        assert.match(code, /locator\('input, textarea, \[contenteditable\]'\)/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_TARGET_CHANGED/);
        assert.match(code, /editableSource/);
        assert.match(code, /editableKind/);
        assert.doesNotMatch(code, /same-role-visible-target/);
        assert.doesNotMatch(code, /local-editor-exact/);
        assert.doesNotMatch(code, /depth <= 3/);
        assert.match(code, /__twResolveFreshTarget/);
        assert.match(code, /__twVerifyFreshTarget/);
        assert.match(code, /activation-only-empty/);
        assert.match(code, /phaseStatus: __twActivationOnly \? "activation_only" : "filled"/);
        assert.match(code, /__twActivationOnly = true/);
        assert.match(code, /__twRepairSettleMs = 750/);
        assert.match(code, /waitForTimeout\(__twRepairSettleMs\)/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_NOT_APPLIED/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE/);
        assert.match(code, /__twDispatchAttempted = true/);
        assert.match(code, /__twFinalizeError/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        const nativePasswordEligibleCount = placeholderFillMode && state.fillNativePasswordVisible && state.fillNativePasswordEnabled
          ? state.fillNativePasswordCount
          : 0;
        const placeholderResolvedCount = state.fillRoleBoundCount !== 0 ? state.fillRoleBoundCount : nativePasswordEligibleCount;
        if (placeholderFillMode && placeholderResolvedCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + placeholderResolvedCount };
        if (!scopedFillMode && !placeholderFillMode && state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (Number.isInteger(state.fillEditableErrorCount)) return { isError: true, text: "TOOLWIRE_BROWSER_FILL_EDITABLE_COUNT:" + state.fillEditableErrorCount };
        if (state.fillTargetChanged) return { isError: true, text: "TOOLWIRE_BROWSER_FILL_TARGET_CHANGED" };
        if (nativePasswordFill && (
          state.fillTargetMeta?.tag !== nativePasswordBinding?.tag
          || state.fillTargetMeta?.inputType !== nativePasswordBinding?.type
          || state.fillTargetMeta?.placeholder !== nativePasswordBinding?.placeholder
        )) return { isError: true, text: "TOOLWIRE_BROWSER_FILL_TARGET_CHANGED" };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        if (state.fillUncertain) return { isError: true, text: "TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN:timeout after input event" };
        const textMatches = [...code.matchAll(/\.fill\(("(?:[^"\\]|\\.)*"), \{\}\)/g)];
        const textMatch = textMatches.at(-1);
        assert.ok(textMatch, "fill body must bind a JSON string literal");
        const targetText = JSON.parse(textMatch[1]);
        const clearRequested = targetText === "";
        const beforeValue = nativePasswordFill
          ? null
          : typeof state.fieldRenderedText === "string"
            && /^\s*$/.test(state.fieldValue)
            && !/^\s*$/.test(state.fieldRenderedText)
            ? state.fieldRenderedText
            : state.fieldValue;
        if (state.fillNotApplied) {
          state.fills += 1;
          return { isError: true, text: "TOOLWIRE_BROWSER_FILL_NOT_APPLIED:fresh bound target remained empty after the bounded fill attempt" };
        }
        if (state.fillVerificationUnavailable) {
          state.fieldValue = targetText;
          state.fills += 1;
          return { isError: true, text: "TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appears in fresh DOM but exact bound-target verification did not resolve it" };
        }
        if (state.fillActivationRepair) {
          state.fills += 1;
          return {
            isError: false,
            text: JSON.stringify({
              phaseStatus: "activation_only",
              beforeUrl: state.tabs[0].url,
              afterUrl: state.tabs[0].url,
              afterTitle: state.tabs[0].title,
              beforeValue,
              afterValue: "",
              verificationSource: "activation-only-empty",
              dispatchAttempts: 1,
              settleRecheck: true,
              repairSettleMs: 750,
              reclaimAttempted: false,
              reclaimStatus: null,
              repairAttempted: false,
              repairReason: null,
              snapshot: "FIELD=",
              ...state.cleanupReceipt,
            }),
          };
        }
        if (typeof state.fieldRenderedText === "string" && state.fillStrategy === "type" && targetText === "" && !clearRequested) {
          state.fieldValue = "";
        } else {
          state.fieldValue = targetText;
          if (typeof state.fieldRenderedText === "string") state.fieldRenderedText = targetText;
        }
        state.fills += 1;
        if (state.fillTransportThrow) {
          throw new Error("simulated MCP transport lost after fill dispatch");
        }
        if (state.fillNonJsonResponse) {
          return { isError: false, text: "not-json-after-fill" };
        }
        if (state.fillPostDispatchFailure) {
          return { isError: true, text: "TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN:domSnapshot failed after dispatch" };
        }
        if (state.fillFinalizeFailure) {
          return { isError: true, text: "TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN:finalize failed after dispatch" };
        }
        const afterValue = typeof state.fieldRenderedText === "string" ? state.fieldRenderedText : state.fieldValue;
        return {
          isError: false,
          text: JSON.stringify({
            beforeUrl: state.tabs[0].url,
            afterUrl: state.tabs[0].url,
            afterTitle: state.tabs[0].title,
            ...(nativePasswordFill ? {} : { beforeValue, afterValue }),
            verificationSource: nativePasswordFill
              ? "fresh-native-password-binding"
              : typeof state.fieldRenderedText === "string" ? "fresh-target-rendered-text" : state.fillVerificationSource,
            ...(nativePasswordFill
              ? {}
              : { snapshot: typeof state.fieldRenderedText === "string" ? `FIELD_RENDERED=${state.fieldRenderedText}` : `FIELD=${state.fieldValue}` }),
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Repair activated Chrome fill") {
        assert.match(code, /__twResolveTarget/);
        assert.match(code, /fresh repair target/);
        assert.match(code, /repairDispatched/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        if (state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        const textMatch = code.match(/\.fill\(("(?:[^"\\]|\\.)*"), \{\}\)/);
        assert.ok(textMatch, "repair fill body must bind a JSON string literal");
        const targetText = JSON.parse(textMatch[1]);
        if (state.fieldValue && state.fieldValue !== targetText) {
          return { isError: true, text: "TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:fresh repair target was no longer blank; refusing to overwrite it" };
        }
        const repairDispatched = state.fieldValue !== targetText;
        if (repairDispatched) {
          state.fieldValue = targetText;
          state.fills += 1;
        }
        return {
          isError: false,
          text: JSON.stringify({
            phaseStatus: "filled",
            beforeUrl: state.tabs[0].url,
            afterUrl: state.tabs[0].url,
            afterTitle: state.tabs[0].title,
            afterValue: state.fieldValue,
            verificationSource: "fresh-target-rendered-text",
            repairDispatched,
            snapshot: `FIELD=${state.fieldValue}`,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Execute prepared Chrome upload") {
        const exactTextMode = code.includes("playwright.getByText(");
        if (exactTextMode) {
          assert.match(code, /getByText/);
          if (state.textVisibleCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.textVisibleCount };
          if (state.textSemanticCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + state.textSemanticCount };
        } else {
          assert.match(code, /getByRole/);
        }
        assert.match(code, /waitForEvent\("filechooser"/);
        assert.match(code, /\.setFiles\(\[/);
        assert.match(code, /TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        if (state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        if (state.uploadUncertain) return { isError: true, text: "TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN:file chooser timeout after click" };
        state.uploads += 1;
        if (typeof state.uploadPostDispatchHook === "function") await state.uploadPostDispatchHook();
        return {
          isError: false,
          text: JSON.stringify({
            beforeUrl: state.tabs[0].url,
            afterUrl: state.tabs[0].url,
            afterTitle: state.tabs[0].title,
            snapshot: "POST_UPLOAD_OK",
            chooserConfirmed: true,
            multiple: false,
            setFilesReturned: true,
            readbackError: null,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Execute prepared Chrome download") {
        const exactTextMode = code.includes("playwright.getByText(");
        if (exactTextMode) {
          assert.match(code, /getByText/);
          assert.match(code, /__twVisibleTextCandidates\.length/);
          if (state.textVisibleCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.textVisibleCount };
          if (state.textSemanticCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + state.textSemanticCount };
        } else {
          assert.match(code, /getByRole/);
        }
        assert.match(code, /waitForEvent\("download"/);
        assert.match(code, /\.click\(\{ timeoutMs: 5000 \}\)/);
        assert.match(code, /download\.path|__twDownload\.path/);
        assert.match(code, /TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        if (exactTextMode && state.textBindingChanged) return { isError: true, text: "TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED" };
        if (state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        if (state.downloadUncertain) return { isError: true, text: "TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN:download event timeout after click" };
        state.downloads += 1;
        return {
          isError: false,
          text: JSON.stringify({
            beforeUrl: state.tabs[0].url,
            afterUrl: state.tabs[0].url,
            afterTitle: state.tabs[0].title,
            snapshot: "POST_DOWNLOAD_OK",
            clickReturned: true,
            downloadConfirmed: true,
            downloadPath: "C:\\Users\\Test\\Downloads\\fixture.txt",
            pathError: null,
            readbackError: null,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Execute prepared Chrome click") {
        const exactTextMode = code.includes("playwright.getByText(");
        const scopedRoleMode = code.includes("const __twScopeLinks =");
        const localRadioMode = code.includes("__twDispatchLocator.check(");
        const rightClickMode = code.includes('button: "right"');
        if (exactTextMode) {
          assert.match(code, /getByText/);
          assert.match(code, /__twRawTextLocator\.all\(\)/);
          assert.match(code, /__twCandidate\.isVisible\(\)/);
          assert.match(code, /__twVisibleTextCandidates\.length/);
          assert.doesNotMatch(code, /getByText[\s\S]*filter\(\{ visible: true \}\)/);
          assert.match(code, /getByRole/);
          assert.match(code, /filter\(\{ has: __twTextLocator \}\)/);
          if (state.textVisibleCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.textVisibleCount };
          if (state.textSemanticCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + state.textSemanticCount };
        } else if (scopedRoleMode) {
          assert.match(code, /__twScopeLinks\.evaluateAll/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_LINK_COUNT/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT/);
          if (state.scopeLinkCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + state.scopeLinkCount };
          if (state.scopedTargetCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:3:" + state.scopedTargetCount };
        } else {
          assert.match(code, /getByRole/);
        }
        assert.match(code, /exact: true/);
        if (localRadioMode) {
          assert.match(code, /input\[type="radio"\]:not\(:disabled\)/);
          assert.match(code, /__twDispatchLocator\.check\(\{ timeoutMs: 5000 \}\)/);
          assert.match(code, /__twDispatchLocator\.isChecked\(\)/);
        } else if (rightClickMode) {
          assert.match(code, /__twDispatchLocator\.click\(\{ button: "right", timeoutMs: 5000 \}\)/);
        } else {
          assert.match(code, /__twDispatchLocator\.click\(\{ timeoutMs: 5000 \}\)/);
        }
        assert.match(code, /TOOLWIRE_BROWSER_ACTION_URL_CHANGED/);
        assert.match(code, /__twDispatchAttempted = true/);
        assert.match(code, /__twFinalizeError/);
        assert.match(code, /TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        if (exactTextMode && state.textBindingChanged) return { isError: true, text: "TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED" };
        if (!scopedRoleMode && state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        if (state.clickUncertain) return { isError: true, text: "TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:timeout after dispatch" };
        state.clicks += 1;
        if (state.clickTransportThrow) {
          throw new Error("simulated MCP transport lost after click dispatch");
        }
        if (state.clickEmptyResponse) {
          return { isError: false, text: "" };
        }
        if (state.clickGenericIsErrorAfterDispatch) {
          return { isError: true, text: "simulated node_repl backend failure after click dispatch" };
        }
        if (state.clickPostDispatchFailure) {
          return { isError: true, text: "TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:domSnapshot failed after dispatch" };
        }
        if (state.clickFinalizeFailure) {
          return { isError: true, text: "TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:finalize failed after dispatch" };
        }
        return {
          isError: false,
          text: JSON.stringify({
            beforeUrl: state.tabs[0].url,
            afterUrl: state.tabs[0].url,
            afterTitle: state.tabs[0].title,
            snapshot: "POST_CLICK_OK",
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Discover current Browser WebMCP tools") {
        assert.match(code, /capabilities\.get\("webmcp"\)/);
        assert.match(code, /fetchTools\(\)/);
        assert.match(code, /__codexlessWebMcpHandles\.set/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        assert.ok(
          code.indexOf("cleanupBrowserClaim(__twBrowser, __twTab)") < code.indexOf("__codexlessWebMcpHandles.set"),
          "discover must not commit the durable node-side handle before claim cleanup completes"
        );
        state.webMcpFetches += 1;
        if (typeof state.webMcpDiscoverErrorText === "string") {
          return { isError: true, text: state.webMcpDiscoverErrorText };
        }
        return {
          isError: false,
          text: JSON.stringify({
            title: state.tabs[0].title,
            url: state.tabs[0].url,
            lastOpened: state.tabs[0].lastOpened,
            description: state.webMcpDescription,
            descriptionBytes: Buffer.byteLength(state.webMcpDescription, "utf8"),
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Discard current Browser WebMCP handle") {
        assert.match(code, /__codexlessWebMcpHandles\?\.delete/);
        state.webMcpDrops += 1;
        return { isError: false, text: JSON.stringify({ discarded: true }) };
      }
      if (title === "Call current Browser WebMCP tool") {
        assert.match(code, /__codexlessWebMcpHandles\?\.get/);
        assert.match(code, /\.tools\.call\(/);
        assert.match(code, /__codexlessWebMcpHandles\.delete/);
        assert.ok(
          code.indexOf("__codexlessWebMcpHandles.delete") < code.indexOf(".tools.call("),
          "dispatch attempt must consume the node-side handle before calling the page-defined tool"
        );
        assert.doesNotMatch(code, /fetchTools\(\)/);
        assert.doesNotMatch(code, /registration_id\s*:/);
        state.webMcpCalls += 1;
        if (typeof state.webMcpCallErrorText === "string") {
          return { isError: true, text: state.webMcpCallErrorText };
        }
        const resultJson = JSON.stringify(state.webMcpResult);
        return {
          isError: false,
          text: JSON.stringify({
            result: state.webMcpResult,
            resultOmitted: false,
            resultBytes: Buffer.byteLength(resultJson, "utf8"),
            ...state.cleanupReceipt,
          }),
        };
      }
      if (code.includes("browsers.list")) {
        return {
          isError: false,
          text: JSON.stringify(state.browserBackends),
        };
      }
      if (title === "Discover opaque Browser elements" || title === "Prepare opaque Browser element action") {
        assert.match(code, /user\.claimTab\(/);
        assert.match(code, /dom_cua\.get_visible_dom\(\)/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        assert.doesNotMatch(code, /dom_cua\.(?:click|double_click)\(/, "opaque element discovery/preparation must not dispatch an action");
        state.elementVisibleDomReads += 1;
        return {
          isError: false,
          text: JSON.stringify({
            title: state.tabs[0].title,
            url: state.tabs[0].url,
            visibleDom: state.visibleDom,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (title === "Execute opaque Browser element action") {
        assert.match(code, /user\.claimTab\(/);
        assert.match(code, /dom_cua\.get_visible_dom\(\)/);
        assert.match(code, /const __twExpectedNodeId = /);
        assert.match(code, /const __twFingerprint = __twCreateHash\("sha256"\)/);
        assert.match(code, /TOOLWIRE_BROWSER_ELEMENT_STALE/);
        assert.match(code, /TOOLWIRE_BROWSER_ELEMENT_TARGET_CHANGED/);
        assert.match(code, /TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN/);
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/);
        const nodeMatch = code.match(/const __twExpectedNodeId = ("(?:[^"\\]|\\.)*");/);
        assert.ok(nodeMatch, "opaque action must bind the server-held stock node id only inside execution code");
        const rawNodeId = JSON.parse(nodeMatch[1]);
        const actionMatch = code.match(/if \(("(?:click|double_click)") === "click"\)/);
        assert.ok(actionMatch, "opaque action must bind one reviewed action literal before dispatch");
        const action = JSON.parse(actionMatch[1]);
        if (!state.visibleDom.includes(`node_id=${rawNodeId}`) && !state.visibleDom.includes(`node_id="${rawNodeId}"`)) {
          return { isError: true, text: "TOOLWIRE_BROWSER_ELEMENT_STALE" };
        }
        state.elementVisibleDomReads += 1;
        if (action === "double_click") state.elementDoubleClicks += 1;
        else state.elementClicks += 1;
        if (state.elementActionUncertain) return { isError: true, text: "TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:simulated lost stock action receipt" };
        return {
          isError: false,
          text: JSON.stringify({
            beforeUrl: state.tabs[0].url,
            afterUrl: state.tabs[0].url,
            afterTitle: state.tabs[0].title,
            action,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (code.includes("domSnapshot")) {
        assert.match(code, /cleanupBrowserClaim\(__twBrowser, __twTab\)/, "claimed user-tab reads must route cleanup through the capability-shape adapter");
        if (state.stale) return { isError: true, text: "TOOLWIRE_BROWSER_TAB_STALE" };
        if (state.scrollReadbackFailure && state.scrolls > 0) {
          return { isError: true, text: "simulated post-scroll DOM readback failure" };
        }
        const rawSnapshot = typeof state.domSnapshotOverride === "string"
          ? state.domSnapshotOverride
          : typeof state.fieldRenderedText === "string"
            ? `FIELD_RENDERED=${state.fieldRenderedText}`
            : state.lastScrollDelta == null
              ? "A".repeat(2500)
              : `SCROLLED=${state.lastScrollDelta}`;
        let snapshot = rawSnapshot;
        if (code.includes("sanitizeBrowserDomSnapshot")) {
          assert.match(code, /input\[type="password"\], \[role="password"\]/);
          assert.match(code, /filter\(\{ visible: true \}\)/);
          snapshot = sanitizePasswordDomSnapshot(rawSnapshot, state.passwordSnapshotDescriptors).snapshot;
        }
        return {
          isError: false,
          text: JSON.stringify({
            title: state.tabs[0].title,
            url: state.tabs[0].url,
            lastOpened: state.tabs[0].lastOpened,
            snapshot,
            ...state.cleanupReceipt,
          }),
        };
      }
      if (code.includes("user.openTabs")) {
        if (typeof state.openTabsErrorText === "string") {
          return { isError: true, text: state.openTabsErrorText };
        }
        return { isError: false, text: JSON.stringify(state.tabs) };
      }
      throw new Error("unexpected node_repl code");
    },
  };
}

test("Browser executor integrates stock visible-DOM identity behind opaque element refs for click and double-click", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const tabRef = listed.tabs[0].tabRef;

  const discovered = await browser.discoverElements({ tabRef });
  assert.equal(discovered.count, 2);
  assert.equal(discovered.elements[0].descriptor.name, "Compose");
  assert.equal(discovered.elements[1].descriptor.name, "Compose");
  assert.notEqual(discovered.elements[0].elementRef, discovered.elements[1].elementRef);
  assert.equal(JSON.stringify(discovered).includes('"17"'), false, "public opaque discovery must not leak raw stock node ids");
  assert.equal(JSON.stringify(discovered).includes('"23"'), false, "public opaque discovery must not leak repeated-target raw stock ids");

  const prepared = await browser.prepareElementAction({
    tabRef,
    elementRef: discovered.elements[0].elementRef,
    action: "click",
  });
  assert.equal(prepared.action.kind, "click");
  assert.equal(prepared.action.elementRef, discovered.elements[0].elementRef);
  assert.equal(JSON.stringify(prepared).includes('"17"'), false, "prepared public receipt must keep stock node id server-side");
  const clicked = await browser.elementAction({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.elementClicks, 1);
  assert.equal(workbench.state.elementDoubleClicks, 0);

  const refreshed = await browser.discoverElements({ tabRef });
  await assert.rejects(
    () => browser.prepareElementAction({ tabRef, elementRef: discovered.elements[0].elementRef, action: "click" }),
    (error) => error.code === "BROWSER_ELEMENT_REF_UNKNOWN"
  );
  const preparedDouble = await browser.prepareElementAction({
    tabRef,
    elementRef: refreshed.elements[1].elementRef,
    action: "double_click",
  });
  const doubled = await browser.elementAction({ actionApprovalRef: preparedDouble.actionApprovalRef });
  assert.equal(doubled.status, "double_clicked");
  assert.equal(workbench.state.elementDoubleClicks, 1);

  await assert.rejects(
    () => browser.prepareElementAction({ tabRef, rawNodeId: "17", action: "click" }),
    (error) => error.code === "BROWSER_ELEMENT_REF_REQUIRED"
  );
});

test("Browser opaque element execution revalidates fresh node state and never replays an uncertain dispatch", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const tabRef = listed.tabs[0].tabRef;

  let discovered = await browser.discoverElements({ tabRef });
  let prepared = await browser.prepareElementAction({ tabRef, elementRef: discovered.elements[0].elementRef, action: "click" });
  workbench.state.visibleDom = '<button node_id=99 role="button" aria-label="Compose">Compose</button>';
  await assert.rejects(
    () => browser.elementAction({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => error.code === "BROWSER_ELEMENT_STALE"
  );
  assert.equal(workbench.state.elementClicks, 0, "stale target must fail before dispatch");

  workbench.state.visibleDom = '<button node_id=17 role="button" aria-label="Compose">Compose</button>';
  discovered = await browser.discoverElements({ tabRef });
  prepared = await browser.prepareElementAction({ tabRef, elementRef: discovered.elements[0].elementRef, action: "click" });
  workbench.state.elementActionUncertain = true;
  await assert.rejects(
    () => browser.elementAction({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => error.code === "BROWSER_CLICK_RESULT_UNCERTAIN"
  );
  assert.equal(workbench.state.elementClicks, 1, "uncertain stock dispatch must be attempted exactly once");
  await assert.rejects(
    () => browser.elementAction({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => error.code === "BROWSER_ACTION_REF_EXPIRED"
  );
  assert.equal(workbench.state.elementClicks, 1, "consumed opaque action ref must never replay the uncertain dispatch");
});

test("Browser origin permission diagnosis separates saved deny, network policy, generic permission, transport, and success", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });

  workbench.state.openTabsErrorText = "persisted_user_denied source=browser-use-persisted-state scope=conversation Browser use cannot access https://gaim1.xyz/private/path?token=secret#frag because the user has a saved preference that blocks it.";
  await assert.rejects(() => browser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_ORIGIN_SAVED_PERMISSION_DENIED");
    assert.deepEqual(error.diagnostic, {
      source: "browser-use-persisted-state",
      scope: "conversation",
      origin: "https://gaim1.xyz",
    });
    assert.match(error.message, /Browser is connected/i);
    assert.match(error.message, /saved website permission/i);
    assert.doesNotMatch(`${error.message} ${(error.nextActions ?? []).join(" ")}`, /extension|restart|side.?bar|reinstall/i);
    assert.doesNotMatch(`${error.message} ${(error.nextActions ?? []).join(" ")}`, /private\/path|token=secret|#frag/i);
    return true;
  });

  workbench.state.openTabsErrorText = "browser-use-persisted-state scope=global Browser use cannot access https://global.example.test/account?private=1 because the user has a saved preference that blocks it.";
  await assert.rejects(() => browser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_ORIGIN_SAVED_PERMISSION_DENIED");
    assert.equal(error.diagnostic?.scope, "global");
    assert.equal(error.diagnostic?.origin, "https://global.example.test");
    return true;
  });

  workbench.state.openTabsErrorText = "enterprise_policy_blocked source=codex-network-policy Browser use cannot access https://policy.example.test/secret?scope=global because the admin-enforced policy blocks it.";
  await assert.rejects(() => browser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_ORIGIN_NETWORK_POLICY_DENIED");
    assert.deepEqual(error.diagnostic, {
      source: "codex-network-policy",
      origin: "https://policy.example.test",
    });
    assert.match(error.message, /Codex\/workspace network policy/i);
    assert.doesNotMatch(`${error.message} ${(error.nextActions ?? []).join(" ")}`, /extension|restart|side.?bar|reinstall/i);
    assert.doesNotMatch(`${error.message} ${(error.nextActions ?? []).join(" ")}`, /\/secret|scope=global/i);
    return true;
  });

  workbench.state.openTabsErrorText = "permission denied while reading browser state";
  await assert.rejects(() => browser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_RUNTIME_ERROR");
    assert.equal(error.diagnostic, null);
    return true;
  });

  workbench.state.openTabsErrorText = "Browser extension protocol version mismatch";
  await assert.rejects(() => browser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_RUNTIME_PROTOCOL_MISMATCH");
    assert.match((error.nextActions ?? []).join(" "), /matched bundle|compatibility/i);
    return true;
  });

  workbench.state.openTabsErrorText = "transport closed during extension handshake";
  await assert.rejects(() => browser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_RUNTIME_ERROR");
    return true;
  });

  workbench.state.openTabsErrorText = "Tab 123 is already part of browser session other-session";
  await assert.rejects(() => browser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_TAB_BUSY");
    assert.deepEqual(error.diagnostic, {
      claimStatus: "busy",
      recovery: "bounded-no-automatic-mutation-replay",
    });
    assert.match((error.nextActions ?? []).join(" "), /fresh tab|different/i);
    assert.match((error.nextActions ?? []).join(" "), /do not automatically replay/i);
    assert.doesNotMatch((error.nextActions ?? []).join(" "), /reinstall|restart Chrome/i);
    return true;
  });

  for (const [message, code] of [
    ["Chrome extension is blocked by the administrator through ExtensionInstallBlocklist", "BROWSER_EXTENSION_POLICY_BLOCKED"],
    ["AppLocker: this program was blocked by your system administrator", "BROWSER_ENTERPRISE_EXECUTION_POLICY_BLOCKED"],
    ["net::ERR_BLOCKED_BY_ADMINISTRATOR", "BROWSER_ENTERPRISE_NETWORK_POLICY_BLOCKED"],
  ]) {
    workbench.state.openTabsErrorText = message;
    await assert.rejects(() => browser.listTabs({}), (error) => {
      assert.equal(error.code, code);
      assert.match((error.nextActions ?? []).join(" "), /administrator|policy/i);
      return true;
    });
  }

  workbench.state.openTabsErrorText = "Chrome extension is not connected";
  await assert.rejects(() => browser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_CHROME_NOT_CONNECTED");
    assert.match((error.nextActions ?? []).join(" "), /Chrome extension\/backend/i);
    return true;
  });

  workbench.state.openTabsErrorText = null;
  const listed = await browser.listTabs({});
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0].url, "https://mail.example.test/inbox");
});

test("Browser finalize-absent existing-tab read reports deferred turn-boundary release and same-turn reclaim stays busy", async () => {
  const workbench = makeWorkbench();
  workbench.state.cleanupReceipt = {
    cleanupStatus: "deferred",
    cleanupReason: "turn-boundary-auto-release",
    cleanupError: null,
  };
  workbench.state.simulateClaimLifecycle = true;
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const tabRef = listed.tabs[0].tabRef;

  const first = await browser.readTab({ tabRef });
  assert.equal(first.cleanupStatus, "deferred");
  assert.equal(first.cleanupReason, "turn-boundary-auto-release");
  assert.equal(first.cleanupError, null);
  assert.equal(workbench.state.syntheticClaimAttempts, 1);

  await assert.rejects(() => browser.readTab({ tabRef }), (error) => {
    assert.equal(error.code, "BROWSER_TAB_BUSY");
    assert.deepEqual(error.diagnostic, {
      claimStatus: "busy",
      recovery: "bounded-no-automatic-mutation-replay",
    });
    assert.match((error.nextActions ?? []).join(" "), /turn-end cleanup/i);
    return true;
  });
  assert.equal(workbench.state.syntheticClaimAttempts, 2, "read reclaim remains one bounded claim attempt with no hidden retry loop");
});

test("Browser existing-tab mutation claim-busy is pre-dispatch diagnostic and is never auto-replayed", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    role: "button",
    name: "Compose",
  });
  workbench.state.claimTabErrorText = "Tab 123 is already part of browser session synthetic-session";

  await assert.rejects(() => browser.click({ actionApprovalRef: prepared.actionApprovalRef }), (error) => {
    assert.equal(error.code, "BROWSER_TAB_BUSY");
    assert.match(error.message, /cannot claim/i);
    assert.match((error.nextActions ?? []).join(" "), /do not automatically replay/i);
    return true;
  });
  assert.equal(workbench.state.clicks, 0, "claim-busy happens before click dispatch");
  const executeCalls = workbench.calls.filter((call) => call.arguments?.title === "Execute prepared Chrome click");
  assert.equal(executeCalls.length, 1, "mutation claim-busy must not trigger an automatic retry");
});

test("Browser tool errors surface only bounded permission diagnostics", async () => {
  const registered = new Map();
  const server = {
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  };
  const browser = {
    async listTabs() {
      const error = new Error("Browser is connected, but Browser use for https://gaim1.xyz is blocked by a saved website permission.");
      error.code = "BROWSER_ORIGIN_SAVED_PERMISSION_DENIED";
      error.nextActions = ["Change the saved website permission, then retry."];
      error.diagnostic = {
        source: "browser-use-persisted-state",
        scope: "conversation",
        origin: "https://gaim1.xyz",
      };
      throw error;
    },
    async click() {
      const error = new Error("Browser node_repl discovery remained unavailable after one bounded pre-dispatch rediscovery attempt.");
      error.code = "BROWSER_NODE_REPL_DISCOVERY_FAILED";
      error.nextActions = ["Retry the same prepared actionApprovalRef after Browser/node_repl recovers."];
      error.diagnostic = {
        failureLayer: "pre_dispatch_discovery",
        preDispatch: true,
        safeToRetry: true,
        internalRediscoveryAttempts: 1,
        actionRefRetained: true,
        rawProviderId: "must-not-leak",
      };
      throw error;
    },
  };
  registerBrowserPreviewTools(server, browser);
  const result = await registered.get("codex.browser_tabs").handler({});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.errorCode, "BROWSER_ORIGIN_SAVED_PERMISSION_DENIED");
  assert.deepEqual(result.structuredContent?.diagnostic, {
    source: "browser-use-persisted-state",
    scope: "conversation",
    origin: "https://gaim1.xyz",
  });

  const discoveryResult = await registered.get("codex.browser_click").handler({ actionApprovalRef: "browser_action_test" });
  assert.equal(discoveryResult.isError, true);
  assert.equal(discoveryResult.structuredContent?.errorCode, "BROWSER_NODE_REPL_DISCOVERY_FAILED");
  assert.deepEqual(discoveryResult.structuredContent?.diagnostic, {
    failureLayer: "pre_dispatch_discovery",
    preDispatch: true,
    safeToRetry: true,
    actionRefRetained: true,
    internalRediscoveryAttempts: 1,
  });
  assert.equal(Object.hasOwn(discoveryResult.structuredContent?.diagnostic ?? {}, "rawProviderId"), false);
});

test("Browser family-aware existing-tab tools expose family-neutral public titles and descriptions", () => {
  const registered = new Map();
  const server = {
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  };
  registerBrowserPreviewTools(server, {});
  const familyAwareTools = [
    "codex.browser_read", "codex.browser_screenshot",
    "codex.browser_discover_elements", "codex.browser_prepare_element_action", "codex.browser_element_action",
    "codex.browser_prepare_close_tab", "codex.browser_close_tab",
    "codex.browser_prepare_bulk_close_tabs", "codex.browser_bulk_close_tabs",
    "codex.browser_scroll", "codex.browser_keypress",
    "codex.browser_prepare_navigate", "codex.browser_navigate",
    "codex.browser_prepare_click", "codex.browser_click",
    "codex.browser_prepare_download", "codex.browser_download",
    "codex.browser_prepare_upload", "codex.browser_upload",
    "codex.browser_prepare_fill", "codex.browser_fill",
  ];
  for (const name of familyAwareTools) {
    const definition = registered.get(name)?.definition;
    assert.ok(definition, `${name} must be registered`);
    assert.doesNotMatch(definition.title ?? "", /Chrome/i, `${name} title must not advertise Chrome-only semantics`);
    const description = definition.description ?? "";
    assert.doesNotMatch(description, /existing Chrome tab|Chrome tabRef|previously prepared Chrome|existing Chrome textbox/i, `${name} description must not advertise Chrome-only existing-tab semantics`);
  }
  assert.doesNotMatch(registered.get("codex.browser_prepare_open_tab")?.definition?.title ?? "", /Chrome/i, "new-tab must be browser-family neutral once family is explicitly bound at prepare time");
  assert.match(registered.get("codex.browser_model_route_probe")?.definition?.description ?? "", /Chrome/i, "model-route diagnostic remains truthfully Chrome-specific");
});

test("Browser opaque element public surface exposes only bounded refs and single-use prepared actions", () => {
  const registered = new Map();
  const server = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
  registerBrowserPreviewTools(server, {});
  const discover = registered.get("codex.browser_discover_elements")?.definition;
  const prepare = registered.get("codex.browser_prepare_element_action")?.definition;
  const execute = registered.get("codex.browser_element_action")?.definition;
  assert.ok(discover && prepare && execute);
  assert.equal(discover.annotations?.readOnlyHint, true);
  assert.equal(discover.inputSchema.safeParse({ tabRef: "browser_tab_test" }).success, true);
  assert.equal(discover.inputSchema.safeParse({ tabRef: "browser_tab_test", maxNodes: 256 }).success, true);
  assert.equal(discover.inputSchema.safeParse({ tabRef: "browser_tab_test", maxNodes: 257 }).success, false);
  for (const forbidden of ["nodeId", "providerTabId", "selector", "index", "x", "y", "javascript"]) {
    assert.equal(discover.inputSchema.safeParse({ tabRef: "browser_tab_test", [forbidden]: "raw" }).success, false, `${forbidden} must not enter discovery authority`);
  }
  assert.equal(prepare.annotations?.readOnlyHint, true);
  assert.equal(prepare.inputSchema.safeParse({ tabRef: "browser_tab_test", elementRef: "browser_element_test", action: "click" }).success, true);
  assert.equal(prepare.inputSchema.safeParse({ tabRef: "browser_tab_test", elementRef: "browser_element_test", action: "double_click" }).success, true);
  assert.equal(prepare.inputSchema.safeParse({ tabRef: "browser_tab_test", elementRef: "browser_element_test", action: "fill" }).success, false);
  assert.equal(prepare.inputSchema.safeParse({ tabRef: "browser_tab_test", elementRef: "browser_element_test", action: "click", nodeId: "42" }).success, false);
  assert.equal(execute.annotations?.destructiveHint, true);
  assert.deepEqual(Object.keys(execute.inputSchema.shape), ["actionApprovalRef"]);
  assert.equal(execute.inputSchema.safeParse({ actionApprovalRef: "browser_action_test" }).success, true);
  assert.equal(execute.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", elementRef: "browser_element_test" }).success, false);
  assert.match(discover.description ?? "", /fallback/i);
  assert.match(prepare.description ?? "", /not evidence of user approval/i);
  assert.match(execute.description ?? "", /never auto-replayed/i);
});

test("Browser prepare-click schema exposes only narrow role/name or exact-text targets", () => {
  const registered = new Map();
  const server = {
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  };
  registerBrowserPreviewTools(server, {});
  const prepareClick = registered.get("codex.browser_prepare_click")?.definition;
  assert.ok(prepareClick, "browser_prepare_click must be registered");
  const schema = prepareClick.inputSchema;
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", role: "button", name: "Refresh" }).success, true);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", role: "button", name: "Reply", scopeUrl: "https://www.reddit.com/r/codex/comments/example/comment/abc123/" }).success, true);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", text: "Clickable card title" }).success, true);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", role: "button", name: "Refresh", button: "right" }).success, true);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", role: "button", name: "Refresh", button: "middle" }).success, false);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", text: "Clickable card title", selector: ".thread-card" }).success, false);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", text: "Clickable card title", id: "sendPasswordButton" }).success, false);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", text: "Clickable card title", javascript: "document.getElementById('sendPasswordButton').click()" }).success, false);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", text: "Clickable card title", x: 100, y: 200 }).success, false);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", role: "button", name: "Reply", scopeUrl: "https://example.test", nodeId: "comment-1" }).success, false);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", text: "Clickable card title", url: "https://example.test" }).success, false);
  assert.match(prepareClick.description ?? "", /exact visible text/i);
  assert.match(prepareClick.description ?? "", /scopeUrl/i);
  assert.match(prepareClick.description ?? "", /left or right click/i);
  assert.match(prepareClick.description ?? "", /no CSS selector\/JavaScript\/coordinates\/node ids\/item indexes\/ancestor depth/i);
});

test("Browser model-route probe is a narrow household diagnostic surface", () => {
  const registered = new Map();
  const server = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
  registerBrowserPreviewTools(server, {});
  const probe = registered.get("codex.browser_model_route_probe")?.definition;
  assert.ok(probe, "browser_model_route_probe must be registered");
  assert.equal(probe.inputSchema.safeParse({ tabRef: "browser_tab_test" }).success, true);
  assert.equal(probe.inputSchema.safeParse({ tabRef: "browser_tab_test", rawCdpMethod: "Network.getAllCookies" }).success, false);
  assert.deepEqual(Object.keys(probe.inputSchema.shape), ["tabRef", "cwd"]);
  assert.equal(probe.annotations?.readOnlyHint, false, "the probe submits one fixed Web verification message");
  assert.equal(probe.annotations?.idempotentHint, false, "the probe must never be auto-replayed after possible submission");
  assert.match(probe.description ?? "", /request may originate from any normal client or Main Road entry/i);
  assert.match(probe.description ?? "", /healthy Chrome Browser extension\/backend/i);
  assert.match(probe.description ?? "", /usable ChatGPT login state/i);
  assert.match(probe.description ?? "", /only two product modes/i);
  assert.match(probe.description ?? "", /current\/opened ChatGPT Web conversation/i);
  assert.match(probe.description ?? "", /Temporary vs normal and project vs non-project/i);
  assert.match(probe.description ?? "", /Do not attempt brittle automatic reconstruction/i);
  assert.match(probe.description ?? "", /你现在是什么模型？/i);
  assert.match(probe.description ?? "", /does not expose raw CDP/i);
  assert.match(probe.description ?? "", /never auto-retries/i);
  assert.match(probe.description ?? "", /short visually distinct evidence block/i);
  assert.match(probe.description ?? "", /actual verified surface as Chat, Work, or unknown/i);
  assert.match(probe.description ?? "", /do not bury the result or blocker inside a long paragraph/i);
  assert.match(probe.description ?? "", /do not imitate the formal Codex approval\/result presentation/i);
});

test("Browser model-route probe accepts user-selected current and project Web chat surfaces but rejects non-chat pages", async () => {
  for (const { url, expected } of [
    { url: "https://chatgpt.com/c/current-conversation", expected: { temporaryChat: false, projectScoped: false, existingConversation: true, surfaceMode: "chat" } },
    { url: "https://chatgpt.com/g/g-p-example-project/c/project-conversation", expected: { temporaryChat: false, projectScoped: true, existingConversation: true, surfaceMode: "chat" } },
    { url: "https://chatgpt.com/?temporary-chat=true", expected: { temporaryChat: true, projectScoped: false, existingConversation: false, surfaceMode: "chat" } },
  ]) {
    const workbench = makeWorkbench();
    workbench.state.tabs[0] = { ...workbench.state.tabs[0], title: "ChatGPT", url };
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const result = await browser.modelRouteProbe({ tabRef: listed.tabs[0].tabRef });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.verificationContext, expected);
    assert.equal(result.assistantClaim.text, "我是 GPT-5.6 Sol。");
    assert.equal(result.fields.resolved_model_slug, "gpt-5-6-thinking");
    assert.match(result.note, /current\/opened conversation or a newly opened chat/i);
    assert.match(result.note, /not an already-completed phone turn/i);
  }

  const workbench = makeWorkbench();
  workbench.state.tabs[0] = { ...workbench.state.tabs[0], title: "Settings", url: "https://chatgpt.com/settings" };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  await assert.rejects(
    () => browser.modelRouteProbe({ tabRef: listed.tabs[0].tabRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_MODEL_ROUTE_CHAT_SURFACE_REQUIRED");
      assert.match(error.message, /user-selected ChatGPT Web chat surface/i);
      return true;
    }
  );
});

test("Browser model-route probe rejects an Edge-bound tabRef before Chrome-specific dispatch", async () => {
  const workbench = makeWorkbench({
    browserBackends: [
      { name: "Chrome", family: "chrome", type: "extension" },
      { name: "Edge", family: "edge", type: "extension" },
    ],
  });
  workbench.state.tabs[0] = {
    ...workbench.state.tabs[0],
    title: "ChatGPT",
    url: "https://chatgpt.com/c/edge-bound-conversation",
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({ family: "edge" });
  const callsBeforeProbe = workbench.calls.length;
  await assert.rejects(
    () => browser.modelRouteProbe({ tabRef: listed.tabs[0].tabRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_MODEL_ROUTE_FAMILY_DENIED");
      assert.match(error.message, /Chrome-specific/i);
      assert.match(error.nextActions.join(" "), /Chrome tabRef/i);
      return true;
    }
  );
  assert.equal(workbench.calls.length, callsBeforeProbe, "Edge rejection must happen before any model-route Browser dispatch");
});

test("Browser model-route probe reports a known ChatGPT login redirect as a prerequisite instead of a generic host failure", async () => {
  const workbench = makeWorkbench();
  workbench.state.tabs[0] = {
    ...workbench.state.tabs[0],
    title: "Sign in",
    url: "https://auth.openai.com/log-in",
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  await assert.rejects(
    () => browser.modelRouteProbe({ tabRef: listed.tabs[0].tabRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_MODEL_ROUTE_LOGIN_REQUIRED");
      assert.match(error.message, /usable ChatGPT login state/i);
      assert.match(error.nextActions.join(" "), /Sign in to ChatGPT once/i);
      return true;
    }
  );
});

test("Browser prepared download schema stays semantic and destination-free", () => {
  const registered = new Map();
  const server = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
  registerBrowserPreviewTools(server, {});
  const prepareDownload = registered.get("codex.browser_prepare_download")?.definition;
  const download = registered.get("codex.browser_download")?.definition;
  assert.ok(prepareDownload);
  assert.ok(download);
  assert.equal(prepareDownload.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "link", name: "Download report" }).success, true);
  assert.equal(prepareDownload.inputSchema.safeParse({ tabRef: "browser_tab_test", text: "Download report" }).success, true);
  assert.equal(prepareDownload.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "link", name: "Download report", destination: "C:\\tmp\\x.txt" }).success, false);
  assert.equal(prepareDownload.inputSchema.safeParse({ tabRef: "browser_tab_test", selector: "a.download" }).success, false);
  assert.deepEqual(Object.keys(download.inputSchema.shape), ["actionApprovalRef"]);
  assert.equal(prepareDownload.annotations?.readOnlyHint, true);
  assert.equal(download.annotations?.destructiveHint, true);
  assert.match(download.description ?? "", /browser family's managed local download path/i);
  assert.match(download.description ?? "", /never opens, parses, executes, uploads, or trusts/i);
});

test("Browser prepared upload schema binds one file path at prepare time and no path at execute time", () => {
  const registered = new Map();
  const server = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
  registerBrowserPreviewTools(server, {});
  const prepareUpload = registered.get("codex.browser_prepare_upload")?.definition;
  const upload = registered.get("codex.browser_upload")?.definition;
  assert.ok(prepareUpload);
  assert.ok(upload);
  assert.equal(prepareUpload.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "button", name: "Attach report", filePath: "_work/probe.txt" }).success, true);
  assert.equal(prepareUpload.inputSchema.safeParse({ tabRef: "browser_tab_test", text: "Attach report", filePath: "_work/probe.txt" }).success, true);
  assert.equal(prepareUpload.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "button", name: "Attach report", filePath: "_work/probe.txt", selector: "input[type=file]" }).success, false);
  assert.deepEqual(Object.keys(upload.inputSchema.shape), ["actionApprovalRef"]);
  assert.match(prepareUpload.description ?? "", /trusted authority root/i);
  assert.match(upload.description ?? "", /never accepts an arbitrary local path at execution time/i);
  assert.equal(prepareUpload.annotations?.readOnlyHint, true);
  assert.equal(upload.annotations?.destructiveHint, true);
});

test("Browser close-tab schemas bind only an opaque tabRef at prepare time and only the prepared ref at execution", () => {
  const registered = new Map();
  const server = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
  registerBrowserPreviewTools(server, {});
  const prepareClose = registered.get("codex.browser_prepare_close_tab")?.definition;
  const closeTab = registered.get("codex.browser_close_tab")?.definition;
  assert.ok(prepareClose);
  assert.ok(closeTab);
  assert.equal(prepareClose.inputSchema.safeParse({ tabRef: "browser_tab_test" }).success, true);
  assert.equal(prepareClose.inputSchema.safeParse({ tabRef: "browser_tab_test", providerTabId: "raw-provider" }).success, false);
  assert.equal(prepareClose.inputSchema.safeParse({ tabRef: "browser_tab_test", url: "https://example.test" }).success, false);
  assert.equal(prepareClose.inputSchema.safeParse({ tabRef: "browser_tab_test", title: "Example" }).success, false);
  assert.equal(prepareClose.inputSchema.safeParse({ tabRef: "browser_tab_test", index: 0 }).success, false);
  assert.equal(prepareClose.inputSchema.safeParse({ tabRef: "browser_tab_test", windowId: 7 }).success, false);
  assert.deepEqual(Object.keys(closeTab.inputSchema.shape), ["actionApprovalRef"]);
  assert.equal(closeTab.inputSchema.safeParse({ actionApprovalRef: "browser_action_test" }).success, true);
  assert.equal(closeTab.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", tabRef: "browser_tab_other" }).success, false);
  assert.equal(closeTab.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", providerTabId: "raw-provider" }).success, false);
  assert.equal(closeTab.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", url: "https://other.example.test" }).success, false);
  assert.equal(prepareClose.annotations?.readOnlyHint, true);
  assert.equal(prepareClose.annotations?.destructiveHint, false);
  assert.equal(closeTab.annotations?.readOnlyHint, false);
  assert.equal(closeTab.annotations?.destructiveHint, true);
  assert.match(prepareClose.description ?? "", /unsaved page input|unsaved input/i);
  assert.match(closeTab.description ?? "", /official Browser Tab\.close\(\)/i);
  assert.match(closeTab.description ?? "", /never auto-retries/i);
});

test("Browser emergency reset and exact-set bulk-close schemas stay administrator-bounded", () => {
  const registered = new Map();
  const server = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
  registerBrowserPreviewTools(server, {});
  const reset = registered.get("codex.browser_emergency_reset")?.definition;
  const prepareBulk = registered.get("codex.browser_prepare_bulk_close_tabs")?.definition;
  const bulk = registered.get("codex.browser_bulk_close_tabs")?.definition;
  assert.ok(reset);
  assert.ok(prepareBulk);
  assert.ok(bulk);
  assert.deepEqual(Object.keys(reset.inputSchema.shape), ["cwd"]);
  assert.equal(reset.inputSchema.safeParse({}).success, true);
  assert.equal(reset.inputSchema.safeParse({ selector: "*" }).success, false);
  assert.equal(reset.inputSchema.safeParse({ providerTabId: "raw" }).success, false);
  assert.equal(reset.inputSchema.safeParse({ javascript: "location.reload()" }).success, false);
  assert.equal(reset.annotations?.destructiveHint, true);
  assert.match(reset.description ?? "", /never closes, navigates, reloads, clicks, fills, submits/i);
  assert.match(reset.description ?? "", /mutation is still in flight/i);

  assert.equal(prepareBulk.inputSchema.safeParse({ tabRefs: ["browser_tab_a", "browser_tab_b"] }).success, true);
  assert.equal(prepareBulk.inputSchema.safeParse({ tabRefs: [] }).success, false);
  assert.equal(prepareBulk.inputSchema.safeParse({ tabRefs: Array.from({ length: 101 }, (_, i) => `browser_tab_${i}`) }).success, false);
  assert.equal(prepareBulk.inputSchema.safeParse({ tabRefs: ["browser_tab_a"], urlRegex: "reddit" }).success, false);
  assert.equal(prepareBulk.inputSchema.safeParse({ tabRefs: ["browser_tab_a"], domain: "example.test" }).success, false);
  assert.equal(prepareBulk.inputSchema.safeParse({ tabRefs: ["browser_tab_a"], providerTabId: "raw" }).success, false);
  assert.equal(prepareBulk.inputSchema.safeParse({ tabRefs: ["browser_tab_a"], selector: ".tab" }).success, false);
  assert.deepEqual(Object.keys(bulk.inputSchema.shape), ["actionApprovalRef"]);
  assert.equal(bulk.inputSchema.safeParse({ actionApprovalRef: "browser_action_test" }).success, true);
  assert.equal(bulk.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", tabRefs: ["browser_tab_a"] }).success, false);
  assert.equal(bulk.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", x: 1, y: 2 }).success, false);
  assert.equal(prepareBulk.annotations?.readOnlyHint, true);
  assert.equal(bulk.annotations?.destructiveHint, true);
  assert.match(prepareBulk.description ?? "", /exact set of 1\.\.100 opaque tabRef/i);
  assert.match(bulk.description ?? "", /first drift, busy claim.*uncertain close.*stops immediately/i);
});

test("Browser navigation and placeholder-fill schemas stay narrow", () => {
  const registered = new Map();
  const server = {
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  };
  registerBrowserPreviewTools(server, {});

  const prepareOpenTab = registered.get("codex.browser_prepare_open_tab")?.definition;
  const openTab = registered.get("codex.browser_open_tab")?.definition;
  const scroll = registered.get("codex.browser_scroll")?.definition;
  const keypress = registered.get("codex.browser_keypress")?.definition;
  const prepareNavigate = registered.get("codex.browser_prepare_navigate")?.definition;
  const navigate = registered.get("codex.browser_navigate")?.definition;
  const prepareFill = registered.get("codex.browser_prepare_fill")?.definition;
  const fill = registered.get("codex.browser_fill")?.definition;
  assert.ok(prepareOpenTab);
  assert.ok(openTab);
  assert.ok(scroll);
  assert.ok(keypress);
  assert.ok(prepareNavigate);
  assert.ok(navigate);
  assert.ok(prepareFill);
  assert.ok(fill);
  assert.equal(prepareOpenTab.inputSchema.safeParse({ family: "chrome", url: "https://example.test/new" }).success, true);
  assert.equal(prepareOpenTab.inputSchema.safeParse({ family: "edge", url: "https://example.test/new" }).success, true);
  assert.equal(prepareOpenTab.inputSchema.safeParse({ url: "https://example.test/new" }).success, false);
  assert.equal(prepareOpenTab.inputSchema.safeParse({ family: "firefox", url: "https://example.test/new" }).success, false);
  assert.equal(prepareOpenTab.inputSchema.safeParse({ family: "chrome", url: "https://example.test/new", tabRef: "browser_tab_test" }).success, false);
  assert.equal(openTab.inputSchema.safeParse({ actionApprovalRef: "browser_action_test" }).success, true);
  assert.equal(openTab.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", url: "https://example.test" }).success, false);
  assert.equal(scroll.inputSchema.safeParse({ tabRef: "browser_tab_test", direction: "down", amount: "page" }).success, true);
  assert.equal(scroll.inputSchema.safeParse({ tabRef: "browser_tab_test", direction: "down", amount: "page", node_id: "n1" }).success, false);
  assert.equal(scroll.inputSchema.safeParse({ tabRef: "browser_tab_test", direction: "sideways" }).success, false);
  assert.match(prepareOpenTab.description ?? "", /explicit http\(s\) URL/i);
  assert.match(prepareOpenTab.description ?? "", /explicitly choose family=chrome\|edge/i);
  assert.match(scroll.description ?? "", /no caller-supplied selectors, coordinates, node ids, or keys/i);
  assert.equal(keypress.inputSchema.safeParse({ tabRef: "browser_tab_test", key: "Enter" }).success, true);
  assert.equal(keypress.inputSchema.safeParse({ tabRef: "browser_tab_test", key: "Tab" }).success, true);
  assert.equal(keypress.inputSchema.safeParse({ tabRef: "browser_tab_test", key: "Escape" }).success, true);
  assert.equal(keypress.inputSchema.safeParse({ tabRef: "browser_tab_test", key: "Space" }).success, false);
  assert.equal(keypress.inputSchema.safeParse({ tabRef: "browser_tab_test", key: "Enter", modifiers: ["Shift"] }).success, false);
  assert.equal(keypress.inputSchema.safeParse({ tabRef: "browser_tab_test", key: "Enter", text: "hello" }).success, false);
  assert.match(keypress.description ?? "", /Enter, Tab, or Escape/i);
  assert.match(keypress.description ?? "", /cannot supply arbitrary key names, text, modifiers, repeats, selectors, coordinates, node ids, or JavaScript/i);
  assert.equal(prepareNavigate.inputSchema.safeParse({ tabRef: "browser_tab_test", url: "https://example.test/path" }).success, true);
  assert.equal(prepareNavigate.inputSchema.safeParse({ tabRef: "browser_tab_test", url: "https://example.test", selector: "body" }).success, false);
  assert.equal(navigate.inputSchema.safeParse({ actionApprovalRef: "browser_action_test" }).success, true);
  assert.equal(navigate.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", url: "https://example.test" }).success, false);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", name: "Search", text: "x" }).success, true);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", placeholder: "Search Reddit", text: "x" }).success, true);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", scopeUrl: "https://www.reddit.com/r/codex/comments/example/comment/abc123/", text: "x" }).success, true);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", scopeUrl: "https://example.test", text: "x", nodeId: "editor-1" }).success, false);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", name: "Search", text: "x", selector: "textarea" }).success, false);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", placeholder: "パスワード", text: "x", type: "password" }).success, false);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", name: "Search", text: "x", javascript: "el.value='x'" }).success, false);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", name: "Search", text: "x", x: 100, y: 200 }).success, false);
  assert.equal(prepareFill.inputSchema.safeParse({ tabRef: "browser_tab_test", role: "textbox", name: "Search", text: "x", arbitraryKey: true }).success, false);
  assert.deepEqual(Object.keys(prepareFill.inputSchema.shape), ["tabRef", "role", "name", "placeholder", "scopeUrl", "text", "cwd"]);
  assert.deepEqual(Object.keys(fill.inputSchema.shape), ["actionApprovalRef"]);
  assert.equal(Object.hasOwn(prepareFill.inputSchema.shape, "scopeUrl"), true);
  assert.equal(Object.hasOwn(prepareFill.inputSchema.shape, "selector"), false);
  assert.equal(Object.hasOwn(prepareFill.inputSchema.shape, "nodeId"), false);
  assert.match(prepareNavigate.description ?? "", /explicit http\(s\) URL/i);
  assert.match(prepareFill.description ?? "", /placeholder/i);
  assert.match(prepareFill.description ?? "", /scopeUrl/i);
  assert.match(prepareFill.description ?? "", /cannot provide selectors, node ids, item indexes, ancestor depth, JavaScript, or coordinates/i);
});

test("Browser confirmation policy is read dynamically from the current Codex Chrome Skill and returns task-level verbal guidance", async () => {
  const registered = new Map();
  const server = {
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  };
  registerBrowserPreviewTools(server, {});
  const policyTool = registered.get("codex.browser_confirmation_policy")?.definition;
  assert.ok(policyTool);
  assert.equal(policyTool.annotations?.readOnlyHint, true);
  assert.equal(policyTool.annotations?.destructiveHint, false);
  assert.match(policyTool.description ?? "", /current Codex Chrome Skill/i);
  assert.match(policyTool.description ?? "", /task-level verbal-confirmation/i);

  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const result = await browser.confirmationPolicy({ cwd: "C:\\workspace" });
  assert.equal(result.status, "ok");
  assert.equal(result.source, "current Codex Chrome Skill / confirmations");
  assert.match(result.codexPolicy, /Representational communication/);
  assert.equal(result.interactionGuidance.defaultMode, "task_level_verbal_confirmation");
  assert.match(result.interactionGuidance.rule, /ask once/i);
  assert.match(result.interactionGuidance.userFacingExplanation, /brand-neutral/i);
  assert.match(result.interactionGuidance.userFacingExplanation, /does not start a Codex task/i);
  assert.equal(workbench.state.clicks, 0);
  assert.equal(workbench.state.fills, 0);
  assert.equal(workbench.state.navigations, 0);
  assert.equal(workbench.state.openedTabs, 0);
  assert.equal(workbench.state.scrolls, 0);
});

test("Browser Preview injects nested Codex turn metadata and exposes opaque read-only tab refs", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });

  const status = await browser.status({ cwd: "C:\\workspace" });
  assert.equal(status.status, "ok");
  assert.equal(status.chrome.family, "chrome");
  assert.equal(status.authState, "site_specific_unknown");
  assert.equal(JSON.stringify(status).includes("extensionId"), false);

  const listed = await browser.listTabs({ cwd: "C:\\workspace" });
  assert.equal(listed.status, "ok");
  assert.equal(listed.browser, "chrome");
  assert.equal(listed.count, 1);
  assert.match(listed.tabs[0].tabRef, /^browser_tab_/);
  assert.equal(listed.tabs[0].family, "chrome");
  assert.equal(listed.tabs[0].title, "Inbox - Example Mail");
  assert.equal(Object.hasOwn(listed.tabs[0], "providerTabId"), false);
  assert.equal(JSON.stringify(listed).includes("browser-instance"), false);

  const read = await browser.readTab({ tabRef: listed.tabs[0].tabRef, cwd: "C:\\workspace", maxChars: 1000 });
  assert.equal(read.status, "ok");
  assert.equal(read.tab.tabRef, listed.tabs[0].tabRef);
  assert.equal(read.tab.url, "https://mail.example.test/inbox");
  assert.equal(read.snapshot.length, 1000);
  assert.equal(read.snapshotChars, 2500);
  assert.equal(read.snapshotTruncated, true);
  assert.equal(read.authState, "site_specific_unknown");

  const metas = workbench.calls.map((call) => call.meta["x-codex-turn-metadata"]);
  assert.equal(new Set(metas.map((meta) => meta.session_id)).size, 1, "browser session_id must stay stable per executor");
  assert.equal(new Set(metas.map((meta) => meta.turn_id)).size, metas.length, "browser turn_id must be unique per call");
});

test("Browser tab listing thin-projects the stock Edge family and keeps opaque refs family-bound", async () => {
  const workbench = makeWorkbench({
    browserBackends: [
      { name: "Chrome", family: "chrome", type: "extension" },
      { name: "Edge", family: "edge", type: "extension" },
    ],
  });
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });

  const chrome = await browser.listTabs({ family: "chrome", cwd: "C:\\workspace" });
  const edge = await browser.listTabs({ family: "edge", cwd: "C:\\workspace" });
  assert.equal(chrome.browser, "chrome");
  assert.equal(edge.browser, "edge");
  assert.equal(chrome.tabs[0].family, "chrome");
  assert.equal(edge.tabs[0].family, "edge");
  assert.notEqual(chrome.tabs[0].tabRef, edge.tabs[0].tabRef, "same provider id across families must never share an opaque ref");

  const edgeRead = await browser.readTab({ tabRef: edge.tabs[0].tabRef, cwd: "C:\\workspace", maxChars: 1000 });
  assert.equal(edgeRead.status, "ok");
  assert.equal(edgeRead.browser, "edge");
  assert.equal(edgeRead.tab.family, "edge");
  await assert.rejects(
    () => browser.prepareBulkCloseTabs({ tabRefs: [chrome.tabs[0].tabRef, edge.tabs[0].tabRef], cwd: "C:\\workspace" }),
    (error) => error?.code === "BROWSER_BULK_CLOSE_FAMILY_MIXED",
    "one destructive prepared set must never mix Chrome and Edge opaque refs"
  );

  const browserGetCalls = workbench.calls
    .filter((call) => call.arguments?.title === "List current Chrome tabs")
    .map((call) => call.arguments.code);
  assert.ok(browserGetCalls.some((code) => code.includes('browsers.get("chrome")')));
  assert.ok(browserGetCalls.some((code) => code.includes('browsers.get("edge")')));

  const preparedEdgeNavigate = await browser.prepareNavigate({
    tabRef: edge.tabs[0].tabRef,
    url: "https://mail.example.test/edge-next",
    cwd: "C:\\workspace",
  });
  const prepareNavigateCode = [...workbench.calls]
    .reverse()
    .find((call) => call.arguments?.title === "Prepare exact Chrome navigation")?.arguments?.code ?? "";
  assert.match(prepareNavigateCode, /browsers\.get\("edge"\)/, "an Edge opaque ref must prepare against the Edge family even when Chrome exposes the same provider id");
  assert.doesNotMatch(prepareNavigateCode, /browsers\.get\("chrome"\)/, "Edge prepare must never cross-resolve the colliding provider id through Chrome");

  const navigatedEdge = await browser.navigate({ actionApprovalRef: preparedEdgeNavigate.actionApprovalRef });
  assert.equal(navigatedEdge.status, "navigated");
  assert.equal(navigatedEdge.tab.family, "edge");
  assert.equal(navigatedEdge.afterUrl, "https://mail.example.test/edge-next");
  const executeNavigateCode = [...workbench.calls]
    .reverse()
    .find((call) => call.arguments?.title === "Execute prepared Chrome navigation")?.arguments?.code ?? "";
  assert.match(executeNavigateCode, /browsers\.get\("edge"\)/, "prepared Edge operate dispatch must stay in the family sealed into the ref");
  assert.doesNotMatch(executeNavigateCode, /browsers\.get\("chrome"\)/, "prepared Edge operate must not be misdirected to Chrome");
});

test("Browser WebMCP thin projection reuses one stock fetched handle and exposes no registration identity", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({ cwd: "C:\\workspace" });

  const discovered = await browser.discoverWebMcp({ tabRef: listed.tabs[0].tabRef, cwd: "C:\\workspace" });
  assert.equal(discovered.status, "discovered");
  assert.match(discovered.webMcpRef, /^browser_webmcp_/);
  assert.equal(discovered.tab.tabRef, listed.tabs[0].tabRef);
  assert.equal(discovered.description, "WebMCP tools available: save_note");
  assert.equal(workbench.state.webMcpFetches, 1);
  assert.equal(JSON.stringify(discovered).includes("providerTabId"), false);
  assert.equal(JSON.stringify(discovered).includes("registration_id"), false);

  const called = await browser.callWebMcp({
    webMcpRef: discovered.webMcpRef,
    toolName: "save_note",
    input: { text: "hello" },
  });
  assert.equal(called.status, "called");
  assert.equal(called.callConfirmed, true);
  assert.deepEqual(called.result, { saved: true });
  assert.equal(called.resultOmitted, false);
  assert.equal(called.noAutomaticReplay, true);
  assert.equal(workbench.state.webMcpFetches, 1, "call must use the fetched stock handle rather than refetching before dispatch");
  assert.equal(workbench.state.webMcpCalls, 1);
  await assert.rejects(
    () => browser.callWebMcp({ webMcpRef: discovered.webMcpRef, toolName: "save_note", input: { text: "replay" } }),
    (error) => error?.code === "BROWSER_WEBMCP_REF_UNKNOWN",
    "a confirmed dispatch must consume the opaque ref so the same page-defined side effect cannot be replayed"
  );

  const callCode = workbench.calls.find((call) => call.arguments?.title === "Call current Browser WebMCP tool")?.arguments?.code ?? "";
  assert.match(callCode, /__codexlessWebMcpHandles\?\.get/);
  assert.match(callCode, /\.tools\.call\(/);
  assert.doesNotMatch(callCode, /fetchTools\(\)/);
  assert.doesNotMatch(callCode, /registration_id\s*:/);
});

test("Browser WebMCP fails closed on stale/page drift and makes ambiguous dispatch non-replayable", async () => {
  const staleWorkbench = makeWorkbench();
  const staleBrowser = new CodexBrowserExecutor({ workbench: staleWorkbench, defaultCwd: "C:\\workspace" });
  const staleTabs = await staleBrowser.listTabs({ cwd: "C:\\workspace" });
  const staleDiscovery = await staleBrowser.discoverWebMcp({ tabRef: staleTabs.tabs[0].tabRef, cwd: "C:\\workspace" });
  staleWorkbench.state.webMcpCallErrorText = "TOOLWIRE_BROWSER_WEBMCP_HANDLE_STALE";
  await assert.rejects(
    () => staleBrowser.callWebMcp({ webMcpRef: staleDiscovery.webMcpRef, toolName: "save_note", input: { text: "one" } }),
    (error) => error?.code === "BROWSER_WEBMCP_REF_STALE"
  );
  await assert.rejects(
    () => staleBrowser.callWebMcp({ webMcpRef: staleDiscovery.webMcpRef, toolName: "save_note", input: { text: "one" } }),
    (error) => error?.code === "BROWSER_WEBMCP_REF_UNKNOWN"
  );

  const driftWorkbench = makeWorkbench();
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({ cwd: "C:\\workspace" });
  const driftDiscovery = await driftBrowser.discoverWebMcp({ tabRef: driftTabs.tabs[0].tabRef, cwd: "C:\\workspace" });
  driftWorkbench.state.webMcpCallErrorText = "TOOLWIRE_BROWSER_WEBMCP_PAGE_CHANGED";
  await assert.rejects(
    () => driftBrowser.callWebMcp({ webMcpRef: driftDiscovery.webMcpRef, toolName: "save_note", input: { text: "two" } }),
    (error) => error?.code === "BROWSER_WEBMCP_PAGE_CHANGED"
  );

  const notListedWorkbench = makeWorkbench();
  const notListedBrowser = new CodexBrowserExecutor({ workbench: notListedWorkbench, defaultCwd: "C:\\workspace" });
  const notListedTabs = await notListedBrowser.listTabs({ cwd: "C:\\workspace" });
  const notListedDiscovery = await notListedBrowser.discoverWebMcp({ tabRef: notListedTabs.tabs[0].tabRef, cwd: "C:\\workspace" });
  notListedWorkbench.state.webMcpCallErrorText = "TOOLWIRE_BROWSER_WEBMCP_TOOL_NOT_LISTED";
  await assert.rejects(
    () => notListedBrowser.callWebMcp({ webMcpRef: notListedDiscovery.webMcpRef, toolName: "not_listed", input: {} }),
    (error) => error?.code === "BROWSER_WEBMCP_TOOL_NOT_LISTED"
  );
  notListedWorkbench.state.webMcpCallErrorText = null;
  const corrected = await notListedBrowser.callWebMcp({
    webMcpRef: notListedDiscovery.webMcpRef,
    toolName: "save_note",
    input: { text: "corrected" },
  });
  assert.equal(corrected.status, "called", "definitive pre-dispatch tool-not-listed must leave a current fetched handle reusable");

  const uncertainWorkbench = makeWorkbench();
  const uncertainBrowser = new CodexBrowserExecutor({ workbench: uncertainWorkbench, defaultCwd: "C:\\workspace" });
  const uncertainTabs = await uncertainBrowser.listTabs({ cwd: "C:\\workspace" });
  const uncertainDiscovery = await uncertainBrowser.discoverWebMcp({ tabRef: uncertainTabs.tabs[0].tabRef, cwd: "C:\\workspace" });
  uncertainWorkbench.state.webMcpCallErrorText = "simulated transport loss after WebMCP dispatch";
  await assert.rejects(
    () => uncertainBrowser.callWebMcp({ webMcpRef: uncertainDiscovery.webMcpRef, toolName: "save_note", input: { text: "three" } }),
    (error) => error?.code === "BROWSER_WEBMCP_CALL_RESULT_UNCERTAIN"
  );
  await assert.rejects(
    () => uncertainBrowser.callWebMcp({ webMcpRef: uncertainDiscovery.webMcpRef, toolName: "save_note", input: { text: "three" } }),
    (error) => error?.code === "BROWSER_WEBMCP_REF_UNKNOWN",
    "an uncertain dispatch must poison the same opaque ref mechanically, not only by guidance text"
  );
});

test("Browser WebMCP discovery failure explicitly drops any node-side handle that may have been committed before the response failed", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({ cwd: "C:\\workspace" });
  workbench.state.webMcpDiscoverErrorText = "simulated discovery response failure after node-side handle commit";

  await assert.rejects(
    () => browser.discoverWebMcp({ tabRef: listed.tabs[0].tabRef, cwd: "C:\\workspace" })
  );
  assert.equal(workbench.state.webMcpFetches, 1);
  assert.equal(workbench.state.webMcpDrops, 1, "failed discovery must run the explicit node-side handle discard path");
});

test("Browser WebMCP tool schemas keep upstream registration and execute-time tab identity server-side", () => {
  const registered = new Map();
  registerBrowserPreviewTools({
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  }, {});
  const discover = registered.get("codex.browser_webmcp_discover")?.definition;
  const call = registered.get("codex.browser_webmcp_call")?.definition;
  assert.ok(discover);
  assert.ok(call);
  assert.deepEqual(Object.keys(discover.inputSchema.shape).sort(), ["cwd", "tabRef"]);
  assert.deepEqual(Object.keys(call.inputSchema.shape).sort(), ["input", "timeoutMs", "toolName", "webMcpRef"]);
  for (const forbidden of ["registrationId", "registration_id", "providerTabId", "tabRef", "url", "selector", "browserId", "family"]) {
    assert.equal(Object.hasOwn(call.inputSchema.shape, forbidden), false, `call schema must not expose ${forbidden}`);
  }
  assert.equal(discover.annotations?.readOnlyHint, true);
  assert.equal(call.annotations?.idempotentHint, false);
  assert.match(discover.description ?? "", /stock Codex Browser/i);
  assert.match(call.description ?? "", /registration IDs/i);
});

test("Browser WebMCP follows the server-bound Edge family and accepts no execute-time family selector", async () => {
  const workbench = makeWorkbench({
    browserBackends: [
      { name: "Chrome", family: "chrome", type: "extension" },
      { name: "Edge", family: "edge", type: "extension" },
    ],
  });
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const edge = await browser.listTabs({ family: "edge", cwd: "C:\\workspace" });
  const discovered = await browser.discoverWebMcp({ tabRef: edge.tabs[0].tabRef, cwd: "C:\\workspace" });
  assert.equal(discovered.browser, "edge");
  assert.equal(discovered.tab.family, "edge");

  const discoverCode = [...workbench.calls]
    .reverse()
    .find((call) => call.arguments?.title === "Discover current Browser WebMCP tools")?.arguments?.code ?? "";
  assert.match(discoverCode, /browsers\.get\("edge"\)/);
  assert.doesNotMatch(discoverCode, /browsers\.get\("chrome"\)/);

  const called = await browser.callWebMcp({
    webMcpRef: discovered.webMcpRef,
    toolName: "save_note",
    input: { text: "edge-bound" },
  });
  assert.equal(called.status, "called");
  assert.equal(called.browser, "edge");
  const callCode = [...workbench.calls]
    .reverse()
    .find((call) => call.arguments?.title === "Call current Browser WebMCP tool")?.arguments?.code ?? "";
  assert.match(callCode, /browsers\.get\("edge"\)/);
  assert.doesNotMatch(callCode, /browsers\.get\("chrome"\)/);
});

test("Browser password snapshot sanitizer redacts password nodes while preserving ordinary textbox/searchbox content and targeting metadata", () => {
  const rawSnapshot = [
    '- textbox "Account password" [ref=e10]: fixture-secret-one',
    '- textbox "Password field" [ref=e11]:',
    '  - /placeholder: "Password"',
    '  - text: fixture-secret-two',
    '- password "Legacy password role" [ref=e12]: fixture-secret-three',
    '- textbox "Search" [ref=e13]: ordinary-visible-query',
    '- searchbox "Lookup" [ref=e14]: ordinary-search-value',
  ].join("\n");
  const sanitized = sanitizePasswordDomSnapshot(rawSnapshot, [
    { type: "password", role: "", candidateNames: ["Account password"] },
    { type: "password", role: "", candidateNames: ["Password"] },
    { type: "", role: "password", candidateNames: ["Legacy password role"] },
  ]);

  assert.equal(sanitized.redactedNodeCount, 3);
  assert.doesNotMatch(sanitized.snapshot, /fixture-secret-(?:one|two|three)/);
  assert.match(sanitized.snapshot, /textbox "Account password" \[ref=e10\]: \[PASSWORD_REDACTED\]/);
  assert.match(sanitized.snapshot, /\/placeholder: "Password"/);
  assert.match(sanitized.snapshot, /textbox "Password field" \[ref=e11\]:\n  - \/placeholder: "Password"\n  - text: \[PASSWORD_REDACTED\]/);
  assert.match(sanitized.snapshot, /textbox "Search" \[ref=e13\]: ordinary-visible-query/);
  assert.match(sanitized.snapshot, /searchbox "Lookup" \[ref=e14\]: ordinary-search-value/);
});

test("Browser password snapshot sanitizer binds DOM role=password after official snapshots normalize it to generic", () => {
  const rawSnapshot = [
    '- generic "Legacy password role": fixture-role-password-secret',
    '- generic "Ordinary generic": ordinary-generic-value',
    '- textbox "Normal": ordinary-text-value',
  ].join("\n");
  const sanitized = sanitizePasswordDomSnapshot(rawSnapshot, [
    { type: "", role: "password", candidateNames: ["Legacy password role"] },
  ]);

  assert.equal(sanitized.redactedNodeCount, 1);
  assert.doesNotMatch(sanitized.snapshot, /fixture-role-password-secret/);
  assert.match(sanitized.snapshot, /generic "Legacy password role": \[PASSWORD_REDACTED\]/);
  assert.match(sanitized.snapshot, /generic "Ordinary generic": ordinary-generic-value/);
  assert.match(sanitized.snapshot, /textbox "Normal": ordinary-text-value/);

  assert.throws(() => sanitizePasswordDomSnapshot(
    [
      '- generic "Legacy password role": first-secret',
      '- generic "Legacy password role": second-secret',
      '- textbox "Normal": keep',
    ].join("\n"),
    [{ type: "", role: "password", candidateNames: ["Legacy password role"] }]
  ), /BROWSER_PASSWORD_SNAPSHOT_BINDING_AMBIGUOUS/);
});

test("Browser password snapshot sanitizer fails closed instead of redacting unrelated ambiguous textboxes", () => {
  assert.throws(() => sanitizePasswordDomSnapshot(
    ['- textbox [ref=e1]: ordinary-secretless-value', '- textbox "Named" [ref=e2]: keep'].join("\n"),
    [{ type: "password", role: "", candidateNames: [] }]
  ), /BROWSER_PASSWORD_SNAPSHOT_BINDING_AMBIGUOUS/);

  assert.throws(() => sanitizePasswordDomSnapshot(
    ['- textbox "Password" [ref=e1]: actual-password', '- textbox "Password" [ref=e2]: ordinary-nonpassword'].join("\n"),
    [{ type: "password", role: "", candidateNames: ["Password"] }]
  ), /BROWSER_PASSWORD_SNAPSHOT_BINDING_AMBIGUOUS/);
});

test("Browser read and post-scroll readback share the server-side password snapshot sanitizer", async () => {
  const workbench = makeWorkbench();
  workbench.state.domSnapshotOverride = [
    '- textbox "パスワード" [ref=e20]: fixture-only-password',
    '- textbox "Search" [ref=e21]: keep-this-query',
  ].join("\n");
  workbench.state.passwordSnapshotDescriptors = [
    { type: "password", role: "", candidateNames: ["パスワード"] },
  ];
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({ cwd: "C:\\workspace" });
  const tabRef = listed.tabs[0].tabRef;

  const read = await browser.readTab({ tabRef, cwd: "C:\\workspace", maxChars: 1000 });
  assert.doesNotMatch(read.snapshot, /fixture-only-password/);
  assert.match(read.snapshot, /textbox "パスワード" \[ref=e20\]: \[PASSWORD_REDACTED\]/);
  assert.match(read.snapshot, /textbox "Search" \[ref=e21\]: keep-this-query/);

  const readCall = workbench.calls.find((call) => call.arguments?.title === "Read existing Chrome tab DOM");
  assert.ok(readCall, "direct read must dispatch one DOM snapshot request");
  assert.match(readCall.arguments.code, /sanitizeBrowserDomSnapshot\(__twTab\)/);
  assert.match(readCall.arguments.code, /input\[type="password"\], \[role="password"\]/);

  const scrolled = await browser.scrollTab({ tabRef, direction: "down", amount: "page", cwd: "C:\\workspace", maxChars: 1000 });
  assert.equal(scrolled.status, "scrolled");
  assert.equal(scrolled.readbackStatus, "ok");
  assert.doesNotMatch(scrolled.snapshot, /fixture-only-password/);
  assert.match(scrolled.snapshot, /textbox "Search" \[ref=e21\]: keep-this-query/);
});

test("Browser backend topology accepts Chrome plus Edge but fails visibly on multiple Chrome backends without inventing a profile selector", async () => {
  const mixedWorkbench = makeWorkbench({
    browserBackends: [
      { name: "Chrome", family: "chrome", type: "extension" },
      { name: "Edge", family: "edge", type: "extension" },
    ],
  });
  const mixedBrowser = new CodexBrowserExecutor({ workbench: mixedWorkbench, defaultCwd: "C:\\workspace" });
  const mixedStatus = await mixedBrowser.status({});
  assert.equal(mixedStatus.status, "ok");
  assert.equal(mixedStatus.chrome.name, "Chrome");
  assert.deepEqual(mixedStatus.connectedBrowsers.map((entry) => entry.family), ["chrome", "edge"]);

  const ambiguousWorkbench = makeWorkbench({
    browserBackends: [
      { name: "Chrome profile A", family: "chrome", type: "extension" },
      { name: "Chrome profile B", family: "chrome", type: "extension" },
    ],
  });
  const ambiguousBrowser = new CodexBrowserExecutor({ workbench: ambiguousWorkbench, defaultCwd: "C:\\workspace" });
  const ambiguousStatus = await ambiguousBrowser.status({});
  assert.equal(ambiguousStatus.status, "unavailable");
  assert.equal(ambiguousStatus.reason, "BROWSER_CHROME_BACKEND_AMBIGUOUS");
  assert.match(ambiguousStatus.error, /no profile\/backend selector/i);
  assert.match(ambiguousStatus.nextActions.join(" "), /Do not guess/i);
  await assert.rejects(() => ambiguousBrowser.listTabs({}), (error) => {
    assert.equal(error.code, "BROWSER_CHROME_BACKEND_AMBIGUOUS");
    return true;
  });
});

test("Browser screenshot captures one existing viewport as bounded MCP-ready JPEG metadata", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({ cwd: "C:\\workspace" });
  const shot = await browser.screenshotTab({ tabRef: listed.tabs[0].tabRef, cwd: "C:\\workspace" });
  assert.equal(shot.status, "ok");
  assert.equal(shot.mimeType, "image/jpeg");
  assert.equal(shot.width, 2);
  assert.equal(shot.height, 3);
  assert.equal(shot.fullPage, false);
  assert.equal(shot.byteLength, Buffer.from(fakeJpegBase64, "base64").length);
  assert.equal(shot.dataBase64, fakeJpegBase64);
  assert.equal(shot.tab.tabRef, listed.tabs[0].tabRef);
  assert.equal(Object.hasOwn(shot.tab, "providerTabId"), false);
  assert.equal(workbench.state.screenshots, 1);
  assert.equal(workbench.state.clicks, 0);
  assert.equal(workbench.state.fills, 0);
  assert.equal(workbench.state.navigations, 0);
  assert.equal(workbench.state.scrolls, 0);
});

test("Browser screenshot rejects declared byte-length drift instead of accepting a partial/mismatched image receipt", async () => {
  const workbench = makeWorkbench();
  workbench.state.screenshotReportedByteLengthDelta = 7;
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({ cwd: "C:\\workspace" });
  await assert.rejects(
    () => browser.screenshotTab({ tabRef: listed.tabs[0].tabRef, cwd: "C:\\workspace" }),
    (error) => {
      assert.equal(error.code, "BROWSER_SCREENSHOT_PROTOCOL_ERROR");
      assert.match(error.message, /byte length did not match/i);
      return true;
    }
  );
  assert.equal(workbench.state.screenshots, 1);
});

test("Browser screenshot tool exposes only viewport tabRef/cwd inputs and projects image content outside structured JSON", async () => {
  const registered = new Map();
  const fakeBrowser = {
    async screenshotTab() {
      return {
        status: "ok",
        browser: "chrome",
        tab: { tabRef: "browser_tab_test", title: "Visual", url: "https://example.test", lastOpened: null },
        mimeType: "image/jpeg",
        byteLength: Buffer.from(fakeJpegBase64, "base64").length,
        width: 2,
        height: 3,
        fullPage: false,
        dataBase64: fakeJpegBase64,
        note: "viewport only",
      };
    },
  };
  const server = { registerTool(name, definition, handler) { registered.set(name, { definition, handler }); } };
  registerBrowserPreviewTools(server, fakeBrowser);
  const tool = registered.get("codex.browser_screenshot");
  assert.ok(tool);
  assert.equal(tool.definition.annotations?.readOnlyHint, true);
  assert.equal(tool.definition.annotations?.destructiveHint, false);
  assert.match(tool.definition.description ?? "", /viewport-only/i);
  assert.equal(tool.definition.inputSchema.safeParse({ tabRef: "browser_tab_test" }).success, true);
  assert.equal(tool.definition.inputSchema.safeParse({ tabRef: "browser_tab_test", fullPage: true }).success, false);
  assert.equal(tool.definition.inputSchema.safeParse({ tabRef: "browser_tab_test", clip: { x: 0, y: 0, width: 10, height: 10 } }).success, false);
  assert.equal(tool.definition.inputSchema.safeParse({ tabRef: "browser_tab_test", selector: "body" }).success, false);
  const rendered = await tool.handler({ tabRef: "browser_tab_test" });
  assert.equal(rendered.isError, false);
  assert.equal(Object.hasOwn(rendered.structuredContent, "dataBase64"), false);
  assert.equal(rendered.structuredContent.mimeType, "image/jpeg");
  assert.equal(rendered.content.length, 2);
  assert.equal(rendered.content[1].type, "image");
  assert.equal(rendered.content[1].mimeType, "image/jpeg");
  assert.equal(rendered.content[1].data, fakeJpegBase64);
});

test("Browser Preview reports stale opaque tab refs without leaking provider IDs", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  workbench.state.stale = true;
  await assert.rejects(
    () => browser.readTab({ tabRef: listed.tabs[0].tabRef, maxChars: 1000 }),
    (error) => {
      assert.equal(error.code, "BROWSER_TAB_STALE");
      assert.match(error.message, /closed|no longer/i);
      assert.equal(error.message.includes("browser-instance"), false);
      return true;
    }
  );
});

test("Browser close-tab prepare is read-only and execute closes exactly the prepared tab, cleans maps, and consumes the ref", async () => {
  const workbench = makeWorkbench();
  workbench.state.tabs.push({
    providerTabId: '["browser-instance","456"]',
    title: "Draft - Example Mail",
    url: "https://mail.example.test/draft/7",
    lastOpened: "2026-08-13T00:00:01.000Z",
  });
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  assert.equal(listed.count, 2);
  const keeper = listed.tabs.find((tab) => tab.url === "https://mail.example.test/inbox");
  const target = listed.tabs.find((tab) => tab.url === "https://mail.example.test/draft/7");
  assert.ok(keeper);
  assert.ok(target);

  const prepared = await browser.prepareCloseTab({ tabRef: target.tabRef });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "close_tab");
  assert.equal(prepared.action.tab.tabRef, target.tabRef);
  assert.equal(prepared.action.expectedUrl, "https://mail.example.test/draft/7");
  assert.equal(workbench.state.closeDispatches, 0, "prepare close must not close or claim a tab");
  assert.equal(workbench.state.tabs.length, 2);
  assert.equal(JSON.stringify(prepared).includes("providerTabId"), false);

  const closed = await browser.closeTab({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(closed.status, "closed");
  assert.equal(closed.action.kind, "close_tab");
  assert.equal(closed.tab.tabRef, target.tabRef);
  assert.equal(closed.beforeUrl, "https://mail.example.test/draft/7");
  assert.equal(workbench.state.closeDispatches, 1);
  assert.equal(workbench.state.tabs.length, 1);
  assert.equal(workbench.state.tabs[0].url, "https://mail.example.test/inbox", "the other existing tab must remain open");
  assert.equal(JSON.stringify(closed).includes("providerTabId"), false);

  await assert.rejects(
    () => browser.readTab({ tabRef: target.tabRef, maxChars: 1000 }),
    (error) => {
      assert.equal(error.code, "BROWSER_TAB_REF_UNKNOWN");
      return true;
    }
  );
  const after = await browser.listTabs({});
  assert.equal(after.count, 1);
  assert.equal(after.tabs[0].tabRef, keeper.tabRef, "the surviving provider mapping must stay stable");
  assert.equal(after.tabs.some((tab) => tab.url === "https://mail.example.test/draft/7"), false);

  await assert.rejects(
    () => browser.closeTab({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
  assert.equal(workbench.state.closeDispatches, 1, "a consumed close ref must never dispatch twice");

  workbench.state.tabs.push({
    providerTabId: '["browser-instance","456"]',
    title: "Reused Provider Slot",
    url: "https://example.test/reused-provider-slot",
    lastOpened: "2026-08-13T00:00:02.000Z",
  });
  const reused = await browser.listTabs({});
  const reusedTarget = reused.tabs.find((tab) => tab.url === "https://example.test/reused-provider-slot");
  assert.ok(reusedTarget);
  assert.notEqual(reusedTarget.tabRef, target.tabRef, "successful close must remove providerToRef so a reused provider id cannot inherit the old opaque ref");
});

test("Browser close-tab fails closed on unknown/stale refs and URL, provider, or Workbench-generation drift", async () => {
  const unknownWorkbench = makeWorkbench();
  const unknownBrowser = new CodexBrowserExecutor({ workbench: unknownWorkbench, defaultCwd: "C:\\workspace" });
  await assert.rejects(
    () => unknownBrowser.prepareCloseTab({ tabRef: "browser_tab_missing" }),
    (error) => {
      assert.equal(error.code, "BROWSER_TAB_REF_UNKNOWN");
      return true;
    }
  );
  assert.equal(unknownWorkbench.state.closeDispatches, 0);

  const staleWorkbench = makeWorkbench();
  const staleBrowser = new CodexBrowserExecutor({ workbench: staleWorkbench, defaultCwd: "C:\\workspace" });
  const staleTabs = await staleBrowser.listTabs({});
  staleWorkbench.state.stale = true;
  await assert.rejects(
    () => staleBrowser.prepareCloseTab({ tabRef: staleTabs.tabs[0].tabRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_TAB_STALE");
      return true;
    }
  );
  assert.equal(staleWorkbench.state.closeDispatches, 0);

  const urlWorkbench = makeWorkbench();
  const urlBrowser = new CodexBrowserExecutor({ workbench: urlWorkbench, defaultCwd: "C:\\workspace" });
  const urlTabs = await urlBrowser.listTabs({});
  const urlPrepared = await urlBrowser.prepareCloseTab({ tabRef: urlTabs.tabs[0].tabRef });
  urlWorkbench.state.tabs[0] = { ...urlWorkbench.state.tabs[0], url: "https://mail.example.test/draft/changed" };
  await assert.rejects(
    () => urlBrowser.closeTab({ actionApprovalRef: urlPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_PAGE_CHANGED");
      return true;
    }
  );
  assert.equal(urlWorkbench.state.closeDispatches, 0, "URL drift must be detected before close dispatch");
  await assert.rejects(() => urlBrowser.closeTab({ actionApprovalRef: urlPrepared.actionApprovalRef }), /already consumed|expired/i);

  const providerWorkbench = makeWorkbench();
  const providerBrowser = new CodexBrowserExecutor({ workbench: providerWorkbench, defaultCwd: "C:\\workspace" });
  const providerTabs = await providerBrowser.listTabs({});
  const providerPrepared = await providerBrowser.prepareCloseTab({ tabRef: providerTabs.tabs[0].tabRef });
  providerWorkbench.state.tabs[0] = { ...providerWorkbench.state.tabs[0], providerTabId: '["other-browser-instance","123"]' };
  await assert.rejects(
    () => providerBrowser.closeTab({ actionApprovalRef: providerPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_TAB_STALE");
      return true;
    }
  );
  assert.equal(providerWorkbench.state.closeDispatches, 0, "provider drift must fail before close dispatch");

  const generationWorkbench = makeWorkbench();
  const generationBrowser = new CodexBrowserExecutor({ workbench: generationWorkbench, defaultCwd: "C:\\workspace" });
  const generationTabs = await generationBrowser.listTabs({});
  const generationPrepared = await generationBrowser.prepareCloseTab({ tabRef: generationTabs.tabs[0].tabRef });
  generationWorkbench.generation += 1;
  await assert.rejects(
    () => generationBrowser.closeTab({ actionApprovalRef: generationPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_RUNTIME_RESTARTED");
      return true;
    }
  );
  assert.equal(generationWorkbench.state.closeDispatches, 0, "generation drift must never dispatch close");

  const raceWorkbench = makeWorkbench();
  const raceBrowser = new CodexBrowserExecutor({ workbench: raceWorkbench, defaultCwd: "C:\\workspace" });
  const raceTabs = await raceBrowser.listTabs({});
  const racePrepared = await raceBrowser.prepareCloseTab({ tabRef: raceTabs.tabs[0].tabRef });
  raceWorkbench.state.bumpGenerationBeforeMutationDispatch = true;
  await assert.rejects(
    () => raceBrowser.closeTab({ actionApprovalRef: racePrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_WORKBENCH_RESTARTED");
      return true;
    }
  );
  assert.equal(raceWorkbench.state.closeDispatches, 0, "a generation race at the runtime dispatch boundary must fail closed before Tab.close()");
});

test("Browser close-tab uncertainty is fail-visible, single-use, and never replayed", async () => {
  for (const failure of ["closeUncertain", "closeTransportThrow"]) {
    const workbench = makeWorkbench();
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareCloseTab({ tabRef: listed.tabs[0].tabRef });
    workbench.state[failure] = true;

    await assert.rejects(
      () => browser.closeTab({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_CLOSE_RESULT_UNCERTAIN");
        assert.match(error.message, /uncertain|response was not received reliably|timeout after close dispatch/i);
        assert.match((error.nextActions ?? []).join(" "), /do not close again automatically|do not retry/i);
        return true;
      }
    );
    assert.equal(workbench.state.closeDispatches, 1, `${failure} occurs only after one close dispatch attempt`);
    await assert.rejects(
      () => browser.closeTab({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
        return true;
      }
    );
    assert.equal(workbench.state.closeDispatches, 1, `${failure} must not replay through the consumed ref`);
  }
});

test("Browser emergency reset advances generation, invalidates stale refs, releases simulated stale claims, and never closes Chrome tabs", async () => {
  const workbench = makeWorkbench();
  workbench.state.simulateClaimLifecycle = true;
  workbench.state.cleanupReceipt = {
    cleanupStatus: "deferred",
    cleanupReason: "turn-boundary-auto-release",
    cleanupError: null,
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const oldTabRef = listed.tabs[0].tabRef;
  const prepared = await browser.prepareClick({ tabRef: oldTabRef, role: "button", name: "Refresh" });
  assert.equal(prepared.status, "prepared");
  assert.equal(workbench.state.syntheticClaimHeld, true, "finalize-absent prepare should leave the fake Browser session busy");
  await assert.rejects(
    () => browser.readTab({ tabRef: oldTabRef, maxChars: 1000 }),
    (error) => {
      assert.equal(error.code, "BROWSER_TAB_BUSY");
      return true;
    }
  );

  const beforeChromeTabs = workbench.state.tabs.map((tab) => ({ ...tab }));
  const reset = await browser.emergencyResetControlState({});
  assert.equal(reset.status, "reset");
  assert.equal(reset.action, "browser_control_state_emergency_reset");
  assert.equal(reset.before.generation, 1);
  assert.equal(reset.after.generation, 2);
  assert.equal(reset.generationAdvanced, true);
  assert.equal(reset.chromeTabsClosed, 0);
  assert.equal(reset.browserMutationReplayed, false);
  assert.equal(workbench.state.workbenchRestarts, 1);
  assert.equal(workbench.state.syntheticClaimHeld, false, "dedicated Browser Workbench restart must retire the simulated stale claim owner");
  assert.deepEqual(workbench.state.tabs, beforeChromeTabs, "emergency reset must not close, navigate, or replace real Chrome tabs");

  await assert.rejects(
    () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
  assert.equal(workbench.state.clicks, 0, "reset must invalidate prepared mutations rather than replay them");

  const fresh = await browser.listTabs({});
  assert.equal(fresh.count, 1);
  assert.notEqual(fresh.tabs[0].tabRef, oldTabRef, "reset must invalidate old tab-session bindings and mint fresh opaque refs");
  const read = await browser.readTab({ tabRef: fresh.tabs[0].tabRef, maxChars: 1000 });
  assert.equal(read.status, "ok", "a fresh session must be able to claim the disposable tab after reset");
});

test("Browser emergency reset refuses while this runtime can prove a mutation is in flight", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh" });
  const originalMcpCall = workbench.mcpCall.bind(workbench);
  let releaseMutation;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const hold = new Promise((resolve) => { releaseMutation = resolve; });
  workbench.mcpCall = async (input) => {
    if (input.arguments?.title === "Execute prepared Chrome click") {
      markStarted();
      await hold;
    }
    return originalMcpCall(input);
  };
  const clickPromise = browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  await started;
  await assert.rejects(
    () => browser.emergencyResetControlState({}),
    (error) => {
      assert.equal(error.code, "BROWSER_EMERGENCY_RESET_MUTATION_IN_FLIGHT");
      assert.equal(error.diagnostic?.activeMutationCount, 1);
      assert.deepEqual(error.diagnostic?.activeMutationKinds, ["click"]);
      return true;
    }
  );
  assert.equal(workbench.state.workbenchRestarts, 0, "reset must fail before restarting while a mutation is active");
  releaseMutation();
  const clicked = await clickPromise;
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);
});

test("Browser exact-set bulk close closes only prepared tabs and consumes one opaque set ref", async () => {
  const workbench = makeWorkbench();
  workbench.state.tabs.push(
    {
      providerTabId: '["browser-instance","456"]',
      title: "Disposable Two",
      url: "https://example.test/disposable-two",
      lastOpened: "2026-08-13T00:00:01.000Z",
    },
    {
      providerTabId: '["browser-instance","789"]',
      title: "Disposable Three",
      url: "https://example.test/disposable-three",
      lastOpened: "2026-08-13T00:00:02.000Z",
    }
  );
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const first = listed.tabs.find((tab) => tab.url === "https://mail.example.test/inbox");
  const keeper = listed.tabs.find((tab) => tab.url === "https://example.test/disposable-two");
  const third = listed.tabs.find((tab) => tab.url === "https://example.test/disposable-three");
  assert.ok(first && keeper && third);
  const prepared = await browser.prepareBulkCloseTabs({ tabRefs: [third.tabRef, first.tabRef] });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "bulk_close_tabs");
  assert.equal(prepared.action.count, 2);
  assert.deepEqual(prepared.action.tabs.map((tab) => tab.tabRef), [third.tabRef, first.tabRef]);
  assert.equal(JSON.stringify(prepared).includes("providerTabId"), false);
  assert.equal(workbench.state.bulkCloseDispatches, 0);
  assert.equal(workbench.state.tabs.length, 3);

  const closed = await browser.bulkCloseTabs({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(closed.status, "closed");
  assert.equal(closed.requestedCount, 2);
  assert.equal(closed.confirmedClosedCount, 2);
  assert.deepEqual(closed.confirmedClosed.map((tab) => tab.tabRef), [third.tabRef, first.tabRef]);
  assert.equal(closed.noAutomaticReplay, true);
  assert.equal(JSON.stringify(closed).includes("providerTabId"), false);
  assert.equal(workbench.state.bulkCloseDispatches, 2);
  assert.deepEqual(workbench.state.tabs.map((tab) => tab.url), ["https://example.test/disposable-two"], "the unprepared tab must remain open");
  const after = await browser.listTabs({});
  assert.equal(after.count, 1);
  assert.equal(after.tabs[0].tabRef, keeper.tabRef);
  await assert.rejects(
    () => browser.bulkCloseTabs({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
  assert.equal(workbench.state.bulkCloseDispatches, 2, "consumed exact-set ref must never dispatch twice");
});

test("Browser bulk close stops at first drift with a partial receipt and never attempts later tabs", async () => {
  const workbench = makeWorkbench();
  workbench.state.tabs.push(
    {
      providerTabId: '["browser-instance","456"]',
      title: "Disposable Two",
      url: "https://example.test/disposable-two",
      lastOpened: "2026-08-13T00:00:01.000Z",
    },
    {
      providerTabId: '["browser-instance","789"]',
      title: "Disposable Three",
      url: "https://example.test/disposable-three",
      lastOpened: "2026-08-13T00:00:02.000Z",
    }
  );
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareBulkCloseTabs({ tabRefs: listed.tabs.map((tab) => tab.tabRef) });
  const secondProvider = workbench.state.tabs[1].providerTabId;
  workbench.state.tabs = workbench.state.tabs.map((tab) => tab.providerTabId === secondProvider
    ? { ...tab, url: "https://example.test/disposable-two-drifted" }
    : tab);

  const partial = await browser.bulkCloseTabs({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(partial.status, "partial");
  assert.equal(partial.confirmedClosedCount, 1);
  assert.equal(partial.stopReason.errorCode, "BROWSER_BULK_CLOSE_TARGET_CHANGED");
  assert.equal(partial.stopReason.uncertain, false);
  assert.equal(partial.stoppedAtIndex, 1);
  assert.equal(partial.unprocessedCount, 1);
  assert.equal(partial.noAutomaticReplay, true);
  assert.equal(workbench.state.bulkCloseDispatches, 1, "only the first exact target may close before second-target drift stops the set");
  assert.equal(workbench.state.tabs.some((tab) => tab.url === "https://example.test/disposable-three"), true, "later targets must not be attempted after drift");
  await assert.rejects(() => browser.bulkCloseTabs({ actionApprovalRef: prepared.actionApprovalRef }), /expired|consumed/i);
  assert.equal(workbench.state.bulkCloseDispatches, 1);
});

test("Browser bulk close stops on uncertain item, reports only confirmed closes, and never replays the remaining set", async () => {
  const workbench = makeWorkbench();
  workbench.state.tabs.push(
    {
      providerTabId: '["browser-instance","456"]',
      title: "Disposable Two",
      url: "https://example.test/disposable-two",
      lastOpened: "2026-08-13T00:00:01.000Z",
    },
    {
      providerTabId: '["browser-instance","789"]',
      title: "Disposable Three",
      url: "https://example.test/disposable-three",
      lastOpened: "2026-08-13T00:00:02.000Z",
    }
  );
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareBulkCloseTabs({ tabRefs: listed.tabs.map((tab) => tab.tabRef) });
  workbench.state.bulkCloseUncertainProviderTabId = workbench.state.tabs[1].providerTabId;

  const partial = await browser.bulkCloseTabs({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(partial.status, "partial");
  assert.equal(partial.confirmedClosedCount, 1);
  assert.equal(partial.stopReason.errorCode, "BROWSER_BULK_CLOSE_RESULT_UNCERTAIN");
  assert.equal(partial.stopReason.uncertain, true);
  assert.equal(partial.stoppedAtIndex, 1);
  assert.equal(partial.unprocessedCount, 1);
  assert.equal(workbench.state.bulkCloseDispatches, 2, "uncertain second close may have been dispatched exactly once");
  assert.equal(workbench.state.tabs.some((tab) => tab.url === "https://example.test/disposable-three"), true, "third tab must not be attempted after uncertainty");
  await assert.rejects(() => browser.bulkCloseTabs({ actionApprovalRef: prepared.actionApprovalRef }), /expired|consumed/i);
  assert.equal(workbench.state.bulkCloseDispatches, 2, "uncertain exact-set action must never replay");
});

test("Browser Operate prepare/open-tab binds explicit Chrome family, creates one exact deliverable tab, and exposes it on the next family list", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });

  const prepared = await browser.prepareOpenTab({ family: "chrome", url: "https://example.test/new" });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "open_tab");
  assert.equal(prepared.action.family, "chrome");
  assert.equal(prepared.action.toUrl, "https://example.test/new");
  assert.equal(workbench.state.openedTabs, 0, "prepare open-tab must not create a tab");

  const opened = await browser.openTab({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(opened.status, "opened");
  assert.equal(opened.family, "chrome");
  assert.equal(opened.action.family, "chrome");
  assert.equal(opened.requestedUrl, "https://example.test/new");
  assert.equal(opened.afterUrl, "https://example.test/new");
  assert.equal(opened.redirected, false);
  assert.equal(workbench.state.openedTabs, 1);
  assert.deepEqual(workbench.state.openedTabFamilies, ["chrome"]);
  assert.match(opened.note, /browser_tabs/i);
  assert.equal(JSON.stringify(opened).includes("providerTabId"), false);

  const listed = await browser.listTabs({ family: "chrome" });
  assert.equal(listed.count, 2);
  const created = listed.tabs.find((tab) => tab.url === "https://example.test/new");
  assert.ok(created);
  assert.equal(created.family, "chrome");
  assert.match(created.tabRef, /^browser_tab_/);

  await assert.rejects(
    () => browser.openTab({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
  await assert.rejects(
    () => browser.prepareOpenTab({ family: "chrome", url: "javascript:alert(1)" }),
    (error) => {
      assert.equal(error.code, "BROWSER_NAVIGATE_SCHEME_UNSUPPORTED");
      return true;
    }
  );
});

test("Browser Operate explicit Edge new-tab keeps family server-bound and never replays an uncertain create", async () => {
  const workbench = makeWorkbench({
    browserBackends: [
      { name: "Chrome", family: "chrome", type: "extension" },
      { name: "Edge", family: "edge", type: "extension" },
    ],
  });
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });

  const prepared = await browser.prepareOpenTab({ family: "edge", url: "https://example.test/edge-new" });
  assert.equal(prepared.action.family, "edge");
  workbench.state.openTabUncertain = true;

  await assert.rejects(
    () => browser.openTab({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_OPEN_TAB_RESULT_UNCERTAIN");
      assert.match(error.message, /new-tab result is uncertain/i);
      return true;
    }
  );
  assert.equal(workbench.state.openedTabs, 1, "uncertain Edge create may have dispatched exactly once");
  assert.deepEqual(workbench.state.openedTabFamilies, ["edge"]);
  await assert.rejects(
    () => browser.openTab({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
  assert.equal(workbench.state.openedTabs, 1, "uncertain prepared Edge create must never replay");
});

test("Browser bounded scroll moves one existing tab and returns a fresh DOM snapshot without click/fill/navigation targets", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});

  const scrolled = await browser.scrollTab({
    tabRef: listed.tabs[0].tabRef,
    direction: "down",
    amount: "page",
    maxChars: 1000,
  });
  assert.equal(scrolled.status, "scrolled");
  assert.equal(scrolled.direction, "down");
  assert.equal(scrolled.amount, "page");
  assert.equal(scrolled.deltaY, 800);
  assert.equal(scrolled.inputMethod, "body-keypress");
  assert.deepEqual(scrolled.keypresses, ["PageDown"]);
  assert.equal(scrolled.dispatchStatus, "confirmed");
  assert.equal(scrolled.scrollReturned, true);
  assert.equal(scrolled.readbackStatus, "ok");
  assert.equal(scrolled.snapshot, "SCROLLED=800");
  assert.equal(scrolled.snapshotChanged, null);
  assert.equal(workbench.state.scrolls, 1);
  assert.equal(workbench.state.clicks, 0);
  assert.equal(workbench.state.fills, 0);
  assert.equal(workbench.state.navigations, 0);

  const up = await browser.scrollTab({
    tabRef: listed.tabs[0].tabRef,
    direction: "up",
    amount: "small",
    maxChars: 1000,
  });
  assert.equal(up.deltaY, -400);
  assert.equal(up.inputMethod, "body-keypress");
  assert.deepEqual(up.keypresses, Array(6).fill("ArrowUp"));
  assert.equal(workbench.state.scrolls, 2);
});

test("Browser confirmed scroll stays successful when only post-scroll readback fails, while true dispatch uncertainty still fails closed", async () => {
  const readbackWorkbench = makeWorkbench();
  const readbackBrowser = new CodexBrowserExecutor({ workbench: readbackWorkbench, defaultCwd: "C:\\workspace" });
  const readbackTabs = await readbackBrowser.listTabs({});
  readbackWorkbench.state.scrollReadbackFailure = true;
  const scrolled = await readbackBrowser.scrollTab({
    tabRef: readbackTabs.tabs[0].tabRef,
    direction: "down",
    amount: "page",
    maxChars: 1000,
  });
  assert.equal(scrolled.status, "scrolled");
  assert.equal(scrolled.dispatchStatus, "confirmed");
  assert.equal(scrolled.scrollReturned, true);
  assert.equal(scrolled.readbackStatus, "unavailable");
  assert.ok(scrolled.readbackError);
  assert.equal(readbackWorkbench.state.scrolls, 1);

  const uncertainWorkbench = makeWorkbench();
  const uncertainBrowser = new CodexBrowserExecutor({ workbench: uncertainWorkbench, defaultCwd: "C:\\workspace" });
  const uncertainTabs = await uncertainBrowser.listTabs({});
  uncertainWorkbench.state.scrollUncertain = true;
  await assert.rejects(
    () => uncertainBrowser.scrollTab({
      tabRef: uncertainTabs.tabs[0].tabRef,
      direction: "down",
      amount: "page",
      maxChars: 1000,
    }),
    (error) => {
      assert.equal(error.code, "BROWSER_SCROLL_RESULT_UNCERTAIN");
      assert.match(error.message, /uncertain/i);
      return true;
    }
  );
  assert.equal(uncertainWorkbench.state.scrolls, 1);
});

test("Browser fixed keypress exposes only Enter/Tab/Escape at current focus and returns confirmed readback", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  for (const key of ["Tab", "Escape", "Enter"]) {
    const pressed = await browser.keypressTab({ tabRef: listed.tabs[0].tabRef, key, maxChars: 1000 });
    assert.equal(pressed.status, "pressed");
    assert.equal(pressed.key, key);
    assert.equal(pressed.inputMethod, "focused-keypress");
    assert.equal(pressed.dispatchStatus, "confirmed");
    assert.equal(pressed.keypressReturned, true);
    assert.equal(pressed.cleanupStatus, "released");
    assert.equal(pressed.readbackStatus, "ok");
    assert.equal(pressed.urlChanged, false);
    assert.match(pressed.note, /arbitrary keys, modifiers, text, selectors, coordinates, repeats, or JavaScript/i);
  }
  assert.deepEqual(workbench.state.keypresses, ["Tab", "Escape", "Enter"]);
  assert.equal(workbench.state.clicks, 0);
  assert.equal(workbench.state.fills, 0);
  assert.equal(workbench.state.navigations, 0);
  await assert.rejects(
    () => browser.keypressTab({ tabRef: listed.tabs[0].tabRef, key: "Space", maxChars: 1000 }),
    (error) => {
      assert.equal(error.code, "BROWSER_KEYPRESS_KEY_INVALID");
      return true;
    }
  );
});

test("Browser fixed keypress fails closed on dispatch uncertainty and never implies blind replay", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  workbench.state.keypressUncertain = true;
  await assert.rejects(
    () => browser.keypressTab({ tabRef: listed.tabs[0].tabRef, key: "Enter", maxChars: 1000 }),
    (error) => {
      assert.equal(error.code, "BROWSER_KEYPRESS_RESULT_UNCERTAIN");
      assert.match(error.message, /uncertain/i);
      assert.match((error.nextActions ?? []).join(" "), /never blindly repeat|do not retry/i);
      return true;
    }
  );
  assert.deepEqual(workbench.state.keypresses, ["Enter"]);
});

test("Browser Operate prepare/navigate binds one existing tab and exact http(s) URL", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareNavigate({
    tabRef: listed.tabs[0].tabRef,
    url: "https://www.reddit.com/r/codex/",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "navigate");
  assert.equal(prepared.action.fromUrl, "https://mail.example.test/inbox");
  assert.equal(prepared.action.toUrl, "https://www.reddit.com/r/codex/");
  assert.equal(workbench.state.navigations, 0, "prepare navigation must remain read-only");

  const navigated = await browser.navigate({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(navigated.status, "navigated");
  assert.equal(workbench.state.navigations, 1);
  assert.equal(navigated.beforeUrl, "https://mail.example.test/inbox");
  assert.equal(navigated.requestedUrl, "https://www.reddit.com/r/codex/");
  assert.equal(navigated.afterUrl, "https://www.reddit.com/r/codex/");
  assert.equal(navigated.redirected, false);
  assert.equal(navigated.postSnapshot, "POST_NAVIGATE_OK");

  await assert.rejects(
    () => browser.navigate({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
});

test("Prepared Browser actions recover one transient node_repl discovery before ref consumption and preserve no-replay boundaries", async () => {
  const recoveredWorkbench = makeWorkbench();
  const recoveredBrowser = new CodexBrowserExecutor({ workbench: recoveredWorkbench, defaultCwd: "C:\\workspace" });
  const recoveredTabs = await recoveredBrowser.listTabs({});
  const recoveredPrepared = await recoveredBrowser.prepareClick({
    tabRef: recoveredTabs.tabs[0].tabRef,
    role: "button",
    name: "Refresh",
  });
  const recoveredCatalogBaseline = recoveredWorkbench.state.mcpCatalogCalls;
  recoveredWorkbench.state.mcpCatalogFailuresRemaining = 1;
  const recovered = await recoveredBrowser.click({ actionApprovalRef: recoveredPrepared.actionApprovalRef });
  assert.equal(recovered.status, "clicked");
  assert.equal(recoveredWorkbench.state.mcpCatalogCalls - recoveredCatalogBaseline, 2, "exactly one bounded node_repl rediscovery is allowed before dispatch");
  assert.equal(recoveredWorkbench.state.clicks, 1, "recovery must still dispatch the click exactly once");
  await assert.rejects(() => recoveredBrowser.click({ actionApprovalRef: recoveredPrepared.actionApprovalRef }), /invalid, expired, or already consumed/i);

  const persistentWorkbench = makeWorkbench();
  const persistentBrowser = new CodexBrowserExecutor({ workbench: persistentWorkbench, defaultCwd: "C:\\workspace" });
  const persistentTabs = await persistentBrowser.listTabs({});
  const persistentPrepared = await persistentBrowser.prepareClick({
    tabRef: persistentTabs.tabs[0].tabRef,
    role: "button",
    name: "Refresh",
  });
  const persistentCatalogBaseline = persistentWorkbench.state.mcpCatalogCalls;
  persistentWorkbench.state.mcpCatalogFailuresRemaining = 2;
  await assert.rejects(
    () => persistentBrowser.click({ actionApprovalRef: persistentPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_NODE_REPL_DISCOVERY_FAILED");
      assert.deepEqual(error.diagnostic, {
        failureLayer: "pre_dispatch_discovery",
        preDispatch: true,
        safeToRetry: true,
        internalRediscoveryAttempts: 1,
        actionRefRetained: true,
      });
      assert.match((error.nextActions ?? []).join(" "), /same prepared actionApprovalRef/i);
      return true;
    }
  );
  assert.equal(persistentWorkbench.state.mcpCatalogCalls - persistentCatalogBaseline, 2, "persistent discovery failure must stop after one internal rediscovery");
  assert.equal(persistentWorkbench.state.clicks, 0, "pre-dispatch discovery failure must not click");
  persistentWorkbench.state.mcpCatalogFailuresRemaining = 0;
  const retried = await persistentBrowser.click({ actionApprovalRef: persistentPrepared.actionApprovalRef });
  assert.equal(retried.status, "clicked", "the same exact prepared ref remains usable after a proven pre-dispatch discovery failure");
  assert.equal(persistentWorkbench.state.clicks, 1);

  const restartedWorkbench = makeWorkbench();
  const restartedBrowser = new CodexBrowserExecutor({ workbench: restartedWorkbench, defaultCwd: "C:\\workspace" });
  const restartedTabs = await restartedBrowser.listTabs({});
  const restartedPrepared = await restartedBrowser.prepareClick({
    tabRef: restartedTabs.tabs[0].tabRef,
    role: "button",
    name: "Refresh",
  });
  restartedWorkbench.state.mcpCatalogFailuresRemaining = 1;
  restartedWorkbench.state.bumpGenerationOnMcpCatalogFailure = true;
  await assert.rejects(
    () => restartedBrowser.click({ actionApprovalRef: restartedPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_RUNTIME_RESTARTED");
      return true;
    }
  );
  assert.equal(restartedWorkbench.state.clicks, 0, "generation drift during discovery must fail closed before dispatch");
  await assert.rejects(() => restartedBrowser.click({ actionApprovalRef: restartedPrepared.actionApprovalRef }), /invalid, expired, or already consumed/i);
});

test("Browser navigation rejects unsafe URLs, page drift, and uncertain dispatch", async () => {
  const schemeWorkbench = makeWorkbench();
  const schemeBrowser = new CodexBrowserExecutor({ workbench: schemeWorkbench, defaultCwd: "C:\\workspace" });
  const schemeTabs = await schemeBrowser.listTabs({});
  for (const url of ["javascript:alert(1)", "file:///C:/secret.txt", "data:text/plain,x"]) {
    await assert.rejects(
      () => schemeBrowser.prepareNavigate({ tabRef: schemeTabs.tabs[0].tabRef, url }),
      (error) => {
        assert.equal(error.code, "BROWSER_NAVIGATE_SCHEME_UNSUPPORTED");
        return true;
      }
    );
  }
  await assert.rejects(
    () => schemeBrowser.prepareNavigate({ tabRef: schemeTabs.tabs[0].tabRef, url: "https://user:pass@example.test/" }),
    (error) => {
      assert.equal(error.code, "BROWSER_NAVIGATE_CREDENTIALS_UNSUPPORTED");
      return true;
    }
  );
  await assert.rejects(
    () => schemeBrowser.prepareNavigate({ tabRef: schemeTabs.tabs[0].tabRef, url: "https://mail.example.test/inbox" }),
    (error) => {
      assert.equal(error.code, "BROWSER_NAVIGATE_SAME_URL");
      return true;
    }
  );

  const driftWorkbench = makeWorkbench();
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareNavigate({ tabRef: driftTabs.tabs[0].tabRef, url: "https://example.test/next" });
  driftWorkbench.state.pageChanged = true;
  await assert.rejects(
    () => driftBrowser.navigate({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_PAGE_CHANGED");
      return true;
    }
  );
  assert.equal(driftWorkbench.state.navigations, 0);

  const uncertainWorkbench = makeWorkbench();
  const uncertainBrowser = new CodexBrowserExecutor({ workbench: uncertainWorkbench, defaultCwd: "C:\\workspace" });
  const uncertainTabs = await uncertainBrowser.listTabs({});
  const uncertainPrepared = await uncertainBrowser.prepareNavigate({ tabRef: uncertainTabs.tabs[0].tabRef, url: "https://example.test/next" });
  uncertainWorkbench.state.navigatePostDispatchFailure = true;
  await assert.rejects(
    () => uncertainBrowser.navigate({ actionApprovalRef: uncertainPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_NAVIGATE_RESULT_UNCERTAIN");
      assert.match(error.nextActions.join(" "), /Do not retry/i);
      return true;
    }
  );
  assert.equal(uncertainWorkbench.state.navigations, 1, "uncertain failure happens after navigation dispatch");
  await assert.rejects(() => uncertainBrowser.navigate({ actionApprovalRef: uncertainPrepared.actionApprovalRef }), /invalid, expired, already consumed/i);

  const generationWorkbench = makeWorkbench();
  const generationBrowser = new CodexBrowserExecutor({ workbench: generationWorkbench, defaultCwd: "C:\\workspace" });
  const generationTabs = await generationBrowser.listTabs({});
  const generationPrepared = await generationBrowser.prepareNavigate({ tabRef: generationTabs.tabs[0].tabRef, url: "https://example.test/restarted" });
  generationWorkbench.state.navigateGenerationChangeAfterDispatch = true;
  await assert.rejects(
    () => generationBrowser.navigate({ actionApprovalRef: generationPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_NAVIGATE_RESULT_UNCERTAIN");
      assert.notEqual(error.code, "BROWSER_WORKBENCH_RESTARTED");
      assert.match(error.message, /generation changed|result is uncertain/i);
      assert.match(error.nextActions.join(" "), /Do not retry/i);
      return true;
    }
  );
  assert.equal(generationWorkbench.state.navigations, 1, "generation changed only after the navigation side effect was dispatched");
  await assert.rejects(() => generationBrowser.navigate({ actionApprovalRef: generationPrepared.actionApprovalRef }), /invalid, expired, already consumed/i);
});

test("Browser Operate prepare/click is exact, one-shot, and read-back verified", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    role: "button",
    name: "Refresh",
  });
  assert.equal(prepared.status, "prepared");
  assert.match(prepared.actionApprovalRef, /^browser_action_/);
  assert.equal(prepared.action.kind, "click");
  assert.equal(prepared.action.role, "button");
  assert.equal(prepared.action.name, "Refresh");
  assert.equal(prepared.action.exact, true);
  assert.equal(workbench.state.clicks, 0, "prepare must remain read-only");

  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);
  assert.equal(clicked.beforeUrl, "https://mail.example.test/inbox");
  assert.equal(clicked.afterUrl, "https://mail.example.test/inbox");
  assert.equal(clicked.postSnapshot, "POST_CLICK_OK");
  assert.equal(clicked.postSnapshotTruncated, false);

  await assert.rejects(
    () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
});

test("Browser Operate right-click stays semantic, prepared, and one-shot", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    role: "button",
    name: "Refresh",
    button: "right",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "click");
  assert.equal(prepared.action.button, "right");
  assert.equal(workbench.state.clicks, 0);

  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(clicked.action.button, "right");
  assert.equal(workbench.state.clicks, 1);
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome click")?.arguments?.code ?? "";
  assert.match(executeCode, /__twDispatchLocator\.click\(\{ button: "right", timeoutMs: 5000 \}\)/);
  assert.doesNotMatch(executeCode, /__twDispatchLocator\.check\(/);

  await assert.rejects(
    () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );

  await assert.rejects(
    () => browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh", button: "middle" }),
    (error) => {
      assert.equal(error.code, "BROWSER_CLICK_BUTTON_UNSUPPORTED");
      return true;
    }
  );
});

test("Browser scoped role/name click binds a repeated local control to one exact visible link URL", async () => {
  const workbench = makeWorkbench();
  workbench.state.locatorCount = 4;
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const scopeUrl = "https://www.reddit.com/r/codex/comments/example/comment/p41kwir/";
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    role: "button",
    name: "Reply",
    scopeUrl,
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.targetKind, "role");
  assert.equal(prepared.action.role, "button");
  assert.equal(prepared.action.name, "Reply");
  assert.equal(prepared.action.scopeUrl, scopeUrl);
  assert.equal(workbench.state.clicks, 0);
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(prepareCode, /const __twScopeLinks/);
  assert.match(prepareCode, /getByRole\("link"\)\.filter\(\{ visible: true \}\)/);
  assert.match(prepareCode, /__twScopeLinks\.evaluateAll/);
  assert.match(prepareCode, /__twDepth <= 8/);
  assert.match(prepareCode, /getByRole\("button", \{ name: "Reply", exact: true \}\)\.filter\(\{ visible: true \}\)/);
  assert.match(prepareCode, /https:\/\/www\.reddit\.com\/r\/codex\/comments\/example\/comment\/p41kwir\//);
  assert.doesNotMatch(prepareCode, /comment-1|nth\(3\)|querySelector/);

  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(clicked.action.scopeUrl, scopeUrl);
  assert.equal(workbench.state.clicks, 1);
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome click")?.arguments?.code ?? "";
  assert.match(executeCode, /const __twScopeLinks/);
  assert.match(executeCode, /TOOLWIRE_BROWSER_SCOPE_LINK_COUNT/);
  assert.match(executeCode, /TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT/);

  await assert.rejects(
    () => browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Reply", scopeUrl: "javascript:alert(1)" }),
    (error) => {
      assert.equal(error.code, "BROWSER_NAVIGATE_SCHEME_UNSUPPORTED");
      return true;
    }
  );
  await assert.rejects(
    () => browser.prepareClick({ tabRef: listed.tabs[0].tabRef, text: "Reply", scopeUrl }),
    (error) => {
      assert.equal(error.code, "BROWSER_CLICK_TARGET_CONFLICT");
      return true;
    }
  );
});

test("Browser scoped role/name click fails closed when the scope link or local control is ambiguous", async () => {
  {
    const workbench = makeWorkbench();
    workbench.state.scopeLinkCount = 2;
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    await assert.rejects(
      () => browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Reply", scopeUrl: "https://example.test/comment/1" }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_SCOPE_AMBIGUOUS");
        return true;
      }
    );
    assert.equal(workbench.state.clicks, 0);
  }
  {
    const workbench = makeWorkbench();
    workbench.state.scopedTargetCount = 2;
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    await assert.rejects(
      () => browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Reply", scopeUrl: "https://example.test/comment/1" }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
        return true;
      }
    );
    assert.equal(workbench.state.clicks, 0);
  }
  {
    const workbench = makeWorkbench();
    workbench.state.scopedTargetCount = 0;
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    await assert.rejects(
      () => browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Reply", scopeUrl: "https://example.test/comment/1" }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_TARGET_NOT_FOUND_IN_SCOPE");
        return true;
      }
    );
    assert.equal(workbench.state.clicks, 0);
  }
});

test("Browser prepared download confirms one exact target and returns the browser-managed path without reading the file", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareDownload({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh" });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "download");
  assert.equal(workbench.state.clicks, 0);
  assert.equal(workbench.state.downloads, 0);

  const downloaded = await browser.download({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(downloaded.status, "downloaded");
  assert.equal(downloaded.downloadConfirmed, true);
  assert.equal(downloaded.downloadPath, "C:\\Users\\Test\\Downloads\\fixture.txt");
  assert.equal(downloaded.downloadFileName, "fixture.txt");
  assert.equal(downloaded.pathStatus, "available");
  assert.equal(downloaded.readbackStatus, "ok");
  assert.equal(downloaded.cleanupStatus, "released");
  assert.equal(workbench.state.downloads, 1);
  assert.equal(workbench.state.clicks, 0, "download must use its own receipt path rather than ordinary click accounting");
  assert.match(downloaded.note, /downloaded content remains untrusted/i);

  await assert.rejects(() => browser.download({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, already consumed/i);
});

test("Browser prepared download fails closed when dispatch may have happened without a download receipt", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareDownload({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh" });
  workbench.state.downloadUncertain = true;
  await assert.rejects(
    () => browser.download({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_DOWNLOAD_RESULT_UNCERTAIN");
      assert.match((error.nextActions ?? []).join(" "), /Do not retry/i);
      return true;
    }
  );
  await assert.rejects(() => browser.download({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, already consumed/i);
});

test("Browser prepared upload resolves the file through Codex authority before handing it to the chooser", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({
    workbench,
    defaultCwd: projectRoot,
    authorityExecutor: makeAuthorityExecutor(),
  });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareUpload({
    tabRef: listed.tabs[0].tabRef,
    role: "button",
    name: "Refresh",
    filePath: "package.json",
    cwd: projectRoot,
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "upload");
  assert.equal(prepared.action.fileName, "package.json");
  assert.equal(prepared.action.byteLength > 0, true);
  assert.match(prepared.action.sha256, /^[0-9a-f]{64}$/);
  assert.equal(workbench.state.uploads, 0);

  const uploaded = await browser.upload({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(uploaded.status, "file_selected");
  assert.equal(uploaded.fileName, "package.json");
  assert.equal(uploaded.byteLength > 0, true);
  assert.equal(uploaded.sha256, prepared.action.sha256);
  assert.equal(uploaded.chooserConfirmed, true);
  assert.equal(uploaded.setFilesReturned, true);
  assert.equal(uploaded.readbackStatus, "ok");
  assert.equal(uploaded.cleanupStatus, "released");
  assert.equal(workbench.state.uploads, 1);
  assert.match(uploaded.note, /trusted authority root/i);
  assert.match(uploaded.note, /not necessarily remote server acceptance/i);
});

test("Browser prepared upload refuses authority escape before any browser mutation", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({
    workbench,
    defaultCwd: projectRoot,
    authorityExecutor: makeAuthorityExecutor(),
  });
  const listed = await browser.listTabs({});
  await assert.rejects(
    () => browser.prepareUpload({
      tabRef: listed.tabs[0].tabRef,
      role: "button",
      name: "Refresh",
      filePath: "..\\..\\outside-does-not-exist.txt",
      cwd: projectRoot,
    }),
    /ENOENT|outside trusted root|refused path outside/i
  );
  assert.equal(workbench.state.uploads, 0);
  assert.equal(workbench.state.clicks, 0);
});

test("Browser prepared upload refuses source drift before any browser dispatch", async () => {
  await mkdir(path.join(projectRoot, "_work"), { recursive: true });
  const fixtureDir = await mkdtemp(path.join(projectRoot, "_work", "p1c-upload-pre-drift-"));
  const fixturePath = path.join(fixtureDir, "probe.txt");
  try {
    await writeFile(fixturePath, "VERSION_A\n", "utf8");
    const workbench = makeWorkbench();
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: projectRoot, authorityExecutor: makeAuthorityExecutor() });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareUpload({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh", filePath: fixturePath, cwd: projectRoot });
    await writeFile(fixturePath, "VERSION_B\n", "utf8");
    await assert.rejects(
      () => browser.upload({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_UPLOAD_SOURCE_CHANGED");
        assert.match(error.message, /SHA-256|changed/i);
        return true;
      }
    );
    assert.equal(workbench.state.uploads, 0);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Browser prepared upload detects source drift after setFiles and does not replay", async () => {
  await mkdir(path.join(projectRoot, "_work"), { recursive: true });
  const fixtureDir = await mkdtemp(path.join(projectRoot, "_work", "p1c-upload-post-drift-"));
  const fixturePath = path.join(fixtureDir, "probe.txt");
  try {
    await writeFile(fixturePath, "VERSION_A\n", "utf8");
    const workbench = makeWorkbench();
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: projectRoot, authorityExecutor: makeAuthorityExecutor() });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareUpload({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh", filePath: fixturePath, cwd: projectRoot });
    workbench.state.uploadPostDispatchHook = () => writeFile(fixturePath, "VERSION_B\n", "utf8");
    await assert.rejects(
      () => browser.upload({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_UPLOAD_SOURCE_CHANGED_AFTER_DISPATCH");
        assert.match((error.nextActions ?? []).join(" "), /Do not retry/i);
        return true;
      }
    );
    assert.equal(workbench.state.uploads, 1);
    await assert.rejects(() => browser.upload({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, already consumed/i);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Browser prepared upload fails closed on uncertain filechooser/setFiles dispatch and does not replay", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({
    workbench,
    defaultCwd: projectRoot,
    authorityExecutor: makeAuthorityExecutor(),
  });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareUpload({
    tabRef: listed.tabs[0].tabRef,
    role: "button",
    name: "Refresh",
    filePath: "package.json",
    cwd: projectRoot,
  });
  workbench.state.uploadUncertain = true;
  await assert.rejects(
    () => browser.upload({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_UPLOAD_RESULT_UNCERTAIN");
      assert.match((error.nextActions ?? []).join(" "), /Do not retry/i);
      assert.match((error.nextActions ?? []).join(" "), /Allow access to file URLs/i);
      return true;
    }
  );
  await assert.rejects(() => browser.upload({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, already consumed/i);
});

test("Browser Operate exact visible-text fallback handles clickable card text without selectors", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    text: "You taught me something useful",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "click");
  assert.equal(prepared.action.targetKind, "text");
  assert.equal(prepared.action.text, "You taught me something useful");
  assert.equal(prepared.action.exact, true);
  assert.equal(Object.hasOwn(prepared.action, "role"), false);
  assert.equal(Object.hasOwn(prepared.action, "name"), false);
  assert.equal(workbench.state.clicks, 0, "exact-text prepare must remain read-only");

  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(clicked.action.targetKind, "text");
  assert.equal(clicked.action.text, "You taught me something useful");
  assert.equal(workbench.state.clicks, 1);

  await assert.rejects(
    () => browser.prepareClick({
      tabRef: listed.tabs[0].tabRef,
      role: "button",
      name: "Refresh",
      text: "You taught me something useful",
    }),
    (error) => {
      assert.equal(error.code, "BROWSER_CLICK_TARGET_CONFLICT");
      return true;
    }
  );

  const hiddenDuplicateWorkbench = makeWorkbench();
  hiddenDuplicateWorkbench.state.textHiddenDuplicateCount = 1;
  const hiddenDuplicateBrowser = new CodexBrowserExecutor({ workbench: hiddenDuplicateWorkbench, defaultCwd: "C:\\workspace" });
  const hiddenDuplicateTabs = await hiddenDuplicateBrowser.listTabs({});
  const hiddenDuplicatePrepared = await hiddenDuplicateBrowser.prepareClick({
    tabRef: hiddenDuplicateTabs.tabs[0].tabRef,
    text: "One visible card plus one hidden detail copy",
  });
  assert.equal(hiddenDuplicatePrepared.status, "prepared", "a hidden exact-text duplicate must not create false ambiguity");
  const hiddenDuplicateCode = hiddenDuplicateWorkbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(hiddenDuplicateCode, /__twRawTextLocator\.all\(\)/);
  assert.match(hiddenDuplicateCode, /__twCandidate\.isVisible\(\)/);
  assert.doesNotMatch(hiddenDuplicateCode, /getByText[\s\S]*filter\(\{ visible: true \}\)/);

  const ambiguousWorkbench = makeWorkbench();
  ambiguousWorkbench.state.textVisibleCount = 2;
  const ambiguousBrowser = new CodexBrowserExecutor({ workbench: ambiguousWorkbench, defaultCwd: "C:\\workspace" });
  const ambiguousTabs = await ambiguousBrowser.listTabs({});
  await assert.rejects(
    () => ambiguousBrowser.prepareClick({ tabRef: ambiguousTabs.tabs[0].tabRef, text: "Two visible duplicate cards" }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
      return true;
    }
  );

  const nonSemanticWorkbench = makeWorkbench();
  nonSemanticWorkbench.state.textSemanticCount = 0;
  const nonSemanticBrowser = new CodexBrowserExecutor({ workbench: nonSemanticWorkbench, defaultCwd: "C:\\workspace" });
  const nonSemanticTabs = await nonSemanticBrowser.listTabs({});
  await assert.rejects(
    () => nonSemanticBrowser.prepareClick({ tabRef: nonSemanticTabs.tabs[0].tabRef, text: "Clickable-looking text" }),
    (error) => {
      assert.equal(error.code, "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE");
      return true;
    }
  );

  const multiSemanticWorkbench = makeWorkbench();
  multiSemanticWorkbench.state.textSemanticCount = 2;
  const multiSemanticBrowser = new CodexBrowserExecutor({ workbench: multiSemanticWorkbench, defaultCwd: "C:\\workspace" });
  const multiSemanticTabs = await multiSemanticBrowser.listTabs({});
  await assert.rejects(
    () => multiSemanticBrowser.prepareClick({ tabRef: multiSemanticTabs.tabs[0].tabRef, text: "Nested ambiguous action" }),
    (error) => {
      assert.equal(error.code, "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE");
      return true;
    }
  );
});

test("Browser exact-text binds a unique visible enabled menuitem even when its accessible name is unusable", async () => {
  const fixture = await readFile(path.join(projectRoot, "test", "fixtures", "browser-exact-text-menuitem.html"), "utf8");
  assert.match(fixture, /role="menuitem"/);
  assert.match(fixture, /aria-hidden="true">ショートカットを追加/);
  assert.match(fixture, /role="menuitem" aria-disabled="true"/);

  const workbench = makeWorkbench();
  workbench.state.textSemanticKind = "role";
  workbench.state.textSemanticRole = "menuitem";
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    text: "ショートカットを追加",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.targetKind, "text");
  assert.equal(workbench.state.clicks, 0, "menuitem exact-text prepare must remain read-only");

  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(prepareCode, /\["link","button","menuitem"\]/);
  assert.match(prepareCode, /getByRole\(__twRole\)\.filter\(\{ has: __twTextLocator \}\)/);
  assert.match(prepareCode, /__twLocator\.isVisible\(\)/);
  assert.match(prepareCode, /__twLocator\.isEnabled\(\)/);
  assert.doesNotMatch(prepareCode, /drive\.google|google drive|gmo car/i, "menuitem support must stay site-neutral except for the caller-bound exact text literal");

  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome click")?.arguments?.code ?? "";
  assert.match(executeCode, /\["menuitem"\]/, "execute must re-bind the server-derived menuitem role rather than reopen link/button fallback");
  assert.match(executeCode, /getByText\("ショートカットを追加", \{ exact: true \}\)/);
  assert.match(executeCode, /__twLocator\.isVisible\(\)/);
  assert.match(executeCode, /__twLocator\.isEnabled\(\)/);

  const driftWorkbench = makeWorkbench();
  driftWorkbench.state.textSemanticKind = "role";
  driftWorkbench.state.textSemanticRole = "menuitem";
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareClick({ tabRef: driftTabs.tabs[0].tabRef, text: "ショートカットを追加" });
  driftWorkbench.state.textBindingChanged = true;
  await assert.rejects(
    () => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
      return true;
    }
  );
  assert.equal(driftWorkbench.state.clicks, 0, "menuitem role/text drift must fail before dispatch");

  const disabledWorkbench = makeWorkbench();
  disabledWorkbench.state.textSemanticKind = "role";
  disabledWorkbench.state.textSemanticRole = "menuitem";
  disabledWorkbench.state.locatorEnabled = false;
  const disabledBrowser = new CodexBrowserExecutor({ workbench: disabledWorkbench, defaultCwd: "C:\\workspace" });
  const disabledTabs = await disabledBrowser.listTabs({});
  await assert.rejects(
    () => disabledBrowser.prepareClick({ tabRef: disabledTabs.tabs[0].tabRef, text: "無効な操作" }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_NOT_ENABLED");
      return true;
    }
  );
  assert.equal(disabledWorkbench.state.clicks, 0);

  const ambiguousWorkbench = makeWorkbench();
  ambiguousWorkbench.state.textSemanticKind = "role";
  ambiguousWorkbench.state.textSemanticRole = "menuitem";
  ambiguousWorkbench.state.textSemanticCount = 2;
  const ambiguousBrowser = new CodexBrowserExecutor({ workbench: ambiguousWorkbench, defaultCwd: "C:\\workspace" });
  const ambiguousTabs = await ambiguousBrowser.listTabs({});
  await assert.rejects(
    () => ambiguousBrowser.prepareClick({ tabRef: ambiguousTabs.tabs[0].tabRef, text: "重複メニュー" }),
    (error) => {
      assert.equal(error.code, "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE");
      return true;
    }
  );
  assert.equal(ambiguousWorkbench.state.clicks, 0);
});

test("Browser exact-text binds a stable data-thread-id card and rejects binding drift", async () => {
  const workbench = makeWorkbench();
  workbench.state.textSemanticKind = "thread-card-data";
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    text: "Rhysen exact thread title",
  });
  assert.equal(prepared.status, "prepared");
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(prepareCode, /data-thread-id/);
  assert.match(prepareCode, /classList.*thread-card/);
  assert.match(prepareCode, /thread-card-data/);
  assert.equal(workbench.state.clicks, 0);

  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome click")?.arguments?.code ?? "";
  assert.match(executeCode, /threadId.*2811/);
  assert.match(executeCode, /TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED/);

  const driftWorkbench = makeWorkbench();
  driftWorkbench.state.textSemanticKind = "thread-card-data";
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareClick({ tabRef: driftTabs.tabs[0].tabRef, text: "Rhysen exact thread title" });
  driftWorkbench.state.textBindingChanged = true;
  await assert.rejects(
    () => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
      return true;
    }
  );
});

test("Browser exact-text binds a unique server-observed stable-id custom anchor and rejects fingerprint drift", async () => {
  const workbench = makeWorkbench();
  workbench.state.textSemanticKind = "stable-element-id";
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    text: "パスワード通知",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.targetKind, "text");
  assert.equal(Object.hasOwn(prepared.action, "id"), false, "server-derived stable DOM ids must never be exposed as caller target input/output");
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(prepareCode, /stable-element-id/);
  assert.match(prepareCode, /tagName === "a"/);
  assert.match(prepareCode, /stableIdPattern/);
  assert.match(prepareCode, /document\.querySelectorAll\("\[id\]"\)/);
  assert.match(prepareCode, /duplicateIds\.length === 1/);
  assert.match(prepareCode, /href === null/);
  assert.match(prepareCode, /ariaDisabled/);
  assert.doesNotMatch(prepareCode, /sendPasswordButton/, "prepare source must derive the DOM id from page state rather than caller input");
  assert.equal(workbench.state.clicks, 0, "stable-id prepare must remain read-only");

  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome click")?.arguments?.code ?? "";
  assert.match(executeCode, /sendPasswordButton/);
  assert.match(executeCode, /TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED/);
  assert.match(executeCode, /__twStableIdBinding\.tagName/);
  assert.match(executeCode, /__twStableIdBinding\.href/);
  assert.doesNotMatch(executeCode, /locator\(["']#sendPasswordButton["']\)/, "execute must not turn the server-read id into a caller-style CSS selector path");

  const driftWorkbench = makeWorkbench();
  driftWorkbench.state.textSemanticKind = "stable-element-id";
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareClick({ tabRef: driftTabs.tabs[0].tabRef, text: "パスワード通知" });
  driftWorkbench.state.textBindingChanged = true;
  await assert.rejects(
    () => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
      return true;
    }
  );
  assert.equal(driftWorkbench.state.clicks, 0, "stable-id fingerprint drift must fail before dispatch");

  const nonAnchorWorkbench = makeWorkbench();
  nonAnchorWorkbench.state.textSemanticKind = "stable-element-id";
  nonAnchorWorkbench.state.textStableIdBinding = {
    kind: "stable-element-id",
    depth: 0,
    tagName: "div",
    id: "sendPasswordButton",
    role: null,
    href: null,
    ariaDisabled: null,
  };
  const nonAnchorBrowser = new CodexBrowserExecutor({ workbench: nonAnchorWorkbench, defaultCwd: "C:\\workspace" });
  const nonAnchorTabs = await nonAnchorBrowser.listTabs({});
  await assert.rejects(
    () => nonAnchorBrowser.prepareClick({ tabRef: nonAnchorTabs.tabs[0].tabRef, text: "Clickable-looking div" }),
    (error) => {
      assert.equal(error.code, "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE");
      return true;
    }
  );
  assert.equal(nonAnchorWorkbench.state.clicks, 0);
});

test("Browser stable-id exact-text fallback is click-only and does not widen download or upload targeting", async () => {
  const downloadWorkbench = makeWorkbench();
  downloadWorkbench.state.textSemanticKind = "stable-element-id";
  const downloadBrowser = new CodexBrowserExecutor({ workbench: downloadWorkbench, defaultCwd: projectRoot });
  const downloadTabs = await downloadBrowser.listTabs({});
  await assert.rejects(
    () => downloadBrowser.prepareDownload({ tabRef: downloadTabs.tabs[0].tabRef, text: "Custom download-looking anchor", cwd: projectRoot }),
    (error) => {
      assert.equal(error.code, "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE");
      return true;
    }
  );
  const downloadPrepareCode = downloadWorkbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(downloadPrepareCode, /if \(__twSemanticCount === 0 && false\)/, "download must disable the click-only stable-id fallback");
  assert.equal(downloadWorkbench.state.downloads, 0);

  const uploadWorkbench = makeWorkbench();
  uploadWorkbench.state.textSemanticKind = "stable-element-id";
  const uploadBrowser = new CodexBrowserExecutor({
    workbench: uploadWorkbench,
    defaultCwd: projectRoot,
    authorityExecutor: makeAuthorityExecutor(),
  });
  const uploadTabs = await uploadBrowser.listTabs({});
  await assert.rejects(
    () => uploadBrowser.prepareUpload({
      tabRef: uploadTabs.tabs[0].tabRef,
      text: "Custom upload-looking anchor",
      filePath: "package.json",
      cwd: projectRoot,
    }),
    (error) => {
      assert.equal(error.code, "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE");
      return true;
    }
  );
  const uploadPrepareCode = uploadWorkbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(uploadPrepareCode, /if \(__twSemanticCount === 0 && false\)/, "upload must disable the click-only stable-id fallback");
  assert.equal(uploadWorkbench.state.uploads, 0);
});

test("Browser exact-text binds a generic onclick-property card ancestor and rejects binding drift", async () => {
  const workbench = makeWorkbench();
  workbench.state.textSemanticKind = "onclick-property";
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({
    tabRef: listed.tabs[0].tabRef,
    text: "Rhysen thread title",
  });
  assert.equal(prepared.status, "prepared");
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(prepareCode, /\.evaluate\(/);
  assert.match(prepareCode, /typeof current\.onclick === "function"/);
  assert.match(prepareCode, /locator\("\.\."\)/);
  assert.doesNotMatch(prepareCode, /locator\("\[onclick\]"\)/);
  assert.equal(workbench.state.clicks, 0);
  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);

  const driftWorkbench = makeWorkbench();
  driftWorkbench.state.textSemanticKind = "onclick-property";
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareClick({ tabRef: driftTabs.tabs[0].tabRef, text: "Rhysen thread title" });
  driftWorkbench.state.textBindingChanged = true;
  await assert.rejects(
    () => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
      return true;
    }
  );
  assert.equal(driftWorkbench.state.clicks, 0, "binding drift must fail before dispatch");
});

test("Browser exact-text binds a label-associated enabled form control and rejects binding drift", async () => {
  const workbench = makeWorkbench();
  workbench.state.textSemanticKind = "label-control";
  workbench.state.textClickBinding = {
    kind: "label-control",
    depth: 1,
    tagName: "label",
    forId: "flair-funny",
    controlTagName: "input",
    controlType: "radio",
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, text: "Funny" });
  assert.equal(prepared.status, "prepared");
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(prepareCode, /label-control/);
  assert.match(prepareCode, /current\.control/);
  assert.match(prepareCode, /document\.getElementById/);
  assert.match(prepareCode, /input,button,select,textarea/);
  assert.match(prepareCode, /!control\.disabled/);
  assert.match(prepareCode, /locator\("body \*"\)/);
  assert.equal(workbench.state.clicks, 0);
  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);

  const driftWorkbench = makeWorkbench();
  driftWorkbench.state.textSemanticKind = "label-control";
  driftWorkbench.state.textClickBinding = {
    kind: "label-control",
    depth: 1,
    tagName: "label",
    forId: "flair-funny",
    controlTagName: "input",
    controlType: "radio",
  };
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareClick({ tabRef: driftTabs.tabs[0].tabRef, text: "Funny" });
  driftWorkbench.state.textBindingChanged = true;
  await assert.rejects(
    () => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
      return true;
    }
  );
  assert.equal(driftWorkbench.state.clicks, 0, "label/control binding drift must fail before dispatch");
});

test("Browser exact-text binds one local enabled radio and dispatches check instead of a container click", async () => {
  const workbench = makeWorkbench();
  workbench.state.textSemanticKind = "local-radio";
  workbench.state.textClickBinding = {
    kind: "local-radio",
    depth: 2,
    id: "flair-funny",
    name: "flair",
    value: "funny-template",
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, text: "Funny" });
  assert.equal(prepared.status, "prepared");
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(prepareCode, /local-radio/);
  assert.match(prepareCode, /querySelectorAll\?\.\('input\[type="radio"\]'\)/);
  assert.match(prepareCode, /radios\.length === 1/);
  assert.equal(workbench.state.clicks, 0);

  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome click")?.arguments?.code ?? "";
  assert.match(executeCode, /input\[type="radio"\]:not\(:disabled\)/);
  assert.match(executeCode, /__twDispatchLocator\.check\(\{ timeoutMs: 5000 \}\)/);
  assert.match(executeCode, /__twDispatchLocator\.isChecked\(\)/);
  assert.doesNotMatch(executeCode, /__twDispatchLocator\.click\(\{ timeoutMs: 5000 \}\)/);

  const driftWorkbench = makeWorkbench();
  driftWorkbench.state.textSemanticKind = "local-radio";
  driftWorkbench.state.textClickBinding = {
    kind: "local-radio",
    depth: 2,
    id: "flair-funny",
    name: "flair",
    value: "funny-template",
  };
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareClick({ tabRef: driftTabs.tabs[0].tabRef, text: "Funny" });
  driftWorkbench.state.textBindingChanged = true;
  await assert.rejects(
    () => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
      return true;
    }
  );
  assert.equal(driftWorkbench.state.clicks, 0, "local radio binding drift must fail before dispatch");
});

test("Browser exact-text binds a server-read old-Reddit flair template option and verifies the hidden template id", async () => {
  const workbench = makeWorkbench();
  workbench.state.textSemanticKind = "flair-template-option";
  workbench.state.textClickBinding = {
    kind: "flair-template-option",
    depth: 3,
    selectorDepth: 3,
    templateId: "935162a0-7be9-11ed-913e-6a257d69e3b3",
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, text: "Funny" });
  assert.equal(prepared.status, "prepared");
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome click")?.arguments?.code ?? "";
  assert.match(prepareCode, /flair-template-option/);
  assert.match(prepareCode, /flairsample-right/);
  assert.match(prepareCode, /flairselector/);
  assert.match(prepareCode, /flair_template_id/);
  assert.doesNotMatch(prepareCode, /935162a0-7be9-11ed-913e-6a257d69e3b3/);
  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.state.clicks, 1);
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome click")?.arguments?.code ?? "";
  assert.match(executeCode, /flair_template_id/);
  assert.match(executeCode, /__twFlairHidden\.evaluateAll/);
  assert.match(executeCode, /typeof element\?\.value === "string"/);
  assert.match(executeCode, /935162a0-7be9-11ed-913e-6a257d69e3b3/);

  const driftWorkbench = makeWorkbench();
  driftWorkbench.state.textSemanticKind = "flair-template-option";
  driftWorkbench.state.textClickBinding = {
    kind: "flair-template-option",
    depth: 3,
    selectorDepth: 3,
    templateId: "935162a0-7be9-11ed-913e-6a257d69e3b3",
  };
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareClick({ tabRef: driftTabs.tabs[0].tabRef, text: "Funny" });
  driftWorkbench.state.textBindingChanged = true;
  await assert.rejects(
    () => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
      return true;
    }
  );
  assert.equal(driftWorkbench.state.clicks, 0, "flair template binding drift must fail before dispatch");
});

test("Browser Operate fails closed on ambiguous targets, page drift, and uncertain click results", async () => {
  const ambiguousWorkbench = makeWorkbench();
  ambiguousWorkbench.state.locatorCount = 2;
  const ambiguousBrowser = new CodexBrowserExecutor({ workbench: ambiguousWorkbench, defaultCwd: "C:\\workspace" });
  const ambiguousTabs = await ambiguousBrowser.listTabs({});
  await assert.rejects(
    () => ambiguousBrowser.prepareClick({ tabRef: ambiguousTabs.tabs[0].tabRef, role: "button", name: "Refresh" }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
      return true;
    }
  );

  const driftWorkbench = makeWorkbench();
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareClick({ tabRef: driftTabs.tabs[0].tabRef, role: "button", name: "Refresh" });
  driftWorkbench.state.pageChanged = true;
  await assert.rejects(
    () => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_PAGE_CHANGED");
      return true;
    }
  );
  await assert.rejects(() => driftBrowser.click({ actionApprovalRef: driftPrepared.actionApprovalRef }), /invalid, expired, or already consumed/);
  assert.equal(driftWorkbench.state.clicks, 0);

  const uncertainWorkbench = makeWorkbench();
  const uncertainBrowser = new CodexBrowserExecutor({ workbench: uncertainWorkbench, defaultCwd: "C:\\workspace" });
  const uncertainTabs = await uncertainBrowser.listTabs({});
  const uncertainPrepared = await uncertainBrowser.prepareClick({ tabRef: uncertainTabs.tabs[0].tabRef, role: "button", name: "Refresh" });
  uncertainWorkbench.state.clickUncertain = true;
  await assert.rejects(
    () => uncertainBrowser.click({ actionApprovalRef: uncertainPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_CLICK_RESULT_UNCERTAIN");
      assert.match(error.nextActions.join(" "), /Do not retry/i);
      return true;
    }
  );
  await assert.rejects(() => uncertainBrowser.click({ actionApprovalRef: uncertainPrepared.actionApprovalRef }), /invalid, expired, or already consumed/);
});

test("Browser click post-dispatch readback/finalize failures remain uncertain and non-retryable", async () => {
  for (const failure of ["clickPostDispatchFailure", "clickFinalizeFailure"]) {
    const workbench = makeWorkbench();
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh" });
    workbench.state[failure] = true;
    await assert.rejects(
      () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_CLICK_RESULT_UNCERTAIN");
        assert.match(error.nextActions.join(" "), /Do not retry/i);
        return true;
      }
    );
    assert.equal(workbench.state.clicks, 1, `${failure} happens after the click was already dispatched`);
    await assert.rejects(() => browser.click({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, or already consumed/);
  }
});

test("Browser click transport loss or empty response after dispatch remains uncertain", async () => {
  for (const failure of ["clickTransportThrow", "clickEmptyResponse"]) {
    const workbench = makeWorkbench();
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh" });
    workbench.state[failure] = true;
    await assert.rejects(
      () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_CLICK_RESULT_UNCERTAIN");
        assert.match(error.nextActions.join(" "), /Do not retry/i);
        return true;
      }
    );
    assert.equal(workbench.state.clicks, 1, `${failure} happens after remote click dispatch`);
    await assert.rejects(() => browser.click({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, or already consumed/);
  }
});

test("Browser generic MCP isError after a mutation becomes uncertain and cannot replay", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh" });
  workbench.state.clickGenericIsErrorAfterDispatch = true;
  await assert.rejects(
    () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_CLICK_RESULT_UNCERTAIN");
      assert.match(error.message, /error response after dispatch may have occurred/i);
      assert.match((error.nextActions ?? []).join(" "), /Do not retry/i);
      return true;
    }
  );
  assert.equal(workbench.state.clicks, 1, "the generic isError arrives only after one remote mutation dispatch");
  await assert.rejects(() => browser.click({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, or already consumed/);
  assert.equal(workbench.state.clicks, 1, "the consumed action ref must not replay after generic post-dispatch isError");
});

test("Browser Operate prepare/fill is exact, one-shot, verified, and does not submit", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareFill({
    tabRef: listed.tabs[0].tabRef,
    role: "textbox",
    name: "Search",
    text: "needle text",
  });
  assert.equal(prepared.status, "prepared");
  assert.match(prepared.actionApprovalRef, /^browser_action_/);
  assert.equal(prepared.action.kind, "fill");
  assert.equal(prepared.action.role, "textbox");
  assert.equal(prepared.action.name, "Search");
  assert.equal(prepared.action.text, "needle text");
  assert.equal(prepared.action.currentValue, "");
  assert.equal(workbench.state.fills, 0, "prepare fill must remain page-read-only");
  const prepareFillCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome fill")?.arguments?.code ?? "";
  assert.doesNotMatch(prepareFillCode, /inputValue\s*\(/, "Chrome locator API does not expose inputValue(); fixed internal evaluate getter must be used");
  assert.match(prepareFillCode, /if \(typeof element\?\.value === "string"\) return element\.value/);
  assert.match(prepareFillCode, /isContentEditable/);

  const filled = await browser.fill({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(filled.status, "filled");
  assert.equal(workbench.state.fills, 1);
  assert.equal(workbench.state.clicks, 0, "fill must not secretly submit through click");
  assert.equal(filled.beforeValue, "");
  assert.equal(filled.afterValue, "needle text");
  assert.equal(filled.verificationSource, "fresh-target");
  assert.equal(filled.dispatchAttempts, 1);
  assert.equal(filled.repairAttempted, false);
  assert.equal(filled.repairReason, null);
  assert.equal(filled.beforeUrl, "https://mail.example.test/inbox");
  assert.equal(filled.afterUrl, "https://mail.example.test/inbox");
  assert.equal(filled.postSnapshot, "FIELD=needle text");
  assert.match(filled.note, /did not click, press Enter, navigate, or submit/i);

  await assert.rejects(
    () => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
});

test("Browser fill normalizes a direct textarea and a semantic wrapper with one visible editable descendant", async () => {
  {
    const workbench = makeWorkbench();
    workbench.state.fillTargetMeta = {
      tag: "textarea",
      contentEditable: false,
      customHost: null,
      editableSource: "direct",
      editableKind: "textarea",
      semanticTag: "textarea",
      semanticContentEditable: false,
    };
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareFill({
      tabRef: listed.tabs[0].tabRef,
      role: "textbox",
      name: "Instructions",
      text: "textarea exact",
    });
    const filled = await browser.fill({ actionApprovalRef: prepared.actionApprovalRef });
    assert.equal(filled.status, "filled");
    assert.equal(filled.afterValue, "textarea exact");
    assert.equal(workbench.state.fills, 1);
  }

  {
    const workbench = makeWorkbench();
    workbench.state.fillStrategy = "type";
    workbench.state.fillTargetMeta = {
      tag: "div",
      contentEditable: true,
      customHost: null,
      editableSource: "unique-visible-descendant",
      editableKind: "contenteditable",
      semanticTag: "div",
      semanticContentEditable: false,
    };
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareFill({
      tabRef: listed.tabs[0].tabRef,
      role: "textbox",
      name: "Instructions",
      text: "nested editor exact",
    });
    const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome fill")?.arguments?.code ?? "";
    assert.match(prepareCode, /__twBoundSemanticLocator\.locator\('input, textarea, \[contenteditable\]'\)/);
    assert.match(prepareCode, /__twVisibleEditableCandidates\.length > 1/);
    assert.doesNotMatch(prepareCode, /\.nth\(__twVisibleEditableCandidates/, "the editable descendant must be selected only after proving there is exactly one, not by caller-visible index");
    const filled = await browser.fill({ actionApprovalRef: prepared.actionApprovalRef });
    assert.equal(filled.status, "filled");
    assert.equal(filled.afterValue, "nested editor exact");
    assert.equal(workbench.state.fills, 1);
  }
});

test("Browser empty fill clears a populated rich editor and prepare reports rendered current value", async () => {
  const workbench = makeWorkbench();
  const existingText = "TOOLWIRE_NIGHT_DOGFOOD_0100_20260818 — rich editor exact readback test";
  workbench.state.fieldValue = "";
  workbench.state.fieldRenderedText = existingText;
  workbench.state.fillStrategy = "type";
  workbench.state.fillTargetMeta = {
    tag: "div",
    contentEditable: true,
    customHost: null,
    editableSource: "direct",
    editableKind: "contenteditable",
    semanticTag: "div",
    semanticContentEditable: true,
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});

  const beforeRead = await browser.readTab({ tabRef: listed.tabs[0].tabRef, maxChars: 1000 });
  assert.equal(beforeRead.snapshot, `FIELD_RENDERED=${existingText}`);

  const prepared = await browser.prepareFill({
    tabRef: listed.tabs[0].tabRef,
    role: "textbox",
    name: "Search",
    text: "",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.currentValue, existingText, "prepare must report the same populated rendered text that an independent DOM read can observe");
  assert.equal(prepared.action.fillStrategy, "type");
  assert.equal(workbench.state.fills, 0, "prepare empty fill must remain read-only");
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome fill")?.arguments?.code ?? "";
  assert.match(prepareCode, /__twLocator\.innerText\(\{ timeoutMs: 1000 \}\)/);
  assert.match(prepareCode, /__twLocator\.textContent\(\{ timeoutMs: 1000 \}\)/);

  const cleared = await browser.fill({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(cleared.status, "filled");
  assert.equal(cleared.beforeValue, existingText);
  assert.equal(cleared.afterValue, "");
  assert.equal(cleared.dispatchAttempts, 1);
  assert.equal(cleared.repairAttempted, false, "clear must not enter the replacement-editor replay repair path");
  assert.equal(cleared.reclaimAttempted, false);
  assert.equal(workbench.state.fills, 1);
  assert.equal(workbench.state.fieldRenderedText, "", "empty fill must actually clear the rendered rich-editor text");
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome fill")?.arguments?.code ?? "";
  assert.match(executeCode, /const __twClearRequested = true/);
  assert.match(executeCode, /if \(__twClearRequested\) \{[\s\S]*?__twLocator\.fill\("", \{\}\)/);

  const afterRead = await browser.readTab({ tabRef: listed.tabs[0].tabRef, maxChars: 1000 });
  assert.equal(afterRead.snapshot, "FIELD_RENDERED=");
  assert.doesNotMatch(afterRead.snapshot, /TOOLWIRE_NIGHT_DOGFOOD_0100_20260818/);
});

test("Browser scoped fill binds one unnamed local textbox to one exact visible link URL", async () => {
  const workbench = makeWorkbench();
  workbench.state.locatorCount = 4;
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const scopeUrl = "https://www.reddit.com/r/codex/comments/example/comment/p41kwir/";
  const prepared = await browser.prepareFill({
    tabRef: listed.tabs[0].tabRef,
    role: "textbox",
    scopeUrl,
    text: "SCOPED_REPLY",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.targetKind, "scope-role");
  assert.equal(prepared.action.role, "textbox");
  assert.equal(prepared.action.scopeUrl, scopeUrl);
  assert.equal(Object.hasOwn(prepared.action, "name"), false);
  assert.equal(Object.hasOwn(prepared.action, "placeholder"), false);
  assert.equal(workbench.state.fills, 0);
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome fill")?.arguments?.code ?? "";
  assert.match(prepareCode, /const __twScopeLinks/);
  assert.match(prepareCode, /getByRole\("link"\)\.filter\(\{ visible: true \}\)/);
  assert.match(prepareCode, /__twScopeLinks\.evaluateAll/);
  assert.match(prepareCode, /__twDepth <= 8/);
  assert.match(prepareCode, /getByRole\("textbox"\)\.filter\(\{ visible: true \}\)/);
  assert.match(prepareCode, /https:\/\/www\.reddit\.com\/r\/codex\/comments\/example\/comment\/p41kwir\//);
  assert.doesNotMatch(prepareCode, /editor-1|nth\(3\)|querySelector\(/);

  const filled = await browser.fill({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(filled.status, "filled");
  assert.equal(filled.action.targetKind, "scope-role");
  assert.equal(filled.action.scopeUrl, scopeUrl);
  assert.equal(filled.afterValue, "SCOPED_REPLY");
  assert.equal(workbench.state.fills, 1);
  assert.equal(workbench.state.clicks, 0);
  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome fill")?.arguments?.code ?? "";
  assert.match(executeCode, /const __twScopeLinks/);
  assert.match(executeCode, /TOOLWIRE_BROWSER_SCOPE_LINK_COUNT/);
  assert.match(executeCode, /TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT/);
  assert.doesNotMatch(executeCode, /same-role-visible-target|local-editor-exact/);

  await assert.rejects(
    () => browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", scopeUrl: "javascript:alert(1)", text: "x" }),
    (error) => {
      assert.equal(error.code, "BROWSER_NAVIGATE_SCHEME_UNSUPPORTED");
      return true;
    }
  );
  await assert.rejects(
    () => browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", name: "Reply", scopeUrl, text: "x" }),
    (error) => {
      assert.equal(error.code, "BROWSER_FILL_TARGET_CONFLICT");
      return true;
    }
  );
});

test("Browser scoped fill fails closed when the scope link or local editor is ambiguous", async () => {
  {
    const workbench = makeWorkbench();
    workbench.state.scopeLinkCount = 2;
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    await assert.rejects(
      () => browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", scopeUrl: "https://example.test/comment/1", text: "x" }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_SCOPE_AMBIGUOUS");
        return true;
      }
    );
    assert.equal(workbench.state.fills, 0);
  }
  {
    const workbench = makeWorkbench();
    workbench.state.scopedTargetCount = 2;
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    await assert.rejects(
      () => browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", scopeUrl: "https://example.test/comment/1", text: "x" }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
        return true;
      }
    );
    assert.equal(workbench.state.fills, 0);
  }
  {
    const workbench = makeWorkbench();
    workbench.state.scopedTargetCount = 0;
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    await assert.rejects(
      () => browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", scopeUrl: "https://example.test/comment/1", text: "x" }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_TARGET_NOT_FOUND_IN_SCOPE");
        return true;
      }
    );
    assert.equal(workbench.state.fills, 0);
  }
});

test("Browser fill placeholder fallback stays exact, unique, and role-bounded", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareFill({
    tabRef: listed.tabs[0].tabRef,
    role: "textbox",
    placeholder: "Search Reddit",
    text: "browser hand",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.targetKind, "placeholder");
  assert.equal(prepared.action.role, "textbox");
  assert.equal(prepared.action.placeholder, "Search Reddit");
  assert.equal(Object.hasOwn(prepared.action, "name"), false);
  assert.equal(workbench.state.fills, 0);
  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome fill")?.arguments?.code ?? "";
  assert.doesNotMatch(prepareCode, /getByPlaceholder/, "placeholder binding must not depend on the narrower upstream placeholder selector path");
  assert.match(prepareCode, /getByRole\("textbox"\)\.filter\(\{ visible: true \}\)/);
  assert.match(prepareCode, /__twPlaceholderRoleCandidates/);
  assert.match(prepareCode, /__twPlaceholderSemanticMatches/);
  assert.match(prepareCode, /directPlaceholder === expectedPlaceholder/);
  assert.match(prepareCode, /descendant\.getAttribute\("placeholder"\) === expectedPlaceholder/);
  assert.match(prepareCode, /descendant\.getAttribute\("aria-placeholder"\) === expectedPlaceholder/);
  assert.match(prepareCode, /directAriaPlaceholder === expectedPlaceholder/);
  assert.match(prepareCode, /TOOLWIRE_BROWSER_FILL_PLACEHOLDER_DESCENDANT_COUNT/);
  assert.match(prepareCode, /__twPlaceholderSemanticMatches\.length !== 1/);
  assert.match(prepareCode, /__twResolveBoundEditableLocator/);
  assert.match(prepareCode, /locator\('input, textarea, \[contenteditable\]'\)/);
  assert.doesNotMatch(prepareCode, /nativeIndexes|focusDistances/, "placeholder binding must not pick a candidate by native index or focus proximity");
  assert.doesNotMatch(prepareCode, /inputValue\s*\(/);
  assert.match(prepareCode, /if \(typeof element\?\.value === "string"\) return element\.value/);
  assert.match(prepareCode, /isContentEditable/);

  const filled = await browser.fill({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(filled.status, "filled");
  assert.equal(filled.action.targetKind, "placeholder");
  assert.equal(filled.action.placeholder, "Search Reddit");
  assert.equal(filled.afterValue, "browser hand");
  assert.equal(workbench.state.fills, 1);

  await assert.rejects(
    () => browser.prepareFill({
      tabRef: listed.tabs[0].tabRef,
      role: "textbox",
      name: "Search",
      placeholder: "Search Reddit",
      text: "x",
    }),
    (error) => {
      assert.equal(error.code, "BROWSER_FILL_TARGET_CONFLICT");
      return true;
    }
  );
  await assert.rejects(
    () => browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", text: "x" }),
    (error) => {
      assert.equal(error.code, "BROWSER_FILL_TARGET_REQUIRED");
      return true;
    }
  );
});

test("Browser fill rejects a unique placeholder when it does not satisfy the caller-requested textbox/searchbox role", async () => {
  const workbench = makeWorkbench();
  workbench.state.fillRoleBoundCount = 0;
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  await assert.rejects(
    () => browser.prepareFill({
      tabRef: listed.tabs[0].tabRef,
      role: "searchbox",
      placeholder: "Search Reddit",
      text: "x",
    }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
      assert.match(error.message, /matched 0 elements/i);
      return true;
    }
  );
  assert.equal(workbench.state.fills, 0, "role-mismatched placeholder must fail during read-only prepare");
});

test("Browser fill supports a unique visible enabled native password input only through textbox exact-placeholder binding", async () => {
  const workbench = makeWorkbench();
  workbench.state.fillRoleBoundCount = 0;
  workbench.state.fillNativePasswordCount = 1;
  workbench.state.fillTargetMeta = {
    tag: "input",
    inputType: "password",
    placeholder: "パスワード",
    contentEditable: false,
    customHost: null,
    editableSource: "direct",
    editableKind: "input",
    semanticTag: "input",
    semanticContentEditable: false,
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareFill({
    tabRef: listed.tabs[0].tabRef,
    role: "textbox",
    placeholder: "パスワード",
    text: "fixture-only-password",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.targetKind, "placeholder");
  assert.equal(prepared.action.role, "textbox");
  assert.equal(prepared.action.placeholder, "パスワード");
  assert.deepEqual(prepared.action.targetBinding, { tag: "input", type: "password", placeholder: "パスワード" });
  assert.equal(prepared.action.textLength, "fixture-only-password".length);
  assert.equal(Object.hasOwn(prepared.action, "text"), false);
  assert.equal(Object.hasOwn(prepared.action, "currentValue"), false);
  assert.equal(Object.hasOwn(prepared.action, "targetStructure"), false);
  assert.equal(workbench.state.fills, 0);

  const prepareCode = workbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome fill")?.arguments?.code ?? "";
  assert.match(prepareCode, /__twNativePasswordCandidates/);
  assert.match(prepareCode, /__twCandidate\.isVisible\(\)/);
  assert.match(prepareCode, /__twCandidate\.isEnabled\(\)/);
  assert.match(prepareCode, /__twNativePasswordTarget/);
  assert.match(prepareCode, /if \(!__twNativePasswordTarget\)/, "prepare must not read the native password value");

  const filled = await browser.fill({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(filled.status, "filled");
  assert.equal(filled.action.textLength, "fixture-only-password".length);
  assert.deepEqual(filled.action.targetBinding, { tag: "input", type: "password", placeholder: "パスワード" });
  assert.equal(filled.verificationSource, "fresh-native-password-binding");
  assert.equal(filled.dispatchAttempts, 1);
  assert.equal(filled.repairAttempted, false);
  assert.equal(Object.hasOwn(filled, "beforeValue"), false);
  assert.equal(Object.hasOwn(filled, "afterValue"), false);
  assert.equal(Object.hasOwn(filled, "postSnapshot"), false);
  assert.equal(workbench.state.fills, 1, "native password fill must dispatch exactly once");
  assert.equal(workbench.calls.some((call) => call.arguments?.title === "Repair activated Chrome fill"), false);

  const executeCode = workbench.calls.find((call) => call.arguments?.title === "Execute prepared Chrome fill")?.arguments?.code ?? "";
  assert.match(executeCode, /const __twNativePasswordFill = true;/);
  assert.match(executeCode, /__twAssertNativePasswordBinding/);
  assert.match(executeCode, /if \(!__twNativePasswordFill\)/, "execute must not read the native password value");
  assert.match(executeCode, /__twNativePasswordFill \? null : await sanitizeBrowserDomSnapshot\(__twTab\)/);

  const roleNameWorkbench = makeWorkbench();
  roleNameWorkbench.state.locatorCount = 0;
  const roleNameBrowser = new CodexBrowserExecutor({ workbench: roleNameWorkbench, defaultCwd: "C:\\workspace" });
  const roleNameTabs = await roleNameBrowser.listTabs({});
  await assert.rejects(
    () => roleNameBrowser.prepareFill({
      tabRef: roleNameTabs.tabs[0].tabRef,
      role: "textbox",
      name: "パスワード",
      text: "fixture-only-password",
    }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
      return true;
    }
  );
  const roleNameCode = roleNameWorkbench.calls.find((call) => call.arguments?.title === "Prepare exact Chrome fill")?.arguments?.code ?? "";
  assert.doesNotMatch(roleNameCode, /__twNativePasswordCandidates/, "role+name must not gain the password placeholder fallback");
});

test("Browser password exact-placeholder fill fails closed on ambiguity and hidden or disabled candidates", async () => {
  for (const fixture of [
    { label: "ambiguous", count: 2, visible: true, enabled: true },
    { label: "hidden", count: 1, visible: false, enabled: true },
    { label: "disabled", count: 1, visible: true, enabled: false },
  ]) {
    const workbench = makeWorkbench();
    workbench.state.fillRoleBoundCount = 0;
    workbench.state.fillNativePasswordCount = fixture.count;
    workbench.state.fillNativePasswordVisible = fixture.visible;
    workbench.state.fillNativePasswordEnabled = fixture.enabled;
    workbench.state.fillTargetMeta = {
      ...workbench.state.fillTargetMeta,
      inputType: "password",
      placeholder: "パスワード",
    };
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    await assert.rejects(
      () => browser.prepareFill({
        tabRef: listed.tabs[0].tabRef,
        role: "textbox",
        placeholder: "パスワード",
        text: "fixture-only-password",
      }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS", fixture.label);
        return true;
      }
    );
    assert.equal(workbench.state.fills, 0, `${fixture.label} password candidate must fail during prepare`);
  }
});

test("Browser password exact-placeholder fill fails closed on placeholder or type drift before execute", async () => {
  const preparePassword = async () => {
    const workbench = makeWorkbench();
    workbench.state.fillRoleBoundCount = 0;
    workbench.state.fillNativePasswordCount = 1;
    workbench.state.fillTargetMeta = {
      ...workbench.state.fillTargetMeta,
      inputType: "password",
      placeholder: "パスワード",
    };
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareFill({
      tabRef: listed.tabs[0].tabRef,
      role: "textbox",
      placeholder: "パスワード",
      text: "fixture-only-password",
    });
    return { workbench, browser, prepared };
  };

  {
    const { workbench, browser, prepared } = await preparePassword();
    workbench.state.fillNativePasswordCount = 0;
    workbench.state.fillTargetMeta.placeholder = "変更済み";
    await assert.rejects(
      () => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
        return true;
      }
    );
    assert.equal(workbench.state.fills, 0);
  }

  {
    const { workbench, browser, prepared } = await preparePassword();
    workbench.state.fillRoleBoundCount = 1;
    workbench.state.fillNativePasswordCount = 0;
    workbench.state.fillTargetMeta.inputType = "text";
    await assert.rejects(
      () => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
        return true;
      }
    );
    assert.equal(workbench.state.fills, 0);
  }
});

test("Browser fill re-resolves a replaced rich editor and performs one guarded repair only when the fresh target is proven empty", async () => {
  const workbench = makeWorkbench();
  workbench.state.fillActivationRepair = true;
  workbench.state.fillTargetMeta = {
    tag: "div",
    contentEditable: false,
    customHost: null,
    editableSource: "semantic-shell",
    editableKind: "semantic-shell",
    semanticTag: "div",
    semanticContentEditable: false,
  };
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const prepared = await browser.prepareFill({
    tabRef: listed.tabs[0].tabRef,
    role: "textbox",
    placeholder: "Join the conversation",
    text: "reddit bounded repair",
  });
  const filled = await browser.fill({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(filled.status, "filled");
  assert.equal(filled.afterValue, "reddit bounded repair");
  assert.equal(filled.dispatchAttempts, 2);
  assert.equal(filled.settleRecheck, true);
  assert.equal(filled.repairSettleMs, 750);
  assert.equal(filled.reclaimAttempted, true);
  assert.equal(filled.reclaimStatus, "fresh-execution");
  assert.equal(filled.repairAttempted, true);
  assert.equal(filled.repairReason, "fresh-target-empty-after-first-execution");
  assert.match(filled.verificationSource, /^empty-target-repair:/);
  assert.equal(workbench.state.fills, 2, "one bounded repair is allowed only after proving the re-resolved target stayed empty");
  const repairCode = workbench.calls.find((call) => call.arguments?.title === "Repair activated Chrome fill")?.arguments?.code ?? "";
  assert.match(repairCode, /__twResolveBoundEditableLocator/);
  assert.doesNotMatch(repairCode, /TOOLWIRE_BROWSER_FILL_TARGET_CHANGED/, "post-activation replacement may change the concrete editable shape once the original semantic binding is freshly re-proved");
});

test("Browser fill separates deterministic no-write and verification-unavailable outcomes from true mutation uncertainty", async () => {
  {
    const workbench = makeWorkbench();
    workbench.state.fillNotApplied = true;
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", name: "Search", text: "not applied" });
    await assert.rejects(
      () => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_FILL_NOT_APPLIED");
        assert.match(error.nextActions.join(" "), /fresh fill can be prepared safely/i);
        return true;
      }
    );
    assert.equal(workbench.state.fieldValue, "");
  }
  {
    const workbench = makeWorkbench();
    workbench.state.fillVerificationUnavailable = true;
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", name: "Search", text: "visible but unresolved" });
    await assert.rejects(
      () => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_FILL_VERIFICATION_UNAVAILABLE");
        assert.match(error.nextActions.join(" "), /Do not retry automatically/i);
        return true;
      }
    );
    assert.equal(workbench.state.fieldValue, "visible but unresolved");
  }
});

test("Browser fill fails closed on unsupported roles, page drift, ambiguous targets, and uncertain dispatch", async () => {
  const roleWorkbench = makeWorkbench();
  const roleBrowser = new CodexBrowserExecutor({ workbench: roleWorkbench, defaultCwd: "C:\\workspace" });
  const roleTabs = await roleBrowser.listTabs({});
  await assert.rejects(
    () => roleBrowser.prepareFill({ tabRef: roleTabs.tabs[0].tabRef, role: "button", name: "Search", text: "x" }),
    (error) => {
      assert.equal(error.code, "BROWSER_FILL_ROLE_UNSUPPORTED");
      return true;
    }
  );

  const ambiguousWorkbench = makeWorkbench();
  ambiguousWorkbench.state.locatorCount = 2;
  const ambiguousBrowser = new CodexBrowserExecutor({ workbench: ambiguousWorkbench, defaultCwd: "C:\\workspace" });
  const ambiguousTabs = await ambiguousBrowser.listTabs({});
  await assert.rejects(
    () => ambiguousBrowser.prepareFill({ tabRef: ambiguousTabs.tabs[0].tabRef, role: "textbox", name: "Search", text: "x" }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
      return true;
    }
  );
  assert.equal(ambiguousWorkbench.state.fills, 0);

  const editableAmbiguousWorkbench = makeWorkbench();
  editableAmbiguousWorkbench.state.fillEditableErrorCount = 2;
  const editableAmbiguousBrowser = new CodexBrowserExecutor({ workbench: editableAmbiguousWorkbench, defaultCwd: "C:\\workspace" });
  const editableAmbiguousTabs = await editableAmbiguousBrowser.listTabs({});
  await assert.rejects(
    () => editableAmbiguousBrowser.prepareFill({ tabRef: editableAmbiguousTabs.tabs[0].tabRef, role: "textbox", name: "Instructions", text: "x" }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_AMBIGUOUS");
      assert.match(error.message, /2 visible supported editable descendants/i);
      return true;
    }
  );
  assert.equal(editableAmbiguousWorkbench.state.fills, 0, "multiple descendants must fail during read-only prepare");

  const driftWorkbench = makeWorkbench();
  const driftBrowser = new CodexBrowserExecutor({ workbench: driftWorkbench, defaultCwd: "C:\\workspace" });
  const driftTabs = await driftBrowser.listTabs({});
  const driftPrepared = await driftBrowser.prepareFill({ tabRef: driftTabs.tabs[0].tabRef, role: "textbox", name: "Search", text: "x" });
  driftWorkbench.state.pageChanged = true;
  await assert.rejects(
    () => driftBrowser.fill({ actionApprovalRef: driftPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_PAGE_CHANGED");
      return true;
    }
  );
  assert.equal(driftWorkbench.state.fills, 0);

  const targetChangedWorkbench = makeWorkbench();
  const targetChangedBrowser = new CodexBrowserExecutor({ workbench: targetChangedWorkbench, defaultCwd: "C:\\workspace" });
  const targetChangedTabs = await targetChangedBrowser.listTabs({});
  const targetChangedPrepared = await targetChangedBrowser.prepareFill({
    tabRef: targetChangedTabs.tabs[0].tabRef,
    role: "textbox",
    name: "Instructions",
    text: "x",
  });
  targetChangedWorkbench.state.fillTargetChanged = true;
  await assert.rejects(
    () => targetChangedBrowser.fill({ actionApprovalRef: targetChangedPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_TARGET_CHANGED");
      assert.match(error.message, /editable resolution changed before dispatch/i);
      return true;
    }
  );
  assert.equal(targetChangedWorkbench.state.fills, 0, "prepared editable-shape drift must fail before any fill dispatch");

  const uncertainWorkbench = makeWorkbench();
  const uncertainBrowser = new CodexBrowserExecutor({ workbench: uncertainWorkbench, defaultCwd: "C:\\workspace" });
  const uncertainTabs = await uncertainBrowser.listTabs({});
  const uncertainPrepared = await uncertainBrowser.prepareFill({ tabRef: uncertainTabs.tabs[0].tabRef, role: "searchbox", name: "Search", text: "x" });
  uncertainWorkbench.state.fillUncertain = true;
  await assert.rejects(
    () => uncertainBrowser.fill({ actionApprovalRef: uncertainPrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_FILL_RESULT_UNCERTAIN");
      assert.match(error.nextActions.join(" "), /Do not retry/i);
      return true;
    }
  );
  await assert.rejects(() => uncertainBrowser.fill({ actionApprovalRef: uncertainPrepared.actionApprovalRef }), /invalid, expired, already consumed/i);
});

test("Browser fill post-dispatch readback/finalize failures remain uncertain and non-retryable", async () => {
  for (const failure of ["fillPostDispatchFailure", "fillFinalizeFailure"]) {
    const workbench = makeWorkbench();
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", name: "Search", text: "already changed" });
    workbench.state[failure] = true;
    await assert.rejects(
      () => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_FILL_RESULT_UNCERTAIN");
        assert.match(error.nextActions.join(" "), /Do not retry/i);
        return true;
      }
    );
    assert.equal(workbench.state.fills, 1, `${failure} happens after the field was already changed`);
    assert.equal(workbench.state.fieldValue, "already changed");
    await assert.rejects(() => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, already consumed/i);
  }
});

test("Browser fill transport loss or unreadable response after dispatch remains uncertain", async () => {
  for (const failure of ["fillTransportThrow", "fillNonJsonResponse"]) {
    const workbench = makeWorkbench();
    const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
    const listed = await browser.listTabs({});
    const prepared = await browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", name: "Search", text: "transport-bound" });
    workbench.state[failure] = true;
    await assert.rejects(
      () => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }),
      (error) => {
        assert.equal(error.code, "BROWSER_FILL_RESULT_UNCERTAIN");
        assert.match(error.nextActions.join(" "), /Do not retry/i);
        return true;
      }
    );
    assert.equal(workbench.state.fills, 1, `${failure} happens after remote field mutation`);
    assert.equal(workbench.state.fieldValue, "transport-bound");
    await assert.rejects(() => browser.fill({ actionApprovalRef: prepared.actionApprovalRef }), /invalid, expired, already consumed/i);
  }
});

test("Browser action refs cannot cross click/fill action kinds", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });
  const listed = await browser.listTabs({});
  const clickPrepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Refresh" });
  const fillPrepared = await browser.prepareFill({ tabRef: listed.tabs[0].tabRef, role: "textbox", name: "Search", text: "x" });

  await assert.rejects(() => browser.fill({ actionApprovalRef: clickPrepared.actionApprovalRef }), /prepared fill/i);
  await assert.rejects(() => browser.click({ actionApprovalRef: fillPrepared.actionApprovalRef }), /invalid, expired|prepared click/i);
  assert.equal(workbench.state.clicks, 0);
  assert.equal(workbench.state.fills, 0);

  const clicked = await browser.click({ actionApprovalRef: clickPrepared.actionApprovalRef });
  const filled = await browser.fill({ actionApprovalRef: fillPrepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(filled.status, "filled");
});

test("Browser caller cwd remains discovery context while node_repl uses the dedicated runtime cwd", async () => {
  const callerCwd = "G:/マイドライブ/Codex/DevSpace/ChatGPT使用说明";
  const runtimeCwd = "C:/Users/Yana";
  const browserClientPath = "C:/Users/Test/.codex/plugins/cache/openai-bundled/chrome/99.1/scripts/browser-client.mjs";
  const compatibility = {
    status: "ok",
    build: "99.1",
    chromeSkillPath: fakeSkillPath,
    browserRuntimeCwd: runtimeCwd,
    browserClientPath,
    browserClientSha256: "a".repeat(64),
    browserServicePath: "C:/Users/Test/.codex/plugins/cache/openai-bundled/browser/99.1/scripts/browser-service.mjs",
  };
  const workbench = makeWorkbench({ skillPath: fakeSkillPath });
  workbench.state.expectedBrowserClientUrl = pathToFileURL(browserClientPath).href;
  const catalogCalls = [];
  const catalog = workbench.catalog.bind(workbench);
  workbench.catalog = async (input) => {
    catalogCalls.push(input);
    return catalog(input);
  };
  const browser = new CodexBrowserExecutor({
    workbench,
    defaultCwd: "C:/workspace",
    runtimeCompatibility: compatibility,
    runtimeCompatibilityResolver: async () => compatibility,
  });

  const status = await browser.status({ cwd: callerCwd });
  assert.equal(status.status, "ok");
  assert.ok(
    catalogCalls.some((call) => call.kind === "skills" && path.resolve(call.cwd) === path.resolve(callerCwd)),
    "caller cwd must still select the Codex Skill/project context"
  );
  assert.ok(
    catalogCalls.some((call) => call.kind === "mcp" && path.resolve(call.cwd) === path.resolve(runtimeCwd)),
    "node_repl catalog discovery must use the dedicated Browser runtime cwd"
  );
  assert.ok(
    catalogCalls.every((call) => call.kind !== "mcp" || path.resolve(call.cwd) !== path.resolve(callerCwd)),
    "node_repl catalog discovery must never inherit an arbitrary caller drive cwd"
  );
  assert.ok(workbench.calls.length > 0);
  assert.ok(
    workbench.calls.every((call) => path.resolve(call.cwd) === path.resolve(runtimeCwd)),
    "node_repl must stay on the dedicated Browser runtime cwd instead of inheriting an arbitrary caller drive cwd"
  );
  assert.ok(workbench.calls.every((call) => path.resolve(call.cwd) !== path.resolve(callerCwd)));
});

test("Browser runtime compatibility binding uses the canonical client and rejects cache upgrade drift until main runtime restart", async () => {
  const fixtureRoot = path.join(projectRoot, ".fixture-browser-cache");
  const buildA = "99.1-A";
  const buildB = "99.1-B";
  const chromeRootA = path.join(fixtureRoot, "chrome", buildA);
  const chromeRootB = path.join(fixtureRoot, "chrome", buildB);
  const browserRootA = path.join(fixtureRoot, "browser", buildA);
  const browserRootB = path.join(fixtureRoot, "browser", buildB);
  const deepSkillA = path.join(chromeRootA, "skills", "control-chrome", "nested-layout", "SKILL.md");
  const deepSkillB = path.join(chromeRootB, "skills", "control-chrome", "nested-layout", "SKILL.md");
  const clientA = path.join(chromeRootA, "scripts", "browser-client.mjs");
  const clientB = path.join(chromeRootB, "scripts", "browser-client.mjs");
  const compatibilityA = {
    status: "ok",
    build: buildA,
    chromeSkillPath: deepSkillA,
    browserClientPath: clientA,
    browserClientSha256: "a".repeat(64),
    browserServicePath: path.join(browserRootA, "scripts", "browser-service.mjs"),
  };
  const compatibilityB = {
    status: "ok",
    build: buildB,
    chromeSkillPath: deepSkillB,
    browserClientPath: clientB,
    browserClientSha256: "b".repeat(64),
    browserServicePath: path.join(browserRootB, "scripts", "browser-service.mjs"),
  };
  const workbench = makeWorkbench({ skillPath: deepSkillA });
  workbench.state.expectedBrowserClientUrl = pathToFileURL(clientA).href;
  const bySkill = new Map([
    [path.resolve(deepSkillA), compatibilityA],
    [path.resolve(deepSkillB), compatibilityB],
  ]);
  const browser = new CodexBrowserExecutor({
    workbench,
    defaultCwd: "C:\\workspace",
    runtimeCompatibility: compatibilityA,
    runtimeCompatibilityResolver: async ({ chromeSkillPath }) => bySkill.get(path.resolve(chromeSkillPath)) ?? { status: "unavailable" },
  });

  const first = await browser.listTabs({});
  assert.equal(first.count, 1);
  const legacyDerivedClient = pathToFileURL(path.join(path.resolve(path.dirname(deepSkillA), "..", ".."), "scripts", "browser-client.mjs")).href;
  assert.notEqual(legacyDerivedClient, workbench.state.expectedBrowserClientUrl);
  assert.ok(workbench.calls.length > 0);
  for (const call of workbench.calls) {
    const code = call.arguments?.code ?? "";
    assert.ok(code.includes(JSON.stringify(workbench.state.expectedBrowserClientUrl)));
    assert.equal(code.includes(JSON.stringify(legacyDerivedClient)), false, "nested Skill layout must never drive a relative browser-client import when a canonical binding exists");
  }

  const callsBeforeUpgrade = workbench.calls.length;
  workbench.state.bumpGenerationBeforeReadDispatch = true;
  workbench.state.skillPathAfterReadRestart = deepSkillB;
  await assert.rejects(
    () => browser.listTabs({}),
    (error) => {
      assert.equal(error.code, "BROWSER_WORKBENCH_RESTARTED", "generation change between compatibility check and read dispatch must fail before crossing generations");
      return true;
    }
  );
  assert.equal(workbench.calls.length, callsBeforeUpgrade + 1, "the raced backend probe should be attempted once with an expected Workbench generation");

  const callsAfterGenerationRace = workbench.calls.length;
  await assert.rejects(
    () => browser.listTabs({}),
    (error) => {
      assert.equal(error.code, "BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED");
      assert.match((error.nextActions ?? []).join(" "), /Restart the main Codexless household runtime/i);
      return true;
    }
  );
  assert.equal(workbench.calls.length, callsAfterGenerationRace, "cache/Skill B must not dispatch through child overrides or browser client bound to build A");
});

test("Browser refs and prepared mutations fail closed across Workbench generation changes", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });

  const firstTabs = await browser.listTabs({});
  const oldTabRef = firstTabs.tabs[0].tabRef;
  const prepared = await browser.prepareClick({ tabRef: oldTabRef, role: "button", name: "Refresh" });

  workbench.generation += 1;
  await assert.rejects(
    () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_RUNTIME_RESTARTED");
      return true;
    }
  );
  assert.equal(workbench.state.clicks, 0, "a prepared click from an older generation must never dispatch");
  await assert.rejects(
    () => browser.readTab({ tabRef: oldTabRef, maxChars: 1000 }),
    (error) => {
      assert.equal(error.code, "BROWSER_TAB_REF_UNKNOWN");
      return true;
    }
  );

  const secondTabs = await browser.listTabs({});
  assert.notEqual(secondTabs.tabs[0].tabRef, oldTabRef, "a new Workbench generation must mint fresh opaque tab refs");
  const racePrepared = await browser.prepareClick({ tabRef: secondTabs.tabs[0].tabRef, role: "button", name: "Refresh" });
  workbench.state.bumpGenerationBeforeMutationDispatch = true;
  await assert.rejects(
    () => browser.click({ actionApprovalRef: racePrepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_WORKBENCH_RESTARTED");
      return true;
    }
  );
  assert.equal(workbench.state.clicks, 0, "a generation race before Browser mutation dispatch must fail closed, not become an uncertain replay");
});

test("Browser Preview diagnoses missing Skill, node_repl, and Chrome backend without CUA fallback", async () => {
  const missingSkill = new CodexBrowserExecutor({ workbench: makeWorkbench({ skillAvailable: false }), defaultCwd: "C:\\workspace" });
  const skillStatus = await missingSkill.status({});
  assert.equal(skillStatus.status, "unavailable");
  assert.equal(skillStatus.reason, "chrome_skill_unavailable");
  assert.match(skillStatus.nextActions.join(" "), /Do not use CUA/i);

  const missingRepl = new CodexBrowserExecutor({ workbench: makeWorkbench({ nodeReplAvailable: false }), defaultCwd: "C:\\workspace" });
  const replStatus = await missingRepl.status({});
  assert.equal(replStatus.status, "unavailable");
  assert.equal(replStatus.reason, "node_repl_unavailable");

  const noChrome = new CodexBrowserExecutor({ workbench: makeWorkbench({ chromeConnected: false }), defaultCwd: "C:\\workspace" });
  const chromeStatus = await noChrome.status({});
  assert.equal(chromeStatus.status, "unavailable");
  assert.equal(chromeStatus.reason, "chrome_not_connected");
  assert.match(chromeStatus.nextActions.join(" "), /Do not fall back to Computer Use/i);

  const manifestWorkbench = makeWorkbench();
  const manifestMismatch = new CodexBrowserExecutor({
    workbench: manifestWorkbench,
    defaultCwd: "C:\\workspace",
    runtimeCompatibility: {
      status: "unavailable",
      reason: "current_browser_plugin_manifest_mismatch",
      build: "26.999.12345",
    },
  });
  const manifestStatus = await manifestMismatch.status({});
  assert.equal(manifestStatus.status, "unavailable");
  assert.equal(manifestStatus.reason, "BROWSER_RUNTIME_MANIFEST_MISMATCH");
  assert.equal(manifestStatus.compatibilityReason, "current_browser_plugin_manifest_mismatch");
  assert.equal(manifestStatus.nodeRepl, "not_started");
  assert.match(manifestStatus.nextActions.join(" "), /matching build/i);
  assert.match(manifestStatus.nextActions.join(" "), /not.*disconnected Chrome/i);
});
