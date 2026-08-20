import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { CodexBrowserExecutor, canonicalizeContentEditableParagraphText, resolveBoundContentEditableParagraphText } from "../src/codex-browser-executor.mjs";
import { registerBrowserPreviewTools } from "../src/browser-tools.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fakeSkillPath = "C:\\Users\\Test\\.codex\\plugins\\cache\\openai-bundled\\chrome\\99.1\\skills\\control-chrome\\SKILL.md";
const fakeDownloadPath = process.platform === "win32"
  ? "C:\\Users\\Test\\Downloads\\fixture.txt"
  : "/Users/Test/Downloads/fixture.txt";
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

function makeWorkbench({ chromeConnected = true, skillAvailable = true, nodeReplAvailable = true } = {}) {
  const calls = [];
  const state = {
    tabs: [{
      providerTabId: '["browser-instance","123"]',
      title: "Inbox - Example Mail",
      url: "https://mail.example.test/inbox",
      lastOpened: "2026-08-13T00:00:00.000Z",
    }],
    stale: false,
    openTabsErrorText: null,
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
    scopeLinkCount: 1,
    scopedTargetCount: 1,
    textBindingChanged: false,
    pageChanged: false,
    clickUncertain: false,
    fillUncertain: false,
    navigateUncertain: false,
    navigatePostDispatchFailure: false,
    navigateTransportThrow: false,
    closeUncertain: false,
    closeTransportThrow: false,
    closeDispatches: 0,
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
    fillVerificationSource: "fresh-target",
    fillRoleBoundCount: 1,
    clicks: 0,
    downloads: 0,
    downloadUncertain: false,
    uploads: 0,
    uploadUncertain: false,
    uploadPostDispatchHook: null,
    fills: 0,
    navigations: 0,
    openedTabs: 0,
    screenshots: 0,
    screenshotReportedByteLengthDelta: 0,
    keypresses: [],
    keypressUncertain: false,
    scrolls: 0,
    lastScrollDelta: null,
    scrollUncertain: false,
    scrollReadbackFailure: false,
    fieldValue: "",
    fieldRenderedText: null,
    fillStrategy: "fill",
    fillTargetMeta: { tag: "input", contentEditable: false, customHost: null },
    bumpGenerationBeforeMutationDispatch: false,
  };
  return {
    generation: 1,
    calls,
    state,
    async catalog({ kind }) {
      if (kind === "skills") {
        return { skills: skillAvailable ? [{ name: "chrome:control-chrome", path: fakeSkillPath, enabled: true }] : [] };
      }
      if (kind === "mcp") {
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
      assert.match(input.arguments?.code ?? "", /\n\{\n/, "Browser body must be isolated in a block scope for persistent node_repl sessions");

      const code = input.arguments?.code ?? "";
      const title = input.arguments?.title ?? "";
      if (input.expectedGeneration !== null && input.expectedGeneration !== undefined) {
        assert.equal(input.expectedGeneration, this.generation, "Browser must bind stateful Workbench calls to the current generation");
      }
      if (state.bumpGenerationBeforeMutationDispatch && /^Execute prepared Chrome (navigate|click|download|fill|tab close)$/.test(title)) {
        state.bumpGenerationBeforeMutationDispatch = false;
        this.generation += 1;
        throw new Error(`WORKBENCH_GENERATION_STALE: expected=${input.expectedGeneration} current=${this.generation}`);
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
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
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
          }),
        };
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
        assert.match(code, /if \(__twTab && !__twDispatchAttempted\)/, "finalize is allowed only to release a pre-dispatch claim");
        assert.doesNotMatch(code, /tabs\.finalize\(\{ keep: \[\] \}\)[\s\S]*__twTab\.close\(\)/, "close dispatch must not be implemented through finalize");
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
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        if (state.navigateUncertain) return { isError: true, text: "TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN:timeout after dispatch" };
        const targetMatch = code.match(/\.goto\(("(?:[^"\\]|\\.)*")\)/);
        assert.ok(targetMatch, "navigate body must bind a JSON URL literal");
        const targetUrl = JSON.parse(targetMatch[1]);
        const beforeUrl = state.tabs[0].url;
        state.navigations += 1;
        state.tabs[0] = { ...state.tabs[0], url: targetUrl, title: "Navigated Page" };
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
          }),
        };
      }
      if (title === "Execute prepared Chrome new tab") {
        assert.match(code, /\.tabs\.new\(\)/);
        assert.match(code, /\.goto\(/);
        assert.match(code, /typeof __twBrowser\.tabs\?\.finalize === "function"/);
        assert.match(code, /status: "deliverable"/);
        assert.match(code, /__twTab\.markDeliverable\(\)/, "new Chrome runtimes without tabs.finalize must keep the exact created tab through Tab.markDeliverable()");
        assert.match(code, /TOOLWIRE_BROWSER_DELIVERABLE_API_UNAVAILABLE/, "unknown cleanup APIs must fail visibly after dispatch rather than guessing");
        assert.match(code, /TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN/);
        const targetMatch = code.match(/\.goto\(("(?:[^"\\]|\\.)*")\)/);
        assert.ok(targetMatch, "new-tab body must bind a JSON URL literal");
        const targetUrl = JSON.parse(targetMatch[1]);
        state.openedTabs += 1;
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
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
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
            cleanupStatus: "released",
            cleanupError: null,
          }),
        };
      }
      if (title === "Dispatch fixed Chrome keypress") {
        assert.match(code, /dom_cua\.keypress\(\{ keys: \[/);
        assert.match(code, /TOOLWIRE_BROWSER_ACTION_URL_CHANGED/);
        assert.match(code, /TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN/);
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
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
            cleanupStatus: "released",
            cleanupError: null,
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
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
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
                : null,
          }),
        };
      }
      if (title === "Prepare exact Chrome fill") {
        const scopedFillMode = code.includes("const __twScopeLinks =");
        const placeholderFillMode = code.includes("getByPlaceholder");
        assert.match(code, /getByRole/);
        if (placeholderFillMode) {
          assert.match(code, /__twRoleBoundLocator/);
          assert.match(code, /__twLocator\.and\(__twRoleLocator\)/);
        }
        if (scopedFillMode) {
          assert.match(code, /__twScopeLinks\.evaluateAll/);
          assert.match(code, /__twDepth <= 8/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_LINK_COUNT/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT/);
          if (state.scopeLinkCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + state.scopeLinkCount };
          if (state.scopedTargetCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:3:" + state.scopedTargetCount };
        } else {
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
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
        assert.equal(state.fills, 0, "prepare fill must not mutate the field");
        if (placeholderFillMode && state.fillRoleBoundCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.fillRoleBoundCount };
        if (!scopedFillMode && state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        const currentValue = typeof state.fieldRenderedText === "string"
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
          }),
        };
      }
      if (title === "Execute prepared Chrome fill") {
        const scopedFillMode = code.includes("const __twScopeLinks =");
        assert.match(code, /getByRole/);
        if (scopedFillMode) {
          assert.match(code, /__twScopeLinks\.evaluateAll/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_LINK_COUNT/);
          assert.match(code, /TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT/);
          if (state.scopeLinkCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + state.scopeLinkCount };
          if (state.scopedTargetCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:3:" + state.scopedTargetCount };
        } else {
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
        assert.match(code, /__twExactRoleMatches > 1/);
        assert.match(code, /querySelectorAll\('input, textarea, \[contenteditable\]/);
        assert.match(code, /depth <= 3/);
        assert.match(code, /local-editor-exact/);
        assert.match(code, /__twResolveFreshTarget/);
        assert.match(code, /__twVerifyFreshTarget/);
        assert.match(code, /activation-only-empty/);
        assert.match(code, /phaseStatus: __twActivationOnly \? "activation_only" : "filled"/);
        assert.match(code, /__twActivationOnly = true/);
        assert.match(code, /__twRepairSettleMs = 750/);
        assert.match(code, /waitForTimeout\(__twRepairSettleMs\)/);
        assert.match(code, /__twBrowser\.tabs\.finalize\(\{ keep: \[\] \}\)/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_NOT_APPLIED/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE/);
        assert.match(code, /__twDispatchAttempted = true/);
        assert.match(code, /__twFinalizeError/);
        assert.match(code, /TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN/);
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
        if (state.pageChanged) return { isError: true, text: "TOOLWIRE_BROWSER_ACTION_URL_CHANGED" };
        if (!scopedFillMode && state.locatorCount !== 1) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_COUNT:" + state.locatorCount };
        if (!state.locatorVisible) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE" };
        if (!state.locatorEnabled) return { isError: true, text: "TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED" };
        if (state.fillUncertain) return { isError: true, text: "TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN:timeout after input event" };
        const textMatches = [...code.matchAll(/\.fill\(("(?:[^"\\]|\\.)*"), \{\}\)/g)];
        const textMatch = textMatches.at(-1);
        assert.ok(textMatch, "fill body must bind a JSON string literal");
        const targetText = JSON.parse(textMatch[1]);
        const clearRequested = targetText === "";
        const beforeValue = typeof state.fieldRenderedText === "string"
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
            beforeValue,
            afterValue,
            verificationSource: typeof state.fieldRenderedText === "string" ? "fresh-target-rendered-text" : state.fillVerificationSource,
            snapshot: typeof state.fieldRenderedText === "string" ? `FIELD_RENDERED=${state.fieldRenderedText}` : `FIELD=${state.fieldValue}`,
          }),
        };
      }
      if (title === "Repair activated Chrome fill") {
        assert.match(code, /__twResolveTarget/);
        assert.match(code, /fresh repair target/);
        assert.match(code, /repairDispatched/);
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
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
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
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
            cleanupStatus: "released",
            cleanupError: null,
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
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
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
            downloadPath: fakeDownloadPath,
            pathError: null,
            readbackError: null,
            cleanupStatus: "released",
            cleanupError: null,
          }),
        };
      }
      if (title === "Execute prepared Chrome click") {
        const exactTextMode = code.includes("playwright.getByText(");
        const scopedRoleMode = code.includes("const __twScopeLinks =");
        const localRadioMode = code.includes("__twDispatchLocator.check(");
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
        } else {
          assert.match(code, /__twDispatchLocator\.click\(\{ timeoutMs: 5000 \}\)/);
        }
        assert.match(code, /TOOLWIRE_BROWSER_ACTION_URL_CHANGED/);
        assert.match(code, /__twDispatchAttempted = true/);
        assert.match(code, /__twFinalizeError/);
        assert.match(code, /TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN/);
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/);
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
          }),
        };
      }
      if (code.includes("browsers.list")) {
        return {
          isError: false,
          text: JSON.stringify(chromeConnected
            ? [{ name: "Chrome", family: "chrome", type: "extension" }]
            : [{ name: "Edge", family: "edge", type: "extension" }]),
        };
      }
      if (code.includes("domSnapshot")) {
        assert.match(code, /tabs\.finalize\(\{ keep: \[\] \}\)/, "claimed user tabs must be finalized/released after read");
        if (state.stale) return { isError: true, text: "TOOLWIRE_BROWSER_TAB_STALE" };
        if (state.scrollReadbackFailure && state.scrolls > 0) {
          return { isError: true, text: "simulated post-scroll DOM readback failure" };
        }
        return {
          isError: false,
          text: JSON.stringify({
            title: state.tabs[0].title,
            url: state.tabs[0].url,
            lastOpened: state.tabs[0].lastOpened,
            snapshot: typeof state.fieldRenderedText === "string"
              ? `FIELD_RENDERED=${state.fieldRenderedText}`
              : state.lastScrollDelta == null
                ? "A".repeat(2500)
                : `SCROLLED=${state.lastScrollDelta}`,
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
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", text: "Clickable card title", selector: ".thread-card" }).success, false);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", role: "button", name: "Reply", scopeUrl: "https://example.test", nodeId: "comment-1" }).success, false);
  assert.equal(schema.safeParse({ tabRef: "browser_tab_test", text: "Clickable card title", url: "https://example.test" }).success, false);
  assert.match(prepareClick.description ?? "", /exact visible text/i);
  assert.match(prepareClick.description ?? "", /scopeUrl/i);
  assert.match(prepareClick.description ?? "", /no CSS selector\/JavaScript\/coordinates\/node ids\/item indexes\/ancestor depth/i);
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
  assert.match(download.description ?? "", /browser-managed local download path/i);
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
  assert.match(closeTab.description ?? "", /official Chrome Tab\.close\(\)/i);
  assert.match(closeTab.description ?? "", /never auto-retries/i);
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
  assert.ok(prepareOpenTab);
  assert.ok(openTab);
  assert.ok(scroll);
  assert.ok(keypress);
  assert.ok(prepareNavigate);
  assert.ok(navigate);
  assert.ok(prepareFill);
  assert.equal(prepareOpenTab.inputSchema.safeParse({ url: "https://example.test/new" }).success, true);
  assert.equal(prepareOpenTab.inputSchema.safeParse({ url: "https://example.test/new", tabRef: "browser_tab_test" }).success, false);
  assert.equal(openTab.inputSchema.safeParse({ actionApprovalRef: "browser_action_test" }).success, true);
  assert.equal(openTab.inputSchema.safeParse({ actionApprovalRef: "browser_action_test", url: "https://example.test" }).success, false);
  assert.equal(scroll.inputSchema.safeParse({ tabRef: "browser_tab_test", direction: "down", amount: "page" }).success, true);
  assert.equal(scroll.inputSchema.safeParse({ tabRef: "browser_tab_test", direction: "down", amount: "page", node_id: "n1" }).success, false);
  assert.equal(scroll.inputSchema.safeParse({ tabRef: "browser_tab_test", direction: "sideways" }).success, false);
  assert.match(prepareOpenTab.description ?? "", /explicit http\(s\) URL/i);
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
  assert.equal(listed.count, 1);
  assert.match(listed.tabs[0].tabRef, /^browser_tab_/);
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

test("Browser Operate prepare/open-tab creates one exact deliverable tab and exposes it on the next tab list", async () => {
  const workbench = makeWorkbench();
  const browser = new CodexBrowserExecutor({ workbench, defaultCwd: "C:\\workspace" });

  const prepared = await browser.prepareOpenTab({ url: "https://example.test/new" });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.action.kind, "open_tab");
  assert.equal(prepared.action.toUrl, "https://example.test/new");
  assert.equal(workbench.state.openedTabs, 0, "prepare open-tab must not create a tab");

  const opened = await browser.openTab({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(opened.status, "opened");
  assert.equal(opened.requestedUrl, "https://example.test/new");
  assert.equal(opened.afterUrl, "https://example.test/new");
  assert.equal(opened.redirected, false);
  assert.equal(workbench.state.openedTabs, 1);
  assert.match(opened.note, /browser_tabs/i);
  assert.equal(JSON.stringify(opened).includes("providerTabId"), false);

  const listed = await browser.listTabs({});
  assert.equal(listed.count, 2);
  const created = listed.tabs.find((tab) => tab.url === "https://example.test/new");
  assert.ok(created);
  assert.match(created.tabRef, /^browser_tab_/);

  await assert.rejects(
    () => browser.openTab({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => {
      assert.equal(error.code, "BROWSER_ACTION_REF_EXPIRED");
      return true;
    }
  );
  await assert.rejects(
    () => browser.prepareOpenTab({ url: "javascript:alert(1)" }),
    (error) => {
      assert.equal(error.code, "BROWSER_NAVIGATE_SCHEME_UNSUPPORTED");
      return true;
    }
  );
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
  assert.equal(downloaded.downloadPath, fakeDownloadPath);
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

test("Browser empty fill clears a populated rich editor and prepare reports rendered current value", async () => {
  const workbench = makeWorkbench();
  const existingText = "TOOLWIRE_NIGHT_DOGFOOD_0100_20260818 — rich editor exact readback test";
  workbench.state.fieldValue = "";
  workbench.state.fieldRenderedText = existingText;
  workbench.state.fillStrategy = "type";
  workbench.state.fillTargetMeta = { tag: "div", contentEditable: true, customHost: null };
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
  assert.match(executeCode, /if \(false\) \{\s*const __twVisibleRoleTargets/);

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
  assert.match(prepareCode, /getByPlaceholder/);
  assert.match(prepareCode, /getByPlaceholder[\s\S]*filter\(\{ visible: true \}\)/);
  assert.match(prepareCode, /getByRole/);
  assert.match(prepareCode, /__twSemanticPlaceholderIndexes/);
  assert.match(prepareCode, /__twCandidate\.and\(__twSemanticRoleLocator\)\.count\(\)/);
  assert.match(prepareCode, /__twSemanticPlaceholderIndexes\.length === 1/);
  assert.match(prepareCode, /__twSemanticShell\.getByRole\("textbox"\)\.filter\(\{ visible: true \}\)/);
  assert.match(prepareCode, /__twNestedSemanticTextboxCount === 1/);
  assert.match(prepareCode, /__twNestedSemanticTextboxCount === 0/);
  assert.match(prepareCode, /nativeIndexes/);
  assert.match(prepareCode, /tag === "input" \|\| tag === "textarea"/);
  assert.match(prepareCode, /nativeIndexes\.length === 1/);
  assert.match(prepareCode, /focusDistances/);
  assert.match(prepareCode, /getByRole\("textbox"\)\.filter\(\{ visible: true \}\)/);
  assert.match(prepareCode, /\.nth\(__twCandidateState\.nativeIndexes\[0\]\)/);
  assert.match(prepareCode, /\.and\(__twRoleLocator\)/);
  assert.match(prepareCode, /let __twLocator = __twPlaceholderLocator/);
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

test("Browser fill re-resolves a replaced rich editor and performs one guarded repair only when the fresh target is proven empty", async () => {
  const workbench = makeWorkbench();
  workbench.state.fillActivationRepair = true;
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
});
