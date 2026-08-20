import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveAuthorizedExistingFile } from "./construction-tools.mjs";

const CHROME_SKILL_NAME = "chrome:control-chrome";
const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_TOOL = "js";
const DEFAULT_MAX_SNAPSHOT_CHARS = 80_000;
const MAX_SNAPSHOT_CHARS = 200_000;
const BROWSER_ACTION_APPROVAL_TTL_MS = 5 * 60_000;
const BROWSER_POST_ACTION_MAX_CHARS = 20_000;
const BROWSER_FILL_ROLES = new Set(["textbox", "searchbox"]);
const BROWSER_FIXED_KEYS = new Set(["Enter", "Tab", "Escape"]);
const MAX_BROWSER_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 5_000_000;
const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const JPEG_SIGNATURE_HEX = "ffd8ff";
const BROWSER_MUTATION_DEFINITIVE_RESPONSE_CODES = new Set([
  "BROWSER_FILL_NOT_APPLIED",
  "BROWSER_FILL_VERIFICATION_UNAVAILABLE",
  "BROWSER_FILL_VERIFY_MISMATCH",
  "BROWSER_FILL_VALUE_UNREADABLE",
  "BROWSER_ACTION_PAGE_CHANGED",
  "BROWSER_ACTION_TARGET_CHANGED",
  "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE",
  "BROWSER_ACTION_SCOPE_NOT_FOUND",
  "BROWSER_ACTION_SCOPE_AMBIGUOUS",
  "BROWSER_ACTION_TARGET_NOT_FOUND_IN_SCOPE",
  "BROWSER_ACTION_TARGET_AMBIGUOUS",
  "BROWSER_ACTION_TARGET_NOT_VISIBLE",
  "BROWSER_ACTION_TARGET_NOT_ENABLED",
  "BROWSER_TAB_STALE",
]);

const PREPARED_ACTION_METADATA = Object.freeze({
  close_tab: Object.freeze({
    invalidReferenceMessage: "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_close_tab",
    expiredReferenceMessage: "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared tab close",
    expiredNextActions: Object.freeze(["Call codex.browser_tabs and codex.browser_prepare_close_tab again only if the exact tab still needs to be closed."]),
    generationMessage: "The prepared tab close belongs to an older Codex Workbench generation and cannot be dispatched",
    generationNextActions: Object.freeze(["Call codex.browser_tabs and prepare the close again from the current Browser runtime only if the tab still needs to be closed."]),
    tabMessage: "The prepared tab close no longer matches a current Browser runtime tab",
    tabNextActions: Object.freeze(["Call codex.browser_tabs and prepare a fresh close only for the exact current tab that still needs closing."]),
  }),
  open_tab: Object.freeze({
    invalidReferenceMessage: "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_open_tab",
    expiredReferenceMessage: "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared new-tab action",
    expiredNextActions: Object.freeze(["Call codex.browser_prepare_open_tab again to prepare a fresh exact URL."]),
    generationMessage: "The prepared new-tab action belongs to an older Codex Workbench generation and cannot be dispatched",
    generationNextActions: Object.freeze(["Prepare the new tab again from the current Browser runtime."]),
  }),
  navigate: Object.freeze({
    invalidReferenceMessage: "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_navigate",
    expiredReferenceMessage: "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared navigation",
    expiredNextActions: Object.freeze(["Call codex.browser_tabs and codex.browser_prepare_navigate again to prepare a fresh exact navigation."]),
    generationMessage: "The prepared navigation belongs to an older Codex Workbench generation and cannot be dispatched",
    generationNextActions: Object.freeze(["Call codex.browser_tabs and prepare the navigation again from current page state."]),
    tabMessage: "The prepared navigation no longer matches a current Browser runtime tab",
    tabNextActions: Object.freeze(["Call codex.browser_tabs and prepare the navigation again from current page state."]),
  }),
  click: Object.freeze({
    invalidReferenceMessage: "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_click",
    expiredReferenceMessage: "actionApprovalRef is invalid, expired, or already consumed",
    expiredNextActions: Object.freeze(["Call codex.browser_tabs and codex.browser_prepare_click again to prepare a fresh exact click."]),
    generationMessage: "The prepared click belongs to an older Codex Workbench generation and cannot be dispatched",
    generationNextActions: Object.freeze(["Call codex.browser_tabs and prepare the click again from current page state."]),
    tabMessage: "The prepared click no longer matches a current Browser runtime tab",
    tabNextActions: Object.freeze(["Call codex.browser_tabs and prepare the click again from current page state."]),
  }),
  download: Object.freeze({
    invalidReferenceMessage: "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_download",
    expiredReferenceMessage: "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared download",
    expiredNextActions: Object.freeze(["Call codex.browser_tabs and codex.browser_prepare_download again to prepare a fresh exact download."]),
    generationMessage: "The prepared download belongs to an older Codex Workbench generation and cannot be dispatched",
    generationNextActions: Object.freeze(["Call codex.browser_tabs and prepare the download again from current page state."]),
    tabMessage: "The prepared download no longer matches a current Browser runtime tab",
    tabNextActions: Object.freeze(["Call codex.browser_tabs and prepare the download again from current page state."]),
  }),
  upload: Object.freeze({
    invalidReferenceMessage: "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_upload",
    expiredReferenceMessage: "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared upload",
    expiredNextActions: Object.freeze(["Call codex.browser_tabs and codex.browser_prepare_upload again to prepare a fresh exact upload."]),
    generationMessage: "The prepared upload belongs to an older Codex Workbench generation and cannot be dispatched",
    generationNextActions: Object.freeze(["Call codex.browser_tabs and prepare the upload again from current page state."]),
    tabMessage: "The prepared upload no longer matches a current Browser runtime tab",
    tabNextActions: Object.freeze(["Call codex.browser_tabs and prepare the upload again from current page state."]),
  }),
  fill: Object.freeze({
    invalidReferenceMessage: "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_fill",
    expiredReferenceMessage: "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared fill",
    expiredNextActions: Object.freeze(["Call codex.browser_tabs and codex.browser_prepare_fill again to prepare a fresh exact fill."]),
    generationMessage: "The prepared fill belongs to an older Codex Workbench generation and cannot be dispatched",
    generationNextActions: Object.freeze(["Call codex.browser_tabs and prepare the fill again from current page state."]),
    tabMessage: "The prepared fill no longer matches a current Browser runtime tab",
    tabNextActions: Object.freeze(["Call codex.browser_tabs and prepare the fill again from current page state."]),
  }),
});

const BROWSER_MUTATION_UNCERTAINTY = Object.freeze({
  click: Object.freeze({
    marker: "TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN",
    code: "BROWSER_CLICK_RESULT_UNCERTAIN",
    messagePrefix: "Browser click result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this click automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Re-read current tab/page state first, then prepare a fresh click only if the intended action is still needed.",
    ]),
    classifiedNextActions: Object.freeze(["Do not retry this click automatically. Re-read current tab/page state first, then prepare a fresh click only if the intended action is still needed."]),
  }),
  fill: Object.freeze({
    marker: "TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN",
    code: "BROWSER_FILL_RESULT_UNCERTAIN",
    messagePrefix: "Browser fill result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this fill automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Re-read current tab/page state first, then prepare a fresh fill only if the intended action is still needed.",
    ]),
    classifiedNextActions: Object.freeze(["Do not retry this fill automatically. Re-read current tab/page state first, then prepare a fresh fill only if the intended text is still needed."]),
  }),
  navigate: Object.freeze({
    marker: "TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN",
    code: "BROWSER_NAVIGATE_RESULT_UNCERTAIN",
    messagePrefix: "Browser navigation result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this navigate automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Re-read current tab/page state first, then prepare a fresh navigate only if the intended action is still needed.",
    ]),
    classifiedNextActions: Object.freeze(["Do not retry this navigation automatically. Re-read current tab/page state first, then prepare a fresh navigation only if the intended destination is still needed."]),
  }),
  open_tab: Object.freeze({
    marker: "TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN",
    code: "BROWSER_OPEN_TAB_RESULT_UNCERTAIN",
    messagePrefix: "Browser new-tab result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this open_tab automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Re-read current tab/page state first, then prepare a fresh open_tab only if the intended action is still needed.",
    ]),
    classifiedNextActions: Object.freeze(["Do not open another tab automatically. Call codex.browser_tabs first and inspect whether the requested URL is already open before preparing a fresh new-tab action."]),
  }),
  close_tab: Object.freeze({
    marker: "TOOLWIRE_BROWSER_CLOSE_RESULT_UNCERTAIN",
    code: "BROWSER_CLOSE_RESULT_UNCERTAIN",
    messagePrefix: "Browser tab-close result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this close_tab automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Call codex.browser_tabs to inspect current tab state. Do not close again automatically; prepare a fresh close only if the exact intended tab is still present and still needs closing.",
    ]),
    classifiedNextActions: Object.freeze(["Do not close again automatically. Call codex.browser_tabs to inspect current tab state, then prepare a fresh close only if the exact intended tab is still present and still needs closing."]),
  }),
  scroll: Object.freeze({
    marker: "TOOLWIRE_BROWSER_SCROLL_RESULT_UNCERTAIN",
    code: "BROWSER_SCROLL_RESULT_UNCERTAIN",
    messagePrefix: "Browser scroll result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this scroll automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Re-read current tab/page state first, then scroll again only if more loaded content is still needed.",
    ]),
    classifiedNextActions: Object.freeze(["Re-read the current tab first. Scroll again only if more loaded content is still needed; do not blindly repeat the previous scroll."]),
  }),
  keypress: Object.freeze({
    marker: "TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN",
    code: "BROWSER_KEYPRESS_RESULT_UNCERTAIN",
    messagePrefix: "Browser keypress result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this keypress automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Re-read current tab/page state first. Press the key again only if the intended effect is clearly still needed; never blindly repeat Enter/Tab/Escape.",
    ]),
    classifiedNextActions: Object.freeze(["Do not retry Enter/Tab/Escape automatically. Re-read the current tab/page state first, then press again only if the intended effect is clearly still needed."]),
  }),
  download: Object.freeze({
    marker: "TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN",
    code: "BROWSER_DOWNLOAD_RESULT_UNCERTAIN",
    messagePrefix: "Browser download result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this download automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Do not start another download automatically. Inspect the browser's download location or current task state first because the file may already have been created.",
    ]),
    classifiedNextActions: Object.freeze(["Do not retry this download automatically. The target click may already have created a file in the browser's configured download location; inspect current state first."]),
  }),
  upload: Object.freeze({
    marker: "TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN",
    code: "BROWSER_UPLOAD_RESULT_UNCERTAIN",
    messagePrefix: "Browser upload result is uncertain: ",
    directNextActions: Object.freeze([
      "Do not retry this upload automatically. The remote action may already have happened even though its MCP response was lost or unreadable.",
      "Do not re-select the file automatically. The webpage may already have received the file selection/change event or started an upload; inspect page state first.",
    ]),
    classifiedNextActions: Object.freeze([
      "Do not retry this upload automatically. The webpage may already have received the file selection/change event or started an upload; inspect current page state first.",
      "If Chromium file-chooser integration is unavailable, Google Chrome requires enabling 'Allow access to file URLs' for the ChatGPT browser extension before retrying a fresh, user-authorized upload.",
    ]),
  }),
});
const PREPARED_ACTION_KINDS = new Set(Object.keys(PREPARED_ACTION_METADATA));

export function canonicalizeContentEditableParagraphText(element) {
  if (!element) return null;
  const contentEditableAttr = typeof element.getAttribute === "function" ? element.getAttribute("contenteditable") : null;
  const normalizedContentEditableAttr = typeof contentEditableAttr === "string" ? contentEditableAttr.trim().toLowerCase() : null;
  const effectiveContentEditable = element.isContentEditable === true
    || normalizedContentEditableAttr === ""
    || normalizedContentEditableAttr === "true"
    || normalizedContentEditableAttr === "plaintext-only";
  if (!effectiveContentEditable) return null;
  const directNodes = Array.from(element.childNodes ?? []);
  const meaningfulNodes = directNodes.filter((node) => {
    if (node?.nodeType === 1) return true;
    if (node?.nodeType === 3) return String(node.textContent ?? "").trim() !== "";
    return false;
  });
  if (!meaningfulNodes.length) return null;
  if (meaningfulNodes.some((node) => node?.nodeType !== 1 || String(node.tagName ?? "").toUpperCase() !== "P")) {
    return null;
  }

  const inlineTags = new Set([
    "A", "B", "CODE", "DEL", "EM", "I", "INS", "MARK", "S", "SPAN", "STRONG", "SUB", "SUP", "U",
  ]);
  const readInline = (node) => {
    if (node?.nodeType === 3) return String(node.textContent ?? "");
    if (node?.nodeType !== 1) return "";
    const tag = String(node.tagName ?? "").toUpperCase();
    if (tag === "BR") return "\n";
    if (!inlineTags.has(tag)) return null;
    const parts = [];
    for (const child of Array.from(node.childNodes ?? [])) {
      const part = readInline(child);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join("");
  };

  const paragraphs = [];
  for (const paragraph of meaningfulNodes) {
    // Rich editors commonly keep an empty paragraph alive with one or more <br>
    // placeholders. textContent remains empty in that case; semantically it is
    // one empty line, not an extra newline emitted by each placeholder <br>.
    if (String(paragraph.textContent ?? "") === "") {
      paragraphs.push("");
      continue;
    }
    const parts = [];
    for (const child of Array.from(paragraph.childNodes ?? [])) {
      const part = readInline(child);
      if (part === null) return null;
      parts.push(part);
    }
    paragraphs.push(parts.join(""));
  }
  return paragraphs.join("\n").replace(/\r\n?/g, "\n");
}

export function resolveBoundContentEditableParagraphText(element, isVisibleOverride = null) {
  const canonical = (candidate) => canonicalizeContentEditableParagraphText(candidate);
  const isEffectiveContentEditable = (candidate) => {
    if (!candidate) return false;
    if (candidate.isContentEditable === true) return true;
    const attr = typeof candidate.getAttribute === "function" ? candidate.getAttribute("contenteditable") : null;
    if (typeof attr !== "string") return false;
    const normalized = attr.trim().toLowerCase();
    return normalized === "" || normalized === "true" || normalized === "plaintext-only";
  };
  if (!element) {
    return { source: null, editableCount: 0, canonicalRichText: null };
  }
  if (isEffectiveContentEditable(element)) {
    return {
      source: "direct",
      editableCount: 1,
      canonicalRichText: canonical(element),
    };
  }

  const isVisible = typeof isVisibleOverride === "function"
    ? isVisibleOverride
    : (candidate) => {
        if (!candidate || candidate.nodeType !== 1) return false;
        const view = candidate.ownerDocument?.defaultView ?? globalThis.window ?? null;
        const getComputedStyle = typeof view?.getComputedStyle === "function"
          ? view.getComputedStyle.bind(view)
          : null;
        if (getComputedStyle) {
          const style = getComputedStyle(candidate);
          if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= 0.01) return false;
        }
        if (typeof candidate.getClientRects === "function") {
          return Array.from(candidate.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
        }
        return true;
      };

  const descendants = typeof element.querySelectorAll === "function"
    ? Array.from(element.querySelectorAll("[contenteditable]"))
        .filter((candidate) => isEffectiveContentEditable(candidate))
        .filter((candidate) => isVisible(candidate))
    : [];
  if (descendants.length !== 1) {
    return { source: null, editableCount: descendants.length, canonicalRichText: null };
  }
  return {
    source: "unique-visible-descendant",
    editableCount: 1,
    canonicalRichText: canonical(descendants[0]),
  };
}

const CONTENTEDITABLE_PARAGRAPH_CANONICALIZER_SOURCE = canonicalizeContentEditableParagraphText.toString();
const BOUND_CONTENTEDITABLE_PARAGRAPH_RESOLVER_SOURCE = resolveBoundContentEditableParagraphText.toString();

export class BrowserPreviewError extends Error {
  constructor(code, message, nextActions = [], diagnostic = null) {
    super(message);
    this.name = "BrowserPreviewError";
    this.code = code;
    this.nextActions = nextActions;
    this.diagnostic = diagnostic;
  }
}

export class CodexBrowserExecutor {
  #workbench;
  #defaultCwd;
  #authorityExecutor;
  #sessionId = `toolwire-browser-${randomUUID()}`;
  #turnSeq = 0;
  #browserClientUrl = null;
  #tabs = new Map();
  #providerToRef = new Map();
  #actionApprovals = new Map();
  #workbenchGeneration = 0;

  constructor({ workbench, defaultCwd, authorityExecutor = null }) {
    if (!workbench) throw new Error("CodexBrowserExecutor requires workbench");
    if (!defaultCwd) throw new Error("CodexBrowserExecutor requires defaultCwd");
    this.#workbench = workbench;
    this.#defaultCwd = path.resolve(defaultCwd);
    this.#authorityExecutor = authorityExecutor;
    this.#workbenchGeneration = this.#currentWorkbenchGeneration();
  }

  #currentWorkbenchGeneration() {
    return Number.isInteger(this.#workbench?.generation) ? this.#workbench.generation : 0;
  }

  #syncWorkbenchGeneration() {
    const current = this.#currentWorkbenchGeneration();
    if (current === this.#workbenchGeneration) return false;
    this.#tabs.clear();
    this.#providerToRef.clear();
    this.#actionApprovals.clear();
    this.#browserClientUrl = null;
    this.#sessionId = `toolwire-browser-${randomUUID()}`;
    this.#turnSeq = 0;
    this.#workbenchGeneration = current;
    return true;
  }

  async status({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const dependency = await this.#dependencyStatus(effectiveCwd);
    if (dependency.status !== "ok") return dependency;

    try {
      const backends = await this.#listBackends(effectiveCwd);
      const chrome = backends.find((backend) => backend.family === "chrome");
      if (!chrome) {
        return {
          status: "unavailable",
          reason: "chrome_not_connected",
          chromeSkill: "ok",
          nodeRepl: "ok",
          connectedBrowsers: backends,
          nextActions: [
            "Open Chrome with the supported Codex Chrome extension/runtime enabled, then call codex.browser_status again.",
            "Do not fall back to Computer Use merely because Chrome is not connected.",
          ],
        };
      }
      return {
        status: "ok",
        chromeSkill: "ok",
        nodeRepl: "ok",
        chrome: sanitizeBackend(chrome),
        connectedBrowsers: backends.map(sanitizeBackend),
        authState: "site_specific_unknown",
        note: "Browser connectivity is healthy. Website login state is site-specific and is verified by reading the actual tab URL/page; the Browser runtime does not infer authentication from extension connectivity alone.",
      };
    } catch (error) {
      return browserUnavailable(error);
    }
  }

  async confirmationPolicy({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const dependency = await this.#dependencyStatus(effectiveCwd);
    if (dependency.status !== "ok") {
      throw new BrowserPreviewError(
        dependency.reason ?? "BROWSER_CONFIRMATION_POLICY_UNAVAILABLE",
        `Browser confirmation policy is unavailable: ${dependency.reason ?? "unknown"}`,
        dependency.nextActions ?? ["Restore the current Codex Chrome Skill/runtime, then retry."]
      );
    }
    const result = await this.#runJson(effectiveCwd, `
const __twPolicy = await globalThis.__toolwireBrowserAgent.documentation.get("confirmations");
if (typeof __twPolicy !== "string" || !__twPolicy.trim()) {
  throw new Error("TOOLWIRE_BROWSER_CONFIRMATION_POLICY_UNAVAILABLE");
}
nodeRepl.write(JSON.stringify({ policy: __twPolicy }));
`, "Read Codex Browser confirmation policy");
    const codexPolicy = typeof result?.policy === "string" ? result.policy : "";
    if (!codexPolicy.trim()) {
      throw new BrowserPreviewError(
        "BROWSER_CONFIRMATION_POLICY_UNAVAILABLE",
        "The current Codex Chrome Skill returned no Browser confirmation policy",
        ["Do not invent a replacement permission taxonomy. Restore/update the Codex Chrome Skill and retry."]
      );
    }
    return {
      status: "ok",
      source: "current Codex Chrome Skill / confirmations",
      codexPolicy,
      interactionGuidance: {
        defaultMode: "task_level_verbal_confirmation",
        rule: "Use the Codex policy as the default risk taxonomy. If the bounded browser task contains an action class that the Codex policy says requires confirmation, ask once in ordinary conversation for permission covering that task scope before the first such side effect. Do not ask again for routine actions inside the same unchanged task. Ask again only if the task expands into a materially different risk class or a higher-level platform rule requires action-time confirmation.",
        userOverride: "User-authored context may make the confirmation preference stricter or looser where higher-level policy permits. Do not create or require a per-website permission database just to express this preference.",
        userFacingExplanation: "When asking, explain that the extra permission is based on the current Codex Browser Policy. Keep it conversational and brand-neutral. Clarify when useful that this is browser-operation permission only; it does not start a Codex task or by itself consume Codex quota.",
      },
      note: "This tool reads the currently installed Codex Browser confirmation policy dynamically. It does not start a Codex model turn, grant permission, mutate browser state, or decide a specific page action by itself; the caller applies the policy to user-authored task context and current page semantics.",
    };
  }

  async listTabs({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    await this.#requireReady(effectiveCwd);
    const rawTabs = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twTabs = await __twBrowser.user.openTabs();
nodeRepl.write(JSON.stringify(__twTabs.map((tab) => ({
  providerTabId: tab.providerTabId,
  title: tab.title ?? null,
  url: tab.url ?? null,
  lastOpened: tab.lastOpened ?? null,
}))));
`, "List current Chrome tabs");

    if (!Array.isArray(rawTabs)) {
      throw new BrowserPreviewError("BROWSER_PROTOCOL_ERROR", "Chrome openTabs returned a non-array result");
    }

    const currentProviders = new Set();
    const tabs = [];
    for (const raw of rawTabs) {
      const providerTabId = typeof raw?.providerTabId === "string" ? raw.providerTabId : null;
      if (!providerTabId) continue;
      currentProviders.add(providerTabId);
      let tabRef = this.#providerToRef.get(providerTabId);
      if (!tabRef) {
        tabRef = `browser_tab_${randomUUID()}`;
        this.#providerToRef.set(providerTabId, tabRef);
      }
      const state = {
        tabRef,
        providerTabId,
        workbenchGeneration: this.#workbenchGeneration,
        title: stringOrNull(raw.title),
        url: stringOrNull(raw.url),
        lastOpened: stringOrNull(raw.lastOpened),
        seenAt: Date.now(),
      };
      this.#tabs.set(tabRef, state);
      tabs.push(publicTab(state));
    }

    for (const [providerTabId, tabRef] of this.#providerToRef.entries()) {
      if (!currentProviders.has(providerTabId)) {
        this.#providerToRef.delete(providerTabId);
        this.#tabs.delete(tabRef);
      }
    }

    return {
      status: "ok",
      browser: "chrome",
      count: tabs.length,
      tabs,
      note: "tabRef values are opaque and valid only while this Workbench runtime can still match the same open Chrome tab. Call codex.browser_tabs again after a backend restart or when a tab closes/moves unexpectedly.",
    };
  }

  async readTab({ tabRef, cwd = this.#defaultCwd, maxChars = DEFAULT_MAX_SNAPSHOT_CHARS }) {
    const effectiveCwd = path.resolve(cwd);
    this.#assertTabRef(tabRef);
    if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > MAX_SNAPSHOT_CHARS) {
      throw new BrowserPreviewError(
        "BROWSER_MAX_CHARS_INVALID",
        `maxChars must be an integer between 1000 and ${MAX_SNAPSHOT_CHARS}`
      );
    }
    await this.#requireReady(effectiveCwd);
    const state = this.#requireKnownTab(tabRef);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twSnapshot = await __twTab.playwright.domSnapshot();
  __twPayload = {
    title: __twInfo.title ?? null,
    url: __twInfo.url ?? null,
    lastOpened: __twInfo.lastOpened ?? null,
    snapshot: __twSnapshot,
  };
} finally {
  if (__twTab) if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
}
nodeRepl.write(JSON.stringify(__twPayload));
`, "Read existing Chrome tab DOM", { expectedGeneration: state.workbenchGeneration });

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    if (!snapshot && result?.snapshot !== "") {
      throw new BrowserPreviewError("BROWSER_PROTOCOL_ERROR", "Chrome domSnapshot returned no text snapshot");
    }
    const truncated = snapshot.length > maxChars;
    const current = {
      ...state,
      title: stringOrNull(result?.title) ?? state.title,
      url: stringOrNull(result?.url) ?? state.url,
      lastOpened: stringOrNull(result?.lastOpened) ?? state.lastOpened,
      seenAt: Date.now(),
    };
    this.#tabs.set(tabRef, current);
    return {
      status: "ok",
      browser: "chrome",
      tab: publicTab(current),
      snapshot: truncated ? snapshot.slice(0, maxChars) : snapshot,
      snapshotChars: snapshot.length,
      snapshotTruncated: truncated,
      authState: "site_specific_unknown",
      note: "This is a read-only snapshot of the existing tab. The Browser runtime did not navigate, click, submit, or change page state. If the site redirected to a login page, inspect the returned current URL/snapshot instead of assuming authentication.",
    };
  }

  async screenshotTab({ tabRef, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    this.#assertTabRef(tabRef);
    await this.#requireReady(effectiveCwd);
    const state = this.#requireKnownTab(tabRef);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twScreenshot = await __twTab.screenshot({ fullPage: false });
  const __twBytes = __twScreenshot instanceof Uint8Array ? __twScreenshot : new Uint8Array(__twScreenshot);
  __twPayload = {
    title: await __twTab.title() ?? __twInfo.title ?? null,
    url: await __twTab.url() ?? __twInfo.url ?? null,
    lastOpened: __twInfo.lastOpened ?? null,
    byteLength: __twBytes.byteLength,
    dataBase64: Buffer.from(__twBytes).toString("base64"),
  };
} finally {
  if (__twTab) if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
}
nodeRepl.write(JSON.stringify(__twPayload));
`, "Capture existing Chrome tab screenshot", { expectedGeneration: state.workbenchGeneration });

    const dataBase64 = typeof result?.dataBase64 === "string" ? result.dataBase64 : "";
    if (!dataBase64) {
      throw new BrowserPreviewError("BROWSER_SCREENSHOT_PROTOCOL_ERROR", "Chrome screenshot returned no image data");
    }
    let bytes;
    try {
      bytes = Buffer.from(dataBase64, "base64");
    } catch {
      throw new BrowserPreviewError("BROWSER_SCREENSHOT_PROTOCOL_ERROR", "Chrome screenshot returned invalid base64 image data");
    }
    const image = inspectScreenshotImage(bytes);
    if (!image) {
      throw new BrowserPreviewError(
        "BROWSER_SCREENSHOT_FORMAT_UNSUPPORTED",
        "Chrome screenshot returned an unsupported image format; the Browser runtime currently accepts the JPEG/PNG formats observed from the official tab.screenshot() API"
      );
    }
    if (bytes.length > MAX_SCREENSHOT_BYTES) {
      throw new BrowserPreviewError(
        "BROWSER_SCREENSHOT_TOO_LARGE",
        `Chrome viewport screenshot is ${bytes.length} bytes, above the Browser runtime's ${MAX_SCREENSHOT_BYTES}-byte return limit`,
        ["Reduce the browser viewport or inspect the page in smaller visual sections; the Browser runtime does not auto-downsample or silently truncate screenshots."]
      );
    }
    if (Number.isInteger(result?.byteLength) && result.byteLength !== bytes.length) {
      throw new BrowserPreviewError("BROWSER_SCREENSHOT_PROTOCOL_ERROR", "Chrome screenshot byte length did not match its encoded payload");
    }
    const { mimeType, width, height } = image;
    const current = {
      ...state,
      title: stringOrNull(result?.title) ?? state.title,
      url: stringOrNull(result?.url) ?? state.url,
      lastOpened: stringOrNull(result?.lastOpened) ?? state.lastOpened,
      seenAt: Date.now(),
    };
    this.#tabs.set(tabRef, current);
    return {
      status: "ok",
      browser: "chrome",
      tab: publicTab(current),
      mimeType,
      byteLength: bytes.length,
      width,
      height,
      fullPage: false,
      dataBase64,
      note: "This is a read-only screenshot of the current visible viewport from the existing tab. The Browser runtime did not navigate, click, type, submit, scroll, or expose raw provider tab IDs. The image is returned as MCP image content rather than embedded inside structured JSON.",
    };
  }

  async prepareCloseTab({ tabRef, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    this.#assertTabRef(tabRef);
    await this.#requireReady(effectiveCwd);
    const state = this.#requireKnownTab(tabRef);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
nodeRepl.write(JSON.stringify({
  title: __twInfo.title ?? null,
  url: __twInfo.url ?? null,
  lastOpened: __twInfo.lastOpened ?? null,
}));
`, "Prepare exact Chrome tab close", { expectedGeneration: state.workbenchGeneration });

    const currentUrl = stringOrNull(result?.url);
    if (currentUrl === null) {
      throw new BrowserPreviewError(
        "BROWSER_CLOSE_URL_UNAVAILABLE",
        "The current Chrome tab did not expose a URL, so the Browser runtime cannot safely bind and revalidate this close action",
        ["Call codex.browser_tabs again after the tab has a stable visible URL; do not close it through an unbound raw provider id."]
      );
    }
    const current = {
      ...state,
      title: stringOrNull(result?.title) ?? state.title,
      url: currentUrl,
      lastOpened: stringOrNull(result?.lastOpened) ?? state.lastOpened,
      seenAt: Date.now(),
    };
    this.#tabs.set(tabRef, current);
    const prepared = this.#storePreparedAction("close_tab", {
      tabRef,
      providerTabId: state.providerTabId,
      expectedUrl: currentUrl,
      cwd: effectiveCwd,
      workbenchGeneration: state.workbenchGeneration,
    });
    const { actionApprovalRef, expiresAt } = prepared;
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      action: {
        kind: "close_tab",
        tab: publicTab(current),
        expectedUrl: currentUrl,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context before closing this exact existing tab. A normal user tab may contain unsaved input or other in-tab state, so do not treat the legacy actionApprovalRef as permission evidence. Preparing did not claim, close, navigate, reload, focus, or otherwise mutate the tab.",
    };
  }

  async closeTab({ actionApprovalRef }) {
    const prepared = this.#takePreparedAction(actionApprovalRef, "close_tab");
    const effectiveCwd = prepared.cwd;
    await this.#requireReady(effectiveCwd);
    this.#assertPreparedGeneration(prepared);
    const state = this.#requirePreparedTab(prepared);

    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twReleaseError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  __twDispatchAttempted = true;
  await __twTab.close();
  __twPayload = {
    beforeUrl: __twBeforeUrl,
    closed: true,
  };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab && !__twDispatchAttempted) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twReleaseError = __twError;
    }
  }
}
if (__twDispatchAttempted && __twActionError) {
  const __twMessage = __twActionError instanceof Error ? __twActionError.message : String(__twActionError);
  if (/TOOLWIRE_BROWSER_CLOSE_RESULT_UNCERTAIN/i.test(__twMessage)) throw __twActionError;
  throw new Error("TOOLWIRE_BROWSER_CLOSE_RESULT_UNCERTAIN:" + __twMessage);
}
if (__twActionError) throw __twActionError;
if (__twReleaseError) throw __twReleaseError;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute prepared Chrome tab close", { mutationKind: "close_tab", expectedGeneration: prepared.workbenchGeneration });

    if (result?.closed !== true) {
      throw browserMutationResultUncertain(
        "close_tab",
        "Browser close_tab request returned without a confirmed close receipt after dispatch may have occurred."
      );
    }
    this.#tabs.delete(prepared.tabRef);
    if (this.#providerToRef.get(prepared.providerTabId) === prepared.tabRef) {
      this.#providerToRef.delete(prepared.providerTabId);
    }
    return {
      status: "closed",
      browser: "chrome",
      action: { kind: "close_tab" },
      tab: publicTab({
        ...state,
        url: prepared.expectedUrl,
      }),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      note: "Exactly one previously prepared existing Chrome tab was closed through the official Tab.close() primitive after the Browser runtime consumed the single-use ref and revalidated the same Workbench generation, provider identity, and current URL. The Browser runtime removed its local tabRef/provider mapping after the confirmed close. It did not close a window, batch-close tabs, navigate, reload, go back, focus another tab, or retry the close.",
    };
  }

  async prepareOpenTab({ url, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    const targetUrl = normalizeBrowserHttpUrl(url);
    await this.#requireReady(effectiveCwd);
    const prepared = this.#storePreparedAction("open_tab", {
      targetUrl,
      cwd: effectiveCwd,
      workbenchGeneration: this.#workbenchGeneration,
    });
    const { actionApprovalRef, expiresAt } = prepared;
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      action: {
        kind: "open_tab",
        toUrl: targetUrl,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context. If this bounded task does not require confirmation, or its task-level verbal confirmation is already satisfied, call codex.browser_open_tab immediately with this actionApprovalRef. Do not ask merely because the legacy ref name contains Approval. Preparing did not open or navigate any tab.",
    };
  }

  async openTab({ actionApprovalRef }) {
    const prepared = this.#takePreparedAction(actionApprovalRef, "open_tab");
    const effectiveCwd = prepared.cwd;
    await this.#requireReady(effectiveCwd);
    this.#assertPreparedGeneration(prepared);

    const targetUrlLiteral = JSON.stringify(prepared.targetUrl);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twDispatchAttempted = true;
  __twTab = await __twBrowser.tabs.new();
  await __twTab.goto(${targetUrlLiteral});
  await __twTab.playwright.waitForTimeout(250);
  const __twAfterUrl = (await __twTab.url()) ?? null;
  const __twAfterTitle = (await __twTab.title()) ?? null;
  const __twSnapshot = await __twTab.playwright.domSnapshot();
  __twPayload = {
    requestedUrl: ${targetUrlLiteral},
    afterUrl: __twAfterUrl,
    afterTitle: __twAfterTitle,
    snapshot: __twSnapshot,
  };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") {
        await __twBrowser.tabs.finalize({ keep: [{ tab: __twTab, status: "deliverable" }] });
      } else if (typeof __twTab.markDeliverable === "function") {
        await __twTab.markDeliverable();
      } else {
        throw new Error("TOOLWIRE_BROWSER_DELIVERABLE_API_UNAVAILABLE");
      }
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && (__twActionError || __twFinalizeError)) {
  const __twPrimary = __twActionError ?? __twFinalizeError;
  const __twPrimaryMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  const __twFinalizeSuffix = __twFinalizeError && __twActionError
    ? "; finalize also failed: " + (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError))
    : "";
  if (/TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twPrimary;
  throw new Error("TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN:" + __twPrimaryMessage + __twFinalizeSuffix);
}
if (__twActionError) throw __twActionError;
if (__twFinalizeError) throw __twFinalizeError;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute prepared Chrome new tab", { mutationKind: "open_tab", expectedGeneration: prepared.workbenchGeneration });

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    const snapshotTruncated = snapshot.length > BROWSER_POST_ACTION_MAX_CHARS;
    const afterUrl = stringOrNull(result?.afterUrl) ?? prepared.targetUrl;
    return {
      status: "opened",
      action: {
        kind: "open_tab",
        toUrl: prepared.targetUrl,
      },
      requestedUrl: prepared.targetUrl,
      afterUrl,
      redirected: afterUrl !== prepared.targetUrl,
      title: stringOrNull(result?.afterTitle),
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: "Exactly one previously prepared Chrome tab was created with the official browser.tabs.new(), navigated to the bound http(s) URL, and finalized as a user-visible deliverable tab. Call codex.browser_tabs to obtain its normal opaque tabRef before later read/click/fill/scroll work.",
    };
  }

  async scrollTab({ tabRef, direction = "down", amount = "page", cwd = this.#defaultCwd, maxChars = DEFAULT_MAX_SNAPSHOT_CHARS }) {
    const effectiveCwd = path.resolve(cwd);
    this.#assertTabRef(tabRef);
    if (direction !== "down" && direction !== "up") {
      throw new BrowserPreviewError("BROWSER_SCROLL_DIRECTION_INVALID", "direction must be exactly down or up");
    }
    if (amount !== "small" && amount !== "page") {
      throw new BrowserPreviewError("BROWSER_SCROLL_AMOUNT_INVALID", "amount must be exactly small or page");
    }
    if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > MAX_SNAPSHOT_CHARS) {
      throw new BrowserPreviewError(
        "BROWSER_MAX_CHARS_INVALID",
        `maxChars must be an integer between 1000 and ${MAX_SNAPSHOT_CHARS}`
      );
    }
    await this.#requireReady(effectiveCwd);
    const state = this.#requireKnownTab(tabRef);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const expectedUrlLiteral = JSON.stringify(state.url);
    const deltaY = (amount === "small" ? 400 : 800) * (direction === "down" ? 1 : -1);
    const keyName = amount === "page"
      ? (direction === "down" ? "PageDown" : "PageUp")
      : (direction === "down" ? "ArrowDown" : "ArrowUp");
    const keypresses = amount === "page" ? [keyName] : Array(6).fill(keyName);
    const keypressesLiteral = JSON.stringify(keypresses);
    const dispatch = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twScrollReturned = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  __twDispatchAttempted = true;
  const __twBody = __twTab.playwright.locator("body");
  for (const __twKey of ${keypressesLiteral}) {
    await __twBody.press(__twKey, { timeoutMs: 3000 });
  }
  __twScrollReturned = true;
  __twPayload = { beforeUrl: __twBeforeUrl, scrollReturned: true, inputMethod: "body-keypress", keypresses: ${keypressesLiteral}, settleCompleted: false };
  await __twTab.playwright.waitForTimeout(350);
  __twPayload.settleCompleted = true;
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && !__twScrollReturned) {
  const __twPrimaryMessage = __twActionError instanceof Error ? __twActionError.message : String(__twActionError ?? "scroll did not return");
  if (/TOOLWIRE_BROWSER_SCROLL_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twActionError;
  throw new Error("TOOLWIRE_BROWSER_SCROLL_RESULT_UNCERTAIN:" + __twPrimaryMessage);
}
if (__twActionError && !__twScrollReturned) throw __twActionError;
if (!__twPayload) __twPayload = { beforeUrl: ${expectedUrlLiteral}, scrollReturned: __twScrollReturned, settleCompleted: false };
__twPayload.settleError = __twActionError ? (__twActionError instanceof Error ? __twActionError.message : String(__twActionError)) : null;
__twPayload.cleanupStatus = __twFinalizeError ? "uncertain" : "released";
__twPayload.cleanupError = __twFinalizeError ? (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError)) : null;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Dispatch bounded Chrome scroll", { mutationKind: "scroll", expectedGeneration: state.workbenchGeneration });

    let readback = null;
    let readbackError = null;
    try {
      readback = await this.readTab({ tabRef, cwd: effectiveCwd, maxChars });
    } catch (error) {
      readbackError = classifyBrowserError(error);
    }

    const current = this.#tabs.get(tabRef) ?? state;
    const snapshot = typeof readback?.snapshot === "string" ? readback.snapshot : "";
    return {
      status: "scrolled",
      browser: "chrome",
      tab: publicTab(current),
      direction,
      amount,
      deltaY,
      inputMethod: stringOrNull(dispatch?.inputMethod) ?? "body-keypress",
      keypresses: Array.isArray(dispatch?.keypresses) ? dispatch.keypresses.filter((value) => typeof value === "string") : keypresses,
      dispatchStatus: "confirmed",
      scrollReturned: dispatch?.scrollReturned === true,
      settleCompleted: dispatch?.settleCompleted === true,
      settleError: stringOrNull(dispatch?.settleError),
      cleanupStatus: dispatch?.cleanupStatus === "released" ? "released" : "uncertain",
      cleanupError: stringOrNull(dispatch?.cleanupError),
      beforeUrl: stringOrNull(dispatch?.beforeUrl) ?? state.url,
      afterUrl: current.url,
      urlChanged: current.url !== state.url,
      readbackStatus: readback ? "ok" : "unavailable",
      readbackError: readbackError ? {
        code: readbackError.code ?? "BROWSER_SCROLL_READBACK_FAILED",
        message: readbackError.message,
        nextActions: Array.isArray(readbackError.nextActions) ? readbackError.nextActions : [],
      } : null,
      beforeSnapshotChars: null,
      snapshotChanged: null,
      snapshot,
      snapshotChars: Number.isInteger(readback?.snapshotChars) ? readback.snapshotChars : snapshot.length,
      snapshotTruncated: readback?.snapshotTruncated === true,
      note: readback
        ? "One bounded page scroll returned successfully through an official Chrome Playwright keypress targeted at the fixed document body, then the Browser runtime performed a separate read-only DOM readback. Page-sized scroll uses PageDown/PageUp; small scroll uses a bounded ArrowDown/ArrowUp sequence. This avoids the Chrome Input.synthesizeScrollGesture timeout observed on Reddit while keeping caller coordinates/selectors unavailable. The scroll receipt is independent from readback, so a later read failure cannot turn an already-confirmed scroll into an uncertain mutation."
        : "One bounded page scroll returned successfully through an official Chrome Playwright keypress targeted at the fixed document body. The separate read-only DOM readback failed, but the Browser runtime does not mark the confirmed scroll uncertain and does not repeat the scroll automatically; re-read the tab if page content is still needed.",
    };
  }

  async keypressTab({ tabRef, key, cwd = this.#defaultCwd, maxChars = DEFAULT_MAX_SNAPSHOT_CHARS }) {
    const effectiveCwd = path.resolve(cwd);
    this.#assertTabRef(tabRef);
    if (!BROWSER_FIXED_KEYS.has(key)) {
      throw new BrowserPreviewError("BROWSER_KEYPRESS_KEY_INVALID", "key must be exactly Enter, Tab, or Escape");
    }
    if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > MAX_SNAPSHOT_CHARS) {
      throw new BrowserPreviewError(
        "BROWSER_MAX_CHARS_INVALID",
        `maxChars must be an integer between 1000 and ${MAX_SNAPSHOT_CHARS}`
      );
    }
    await this.#requireReady(effectiveCwd);
    const state = this.#requireKnownTab(tabRef);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const expectedUrlLiteral = JSON.stringify(state.url);
    const keyLiteral = JSON.stringify(key);
    const dispatch = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twKeypressReturned = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  __twDispatchAttempted = true;
  await __twTab.dom_cua.keypress({ keys: [${keyLiteral}] });
  __twKeypressReturned = true;
  __twPayload = {
    beforeUrl: __twBeforeUrl,
    keypressReturned: true,
    inputMethod: "focused-keypress",
    key: ${keyLiteral},
    settleCompleted: false,
  };
  await __twTab.playwright.waitForTimeout(250);
  __twPayload.afterUrl = (await __twTab.url()) ?? null;
  __twPayload.afterTitle = (await __twTab.title()) ?? null;
  __twPayload.settleCompleted = true;
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && !__twKeypressReturned) {
  const __twPrimaryMessage = __twActionError instanceof Error ? __twActionError.message : String(__twActionError ?? "keypress did not return");
  if (/TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twActionError;
  throw new Error("TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN:" + __twPrimaryMessage);
}
if (__twActionError && !__twKeypressReturned) throw __twActionError;
if (!__twPayload) __twPayload = { beforeUrl: ${expectedUrlLiteral}, keypressReturned: __twKeypressReturned, key: ${keyLiteral}, settleCompleted: false };
__twPayload.settleError = __twActionError ? (__twActionError instanceof Error ? __twActionError.message : String(__twActionError)) : null;
__twPayload.cleanupStatus = __twFinalizeError ? "uncertain" : "released";
__twPayload.cleanupError = __twFinalizeError ? (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError)) : null;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Dispatch fixed Chrome keypress", { mutationKind: "keypress", expectedGeneration: state.workbenchGeneration });

    const afterUrl = stringOrNull(dispatch?.afterUrl) ?? state.url;
    const afterTitle = stringOrNull(dispatch?.afterTitle) ?? state.title;
    const currentState = {
      ...state,
      url: afterUrl,
      title: afterTitle,
      seenAt: Date.now(),
    };
    this.#tabs.set(tabRef, currentState);

    let readback = null;
    let readbackError = null;
    try {
      readback = await this.readTab({ tabRef, cwd: effectiveCwd, maxChars });
    } catch (error) {
      readbackError = classifyBrowserError(error);
    }
    const current = this.#tabs.get(tabRef) ?? currentState;
    const snapshot = typeof readback?.snapshot === "string" ? readback.snapshot : "";
    return {
      status: "pressed",
      browser: "chrome",
      tab: publicTab(current),
      key,
      inputMethod: stringOrNull(dispatch?.inputMethod) ?? "focused-keypress",
      dispatchStatus: "confirmed",
      keypressReturned: dispatch?.keypressReturned === true,
      settleCompleted: dispatch?.settleCompleted === true,
      settleError: stringOrNull(dispatch?.settleError),
      cleanupStatus: dispatch?.cleanupStatus === "released" ? "released" : "uncertain",
      cleanupError: stringOrNull(dispatch?.cleanupError),
      beforeUrl: stringOrNull(dispatch?.beforeUrl) ?? state.url,
      afterUrl: current.url,
      urlChanged: current.url !== state.url,
      readbackStatus: readback ? "ok" : "unavailable",
      readbackError: readbackError ? {
        code: readbackError.code ?? "BROWSER_KEYPRESS_READBACK_FAILED",
        message: readbackError.message,
        nextActions: Array.isArray(readbackError.nextActions) ? readbackError.nextActions : [],
      } : null,
      snapshot,
      snapshotChars: Number.isInteger(readback?.snapshotChars) ? readback.snapshotChars : snapshot.length,
      snapshotTruncated: readback?.snapshotTruncated === true,
      note: readback
        ? "Exactly one fixed Enter/Tab/Escape keypress returned successfully through the official Chrome DOM CUA keypress API at the page's currently focused element, then the Browser runtime performed a separate read-only DOM readback. Callers cannot supply arbitrary keys, modifiers, text, selectors, coordinates, repeats, or JavaScript. Enter may submit or activate the focused control, so apply the current Codex Browser confirmation policy and task context before calling when that representational/external side effect is possible. A later readback failure cannot turn a confirmed keypress uncertain and the Browser runtime never repeats it automatically."
        : "Exactly one fixed Enter/Tab/Escape keypress returned successfully through the official Chrome DOM CUA keypress API at the page's currently focused element. The separate read-only DOM readback failed, but the Browser runtime does not mark the confirmed keypress uncertain and does not repeat it automatically; re-read the tab if page content is still needed.",
    };
  }

  async prepareNavigate({ tabRef, url, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    this.#assertTabRef(tabRef);
    const targetUrl = normalizeBrowserHttpUrl(url);
    await this.#requireReady(effectiveCwd);
    const state = this.#requireKnownTab(tabRef);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
nodeRepl.write(JSON.stringify({
  title: __twInfo.title ?? null,
  url: __twInfo.url ?? null,
  lastOpened: __twInfo.lastOpened ?? null,
}));
`, "Prepare exact Chrome navigation", { expectedGeneration: state.workbenchGeneration });

    const currentUrl = stringOrNull(result?.url) ?? state.url;
    if (currentUrl === targetUrl) {
      throw new BrowserPreviewError(
        "BROWSER_NAVIGATE_SAME_URL",
        "The selected Chrome tab is already on the exact requested URL; direct navigation would only reload it",
        ["Use codex.browser_read for the current page, or prepare an explicit page action instead of reloading it implicitly."]
      );
    }
    const prepared = this.#storePreparedAction("navigate", {
      tabRef,
      providerTabId: state.providerTabId,
      expectedUrl: currentUrl,
      targetUrl,
      cwd: effectiveCwd,
      workbenchGeneration: state.workbenchGeneration,
    });
    const { actionApprovalRef, expiresAt } = prepared;
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      action: {
        kind: "navigate",
        tab: publicTab({
          ...state,
          title: stringOrNull(result?.title) ?? state.title,
          url: currentUrl,
          lastOpened: stringOrNull(result?.lastOpened) ?? state.lastOpened,
        }),
        fromUrl: currentUrl,
        toUrl: targetUrl,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context. Ordinary navigation should proceed without a redundant prompt; if this bounded task already has any required task-level verbal confirmation, call codex.browser_navigate immediately with this actionApprovalRef. The legacy ref name is not permission evidence. Preparing did not change the page or open a new tab.",
    };
  }

  async navigate({ actionApprovalRef }) {
    const prepared = this.#takePreparedAction(actionApprovalRef, "navigate");
    const effectiveCwd = prepared.cwd;
    await this.#requireReady(effectiveCwd);
    this.#assertPreparedGeneration(prepared);
    const state = this.#requirePreparedTab(prepared);

    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const targetUrlLiteral = JSON.stringify(prepared.targetUrl);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  __twDispatchAttempted = true;
  await __twTab.goto(${targetUrlLiteral});
  await __twTab.playwright.waitForTimeout(250);
  const __twAfterUrl = (await __twTab.url()) ?? null;
  const __twAfterTitle = (await __twTab.title()) ?? null;
  const __twSnapshot = await __twTab.playwright.domSnapshot();
  __twPayload = {
    beforeUrl: __twBeforeUrl,
    requestedUrl: ${targetUrlLiteral},
    afterUrl: __twAfterUrl,
    afterTitle: __twAfterTitle,
    snapshot: __twSnapshot,
  };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && (__twActionError || __twFinalizeError)) {
  const __twPrimary = __twActionError ?? __twFinalizeError;
  const __twPrimaryMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  const __twFinalizeSuffix = __twFinalizeError && __twActionError
    ? "; finalize also failed: " + (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError))
    : "";
  if (/TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twPrimary;
  throw new Error("TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN:" + __twPrimaryMessage + __twFinalizeSuffix);
}
if (__twActionError) throw __twActionError;
if (__twFinalizeError) throw __twFinalizeError;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute prepared Chrome navigation", { mutationKind: "navigate", expectedGeneration: prepared.workbenchGeneration });

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    const snapshotTruncated = snapshot.length > BROWSER_POST_ACTION_MAX_CHARS;
    const current = {
      ...state,
      title: stringOrNull(result?.afterTitle) ?? state.title,
      url: stringOrNull(result?.afterUrl) ?? prepared.targetUrl,
      seenAt: Date.now(),
    };
    this.#tabs.set(prepared.tabRef, current);
    return {
      status: "navigated",
      action: {
        kind: "navigate",
        toUrl: prepared.targetUrl,
      },
      tab: publicTab(current),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      requestedUrl: prepared.targetUrl,
      afterUrl: current.url,
      redirected: current.url !== prepared.targetUrl,
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: "Exactly one previously prepared existing-tab navigation was dispatched after the caller applied the current Browser confirmation policy and task context. The legacy actionApprovalRef is only an exact-action binding, not proof of user approval. The Browser runtime revalidated the same starting tab URL, used the official Chrome tab.goto() for the bound http(s) destination, read back the resulting page state, released the claimed user tab, and did not click, fill, submit, or open a new tab.",
    };
  }

  async prepareClick({ tabRef, role, name, text, scopeUrl, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    this.#assertTabRef(tabRef);
    const normalizedRole = typeof role === "string" ? role.trim() : "";
    const normalizedName = typeof name === "string" ? name.trim() : "";
    const normalizedText = typeof text === "string" ? text.trim() : "";
    const textMode = typeof text === "string";
    const scopeMode = typeof scopeUrl === "string";
    if (textMode && (normalizedRole || normalizedName || scopeMode)) {
      throw new BrowserPreviewError(
        "BROWSER_CLICK_TARGET_CONFLICT",
        "Browser click preparation accepts either exact visible text, or role+name with an optional exact scopeUrl; do not mix the modes"
      );
    }
    if (textMode) {
      if (!normalizedText) {
        throw new BrowserPreviewError("BROWSER_CLICK_TEXT_REQUIRED", "text must contain the exact visible text of the click target");
      }
      if (normalizedText.length > 2_048) {
        throw new BrowserPreviewError("BROWSER_CLICK_TEXT_TOO_LONG", "Browser exact visible-text targets are limited to 2048 characters");
      }
    } else {
      if (!normalizedRole) {
        throw new BrowserPreviewError("BROWSER_ROLE_REQUIRED", "role is required unless exact visible text mode is used");
      }
      if (!normalizedName) {
        throw new BrowserPreviewError("BROWSER_NAME_REQUIRED", "name is required and must be the exact accessible name of the target element");
      }
    }
    const normalizedScopeUrl = scopeMode ? normalizeBrowserHttpUrl(scopeUrl) : null;
    const clickTarget = textMode
      ? { kind: "text", text: normalizedText }
      : {
          kind: "role",
          role: normalizedRole,
          name: normalizedName,
          ...(normalizedScopeUrl ? { scopeUrl: normalizedScopeUrl } : {}),
        };
    await this.#requireReady(effectiveCwd);
    const state = this.#requireKnownTab(tabRef);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const clickLocatorSetupSource = browserClickLocatorSetupSource(clickTarget);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  const __twTitle = (await __twTab.title()) ?? __twInfo.title ?? null;
  ${clickLocatorSetupSource}
  if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount);
  const __twVisible = await __twLocator.isVisible();
  if (!__twVisible) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
  const __twEnabled = await __twLocator.isEnabled();
  if (!__twEnabled) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
  __twPayload = {
    title: __twTitle,
    url: __twUrl,
    count: __twCount,
    visible: __twVisible,
    enabled: __twEnabled,
    resolvedKind: __twResolvedKind,
    resolvedRole: __twResolvedRole,
    resolvedClickBinding: __twResolvedClickBinding,
  };
} finally {
  if (__twTab) if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
}
nodeRepl.write(JSON.stringify(__twPayload));
`, "Prepare exact Chrome click", { expectedGeneration: state.workbenchGeneration });

    const prepared = this.#storePreparedAction("click", {
      tabRef,
      providerTabId: state.providerTabId,
      expectedUrl: stringOrNull(result?.url) ?? state.url,
      cwd: effectiveCwd,
      target: clickTarget,
      textBinding: clickTarget.kind === "text"
        ? browserTextBindingFromPrepareResult(result)
        : null,
      workbenchGeneration: state.workbenchGeneration,
    });
    const { actionApprovalRef, expiresAt } = prepared;
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      action: {
        kind: "click",
        tab: publicTab({
          ...state,
          title: stringOrNull(result?.title) ?? state.title,
          url: stringOrNull(result?.url) ?? state.url,
        }),
        ...(prepared.target.kind === "text"
          ? { targetKind: "text", text: prepared.target.text }
          : {
              targetKind: "role",
              role: prepared.target.role,
              name: prepared.target.name,
              ...(prepared.target.scopeUrl ? { scopeUrl: prepared.target.scopeUrl } : {}),
            }),
        exact: true,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context to the prepared target. If this click is ordinary navigation/expansion or the bounded task's required verbal confirmation is already satisfied, call codex.browser_click immediately with this actionApprovalRef. Ask only when the policy/task actually requires it; do not ask merely because this is a click or because the legacy ref name contains Approval. Preparing did not click or mutate the page.",
    };
  }

  async click({ actionApprovalRef }) {
    const prepared = this.#takePreparedAction(actionApprovalRef, "click");
    const effectiveCwd = prepared.cwd;
    await this.#requireReady(effectiveCwd);
    this.#assertPreparedGeneration(prepared);
    const state = this.#requirePreparedTab(prepared);

    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const clickLocatorSetupSource = browserClickLocatorSetupSource(prepared.target, {
      binding: prepared.textBinding,
    });
    const localRadioBinding = prepared.textBinding?.kind === "local-radio" ? prepared.textBinding : null;
    const localRadioDispatchSource = localRadioBinding
      ? `
  let __twRadioAncestor = __twTextLocator;
  for (let __twDepth = 0; __twDepth < ${localRadioBinding.depth}; __twDepth += 1) {
    __twRadioAncestor = __twRadioAncestor.locator("..");
  }
  const __twDispatchLocator = __twRadioAncestor.locator('input[type="radio"]:not(:disabled)');
  const __twDispatchCount = await __twDispatchLocator.count();
  if (__twDispatchCount !== 1) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED");`
      : `const __twDispatchLocator = __twLocator;`;
    const clickDispatchSource = localRadioBinding
      ? `await __twDispatchLocator.check({ timeoutMs: 5000 });\n  if (!(await __twDispatchLocator.isChecked())) throw new Error("TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:radio not checked after dispatch");`
      : `await __twDispatchLocator.click({ timeoutMs: 5000 });`;
    const flairTemplateBinding = prepared.textBinding?.kind === "flair-template-option" ? prepared.textBinding : null;
    const postClickVerificationSource = flairTemplateBinding
      ? `
  const __twFlairSelectorDepth = await __twLocator.evaluate((element, maxDepth) => {
    let current = element;
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
      if (current.classList?.contains?.("flairselector")) return depth;
      current = current.parentElement;
    }
    return null;
  }, 4);
  if (!Number.isInteger(__twFlairSelectorDepth)) throw new Error("TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:flair selector scope changed after dispatch");
  let __twFlairSelector = __twLocator;
  for (let __twDepth = 0; __twDepth < __twFlairSelectorDepth; __twDepth += 1) {
    __twFlairSelector = __twFlairSelector.locator("..");
  }
  const __twFlairHidden = __twFlairSelector.locator('input[type="hidden"][name="flair_template_id"]');
  const __twFlairHiddenCount = await __twFlairHidden.count();
  if (__twFlairHiddenCount !== 1) throw new Error("TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:flair template hidden input changed after dispatch");
  const __twFlairValues = await __twFlairHidden.evaluateAll((elements) => elements.map((element) => typeof element?.value === "string" ? element.value : null));
  const __twFlairValue = __twFlairValues.length === 1 ? __twFlairValues[0] : null;
  if (__twFlairValue !== ${JSON.stringify(flairTemplateBinding.templateId)}) throw new Error("TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:flair template selection not reflected after dispatch");`
      : "";
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  ${clickLocatorSetupSource}
  if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount);
  const __twVisible = await __twLocator.isVisible();
  if (!__twVisible) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
  const __twEnabled = await __twLocator.isEnabled();
  if (!__twEnabled) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
  ${localRadioDispatchSource}
  __twDispatchAttempted = true;
  ${clickDispatchSource}
  await __twTab.playwright.waitForTimeout(250);
  ${postClickVerificationSource}
  const __twAfterUrl = (await __twTab.url()) ?? null;
  const __twAfterTitle = (await __twTab.title()) ?? null;
  const __twSnapshot = await __twTab.playwright.domSnapshot();
  __twPayload = {
    beforeUrl: __twBeforeUrl,
    afterUrl: __twAfterUrl,
    afterTitle: __twAfterTitle,
    snapshot: __twSnapshot,
  };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && (__twActionError || __twFinalizeError)) {
  const __twPrimary = __twActionError ?? __twFinalizeError;
  const __twPrimaryMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  const __twFinalizeSuffix = __twFinalizeError && __twActionError
    ? "; finalize also failed: " + (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError))
    : "";
  if (/TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twPrimary;
  throw new Error("TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:" + __twPrimaryMessage + __twFinalizeSuffix);
}
if (__twActionError) throw __twActionError;
if (__twFinalizeError) throw __twFinalizeError;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute prepared Chrome click", { mutationKind: "click", expectedGeneration: prepared.workbenchGeneration });

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    const snapshotTruncated = snapshot.length > BROWSER_POST_ACTION_MAX_CHARS;
    const current = {
      ...state,
      title: stringOrNull(result?.afterTitle) ?? state.title,
      url: stringOrNull(result?.afterUrl) ?? state.url,
      seenAt: Date.now(),
    };
    this.#tabs.set(prepared.tabRef, current);
    return {
      status: "clicked",
      action: {
        kind: "click",
        ...(prepared.target.kind === "text"
          ? { targetKind: "text", text: prepared.target.text }
          : {
              targetKind: "role",
              role: prepared.target.role,
              name: prepared.target.name,
              ...(prepared.target.scopeUrl ? { scopeUrl: prepared.target.scopeUrl } : {}),
            }),
        exact: true,
      },
      tab: publicTab(current),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      afterUrl: current.url,
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: "Exactly one previously prepared click was dispatched after the caller applied the current Browser confirmation policy and task context. The legacy actionApprovalRef is only an exact-action binding, not proof of user approval. The Browser runtime revalidated the tab URL and the same unique visible enabled exact target immediately before dispatch, then read back current page state and released the claimed user tab.",
    };
  }

  async prepareDownload({ tabRef, role, name, text, cwd = this.#defaultCwd }) {
    const preparedClick = await this.prepareClick({ tabRef, role, name, text, cwd });
    const prepared = this.#promotePreparedClick(preparedClick.actionApprovalRef, "download");
    if (!prepared) {
      throw new BrowserPreviewError(
        "BROWSER_DOWNLOAD_PREPARE_FAILED",
        "Browser download preparation could not bind the exact target"
      );
    }
    return {
      ...preparedClick,
      action: {
        ...preparedClick.action,
        kind: "download",
      },
      nextAction: "Apply codex.browser_confirmation_policy and the current bounded task context before creating the local download. If the task already authorizes this exact download, call codex.browser_download with this actionApprovalRef. Preparing did not click the target or create a local file.",
    };
  }

  async download({ actionApprovalRef }) {
    const prepared = this.#takePreparedAction(actionApprovalRef, "download");
    const effectiveCwd = prepared.cwd;
    await this.#requireReady(effectiveCwd);
    this.#assertPreparedGeneration(prepared);
    const state = this.#requirePreparedTab(prepared);

    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const clickLocatorSetupSource = browserClickLocatorSetupSource(prepared.target, {
      binding: prepared.textBinding,
    });
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twClickReturned = false;
let __twDownloadConfirmed = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  ${clickLocatorSetupSource}
  if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount);
  const __twVisible = await __twLocator.isVisible();
  if (!__twVisible) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
  const __twEnabled = await __twLocator.isEnabled();
  if (!__twEnabled) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
  const __twDownloadPromise = __twTab.playwright.waitForEvent("download", { timeoutMs: 10000 });
  __twDispatchAttempted = true;
  await __twLocator.click({ timeoutMs: 5000 });
  __twClickReturned = true;
  const __twDownload = await __twDownloadPromise;
  __twDownloadConfirmed = true;
  let __twDownloadPath = null;
  let __twPathError = null;
  try {
    if (typeof __twDownload?.path === "function") {
      __twDownloadPath = await __twDownload.path();
    } else {
      __twPathError = "download.path() is unavailable in this Chrome runtime";
    }
  } catch (__twError) {
    __twPathError = __twError instanceof Error ? __twError.message : String(__twError);
  }
  let __twAfterUrl = __twBeforeUrl;
  let __twAfterTitle = (await __twTab.title()) ?? __twInfo.title ?? null;
  let __twSnapshot = "";
  let __twReadbackError = null;
  try {
    await __twTab.playwright.waitForTimeout(250);
    __twAfterUrl = (await __twTab.url()) ?? __twAfterUrl;
    __twAfterTitle = (await __twTab.title()) ?? __twAfterTitle;
    __twSnapshot = await __twTab.playwright.domSnapshot();
  } catch (__twError) {
    __twReadbackError = __twError instanceof Error ? __twError.message : String(__twError);
  }
  __twPayload = {
    beforeUrl: __twBeforeUrl,
    afterUrl: __twAfterUrl,
    afterTitle: __twAfterTitle,
    snapshot: __twSnapshot,
    clickReturned: __twClickReturned,
    downloadConfirmed: true,
    downloadPath: __twDownloadPath,
    pathError: __twPathError,
    readbackError: __twReadbackError,
  };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && !__twDownloadConfirmed && (__twActionError || __twFinalizeError)) {
  const __twPrimary = __twActionError ?? __twFinalizeError;
  const __twPrimaryMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  const __twFinalizeSuffix = __twFinalizeError && __twActionError
    ? "; finalize also failed: " + (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError))
    : "";
  if (/TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twPrimary;
  throw new Error("TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN:" + __twPrimaryMessage + __twFinalizeSuffix);
}
if (__twActionError) throw __twActionError;
if (!__twPayload) throw new Error("TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN:download dispatch produced no confirmation receipt");
__twPayload.cleanupStatus = __twFinalizeError ? "uncertain" : "released";
__twPayload.cleanupError = __twFinalizeError ? (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError)) : null;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute prepared Chrome download", { mutationKind: "download", expectedGeneration: prepared.workbenchGeneration });

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    const snapshotTruncated = snapshot.length > BROWSER_POST_ACTION_MAX_CHARS;
    const current = {
      ...state,
      title: stringOrNull(result?.afterTitle) ?? state.title,
      url: stringOrNull(result?.afterUrl) ?? state.url,
      seenAt: Date.now(),
    };
    this.#tabs.set(prepared.tabRef, current);
    const downloadPath = stringOrNull(result?.downloadPath);
    return {
      status: "downloaded",
      action: {
        kind: "download",
        ...(prepared.target.kind === "text"
          ? { targetKind: "text", text: prepared.target.text }
          : {
              targetKind: "role",
              role: prepared.target.role,
              name: prepared.target.name,
              ...(prepared.target.scopeUrl ? { scopeUrl: prepared.target.scopeUrl } : {}),
            }),
        exact: true,
      },
      tab: publicTab(current),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      afterUrl: current.url,
      downloadConfirmed: result?.downloadConfirmed === true,
      downloadPath,
      downloadFileName: downloadPath ? path.basename(downloadPath) : null,
      pathStatus: downloadPath ? "available" : "unavailable",
      pathError: stringOrNull(result?.pathError),
      readbackStatus: result?.readbackError ? "unavailable" : "ok",
      readbackError: stringOrNull(result?.readbackError),
      cleanupStatus: result?.cleanupStatus === "released" ? "released" : "uncertain",
      cleanupError: stringOrNull(result?.cleanupError),
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: downloadPath
        ? "Exactly one prepared semantic target produced a confirmed Chrome download event. The Browser runtime returns the browser-managed local download path but does not open, parse, execute, upload, or trust the downloaded file; downloaded content remains untrusted. A later page-read or cleanup failure never causes an automatic repeat download."
        : "Exactly one prepared semantic target produced a confirmed Chrome download event, but this Chrome runtime did not expose a usable download path. The Browser runtime does not repeat the download automatically because the file may already exist in the browser's configured download location.",
    };
  }

  async prepareUpload({ tabRef, role, name, text, filePath, cwd = this.#defaultCwd }) {
    if (!this.#authorityExecutor) {
      throw new BrowserPreviewError(
        "BROWSER_UPLOAD_AUTHORITY_UNAVAILABLE",
        "Browser upload requires the local Codex authority resolver so local file paths cannot bypass project trust boundaries"
      );
    }
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new BrowserPreviewError("BROWSER_UPLOAD_FILE_REQUIRED", "filePath must identify one existing file inside the current Codex trusted authority root");
    }
    const authorizedFile = await resolveAuthorizedExistingFile({
      authorityExecutor: this.#authorityExecutor,
      path: filePath.trim(),
      cwd,
      includeSha256: true,
      maxBytes: MAX_BROWSER_UPLOAD_BYTES,
    });
    const preparedClick = await this.prepareClick({
      tabRef,
      role,
      name,
      text,
      cwd: authorizedFile.cwd,
    });
    const prepared = this.#promotePreparedClick(preparedClick.actionApprovalRef, "upload", {
      uploadFile: {
        path: authorizedFile.path,
        fileName: path.basename(authorizedFile.path),
        byteLength: authorizedFile.byteLength,
        sha256: authorizedFile.sha256,
        trustedAncestor: authorizedFile.trustedAncestor,
      },
    });
    if (!prepared) {
      throw new BrowserPreviewError(
        "BROWSER_UPLOAD_PREPARE_FAILED",
        "Browser upload preparation could not bind the exact file chooser target"
      );
    }
    return {
      ...preparedClick,
      action: {
        ...preparedClick.action,
        kind: "upload",
        fileName: prepared.uploadFile.fileName,
        byteLength: prepared.uploadFile.byteLength,
        sha256: prepared.uploadFile.sha256,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context before transmitting the prepared local file to this exact webpage target. Uploading personal or sensitive files requires the policy's action-time confirmation unless the user's bounded task already clearly authorizes that specific file and destination. Then call codex.browser_upload with this actionApprovalRef. Preparing did not click the file input or expose file contents to the page.",
    };
  }

  async upload({ actionApprovalRef }) {
    const prepared = this.#takePreparedAction(actionApprovalRef, "upload");
    const effectiveCwd = prepared.cwd;
    let currentUploadFile;
    try {
      currentUploadFile = await resolveAuthorizedExistingFile({
        authorityExecutor: this.#authorityExecutor,
        path: prepared.uploadFile.path,
        cwd: effectiveCwd,
        includeSha256: true,
        maxBytes: MAX_BROWSER_UPLOAD_BYTES,
      });
    } catch (error) {
      throw new BrowserPreviewError(
        "BROWSER_UPLOAD_SOURCE_CHANGED",
        `Prepared upload source is no longer the same authorized existing file: ${error instanceof Error ? error.message : String(error)}`,
        ["Do not upload this prepared ref. Re-read/inspect the intended local file and prepare a fresh upload if it is still the file the user meant to send."]
      );
    }
    if (
      currentUploadFile.path !== prepared.uploadFile.path ||
      currentUploadFile.byteLength !== prepared.uploadFile.byteLength ||
      currentUploadFile.sha256 !== prepared.uploadFile.sha256
    ) {
      throw new BrowserPreviewError(
        "BROWSER_UPLOAD_SOURCE_CHANGED",
        "Prepared upload source changed after preparation; canonical path, byte length, or SHA-256 no longer matches the server-bound file",
        ["Do not upload this prepared ref. Inspect the current file and prepare a fresh upload only if the current content is still intended for this destination."]
      );
    }
    await this.#requireReady(effectiveCwd);
    this.#assertPreparedGeneration(prepared);
    const state = this.#requirePreparedTab(prepared);

    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const uploadPathLiteral = JSON.stringify(prepared.uploadFile.path);
    const clickLocatorSetupSource = browserClickLocatorSetupSource(prepared.target, {
      binding: prepared.textBinding,
    });
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twChooserConfirmed = false;
let __twSetFilesReturned = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  ${clickLocatorSetupSource}
  if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount);
  const __twVisible = await __twLocator.isVisible();
  if (!__twVisible) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
  const __twEnabled = await __twLocator.isEnabled();
  if (!__twEnabled) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
  const __twChooserPromise = __twTab.playwright.waitForEvent("filechooser", { timeoutMs: 10000 });
  __twDispatchAttempted = true;
  await __twLocator.click({ timeoutMs: 5000 });
  const __twChooser = await __twChooserPromise;
  __twChooserConfirmed = true;
  const __twMultiple = __twChooser.isMultiple();
  await __twChooser.setFiles([${uploadPathLiteral}], { timeoutMs: 10000 });
  __twSetFilesReturned = true;
  let __twAfterUrl = __twBeforeUrl;
  let __twAfterTitle = (await __twTab.title()) ?? __twInfo.title ?? null;
  let __twSnapshot = "";
  let __twReadbackError = null;
  try {
    await __twTab.playwright.waitForTimeout(250);
    __twAfterUrl = (await __twTab.url()) ?? __twAfterUrl;
    __twAfterTitle = (await __twTab.title()) ?? __twAfterTitle;
    __twSnapshot = await __twTab.playwright.domSnapshot();
  } catch (__twError) {
    __twReadbackError = __twError instanceof Error ? __twError.message : String(__twError);
  }
  __twPayload = {
    beforeUrl: __twBeforeUrl,
    afterUrl: __twAfterUrl,
    afterTitle: __twAfterTitle,
    snapshot: __twSnapshot,
    chooserConfirmed: true,
    multiple: __twMultiple,
    setFilesReturned: true,
    readbackError: __twReadbackError,
  };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && !__twSetFilesReturned && (__twActionError || __twFinalizeError)) {
  const __twPrimary = __twActionError ?? __twFinalizeError;
  const __twPrimaryMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  const __twFinalizeSuffix = __twFinalizeError && __twActionError
    ? "; finalize also failed: " + (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError))
    : "";
  if (/TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twPrimary;
  throw new Error("TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN:" + __twPrimaryMessage + __twFinalizeSuffix);
}
if (__twActionError) throw __twActionError;
if (!__twPayload || !__twChooserConfirmed || !__twSetFilesReturned) {
  throw new Error("TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN:file chooser dispatch produced no confirmed setFiles receipt");
}
__twPayload.cleanupStatus = __twFinalizeError ? "uncertain" : "released";
__twPayload.cleanupError = __twFinalizeError ? (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError)) : null;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute prepared Chrome upload", { mutationKind: "upload", expectedGeneration: prepared.workbenchGeneration });

    let postUploadFile;
    try {
      postUploadFile = await resolveAuthorizedExistingFile({
        authorityExecutor: this.#authorityExecutor,
        path: prepared.uploadFile.path,
        cwd: effectiveCwd,
        includeSha256: true,
        maxBytes: MAX_BROWSER_UPLOAD_BYTES,
      });
    } catch (error) {
      throw new BrowserPreviewError(
        "BROWSER_UPLOAD_SOURCE_CHANGED_AFTER_DISPATCH",
        `Upload source could not be revalidated after setFiles returned: ${error instanceof Error ? error.message : String(error)}`,
        ["Do not retry automatically. The page already received a file selection event; inspect page state and the local file before deciding what happened."]
      );
    }
    if (
      postUploadFile.path !== prepared.uploadFile.path ||
      postUploadFile.byteLength !== prepared.uploadFile.byteLength ||
      postUploadFile.sha256 !== prepared.uploadFile.sha256
    ) {
      throw new BrowserPreviewError(
        "BROWSER_UPLOAD_SOURCE_CHANGED_AFTER_DISPATCH",
        "Upload source changed during the dispatch window; the Browser runtime cannot prove which version the page observed",
        ["Do not retry automatically. Inspect page state and the current local file; prepare a new upload only after the desired content is stable and clearly authorized."]
      );
    }

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    const snapshotTruncated = snapshot.length > BROWSER_POST_ACTION_MAX_CHARS;
    const current = {
      ...state,
      title: stringOrNull(result?.afterTitle) ?? state.title,
      url: stringOrNull(result?.afterUrl) ?? state.url,
      seenAt: Date.now(),
    };
    this.#tabs.set(prepared.tabRef, current);
    return {
      status: "file_selected",
      action: {
        kind: "upload",
        ...(prepared.target.kind === "text"
          ? { targetKind: "text", text: prepared.target.text }
          : {
              targetKind: "role",
              role: prepared.target.role,
              name: prepared.target.name,
              ...(prepared.target.scopeUrl ? { scopeUrl: prepared.target.scopeUrl } : {}),
            }),
        exact: true,
      },
      tab: publicTab(current),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      afterUrl: current.url,
      fileName: prepared.uploadFile.fileName,
      byteLength: prepared.uploadFile.byteLength,
      sha256: prepared.uploadFile.sha256,
      chooserConfirmed: result?.chooserConfirmed === true,
      multiple: result?.multiple === true,
      setFilesReturned: result?.setFilesReturned === true,
      readbackStatus: result?.readbackError ? "unavailable" : "ok",
      readbackError: stringOrNull(result?.readbackError),
      cleanupStatus: result?.cleanupStatus === "released" ? "released" : "uncertain",
      cleanupError: stringOrNull(result?.cleanupError),
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: "Exactly one authority-bounded existing local file from the current Codex trusted authority root was handed to the webpage through the official Chrome filechooser/setFiles flow after revalidating the exact prepared semantic target. The Browser runtime binds canonical path + byte length + SHA-256 at prepare time, revalidates the same fingerprint immediately before Browser dispatch, and checks it again after setFiles returns. This catches ordinary source-file drift but is not represented as an operating-system write lock against a hostile concurrent writer in the narrow dispatch window. setFiles returning confirms browser-side file selection/change delivery, not necessarily remote server acceptance; use page state for any stronger upload-complete claim. The Browser runtime never retries an uncertain upload automatically.",
    };
  }

  async prepareFill({ tabRef, role, name, placeholder, scopeUrl, text, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    this.#assertTabRef(tabRef);
    if (typeof role !== "string" || !role.trim()) {
      throw new BrowserPreviewError("BROWSER_ROLE_REQUIRED", "role is required and must come from the current DOM/accessibility description");
    }
    const normalizedRole = role.trim();
    if (!BROWSER_FILL_ROLES.has(normalizedRole)) {
      throw new BrowserPreviewError(
        "BROWSER_FILL_ROLE_UNSUPPORTED",
        `Browser fill accepts only exact textbox/searchbox targets, not role=${normalizedRole}`,
        ["Read the current tab and choose a textbox or searchbox target. Other input roles remain outside this narrow fill surface."]
      );
    }
    const normalizedName = typeof name === "string" ? name.trim() : "";
    const normalizedPlaceholder = typeof placeholder === "string" ? placeholder.trim() : "";
    const normalizedScopeUrl = typeof scopeUrl === "string" ? normalizeBrowserHttpUrl(scopeUrl) : null;
    const targetModeCount = Number(Boolean(normalizedName)) + Number(Boolean(normalizedPlaceholder)) + Number(Boolean(normalizedScopeUrl));
    if (targetModeCount > 1) {
      throw new BrowserPreviewError(
        "BROWSER_FILL_TARGET_CONFLICT",
        "Browser fill preparation accepts exactly one target mode: role+name, role+placeholder, or role+scopeUrl"
      );
    }
    if (targetModeCount === 0) {
      throw new BrowserPreviewError(
        "BROWSER_FILL_TARGET_REQUIRED",
        "Browser fill preparation requires the exact accessible name, exact placeholder, or one exact visible http(s) scopeUrl for a locally unique textbox/searchbox"
      );
    }
    if (typeof text !== "string") {
      throw new BrowserPreviewError("BROWSER_FILL_TEXT_REQUIRED", "text must be a string and is bound exactly into the prepared fill action");
    }
    if (text.length > 20_000) {
      throw new BrowserPreviewError("BROWSER_FILL_TEXT_TOO_LONG", "Browser fill limits text to 20000 characters per prepared action");
    }
    const fillTarget = normalizedName
      ? { kind: "role", role: normalizedRole, name: normalizedName }
      : normalizedPlaceholder
        ? { kind: "placeholder", role: normalizedRole, placeholder: normalizedPlaceholder }
        : { kind: "scope-role", role: normalizedRole, scopeUrl: normalizedScopeUrl };
    await this.#requireReady(effectiveCwd);
    const state = this.#requireKnownTab(tabRef);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const fillLocatorSetupSource = browserFillLocatorSetupSource(fillTarget);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  const __twTitle = (await __twTab.title()) ?? __twInfo.title ?? null;
  ${fillLocatorSetupSource}
  const __twCount = await __twLocator.count();
  if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount);
  const __twVisible = await __twLocator.isVisible();
  if (!__twVisible) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
  const __twEnabled = await __twLocator.isEnabled();
  if (!__twEnabled) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
  const __twTargetStructure = await __twLocator.evaluate((element) => {
    const attr = (node, name) => typeof node?.getAttribute === "function" ? node.getAttribute(name) : null;
    const tag = (node) => typeof node?.tagName === "string" ? node.tagName.toLowerCase() : null;
    const childSignature = (node) => ({
      tag: tag(node),
      role: attr(node, "role"),
      contenteditable: attr(node, "contenteditable"),
      childElementCount: Number.isInteger(node?.childElementCount) ? node.childElementCount : 0,
    });
    const editableSelector = '[contenteditable]:not([contenteditable="false"])';
    const editableDescendants = typeof element?.querySelectorAll === "function"
      ? Array.from(element.querySelectorAll(editableSelector))
      : [];
    const paragraphDescendants = typeof element?.querySelectorAll === "function"
      ? Array.from(element.querySelectorAll("p"))
      : [];
    const directChildren = Array.from(element?.children ?? []);
    const openShadowRoot = element?.shadowRoot ?? null;
    const outerHtml = typeof element?.outerHTML === "string" ? element.outerHTML : "";
    let outerHtmlByteLength = outerHtml.length;
    try { outerHtmlByteLength = new TextEncoder().encode(outerHtml).byteLength; } catch {}
    return {
      tag: tag(element),
      role: attr(element, "role"),
      type: attr(element, "type"),
      contenteditable: attr(element, "contenteditable"),
      isContentEditable: element?.isContentEditable === true,
      childElementCount: directChildren.length,
      directChildren: directChildren.slice(0, 12).map((child) => childSignature(child)),
      directChildrenTruncated: directChildren.length > 12,
      directParagraphCount: directChildren.filter((child) => tag(child) === "p").length,
      paragraphDescendantCount: paragraphDescendants.length,
      editableDescendantCount: editableDescendants.length,
      editableDescendants: editableDescendants.slice(0, 8).map((child) => childSignature(child)),
      editableDescendantsTruncated: editableDescendants.length > 8,
      hasOpenShadowRoot: Boolean(openShadowRoot),
      shadowChildElementCount: Number.isInteger(openShadowRoot?.childElementCount) ? openShadowRoot.childElementCount : 0,
      shadowSlotCount: typeof openShadowRoot?.querySelectorAll === "function" ? openShadowRoot.querySelectorAll("slot").length : 0,
      lightSlotCount: typeof element?.querySelectorAll === "function" ? element.querySelectorAll("slot").length : 0,
      outerHtmlByteLength,
    };
  });
  let __twCurrentDirectValue = null;
  let __twCurrentRenderedInnerText = null;
  let __twCurrentRenderedTextContent = null;
  try {
    __twCurrentDirectValue = await __twLocator.evaluate((element) => {
      if (typeof element?.value === "string") return element.value;
      if (element?.isContentEditable) return typeof element.innerText === "string" ? element.innerText : (element.textContent ?? "");
      return null;
    });
  } catch {}
  try { __twCurrentRenderedInnerText = await __twLocator.innerText({ timeoutMs: 1000 }); } catch {}
  try { __twCurrentRenderedTextContent = await __twLocator.textContent({ timeoutMs: 1000 }); } catch {}
  const __twCurrentCandidates = [__twCurrentDirectValue, __twCurrentRenderedInnerText, __twCurrentRenderedTextContent]
    .filter((candidate) => typeof candidate === "string");
  if (__twCurrentCandidates.length === 0) throw new Error("TOOLWIRE_BROWSER_FILL_VALUE_UNREADABLE");
  const __twCurrentValue = __twCurrentCandidates.find((candidate) => !/^\\s*$/.test(candidate)) ?? __twCurrentCandidates[0];
  __twPayload = {
    title: __twTitle,
    url: __twUrl,
    count: __twCount,
    visible: __twVisible,
    enabled: __twEnabled,
    currentValue: __twCurrentValue,
    fillStrategy: __twFillStrategy,
    targetMeta: __twTargetMeta,
    targetStructure: __twTargetStructure,
  };
} finally {
  if (__twTab) if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
}
nodeRepl.write(JSON.stringify(__twPayload));
`, "Prepare exact Chrome fill", { expectedGeneration: state.workbenchGeneration });

    const prepared = this.#storePreparedAction("fill", {
      tabRef,
      providerTabId: state.providerTabId,
      expectedUrl: stringOrNull(result?.url) ?? state.url,
      cwd: effectiveCwd,
      target: fillTarget,
      text,
      fillStrategy: result?.fillStrategy === "type" ? "type" : "fill",
      targetMeta: result?.targetMeta ?? null,
      workbenchGeneration: state.workbenchGeneration,
    });
    const { actionApprovalRef, expiresAt } = prepared;
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      action: {
        kind: "fill",
        tab: publicTab({
          ...state,
          title: stringOrNull(result?.title) ?? state.title,
          url: stringOrNull(result?.url) ?? state.url,
        }),
        targetKind: prepared.target.kind,
        role: prepared.target.role,
        ...(prepared.target.kind === "role"
          ? { name: prepared.target.name }
          : prepared.target.kind === "placeholder"
            ? { placeholder: prepared.target.placeholder }
            : { scopeUrl: prepared.target.scopeUrl }),
        exact: true,
        text: prepared.text,
        currentValue: stringOrNull(result?.currentValue) ?? "",
        fillStrategy: prepared.fillStrategy,
        targetStructure: result?.targetStructure ?? null,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context to this exact fill. If the text is ordinary non-sensitive task content and no policy-covered transmission confirmation is needed, or the bounded task's required verbal confirmation is already satisfied, call codex.browser_fill immediately with this actionApprovalRef. Ask only when the policy/task actually requires it; do not ask merely because this is Fill or because the legacy ref name contains Approval. Preparing did not modify the field, click, press Enter, or submit the page.",
    };
  }

  async fill({ actionApprovalRef }) {
    const prepared = this.#takePreparedAction(actionApprovalRef, "fill");
    const effectiveCwd = prepared.cwd;
    await this.#requireReady(effectiveCwd);
    this.#assertPreparedGeneration(prepared);
    const state = this.#requirePreparedTab(prepared);

    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const fillLocatorSetupSource = browserFillLocatorSetupSource(prepared.target);
    const textLiteral = JSON.stringify(prepared.text);
    const canonicalRichTextLiteral = JSON.stringify(prepared.text.replace(/\r\n?/g, "\n"));
    let result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  ${fillLocatorSetupSource}
  const __twCount = await __twLocator.count();
  if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount);
  const __twVisible = await __twLocator.isVisible();
  if (!__twVisible) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
  const __twEnabled = await __twLocator.isEnabled();
  if (!__twEnabled) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
  if (__twFillStrategy !== ${JSON.stringify(prepared.fillStrategy)}) throw new Error("TOOLWIRE_BROWSER_FILL_STRATEGY_CHANGED");
  const __twClearRequested = ${JSON.stringify(prepared.text === "")};
  const __twResolveFreshTarget = async () => {
    const __twFresh = await (async () => {
      ${fillLocatorSetupSource}
      const __twFreshCount = await __twLocator.count();
      if (__twFreshCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twFreshCount);
      if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
      if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
      return { locator: __twLocator, fillStrategy: __twFillStrategy, targetMeta: __twTargetMeta };
    })();
    return __twFresh;
  };
  const __twReadLocatorText = async (locator) => {
    let value = null;
    let renderedInnerText = null;
    let renderedTextContent = null;
    let contentEditable = false;
    let boundRichTextSource = null;
    let boundEditableCount = 0;
    let canonicalRichText = null;
    try {
      const direct = await locator.evaluate((element) => {
        const canonicalizeContentEditableParagraphText = ${CONTENTEDITABLE_PARAGRAPH_CANONICALIZER_SOURCE};
        const __twResolveBoundContentEditableParagraphText = ${BOUND_CONTENTEDITABLE_PARAGRAPH_RESOLVER_SOURCE};
        const isContentEditable = Boolean(element?.isContentEditable);
        return {
          value: typeof element?.value === "string"
            ? element.value
            : isContentEditable
              ? (typeof element.innerText === "string" ? element.innerText : (element.textContent ?? ""))
              : null,
          contentEditable: isContentEditable,
          boundRichText: __twResolveBoundContentEditableParagraphText(element),
        };
      });
      value = typeof direct?.value === "string" ? direct.value : null;
      contentEditable = direct?.contentEditable === true;
      boundRichTextSource = typeof direct?.boundRichText?.source === "string" ? direct.boundRichText.source : null;
      boundEditableCount = Number.isInteger(direct?.boundRichText?.editableCount) ? direct.boundRichText.editableCount : 0;
      canonicalRichText = typeof direct?.boundRichText?.canonicalRichText === "string" ? direct.boundRichText.canonicalRichText : null;
    } catch {}
    try { renderedInnerText = await locator.innerText({ timeoutMs: 1000 }); } catch {}
    try { renderedTextContent = await locator.textContent({ timeoutMs: 1000 }); } catch {}
    const candidates = [value, renderedInnerText, renderedTextContent].filter((candidate) => typeof candidate === "string");
    const blank = candidates.length > 0 && candidates.every((candidate) => /^\\s*$/.test(candidate));
    return {
      value,
      renderedInnerText,
      renderedTextContent,
      contentEditable,
      boundRichTextSource,
      boundEditableCount,
      canonicalRichText,
      readable: candidates.length > 0,
      exact: __twClearRequested
        ? blank
        : candidates.some((candidate) => candidate === ${textLiteral})
          || (boundRichTextSource !== null && canonicalRichText === ${canonicalRichTextLiteral}),
      blank,
    };
  };
  const __twSelectObservedText = (observed) => {
    const candidates = [observed?.value, observed?.renderedInnerText, observed?.renderedTextContent]
      .filter((candidate) => typeof candidate === "string");
    if (candidates.length === 0) return null;
    return candidates.find((candidate) => !/^\\s*$/.test(candidate)) ?? candidates[0];
  };
  const __twBeforeObserved = await __twReadLocatorText(__twLocator);
  const __twBeforeValue = __twSelectObservedText(__twBeforeObserved);
  if (typeof __twBeforeValue !== "string") throw new Error("TOOLWIRE_BROWSER_FILL_VALUE_UNREADABLE");
  const __twVerifyFreshTarget = async (fresh) => {
    const observed = await __twReadLocatorText(fresh.locator);
    if (__twClearRequested) {
      if (observed.blank === true) return { exact: true, afterValue: "", source: "fresh-target-cleared", observed };
      return { exact: false, afterValue: __twSelectObservedText(observed) ?? "", source: null, observed };
    }
    if (observed.value === ${textLiteral}) return { exact: true, afterValue: ${textLiteral}, source: "fresh-target", observed };
    if (observed.renderedInnerText === ${textLiteral} || observed.renderedTextContent === ${textLiteral}) {
      return { exact: true, afterValue: ${textLiteral}, source: "fresh-target-rendered-text", observed };
    }
    if (observed.boundRichTextSource !== null && observed.canonicalRichText === ${canonicalRichTextLiteral}) {
      return { exact: true, afterValue: ${textLiteral}, source: "fresh-target-rich-paragraphs:" + observed.boundRichTextSource, observed };
    }
    if (${JSON.stringify(prepared.target.kind !== "scope-role")}) {
      const __twVisibleRoleTargets = __twTab.playwright.getByRole(${JSON.stringify(prepared.target.role)}).filter({ visible: true });
      const __twRoleValues = await __twVisibleRoleTargets.evaluateAll((elements) => elements.map((element) => {
        const __twCanonicalizeContentEditableParagraphText = ${CONTENTEDITABLE_PARAGRAPH_CANONICALIZER_SOURCE};
        const isContentEditable = Boolean(element?.isContentEditable);
        const value = typeof element?.value === "string"
          ? element.value
          : isContentEditable
            ? (typeof element.innerText === "string" ? element.innerText : (element.textContent ?? ""))
            : typeof element?.innerText === "string"
              ? element.innerText
              : (element?.textContent ?? null);
        return {
          value,
          contentEditable: isContentEditable,
          canonicalRichText: isContentEditable ? __twCanonicalizeContentEditableParagraphText(element) : null,
        };
      }));
      const __twExactRoleMatches = __twRoleValues.filter((entry) => entry?.value === ${textLiteral}
        || (entry?.contentEditable === true && entry?.canonicalRichText === ${canonicalRichTextLiteral})).length;
      if (__twExactRoleMatches > 1) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH");
      if (__twExactRoleMatches === 1) return { exact: true, afterValue: ${textLiteral}, source: "same-role-visible-target", observed };
    }
    const __twLocalEditor = await fresh.locator.evaluate((element, expected) => {
      const __twCanonicalizeContentEditableParagraphText = ${CONTENTEDITABLE_PARAGRAPH_CANONICALIZER_SOURCE};
      const matchesExpected = (candidate) => {
        if (!candidate) return false;
        if (typeof candidate.value === "string") return candidate.value === expected.raw;
        if (candidate.isContentEditable) {
          const raw = typeof candidate.innerText === "string" ? candidate.innerText : (candidate.textContent ?? "");
          const canonical = __twCanonicalizeContentEditableParagraphText(candidate);
          return raw === expected.raw || (typeof canonical === "string" && canonical === expected.canonical);
        }
        return false;
      };
      const isVisible = (candidate) => {
        if (!(candidate instanceof Element)) return false;
        const style = window.getComputedStyle(candidate);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= 0.01) return false;
        return Array.from(candidate.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
      };
      let scope = element?.parentElement ?? null;
      for (let depth = 1; depth <= 3 && scope; depth += 1, scope = scope.parentElement) {
        const matches = [];
        const candidates = scope.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable="false"])');
        for (const candidate of candidates) {
          if (!isVisible(candidate)) continue;
          if (matchesExpected(candidate)) matches.push(candidate);
        }
        if (matches.length > 0) return { depth, exactMatches: matches.length };
      }
      return { depth: null, exactMatches: 0 };
    }, { raw: ${textLiteral}, canonical: ${canonicalRichTextLiteral} });
    if (__twLocalEditor?.exactMatches > 1) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH");
    if (__twLocalEditor?.exactMatches === 1) return { exact: true, afterValue: ${textLiteral}, source: "local-editor-exact", observed };
    return { exact: false, afterValue: typeof observed.value === "string" ? observed.value : "", source: null, observed };
  };
  __twDispatchAttempted = true;
  if (__twClearRequested) {
    await __twLocator.fill("", {});
  } else if (__twFillStrategy === "type") {
    await __twLocator.type(${textLiteral}, { timeoutMs: 5000 });
  } else {
    await __twLocator.fill(${textLiteral}, {});
  }
  await __twTab.playwright.waitForTimeout(250);
  let __twActivationOnly = false;
  let __twSettleRecheck = false;
  let __twRepairSettleMs = null;
  let __twFresh = await __twResolveFreshTarget();
  let __twVerification = await __twVerifyFreshTarget(__twFresh);
  if (!__twVerification.exact && !__twClearRequested) {
    const __twPreRepairSnapshot = await __twTab.playwright.domSnapshot();
    if (__twPreRepairSnapshot.includes(${textLiteral})) {
      throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appears in fresh DOM but exact bound-target verification did not resolve it");
    }
    if (__twVerification.observed?.blank === true) {
      __twSettleRecheck = true;
      __twRepairSettleMs = 750;
      await __twTab.playwright.waitForTimeout(__twRepairSettleMs);
      __twFresh = await __twResolveFreshTarget();
      __twVerification = await __twVerifyFreshTarget(__twFresh);
      const __twSettledSnapshot = await __twTab.playwright.domSnapshot();
      if (!__twVerification.exact && __twSettledSnapshot.includes(${textLiteral})) {
        throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appeared during editor settle but exact bound-target verification did not resolve it");
      }
      if (!__twVerification.exact && __twVerification.observed?.blank === true) {
        __twActivationOnly = true;
      }
    }
  }
  if (!__twActivationOnly && !__twVerification.exact) {
    if (__twClearRequested) {
      if (__twVerification.observed?.readable === true) {
        throw new Error("TOOLWIRE_BROWSER_FILL_NOT_APPLIED:fresh bound target remained non-empty after the bounded clear attempt");
      }
      throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:fresh bound target could not be read after the bounded clear attempt");
    }
    const __twFinalSnapshot = await __twTab.playwright.domSnapshot();
    if (__twFinalSnapshot.includes(${textLiteral})) {
      throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appears in fresh DOM but exact bound-target verification did not resolve it");
    }
    if (__twVerification.observed?.blank === true) {
      throw new Error("TOOLWIRE_BROWSER_FILL_NOT_APPLIED:fresh bound target remained empty after the bounded fill attempt");
    }
    throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH");
  }
  const __twAfterValue = __twActivationOnly ? "" : __twVerification.afterValue;
  const __twVerificationSource = __twActivationOnly
    ? "activation-only-empty"
    : __twSettleRecheck
      ? "editor-settle:" + __twVerification.source
      : __twVerification.source;
  const __twAfterUrl = (await __twTab.url()) ?? null;
  const __twAfterTitle = (await __twTab.title()) ?? null;
  const __twSnapshot = await __twTab.playwright.domSnapshot();
  __twPayload = {
    phaseStatus: __twActivationOnly ? "activation_only" : "filled",
    beforeUrl: __twBeforeUrl,
    afterUrl: __twAfterUrl,
    afterTitle: __twAfterTitle,
    beforeValue: __twBeforeValue,
    afterValue: __twAfterValue,
    verificationSource: __twVerificationSource,
    dispatchAttempts: 1,
    settleRecheck: __twSettleRecheck,
    repairSettleMs: __twRepairSettleMs,
    reclaimAttempted: false,
    reclaimStatus: null,
    repairAttempted: false,
    repairReason: null,
    snapshot: __twSnapshot,
  };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && (__twActionError || __twFinalizeError)) {
  const __twPrimary = __twActionError ?? __twFinalizeError;
  const __twPrimaryMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  const __twFinalizeSuffix = __twFinalizeError && __twActionError
    ? "; finalize also failed: " + (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError))
    : "";
  if (/TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twPrimary;
  if (/TOOLWIRE_BROWSER_FILL_NOT_APPLIED/i.test(__twPrimaryMessage)) throw __twPrimary;
  if (/TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE/i.test(__twPrimaryMessage)) throw __twPrimary;
  throw new Error("TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN:" + __twPrimaryMessage + __twFinalizeSuffix);
}
if (__twActionError) throw __twActionError;
if (__twFinalizeError) throw __twFinalizeError;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute prepared Chrome fill", { mutationKind: "fill", expectedGeneration: prepared.workbenchGeneration });

    if (result?.phaseStatus === "activation_only") {
      const activation = result;
      const repair = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  const __twResolveTarget = async () => {
    return await (async () => {
      ${fillLocatorSetupSource}
      const __twCount = await __twLocator.count();
      if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount);
      if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
      if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
      return { locator: __twLocator, fillStrategy: __twFillStrategy };
    })();
  };
  const __twReadText = async (locator) => {
    let value = null;
    let renderedInnerText = null;
    let renderedTextContent = null;
    let contentEditable = false;
    let boundRichTextSource = null;
    let boundEditableCount = 0;
    let canonicalRichText = null;
    try {
      const direct = await locator.evaluate((element) => {
        const canonicalizeContentEditableParagraphText = ${CONTENTEDITABLE_PARAGRAPH_CANONICALIZER_SOURCE};
        const __twResolveBoundContentEditableParagraphText = ${BOUND_CONTENTEDITABLE_PARAGRAPH_RESOLVER_SOURCE};
        const isContentEditable = Boolean(element?.isContentEditable);
        return {
          value: typeof element?.value === "string"
            ? element.value
            : isContentEditable
              ? (typeof element.innerText === "string" ? element.innerText : (element.textContent ?? ""))
              : null,
          contentEditable: isContentEditable,
          boundRichText: __twResolveBoundContentEditableParagraphText(element),
        };
      });
      value = typeof direct?.value === "string" ? direct.value : null;
      contentEditable = direct?.contentEditable === true;
      boundRichTextSource = typeof direct?.boundRichText?.source === "string" ? direct.boundRichText.source : null;
      boundEditableCount = Number.isInteger(direct?.boundRichText?.editableCount) ? direct.boundRichText.editableCount : 0;
      canonicalRichText = typeof direct?.boundRichText?.canonicalRichText === "string" ? direct.boundRichText.canonicalRichText : null;
    } catch {}
    try { renderedInnerText = await locator.innerText({ timeoutMs: 1000 }); } catch {}
    try { renderedTextContent = await locator.textContent({ timeoutMs: 1000 }); } catch {}
    const candidates = [value, renderedInnerText, renderedTextContent].filter((candidate) => typeof candidate === "string");
    return {
      value,
      renderedInnerText,
      renderedTextContent,
      contentEditable,
      boundRichTextSource,
      boundEditableCount,
      canonicalRichText,
      exact: candidates.some((candidate) => candidate === ${textLiteral})
        || (boundRichTextSource !== null && canonicalRichText === ${canonicalRichTextLiteral}),
      blank: candidates.length > 0 && candidates.every((candidate) => /^\\s*$/.test(candidate)),
    };
  };
  const __twVerify = async (fresh) => {
    const observed = await __twReadText(fresh.locator);
    if (observed.value === ${textLiteral}) return { exact: true, afterValue: ${textLiteral}, source: "fresh-target", observed };
    if (observed.renderedInnerText === ${textLiteral} || observed.renderedTextContent === ${textLiteral}) {
      return { exact: true, afterValue: ${textLiteral}, source: "fresh-target-rendered-text", observed };
    }
    if (observed.boundRichTextSource !== null && observed.canonicalRichText === ${canonicalRichTextLiteral}) {
      return { exact: true, afterValue: ${textLiteral}, source: "fresh-target-rich-paragraphs:" + observed.boundRichTextSource, observed };
    }
    if (${JSON.stringify(prepared.target.kind !== "scope-role")}) {
      const __twVisibleRoleTargets = __twTab.playwright.getByRole(${JSON.stringify(prepared.target.role)}).filter({ visible: true });
      const __twRoleValues = await __twVisibleRoleTargets.evaluateAll((elements) => elements.map((element) => {
        const __twCanonicalizeContentEditableParagraphText = ${CONTENTEDITABLE_PARAGRAPH_CANONICALIZER_SOURCE};
        const isContentEditable = Boolean(element?.isContentEditable);
        const value = typeof element?.value === "string"
          ? element.value
          : isContentEditable
            ? (typeof element.innerText === "string" ? element.innerText : (element.textContent ?? ""))
            : typeof element?.innerText === "string"
              ? element.innerText
              : (element?.textContent ?? null);
        return {
          value,
          contentEditable: isContentEditable,
          canonicalRichText: isContentEditable ? __twCanonicalizeContentEditableParagraphText(element) : null,
        };
      }));
      const __twExactRoleMatches = __twRoleValues.filter((entry) => entry?.value === ${textLiteral}
        || (entry?.contentEditable === true && entry?.canonicalRichText === ${canonicalRichTextLiteral})).length;
      if (__twExactRoleMatches > 1) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH");
      if (__twExactRoleMatches === 1) return { exact: true, afterValue: ${textLiteral}, source: "same-role-visible-target", observed };
    }
    const __twLocalEditor = await fresh.locator.evaluate((element, expected) => {
      const __twCanonicalizeContentEditableParagraphText = ${CONTENTEDITABLE_PARAGRAPH_CANONICALIZER_SOURCE};
      const matchesExpected = (candidate) => {
        if (!candidate) return false;
        if (typeof candidate.value === "string") return candidate.value === expected.raw;
        if (candidate.isContentEditable) {
          const raw = typeof candidate.innerText === "string" ? candidate.innerText : (candidate.textContent ?? "");
          const canonical = __twCanonicalizeContentEditableParagraphText(candidate);
          return raw === expected.raw || (typeof canonical === "string" && canonical === expected.canonical);
        }
        return false;
      };
      const isVisible = (candidate) => {
        if (!(candidate instanceof Element)) return false;
        const style = window.getComputedStyle(candidate);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= 0.01) return false;
        return Array.from(candidate.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
      };
      let scope = element?.parentElement ?? null;
      for (let depth = 1; depth <= 3 && scope; depth += 1, scope = scope.parentElement) {
        const matches = [];
        const candidates = scope.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable="false"])');
        for (const candidate of candidates) {
          if (!isVisible(candidate)) continue;
          if (matchesExpected(candidate)) matches.push(candidate);
        }
        if (matches.length > 0) return { depth, exactMatches: matches.length };
      }
      return { depth: null, exactMatches: 0 };
    }, { raw: ${textLiteral}, canonical: ${canonicalRichTextLiteral} });
    if (__twLocalEditor?.exactMatches > 1) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH");
    if (__twLocalEditor?.exactMatches === 1) return { exact: true, afterValue: ${textLiteral}, source: "local-editor-exact", observed };
    return { exact: false, afterValue: typeof observed.value === "string" ? observed.value : "", source: null, observed };
  };
  let __twFresh = await __twResolveTarget();
  let __twVerification = await __twVerify(__twFresh);
  let __twRepairDispatched = false;
  if (!__twVerification.exact) {
    const __twBeforeSnapshot = await __twTab.playwright.domSnapshot();
    if (__twBeforeSnapshot.includes(${textLiteral})) {
      throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appeared before fresh repair dispatch but exact bound-target verification did not resolve it");
    }
    if (__twVerification.observed?.blank !== true) {
      throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:fresh repair target was no longer blank; refusing to overwrite it");
    }
    __twDispatchAttempted = true;
    __twRepairDispatched = true;
    if (__twFresh.fillStrategy === "type") {
      await __twFresh.locator.type(${textLiteral}, { timeoutMs: 5000 });
    } else {
      await __twFresh.locator.fill(${textLiteral}, {});
    }
    await __twTab.playwright.waitForTimeout(250);
    __twFresh = await __twResolveTarget();
    __twVerification = await __twVerify(__twFresh);
  }
  if (!__twVerification.exact) {
    const __twFinalSnapshot = await __twTab.playwright.domSnapshot();
    if (__twFinalSnapshot.includes(${textLiteral})) {
      throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appears after fresh repair dispatch but exact bound-target verification did not resolve it");
    }
    if (__twVerification.observed?.blank === true) {
      throw new Error("TOOLWIRE_BROWSER_FILL_NOT_APPLIED:fresh repair execution left the bound target empty");
    }
    throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH");
  }
  const __twAfterUrl = (await __twTab.url()) ?? null;
  const __twAfterTitle = (await __twTab.title()) ?? null;
  const __twSnapshot = await __twTab.playwright.domSnapshot();
  __twPayload = {
    phaseStatus: "filled",
    beforeUrl: __twBeforeUrl,
    afterUrl: __twAfterUrl,
    afterTitle: __twAfterTitle,
    afterValue: __twVerification.afterValue,
    verificationSource: __twVerification.source,
    repairDispatched: __twRepairDispatched,
    snapshot: __twSnapshot,
  };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try {
      if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] });
    } catch (__twError) {
      __twFinalizeError = __twError;
    }
  }
}
if (__twDispatchAttempted && (__twActionError || __twFinalizeError)) {
  const __twPrimary = __twActionError ?? __twFinalizeError;
  const __twPrimaryMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  const __twFinalizeSuffix = __twFinalizeError && __twActionError
    ? "; finalize also failed: " + (__twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError))
    : "";
  if (/TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twPrimary;
  if (/TOOLWIRE_BROWSER_FILL_NOT_APPLIED/i.test(__twPrimaryMessage)) throw __twPrimary;
  if (/TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE/i.test(__twPrimaryMessage)) throw __twPrimary;
  throw new Error("TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN:" + __twPrimaryMessage + __twFinalizeSuffix);
}
if (__twActionError) throw __twActionError;
if (__twFinalizeError) throw __twFinalizeError;
nodeRepl.write(JSON.stringify(__twPayload));
`, "Repair activated Chrome fill", { mutationKind: "fill", expectedGeneration: prepared.workbenchGeneration });
      result = {
        ...repair,
        beforeUrl: stringOrNull(activation?.beforeUrl) ?? prepared.expectedUrl,
        beforeValue: stringOrNull(activation?.beforeValue) ?? "",
        dispatchAttempts: repair?.repairDispatched === true ? 2 : 1,
        settleRecheck: activation?.settleRecheck === true,
        repairSettleMs: Number.isInteger(activation?.repairSettleMs) ? activation.repairSettleMs : null,
        reclaimAttempted: true,
        reclaimStatus: "fresh-execution",
        repairAttempted: repair?.repairDispatched === true,
        repairReason: repair?.repairDispatched === true ? "fresh-target-empty-after-first-execution" : null,
        verificationSource: repair?.repairDispatched === true
          ? `empty-target-repair:${stringOrNull(repair?.verificationSource) ?? "fresh-target"}`
          : stringOrNull(repair?.verificationSource) ?? "fresh-target",
      };
    }

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    const snapshotTruncated = snapshot.length > BROWSER_POST_ACTION_MAX_CHARS;
    const current = {
      ...state,
      title: stringOrNull(result?.afterTitle) ?? state.title,
      url: stringOrNull(result?.afterUrl) ?? state.url,
      seenAt: Date.now(),
    };
    this.#tabs.set(prepared.tabRef, current);
    return {
      status: "filled",
      action: {
        kind: "fill",
        targetKind: prepared.target.kind,
        role: prepared.target.role,
        ...(prepared.target.kind === "role"
          ? { name: prepared.target.name }
          : prepared.target.kind === "placeholder"
            ? { placeholder: prepared.target.placeholder }
            : { scopeUrl: prepared.target.scopeUrl }),
        exact: true,
        textLength: prepared.text.length,
      },
      tab: publicTab(current),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      afterUrl: current.url,
      beforeValue: stringOrNull(result?.beforeValue) ?? "",
      afterValue: stringOrNull(result?.afterValue) ?? "",
      verificationSource: stringOrNull(result?.verificationSource) ?? "fresh-target",
      dispatchAttempts: Number.isInteger(result?.dispatchAttempts) ? result.dispatchAttempts : 1,
      settleRecheck: result?.settleRecheck === true,
      repairSettleMs: Number.isInteger(result?.repairSettleMs) ? result.repairSettleMs : null,
      reclaimAttempted: result?.reclaimAttempted === true,
      reclaimStatus: stringOrNull(result?.reclaimStatus),
      repairAttempted: result?.repairAttempted === true,
      repairReason: stringOrNull(result?.repairReason),
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: "Exactly one previously prepared fill was dispatched after the caller applied the current Browser confirmation policy and task context. The legacy actionApprovalRef is only an exact-action binding, not proof of user approval. The Browser runtime revalidated the same tab URL and unique visible enabled exact role/name or role+placeholder target, verified the resulting field value equals the bound text, read back current page state, and released the claimed user tab. It did not click, press Enter, navigate, or submit the page.",
    };
  }

  async #dependencyStatus(cwd) {
    let skills;
    try {
      skills = await this.#workbench.catalog({ kind: "skills", cwd, query: CHROME_SKILL_NAME });
      this.#syncWorkbenchGeneration();
    } catch (error) {
      this.#syncWorkbenchGeneration();
      return browserUnavailable(new BrowserPreviewError(
        "BROWSER_SKILL_DISCOVERY_FAILED",
        `Could not read Codex Skills catalog: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
    const skill = (skills?.skills ?? []).find((entry) => entry?.name === CHROME_SKILL_NAME && entry?.enabled !== false);
    if (!skill?.path) {
      return {
        status: "unavailable",
        reason: "chrome_skill_unavailable",
        chromeSkill: "missing",
        nodeRepl: "unknown",
        nextActions: [
          "Install/enable the current Codex Chrome Skill/plugin, then retry codex.browser_status.",
          "Do not use CUA as an automatic fallback for a missing Browser Skill.",
        ],
      };
    }

    try {
      const mcp = await this.#workbench.catalog({ kind: "mcp", cwd, query: NODE_REPL_TOOL });
      this.#syncWorkbenchGeneration();
      const nodeRepl = (mcp?.servers ?? []).find((server) => server?.name === NODE_REPL_SERVER);
      const js = nodeRepl?.tools?.find((tool) => tool?.name === NODE_REPL_TOOL);
      if (!js || nodeRepl?.error) {
        return {
          status: "unavailable",
          reason: "node_repl_unavailable",
          chromeSkill: "ok",
          nodeRepl: "unavailable",
          nodeReplError: nodeRepl?.error ?? null,
          nextActions: [
            "Restore the Codex node_repl MCP capability, then retry codex.browser_status.",
            "Do not replace the existing-login Chrome path with generic Computer Use.",
          ],
        };
      }
    } catch (error) {
      this.#syncWorkbenchGeneration();
      return browserUnavailable(new BrowserPreviewError(
        "BROWSER_NODE_REPL_DISCOVERY_FAILED",
        `Could not read node_repl status: ${error instanceof Error ? error.message : String(error)}`
      ));
    }

    this.#browserClientUrl = this.#browserClientUrl ?? deriveBrowserClientUrl(skill.path);
    return { status: "ok", skillPathResolved: true, browserClientResolved: true };
  }

  async #requireReady(cwd) {
    const dependency = await this.#dependencyStatus(cwd);
    if (dependency.status !== "ok") {
      throw new BrowserPreviewError(
        dependency.reason ?? "BROWSER_UNAVAILABLE",
        `Browser dependencies are unavailable: ${dependency.reason ?? "unknown"}`,
        dependency.nextActions ?? ["Call codex.browser_status for current diagnostics."]
      );
    }
    const backends = await this.#listBackends(cwd);
    if (!backends.some((backend) => backend.family === "chrome")) {
      throw new BrowserPreviewError(
        "BROWSER_CHROME_NOT_CONNECTED",
        "The Codex Browser runtime is available but no connected Chrome extension/backend is visible",
        [
          "Open Chrome with the supported Codex Chrome extension/runtime enabled, then retry.",
          "Call codex.browser_status to distinguish Browser setup from site login state.",
        ]
      );
    }
  }

  async #listBackends(cwd) {
    const result = await this.#runJson(cwd, `
const __twBackends = await globalThis.__toolwireBrowserAgent.browsers.list();
nodeRepl.write(JSON.stringify(__twBackends.map((backend) => ({
  name: backend.name ?? null,
  family: backend.family ?? null,
  type: backend.type ?? null,
}))));
`, "Check connected browser backends");
    return Array.isArray(result) ? result.map(sanitizeBackend) : [];
  }

  async #runJson(cwd, body, title, { mutationKind = null, expectedGeneration = null } = {}) {
    const clientUrl = await this.#resolveBrowserClientUrl(cwd);
    const bootstrap = `
if (globalThis.__toolwireBrowserAgent?.browsers == null) {
  const { setupBrowserRuntime } = await import(${JSON.stringify(clientUrl)});
  globalThis.__toolwireBrowserAgent = await setupBrowserRuntime();
}
`;
    let response;
    try {
      response = await this.#workbench.mcpCall({
        server: NODE_REPL_SERVER,
        tool: NODE_REPL_TOOL,
        cwd,
        arguments: { code: `${bootstrap}\n{\n${body}\n}`, title },
        meta: this.#nextTurnMeta(),
        expectedGeneration,
      });
      this.#syncWorkbenchGeneration();
    } catch (error) {
      const generationChanged = this.#syncWorkbenchGeneration();
      const message = error instanceof Error ? error.message : String(error);
      if (/WORKBENCH_GENERATION_STALE/i.test(message) || generationChanged) {
        throw new BrowserPreviewError(
          "BROWSER_WORKBENCH_RESTARTED",
          "The persistent Codex Workbench restarted before this Browser request could safely use its prior runtime state",
          ["Call codex.browser_tabs again and prepare a fresh Browser action from the current Workbench generation."]
        );
      }
      if (mutationKind) {
        throw browserMutationResultUncertain(
          mutationKind,
          `Browser ${mutationKind} request was sent but its MCP response was not received reliably: ${message}`
        );
      }
      throw classifyBrowserError(error);
    }
    if (response?.isError) {
      const classified = classifyBrowserError(new Error(response?.text ?? "node_repl browser call failed"));
      const definitiveMutationResponse = typeof classified?.code === "string"
        && (classified.code.endsWith("_RESULT_UNCERTAIN") || BROWSER_MUTATION_DEFINITIVE_RESPONSE_CODES.has(classified.code));
      if (mutationKind && !definitiveMutationResponse) {
        throw browserMutationResultUncertain(
          mutationKind,
          `Browser ${mutationKind} request returned an error response after dispatch may have occurred: ${classified.message}`
        );
      }
      throw classified;
    }
    const text = typeof response?.text === "string" ? response.text.trim() : "";
    if (!text) {
      if (mutationKind) {
        throw browserMutationResultUncertain(
          mutationKind,
          `Browser ${mutationKind} request returned no usable response after dispatch may have occurred.`
        );
      }
      throw new BrowserPreviewError(
        "BROWSER_EMPTY_RESPONSE",
        "Browser runtime returned no text result",
        ["Call codex.browser_status and retry after confirming Chrome/node_repl health."]
      );
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      if (mutationKind) {
        throw browserMutationResultUncertain(
          mutationKind,
          `Browser ${mutationKind} request returned an unreadable response after dispatch may have occurred: ${text.slice(0, 1000)}`
        );
      }
      throw new BrowserPreviewError(
        "BROWSER_PROTOCOL_ERROR",
        `Browser runtime returned non-JSON text: ${text.slice(0, 1000)}`,
        ["Use codex.browser_status to confirm the current Browser plugin/runtime contract."]
      );
    }
  }

  async #resolveBrowserClientUrl(cwd) {
    if (this.#browserClientUrl) return this.#browserClientUrl;
    const dependency = await this.#dependencyStatus(cwd);
    if (dependency.status !== "ok" || !this.#browserClientUrl) {
      throw new BrowserPreviewError(
        dependency.reason ?? "BROWSER_CLIENT_UNAVAILABLE",
        "Could not resolve the current Codex Chrome browser-client runtime",
        dependency.nextActions ?? []
      );
    }
    return this.#browserClientUrl;
  }

  #assertTabRef(tabRef) {
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
  }

  #requireKnownTab(tabRef) {
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current Chrome session."]
      );
    }
    return state;
  }

  #storePreparedAction(kind, fields) {
    if (!PREPARED_ACTION_KINDS.has(kind)) throw new Error(`Unsupported prepared Browser action kind: ${kind}`);
    this.#cleanupActionApprovals();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + BROWSER_ACTION_APPROVAL_TTL_MS;
    const prepared = {
      actionApprovalRef,
      kind,
      ...fields,
      expiresAt,
    };
    this.#actionApprovals.set(actionApprovalRef, prepared);
    return prepared;
  }

  #takePreparedAction(actionApprovalRef, expectedKind) {
    const metadata = PREPARED_ACTION_METADATA[expectedKind];
    if (!metadata) throw new Error(`Unsupported prepared Browser action kind: ${expectedKind}`);
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError("BROWSER_ACTION_REF_INVALID", metadata.invalidReferenceMessage);
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    const validPrepared = prepared?.kind === expectedKind
      && (expectedKind !== "upload" || Boolean(prepared.uploadFile?.path));
    if (!validPrepared) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        metadata.expiredReferenceMessage,
        [...metadata.expiredNextActions]
      );
    }
    // This deletion intentionally stays before the first await at every execution callsite.
    this.#actionApprovals.delete(actionApprovalRef);
    return prepared;
  }

  #promotePreparedClick(actionApprovalRef, newKind, extraFields = {}) {
    if (newKind !== "download" && newKind !== "upload") {
      throw new Error(`Unsupported prepared Browser click promotion: ${newKind}`);
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "click") return null;
    prepared.kind = newKind;
    Object.assign(prepared, extraFields);
    return prepared;
  }

  #assertPreparedGeneration(prepared) {
    const metadata = PREPARED_ACTION_METADATA[prepared?.kind];
    if (!metadata) throw new Error(`Unsupported prepared Browser action kind: ${prepared?.kind}`);
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        metadata.generationMessage,
        [...metadata.generationNextActions]
      );
    }
  }

  #requirePreparedTab(prepared) {
    const metadata = PREPARED_ACTION_METADATA[prepared?.kind];
    if (!metadata?.tabMessage) throw new Error(`Prepared Browser action has no tab binding: ${prepared?.kind}`);
    const state = this.#tabs.get(prepared.tabRef);
    if (!state || state.providerTabId !== prepared.providerTabId) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        metadata.tabMessage,
        [...metadata.tabNextActions]
      );
    }
    return state;
  }

  #cleanupActionApprovals() {
    const now = Date.now();
    for (const [ref, value] of this.#actionApprovals.entries()) {
      if (value.expiresAt <= now) this.#actionApprovals.delete(ref);
    }
  }

  #nextTurnMeta() {
    this.#turnSeq += 1;
    return {
      "x-codex-turn-metadata": {
        session_id: this.#sessionId,
        turn_id: `${this.#sessionId}-${this.#turnSeq}`,
      },
    };
  }
}

function deriveBrowserClientUrl(skillPath) {
  const skillDir = path.dirname(path.resolve(skillPath));
  const versionRoot = path.resolve(skillDir, "..", "..");
  const browserClientPath = path.join(versionRoot, "scripts", "browser-client.mjs");
  return pathToFileURL(browserClientPath).href;
}

function sanitizeBackend(backend) {
  return {
    name: stringOrNull(backend?.name),
    family: stringOrNull(backend?.family),
    type: stringOrNull(backend?.type),
  };
}

function publicTab(state) {
  return {
    tabRef: state.tabRef,
    title: state.title,
    url: state.url,
    lastOpened: state.lastOpened,
  };
}

function browserClickLocatorSetupSource(target, { binding = null } = {}) {
  if (target?.kind === "text" && typeof target.text === "string" && target.text) {
    const textLiteral = JSON.stringify(target.text);
    const bindingKind = binding?.kind === "role" || binding?.kind === "onclick-property" || binding?.kind === "label-control" || binding?.kind === "local-radio" || binding?.kind === "flair-template-option" || binding?.kind === "thread-card-data" ? binding.kind : null;
    const fixedRole = bindingKind === "role" && typeof binding.role === "string" ? binding.role : null;
    const expectedClickBinding = bindingKind === "onclick-property" ? JSON.stringify(binding) : null;
    const expectedLabelBinding = bindingKind === "label-control" ? JSON.stringify(binding) : null;
    const expectedRadioBinding = bindingKind === "local-radio" ? JSON.stringify(binding) : null;
    const expectedFlairTemplateId = bindingKind === "flair-template-option" && typeof binding?.templateId === "string"
      ? JSON.stringify(binding.templateId)
      : null;
    const expectedThreadIdLiteral = bindingKind === "thread-card-data" && typeof binding?.threadId === "string"
      ? JSON.stringify(binding.threadId)
      : null;
    const rolesLiteral = JSON.stringify(fixedRole ? [fixedRole] : bindingKind === "onclick-property" || bindingKind === "label-control" || bindingKind === "local-radio" || bindingKind === "flair-template-option" || bindingKind === "thread-card-data" ? [] : ["link", "button"]);
    const allowOnclickProperty = bindingKind === null || bindingKind === "onclick-property";
    const allowLabelControl = bindingKind === null || bindingKind === "label-control";
    const allowLocalRadio = bindingKind === null || bindingKind === "local-radio";
    const allowFlairTemplateOption = bindingKind === null || bindingKind === "flair-template-option";
    const allowThreadCardData = bindingKind === null || bindingKind === "thread-card-data";
    return `
let __twRawTextCandidates = [];
try {
  const __twRawTextLocator = __twTab.playwright.getByText(${textLiteral}, { exact: true });
  __twRawTextCandidates = await __twRawTextLocator.all();
} catch (__twTextSelectorError) {
  const __twAllTextElements = __twTab.playwright.locator("body *");
  const __twFallbackIndexes = await __twAllTextElements.evaluateAll((elements, exactText) => {
    const normalize = (value) => typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : "";
    const matches = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (normalize(element?.innerText ?? element?.textContent ?? "") !== exactText) continue;
      let hasExactDescendant = false;
      for (const descendant of element?.querySelectorAll?.("*") ?? []) {
        if (normalize(descendant?.innerText ?? descendant?.textContent ?? "") === exactText) {
          hasExactDescendant = true;
          break;
        }
      }
      if (!hasExactDescendant) matches.push(index);
    }
    return matches;
  }, ${textLiteral});
  __twRawTextCandidates = __twFallbackIndexes.map((index) => __twAllTextElements.nth(index));
}
const __twVisibleTextCandidates = [];
for (const __twCandidate of __twRawTextCandidates) {
  if (await __twCandidate.isVisible()) __twVisibleTextCandidates.push(__twCandidate);
}
const __twTextCount = __twVisibleTextCandidates.length;
if (__twTextCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twTextCount);
const __twTextLocator = __twVisibleTextCandidates[0];
let __twLocator = null;
let __twResolvedKind = null;
let __twResolvedRole = null;
let __twResolvedClickBinding = null;
let __twSemanticCount = 0;
for (const __twRole of ${rolesLiteral}) {
  const __twCandidate = __twTab.playwright.getByRole(__twRole).filter({ has: __twTextLocator });
  const __twCandidateCount = await __twCandidate.count();
  __twSemanticCount += __twCandidateCount;
  if (__twCandidateCount === 1) {
    __twLocator = __twCandidate;
    __twResolvedKind = "role";
    __twResolvedRole = __twRole;
  }
}
if (__twSemanticCount > 1) throw new Error("TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + __twSemanticCount);
if (__twSemanticCount === 0 && ${allowOnclickProperty ? "true" : "false"}) {
  const __twClickBinding = await __twTextLocator.evaluate((element, maxDepth) => {
    let current = element;
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
      if (typeof current.onclick === "function") {
        return {
          kind: "onclick-property",
          depth,
          tagName: typeof current.tagName === "string" ? current.tagName.toLowerCase() : null,
          role: typeof current.getAttribute === "function" ? current.getAttribute("role") : null,
          id: typeof current.id === "string" && current.id ? current.id : null,
        };
      }
      current = current.parentElement;
    }
    return null;
  }, 6);
  if (__twClickBinding) {
    ${expectedClickBinding === null ? "" : `if (JSON.stringify(__twClickBinding) !== ${JSON.stringify(expectedClickBinding)}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED");`}
    let __twClickAncestor = __twTextLocator;
    for (let __twDepth = 0; __twDepth < __twClickBinding.depth; __twDepth += 1) {
      __twClickAncestor = __twClickAncestor.locator("..");
    }
    const __twAncestorCount = await __twClickAncestor.count();
    if (__twAncestorCount !== 1) throw new Error("TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + __twAncestorCount);
    __twLocator = __twClickAncestor;
    __twResolvedKind = "onclick-property";
    __twResolvedClickBinding = __twClickBinding;
    __twSemanticCount = 1;
  }
}
if (__twSemanticCount === 0 && ${allowLabelControl ? "true" : "false"}) {
  const __twLabelBinding = await __twTextLocator.evaluate((element, maxDepth) => {
    let current = element;
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
      if (typeof current.tagName === "string" && current.tagName.toLowerCase() === "label") {
        const forId = typeof current.getAttribute === "function" ? current.getAttribute("for") : null;
        const control = current.control
          ?? (forId ? document.getElementById(forId) : null)
          ?? current.querySelector?.("input,button,select,textarea")
          ?? null;
        if (control && !control.disabled) {
          return {
            kind: "label-control",
            depth,
            tagName: "label",
            forId: typeof forId === "string" && forId ? forId : null,
            controlTagName: typeof control.tagName === "string" ? control.tagName.toLowerCase() : null,
            controlType: typeof control.type === "string" && control.type ? control.type.toLowerCase() : null,
          };
        }
      }
      current = current.parentElement;
    }
    return null;
  }, 6);
  if (__twLabelBinding) {
    ${expectedLabelBinding === null ? "" : `if (JSON.stringify(__twLabelBinding) !== ${JSON.stringify(expectedLabelBinding)}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED");`}
    let __twLabel = __twTextLocator;
    for (let __twDepth = 0; __twDepth < __twLabelBinding.depth; __twDepth += 1) {
      __twLabel = __twLabel.locator("..");
    }
    const __twLabelCount = await __twLabel.count();
    if (__twLabelCount !== 1) throw new Error("TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + __twLabelCount);
    __twLocator = __twLabel;
    __twResolvedKind = "label-control";
    __twResolvedClickBinding = __twLabelBinding;
    __twSemanticCount = 1;
  }
}
if (__twSemanticCount === 0 && ${allowLocalRadio ? "true" : "false"}) {
  const __twRadioBinding = await __twTextLocator.evaluate((element, maxDepth) => {
    let current = element;
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
      const radios = Array.from(current.querySelectorAll?.('input[type="radio"]') ?? []).filter((control) => !control.disabled);
      if (radios.length === 1) {
        const control = radios[0];
        return {
          kind: "local-radio",
          depth,
          id: typeof control.id === "string" && control.id ? control.id : null,
          name: typeof control.name === "string" && control.name ? control.name : null,
          value: typeof control.value === "string" ? control.value : null,
        };
      }
      if (radios.length > 1) return null;
      current = current.parentElement;
    }
    return null;
  }, 6);
  if (__twRadioBinding) {
    ${expectedRadioBinding === null ? "" : `if (JSON.stringify(__twRadioBinding) !== ${JSON.stringify(expectedRadioBinding)}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED");`}
    __twLocator = __twTextLocator;
    __twResolvedKind = "local-radio";
    __twResolvedClickBinding = __twRadioBinding;
    __twSemanticCount = 1;
  }
}
if (__twSemanticCount === 0 && ${allowFlairTemplateOption ? "true" : "false"}) {
  const __twFlairBinding = await __twTextLocator.evaluate((element, maxDepth) => {
    let current = element;
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
      const isOption = typeof current.tagName === "string"
        && current.tagName.toLowerCase() === "li"
        && (current.classList?.contains?.("flairsample-right") || current.classList?.contains?.("flairsample-left"));
      const templateId = typeof current.id === "string" ? current.id.trim() : "";
      if (isOption && templateId && templateId.length <= 128) {
        let selector = current;
        for (let selectorDepth = 0; selector && selectorDepth <= 4; selectorDepth += 1) {
          if (selector.classList?.contains?.("flairselector")) {
            const hiddenInputs = Array.from(selector.querySelectorAll?.('input[type="hidden"][name="flair_template_id"]') ?? []);
            if (hiddenInputs.length === 1 && !hiddenInputs[0].disabled) {
              return { kind: "flair-template-option", depth, selectorDepth, templateId };
            }
            return null;
          }
          selector = selector.parentElement;
        }
      }
      current = current.parentElement;
    }
    return null;
  }, 6);
  if (__twFlairBinding) {
    ${expectedFlairTemplateId === null ? "" : `if (__twFlairBinding.templateId !== ${expectedFlairTemplateId}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED");`}
    let __twFlairOption = __twTextLocator;
    for (let __twDepth = 0; __twDepth < __twFlairBinding.depth; __twDepth += 1) {
      __twFlairOption = __twFlairOption.locator("..");
    }
    const __twFlairOptionCount = await __twFlairOption.count();
    if (__twFlairOptionCount !== 1) throw new Error("TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + __twFlairOptionCount);
    __twLocator = __twFlairOption;
    __twResolvedKind = "flair-template-option";
    __twResolvedClickBinding = __twFlairBinding;
    __twSemanticCount = 1;
  }
}
if (__twSemanticCount === 0 && ${allowThreadCardData ? "true" : "false"}) {
  const __twThreadCardBinding = await __twTextLocator.evaluate((element, maxDepth) => {
    let current = element;
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
      const threadId = typeof current.getAttribute === "function" ? current.getAttribute("data-thread-id") : null;
      const isThreadCard = Boolean(current.classList?.contains?.("thread-card"));
      if (isThreadCard && typeof threadId === "string" && threadId.trim()) {
        return {
          kind: "thread-card-data",
          depth,
          tagName: typeof current.tagName === "string" ? current.tagName.toLowerCase() : null,
          threadId: threadId.trim(),
        };
      }
      current = current.parentElement;
    }
    return null;
  }, 6);
  if (__twThreadCardBinding) {
    ${expectedThreadIdLiteral === null ? "" : `if (__twThreadCardBinding.threadId !== ${expectedThreadIdLiteral}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED");`}
    let __twThreadCard = __twTextLocator;
    for (let __twDepth = 0; __twDepth < __twThreadCardBinding.depth; __twDepth += 1) {
      __twThreadCard = __twThreadCard.locator("..");
    }
    const __twThreadCardCount = await __twThreadCard.count();
    if (__twThreadCardCount !== 1) throw new Error("TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + __twThreadCardCount);
    __twLocator = __twThreadCard;
    __twResolvedKind = "thread-card-data";
    __twResolvedClickBinding = __twThreadCardBinding;
    __twSemanticCount = 1;
  }
}
if (__twSemanticCount !== 1 || !__twLocator) {
  if (__twSemanticCount === 0) {
    const __twNoBindingDiagnostics = await __twTextLocator.evaluate((element, maxDepth) => {
      const rows = [];
      let current = element;
      for (let depth = 0; current && depth <= maxDepth; depth += 1) {
        const controls = Array.from(current.querySelectorAll?.("input,button,select,textarea") ?? []).slice(0, 8).map((control) => ({
          tag: typeof control.tagName === "string" ? control.tagName.toLowerCase() : null,
          type: typeof control.type === "string" && control.type ? control.type.toLowerCase() : null,
          name: typeof control.name === "string" && control.name ? control.name : null,
          id: typeof control.id === "string" && control.id ? control.id : null,
          disabled: Boolean(control.disabled),
          checked: typeof control.checked === "boolean" ? control.checked : null,
        }));
        rows.push({
          depth,
          tag: typeof current.tagName === "string" ? current.tagName.toLowerCase() : null,
          role: typeof current.getAttribute === "function" ? current.getAttribute("role") : null,
          id: typeof current.id === "string" && current.id ? current.id : null,
          classes: typeof current.className === "string" ? current.className.slice(0, 256) : null,
          hasOnclick: typeof current.onclick === "function",
          controls,
        });
        current = current.parentElement;
      }
      return rows;
    }, 6);
    throw new Error("TOOLWIRE_BROWSER_TEXT_NO_BINDING:" + JSON.stringify(__twNoBindingDiagnostics));
  }
  throw new Error("TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + __twSemanticCount);
}
const __twCount = 1;`;
  }
  if (
    target?.kind === "role"
    && typeof target.role === "string"
    && typeof target.name === "string"
    && typeof target.scopeUrl === "string"
    && target.scopeUrl
  ) {
    const scopeUrlLiteral = JSON.stringify(target.scopeUrl);
    return `
const __twScopeLinks = __twTab.playwright.getByRole("link").filter({ visible: true });
const __twScopeHrefs = await __twScopeLinks.evaluateAll((elements) => elements.map((element) => {
  const rawHref = typeof element?.href === "string" && element.href
    ? element.href
    : (typeof element?.getAttribute === "function" ? element.getAttribute("href") : null);
  if (!rawHref) return null;
  try { return new URL(rawHref, document.baseURI).href; } catch { return null; }
}));
const __twScopeIndexes = [];
for (let __twIndex = 0; __twIndex < __twScopeHrefs.length; __twIndex += 1) {
  if (__twScopeHrefs[__twIndex] === ${scopeUrlLiteral}) __twScopeIndexes.push(__twIndex);
}
if (__twScopeIndexes.length !== 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + __twScopeIndexes.length);
let __twScope = __twScopeLinks.nth(__twScopeIndexes[0]);
let __twLocator = null;
let __twScopeDepth = null;
for (let __twDepth = 0; __twDepth <= 8; __twDepth += 1) {
  const __twCandidate = __twScope.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true }).filter({ visible: true });
  const __twCandidateCount = await __twCandidate.count();
  if (__twCandidateCount > 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:" + __twDepth + ":" + __twCandidateCount);
  if (__twCandidateCount === 1) {
    __twLocator = __twCandidate;
    __twScopeDepth = __twDepth;
    break;
  }
  __twScope = __twScope.locator("..");
}
if (!__twLocator) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:-1:0");
const __twResolvedKind = "role-scope-url";
const __twResolvedRole = ${JSON.stringify(target.role)};
const __twResolvedClickBinding = { kind: "scope-url", scopeUrl: ${scopeUrlLiteral}, depth: __twScopeDepth };
const __twCount = 1;`;
  }
  if (target?.kind === "role" && typeof target.role === "string" && typeof target.name === "string") {
    return `
const __twLocator = __twTab.playwright.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true });
const __twResolvedKind = "role";
const __twResolvedRole = ${JSON.stringify(target.role)};
const __twResolvedClickBinding = null;
const __twCount = await __twLocator.count();`;
  }
  throw new BrowserPreviewError(
    "BROWSER_CLICK_TARGET_INVALID",
    "Prepared Browser click target is invalid or incomplete; prepare a fresh exact click from current page state"
  );
}

function browserFillLocatorSetupSource(target) {
  const strategyProbe = `
const __twTargetMeta = await __twLocator.evaluate((element) => {
  const tag = String(element?.tagName || "").toLowerCase();
  let customHost = null;
  let current = element?.parentElement ?? null;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const currentTag = String(current.tagName || "").toLowerCase();
    if (currentTag.includes("-")) {
      customHost = currentTag;
      break;
    }
    current = current.parentElement;
  }
  return {
    tag,
    contentEditable: Boolean(element?.isContentEditable),
    customHost,
  };
});
const __twFillStrategy = (__twTargetMeta.contentEditable || (__twTargetMeta.tag === "textarea" && __twTargetMeta.customHost))
  ? "type"
  : "fill";`;
  if (
    target?.kind === "scope-role"
    && typeof target.role === "string"
    && typeof target.scopeUrl === "string"
    && target.scopeUrl
  ) {
    const scopeUrlLiteral = JSON.stringify(target.scopeUrl);
    return `
const __twScopeLinks = __twTab.playwright.getByRole("link").filter({ visible: true });
const __twScopeHrefs = await __twScopeLinks.evaluateAll((elements) => elements.map((element) => {
  const rawHref = typeof element?.href === "string" && element.href
    ? element.href
    : (typeof element?.getAttribute === "function" ? element.getAttribute("href") : null);
  if (!rawHref) return null;
  try { return new URL(rawHref, document.baseURI).href; } catch { return null; }
}));
const __twScopeIndexes = [];
for (let __twIndex = 0; __twIndex < __twScopeHrefs.length; __twIndex += 1) {
  if (__twScopeHrefs[__twIndex] === ${scopeUrlLiteral}) __twScopeIndexes.push(__twIndex);
}
if (__twScopeIndexes.length !== 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + __twScopeIndexes.length);
let __twScope = __twScopeLinks.nth(__twScopeIndexes[0]);
let __twLocator = null;
for (let __twDepth = 0; __twDepth <= 8; __twDepth += 1) {
  const __twCandidate = __twScope.getByRole(${JSON.stringify(target.role)}).filter({ visible: true });
  const __twCandidateCount = await __twCandidate.count();
  if (__twCandidateCount > 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:" + __twDepth + ":" + __twCandidateCount);
  if (__twCandidateCount === 1) {
    __twLocator = __twCandidate;
    break;
  }
  __twScope = __twScope.locator("..");
}
if (!__twLocator) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:-1:0");
${strategyProbe}`;
  }
  if (target?.kind === "role" && typeof target.role === "string" && typeof target.name === "string") {
    return `
const __twLocator = __twTab.playwright.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true });
${strategyProbe}`;
  }
  if (
    target?.kind === "placeholder"
    && typeof target.role === "string"
    && typeof target.placeholder === "string"
    && target.placeholder
  ) {
    return `
const __twPlaceholderLocator = __twTab.playwright.getByPlaceholder(${JSON.stringify(target.placeholder)}, { exact: true }).filter({ visible: true });
const __twPlaceholderCount = await __twPlaceholderLocator.count();
let __twLocator = __twPlaceholderLocator;
if (__twPlaceholderCount !== 1) {
  const __twSemanticRoleLocator = __twTab.playwright.getByRole(${JSON.stringify(target.role)}).filter({ visible: true });
  const __twSemanticPlaceholderIndexes = [];
  for (let __twIndex = 0; __twIndex < __twPlaceholderCount; __twIndex += 1) {
    const __twCandidate = __twPlaceholderLocator.nth(__twIndex);
    const __twSemanticIntersectionCount = await __twCandidate.and(__twSemanticRoleLocator).count();
    if (__twSemanticIntersectionCount === 1) __twSemanticPlaceholderIndexes.push(__twIndex);
  }
  if (__twSemanticPlaceholderIndexes.length === 1) {
    const __twSemanticShell = __twPlaceholderLocator.nth(__twSemanticPlaceholderIndexes[0]);
    const __twNestedSemanticTextbox = __twSemanticShell.getByRole(${JSON.stringify(target.role)}).filter({ visible: true });
    const __twNestedSemanticTextboxCount = await __twNestedSemanticTextbox.count();
    if (__twNestedSemanticTextboxCount === 1) {
      __twLocator = __twNestedSemanticTextbox;
    } else if (__twNestedSemanticTextboxCount === 0) {
      __twLocator = __twSemanticShell;
    } else {
      throw new Error("TOOLWIRE_BROWSER_FILL_CANDIDATES:" + JSON.stringify({
        count: __twPlaceholderCount,
        semanticPlaceholderIndexes: __twSemanticPlaceholderIndexes,
        nestedSemanticTextboxCount: __twNestedSemanticTextboxCount,
      }));
    }
  } else {
  const __twCandidateState = await __twPlaceholderLocator.evaluateAll((elements) => {
    const nativeIndexes = [];
    const focusDistances = [];
    const candidates = [];
    const active = document.activeElement;
    elements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const tag = String(element.tagName || "").toLowerCase();
      const disabled = Boolean(element.disabled);
      const inert = Boolean(element.inert);
      if ((tag === "input" || tag === "textarea") && !disabled && !inert) nativeIndexes.push(index);
      let focusDistance = null;
      if (active) {
        let current = active;
        for (let depth = 0; depth <= 8 && current; depth += 1) {
          if (current === element) {
            focusDistance = depth;
            break;
          }
          current = current.parentElement;
        }
      }
      focusDistances.push(focusDistance);
      if (index < 8) {
        candidates.push({
          tag,
          type: element.getAttribute("type"),
          role: element.getAttribute("role"),
          ariaHidden: element.getAttribute("aria-hidden"),
          tabIndex: typeof element.tabIndex === "number" ? element.tabIndex : null,
          disabled,
          inert,
          focusDistance,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }
    });
    return { count: elements.length, nativeIndexes, focusDistances, candidates };
  });
  if (__twCandidateState.nativeIndexes.length === 1) {
    __twLocator = __twPlaceholderLocator.nth(__twCandidateState.nativeIndexes[0]);
  } else {
    const __twFocused = __twCandidateState.focusDistances
      .map((distance, index) => ({ distance, index }))
      .filter((entry) => Number.isInteger(entry.distance));
    const __twMinDistance = __twFocused.length ? Math.min(...__twFocused.map((entry) => entry.distance)) : null;
    const __twClosest = __twFocused.filter((entry) => entry.distance === __twMinDistance);
    if (__twClosest.length !== 1) {
      throw new Error("TOOLWIRE_BROWSER_FILL_CANDIDATES:" + JSON.stringify(__twCandidateState));
    }
    const __twFocusedShell = __twPlaceholderLocator.nth(__twClosest[0].index);
    const __twFocusedTextbox = __twFocusedShell.getByRole(${JSON.stringify(target.role)}).filter({ visible: true });
    const __twFocusedTextboxCount = await __twFocusedTextbox.count();
    if (__twFocusedTextboxCount !== 1) {
      throw new Error("TOOLWIRE_BROWSER_FILL_CANDIDATES:" + JSON.stringify(__twCandidateState));
    }
    __twLocator = __twFocusedTextbox;
  }
  }
}
const __twRoleLocator = __twTab.playwright.getByRole(${JSON.stringify(target.role)}).filter({ visible: true });
const __twRoleBoundLocator = __twLocator.and(__twRoleLocator);
const __twRoleBoundCount = await __twRoleBoundLocator.count();
if (__twRoleBoundCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twRoleBoundCount);
${strategyProbe}`;
  }
  throw new BrowserPreviewError(
    "BROWSER_FILL_TARGET_INVALID",
    "Prepared Browser fill target is invalid or incomplete; prepare a fresh exact fill from current page state"
  );
}

function normalizeBrowserHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrowserPreviewError("BROWSER_NAVIGATE_URL_REQUIRED", "url is required for Browser navigation");
  }
  if (value.length > 8_192) {
    throw new BrowserPreviewError("BROWSER_NAVIGATE_URL_TOO_LONG", "Browser navigation URLs are limited to 8192 characters");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new BrowserPreviewError(
      "BROWSER_NAVIGATE_URL_INVALID",
      "Browser navigation requires one valid absolute http:// or https:// URL"
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserPreviewError(
      "BROWSER_NAVIGATE_SCHEME_UNSUPPORTED",
      `Browser navigation accepts only http:// or https:// URLs, not ${parsed.protocol}`,
      ["Do not use javascript:, data:, file:, chrome:, extension, or other non-web schemes through this narrow navigation surface."]
    );
  }
  if (parsed.username || parsed.password) {
    throw new BrowserPreviewError(
      "BROWSER_NAVIGATE_CREDENTIALS_UNSUPPORTED",
      "Browser navigation does not accept URLs containing embedded username/password credentials"
    );
  }
  return parsed.href;
}

function browserTextBindingFromPrepareResult(result) {
  if (result?.resolvedKind === "role" && typeof result?.resolvedRole === "string" && result.resolvedRole) {
    return { kind: "role", role: result.resolvedRole };
  }
  const clickBinding = result?.resolvedClickBinding;
  if (
    result?.resolvedKind === "onclick-property"
    && clickBinding?.kind === "onclick-property"
    && Number.isInteger(clickBinding.depth)
    && clickBinding.depth >= 0
    && clickBinding.depth <= 6
    && typeof clickBinding.tagName === "string"
    && (clickBinding.role === null || typeof clickBinding.role === "string")
    && (clickBinding.id === null || typeof clickBinding.id === "string")
  ) {
    return {
      kind: "onclick-property",
      depth: clickBinding.depth,
      tagName: clickBinding.tagName,
      role: clickBinding.role,
      id: clickBinding.id,
    };
  }
  if (
    result?.resolvedKind === "label-control"
    && clickBinding?.kind === "label-control"
    && Number.isInteger(clickBinding.depth)
    && clickBinding.depth >= 0
    && clickBinding.depth <= 6
    && clickBinding.tagName === "label"
    && (clickBinding.forId === null || typeof clickBinding.forId === "string")
    && (clickBinding.controlTagName === null || typeof clickBinding.controlTagName === "string")
    && (clickBinding.controlType === null || typeof clickBinding.controlType === "string")
  ) {
    return {
      kind: "label-control",
      depth: clickBinding.depth,
      tagName: "label",
      forId: clickBinding.forId,
      controlTagName: clickBinding.controlTagName,
      controlType: clickBinding.controlType,
    };
  }
  if (
    result?.resolvedKind === "local-radio"
    && clickBinding?.kind === "local-radio"
    && Number.isInteger(clickBinding.depth)
    && clickBinding.depth >= 0
    && clickBinding.depth <= 6
    && (clickBinding.id === null || typeof clickBinding.id === "string")
    && (clickBinding.name === null || typeof clickBinding.name === "string")
    && (clickBinding.value === null || typeof clickBinding.value === "string")
  ) {
    return {
      kind: "local-radio",
      depth: clickBinding.depth,
      id: clickBinding.id,
      name: clickBinding.name,
      value: clickBinding.value,
    };
  }
  if (
    result?.resolvedKind === "flair-template-option"
    && clickBinding?.kind === "flair-template-option"
    && typeof clickBinding.templateId === "string"
    && clickBinding.templateId.length > 0
    && clickBinding.templateId.length <= 128
  ) {
    return {
      kind: "flair-template-option",
      templateId: clickBinding.templateId,
    };
  }
  if (
    result?.resolvedKind === "thread-card-data"
    && clickBinding?.kind === "thread-card-data"
    && Number.isInteger(clickBinding.depth)
    && clickBinding.depth >= 0
    && clickBinding.depth <= 6
    && typeof clickBinding.tagName === "string"
    && typeof clickBinding.threadId === "string"
    && clickBinding.threadId.length > 0
    && clickBinding.threadId.length <= 128
  ) {
    return {
      kind: "thread-card-data",
      threadId: clickBinding.threadId,
    };
  }
  throw new BrowserPreviewError(
    "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE",
    "The exact visible text did not resolve to one stable semantic click target",
    ["Use an exact role/name target, or handle this action manually until the page exposes one stable link, button, bounded onclick-property ancestor, or server-recognized data-thread-id card binding."]
  );
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function inspectScreenshotImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null;
  if (bytes.subarray(0, 8).toString("hex") === PNG_SIGNATURE_HEX && bytes.length >= 24) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 32_768 || height > 32_768) return null;
    return { mimeType: "image/png", width, height };
  }
  if (bytes.subarray(0, 3).toString("hex") === JPEG_SIGNATURE_HEX) {
    const dimensions = readJpegDimensions(bytes);
    if (!dimensions) return null;
    return { mimeType: "image/jpeg", ...dimensions };
  }
  return null;
}

function readJpegDimensions(bytes) {
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (sofMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > 32_768 || height > 32_768) return null;
      return { width, height };
    }
    offset += segmentLength;
  }
  return null;
}

function browserUnavailable(error) {
  const classified = classifyBrowserError(error);
  return {
    status: "unavailable",
    reason: classified.code ?? "browser_unavailable",
    error: classified.message,
    nextActions: classified.nextActions ?? ["Retry codex.browser_status after restoring the Browser runtime."],
  };
}

function browserMutationResultUncertain(kind, message) {
  const normalizedKind = Object.hasOwn(BROWSER_MUTATION_UNCERTAINTY, kind) ? kind : "click";
  const metadata = BROWSER_MUTATION_UNCERTAINTY[normalizedKind];
  return new BrowserPreviewError(
    metadata.code,
    message,
    [...metadata.directNextActions]
  );
}

function extractBrowserPermissionScope(message) {
  const match = String(message).match(/(?:^|[\s,{])["']?scope["']?\s*[:=]\s*["']?(conversation|global)\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function extractBrowserPermissionOrigin(message) {
  const text = String(message);
  const candidates = [];
  const accessMatch = text.match(/\bcannot\s+access\s+(https?:\/\/\S+?)\s+because\b/i);
  if (accessMatch?.[1]) candidates.push(accessMatch[1]);
  const structuredMatch = text.match(/["']origin["']\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  if (structuredMatch?.[1]) candidates.push(structuredMatch[1]);
  for (const candidate of candidates) {
    try {
      return new URL(candidate).origin;
    } catch {}
  }
  return null;
}

function browserPermissionDiagnostic(message, source) {
  const scope = extractBrowserPermissionScope(message);
  const origin = extractBrowserPermissionOrigin(message);
  return {
    source,
    ...(scope ? { scope } : {}),
    ...(origin ? { origin } : {}),
  };
}

function classifyBrowserError(error) {
  if (error instanceof BrowserPreviewError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const savedPermissionDenied = /\bbrowser-use-persisted-state\b/i.test(message)
    || /\bpersisted_user_denied\b/i.test(message)
    || /the user has a saved preference that blocks it\.?/i.test(message);
  if (savedPermissionDenied) {
    const diagnostic = browserPermissionDiagnostic(message, "browser-use-persisted-state");
    const target = diagnostic.origin ?? "this website";
    return new BrowserPreviewError(
      "BROWSER_ORIGIN_SAVED_PERMISSION_DENIED",
      `Browser is connected, but Browser use for ${target} is blocked by a saved website permission.`,
      [`Open the Browser/Computer use website-permission settings, remove the saved block or allow ${target}, then retry the Browser action.`],
      diagnostic
    );
  }
  const networkPolicyDenied = /\bcodex-network-policy(?!-unavailable)\b/i.test(message)
    || /\benterprise_policy_blocked\b/i.test(message)
    || /the admin-enforced policy blocks it\.?/i.test(message);
  if (networkPolicyDenied) {
    const diagnostic = browserPermissionDiagnostic(message, "codex-network-policy");
    const target = diagnostic.origin ?? "this website";
    return new BrowserPreviewError(
      "BROWSER_ORIGIN_NETWORK_POLICY_DENIED",
      `Browser is connected, but access to ${target} is blocked by Codex/workspace network policy.`,
      ["Use a destination allowed by the current policy, or ask the workspace/organization administrator to change that policy if this site should be allowed."],
      diagnostic
    );
  }
  if (/Missing required Codex turn metadata/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_TURN_METADATA_REJECTED",
      "The Codex Browser runtime rejected the supplied turn metadata",
      ["Refresh/reload the Browser surface so it injects x-codex-turn-metadata automatically."]
    );
  }
  for (const metadata of Object.values(BROWSER_MUTATION_UNCERTAINTY)) {
    if (!new RegExp(metadata.marker, "i").test(message)) continue;
    return new BrowserPreviewError(
      metadata.code,
      message.replace(new RegExp(`^.*${metadata.marker}:`), metadata.messagePrefix),
      [...metadata.classifiedNextActions]
    );
  }
  if (/TOOLWIRE_BROWSER_FILL_NOT_APPLIED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_FILL_NOT_APPLIED",
      message.replace(/^.*TOOLWIRE_BROWSER_FILL_NOT_APPLIED:/, "Browser fill did not apply the prepared text: "),
      ["The fresh bound textbox was directly observed in a state that proves the prepared change did not apply, so a fresh fill can be prepared safely if the intended text is still needed."]
    );
  }
  if (/TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_FILL_VERIFICATION_UNAVAILABLE",
      message.replace(/^.*TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:/, "Browser fill verification is unavailable: "),
      ["Do not retry automatically. Re-read the current tab/page state first; post-dispatch evidence was insufficient to prove the exact bound textbox reached the prepared state."]
    );
  }
  if (/TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_FILL_VERIFY_MISMATCH",
      "The Browser fill returned but the field value did not exactly match the prepared text",
      ["Do not submit or retry automatically. Re-read the current field/page state and decide whether a fresh fill is still needed."]
    );
  }
  if (/TOOLWIRE_BROWSER_FILL_VALUE_UNREADABLE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_FILL_VALUE_UNREADABLE",
      "The prepared Browser textbox/searchbox did not expose a readable string value through the current Chrome locator API",
      ["Re-read the current tab and choose a normal textbox/searchbox target; do not execute or submit from this unresolved field."]
    );
  }
  if (/TOOLWIRE_BROWSER_ACTION_URL_CHANGED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ACTION_PAGE_CHANGED",
      "The prepared Browser action was refused because the tab URL changed after preparation",
      ["Re-read the tab and prepare a fresh action from the current page state."]
    );
  }
  if (/TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ACTION_TARGET_CHANGED",
      "The exact visible-text Browser target no longer resolves to the same prepared click-bearing ancestor",
      ["Re-read the current page and prepare a fresh exact-text action; do not reuse the old approval."]
    );
  }
  if (/TOOLWIRE_BROWSER_TEXT_NO_BINDING:/i.test(message)) {
    const raw = message.slice(message.indexOf("TOOLWIRE_BROWSER_TEXT_NO_BINDING:") + "TOOLWIRE_BROWSER_TEXT_NO_BINDING:".length);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const rows = Array.isArray(parsed) ? parsed.slice(0, 7) : [];
    const summary = rows.map((row) => {
      const controls = Array.isArray(row?.controls)
        ? row.controls.map((control) => `${control?.tag ?? "?"}:${control?.type ?? "-"} name=${control?.name ?? "-"} id=${control?.id ?? "-"} disabled=${Boolean(control?.disabled)} checked=${control?.checked ?? "-"}`).join(",")
        : "";
      return `d${row?.depth ?? "?"} ${row?.tag ?? "?"} role=${row?.role ?? "-"} id=${row?.id ?? "-"} class=${row?.classes ?? "-"} onclick=${Boolean(row?.hasOnclick)} controls=[${controls}]`;
    }).join("; ");
    return new BrowserPreviewError(
      "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE",
      `The exact visible text did not resolve to one stable semantic click target.${summary ? ` Bounded ancestor diagnostics: ${summary}` : ""}`,
      ["Use exact role/name when available. Otherwise add only a server-derived bounded semantic binding that can be revalidated before execution; do not guess a caller selector, node id, item index, JavaScript, or coordinate target."]
    );
  }
  if (/TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:(\d+)/i.test(message)) {
    const match = message.match(/TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:(\d+)/i);
    return new BrowserPreviewError(
      "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE",
      `The exact visible text resolved to ${match?.[1] ?? "an unexpected number of"} stable semantic click targets; the Browser runtime requires exactly one link, button, bounded onclick-property ancestor, or server-recognized data-thread-id card binding`,
      ["Use exact role/name when the page exposes a semantic control, or handle this target manually until the page provides one stable bounded click binding."]
    );
  }
  if (/TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:(\d+)/i.test(message)) {
    const match = message.match(/TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:(\d+)/i);
    const count = Number(match?.[1] ?? 0);
    return new BrowserPreviewError(
      count === 0 ? "BROWSER_ACTION_SCOPE_NOT_FOUND" : "BROWSER_ACTION_SCOPE_AMBIGUOUS",
      count === 0
        ? "The exact Browser scopeUrl did not match any visible link on the current page"
        : `The exact Browser scopeUrl matched ${count} visible links; the Browser runtime requires exactly one local anchor`,
      ["Re-read the current page and use one exact visible link URL from the intended local item; do not guess a CSS selector, node id, or item index."]
    );
  }
  if (/TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:(-?\d+):(\d+)/i.test(message)) {
    const match = message.match(/TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:(-?\d+):(\d+)/i);
    const depth = Number(match?.[1] ?? -1);
    const count = Number(match?.[2] ?? 0);
    return new BrowserPreviewError(
      count === 0 ? "BROWSER_ACTION_TARGET_NOT_FOUND_IN_SCOPE" : "BROWSER_ACTION_TARGET_AMBIGUOUS",
      count === 0
        ? "The exact role/name target was not found within the bounded ancestor scope of the visible scopeUrl link"
        : `The scoped Browser target matched ${count} controls at ancestor depth ${depth}; the Browser runtime refuses to guess among repeated local actions`,
      ["Re-read the current item and prepare again only when one exact role/name control is locally identifiable from that scopeUrl."]
    );
  }
  if (/TOOLWIRE_BROWSER_FILL_CANDIDATES:/i.test(message)) {
    const raw = message.slice(message.indexOf("TOOLWIRE_BROWSER_FILL_CANDIDATES:") + "TOOLWIRE_BROWSER_FILL_CANDIDATES:".length);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates.slice(0, 8) : [];
    const candidateCount = parsed?.count ?? (candidates.length || "multiple");
    const summary = candidates.map((candidate, index) => {
      const rect = candidate?.rect ?? {};
      return `#${index + 1} ${candidate?.tag ?? "?"} type=${candidate?.type ?? "-"} role=${candidate?.role ?? "-"} ariaHidden=${candidate?.ariaHidden ?? "-"} tabIndex=${candidate?.tabIndex ?? "-"} disabled=${Boolean(candidate?.disabled)} inert=${Boolean(candidate?.inert)} rect=${rect.x ?? "?"},${rect.y ?? "?"},${rect.width ?? "?"}x${rect.height ?? "?"}`;
    }).join("; ");
    return new BrowserPreviewError(
      "BROWSER_ACTION_TARGET_AMBIGUOUS",
      `The exact Browser placeholder target matched ${candidateCount} visible elements; the Browser runtime requires exactly one.${summary ? ` Candidate diagnostics: ${summary}` : ""}`,
      ["Read the current tab again and choose a more specific exact role/name target, or leave this page fail-closed until the duplicate controls can be distinguished safely."]
    );
  }
  if (/TOOLWIRE_BROWSER_LOCATOR_COUNT:(\d+)/i.test(message)) {
    const match = message.match(/TOOLWIRE_BROWSER_LOCATOR_COUNT:(\d+)/i);
    return new BrowserPreviewError(
      "BROWSER_ACTION_TARGET_AMBIGUOUS",
      `The exact Browser target matched ${match?.[1] ?? "an unexpected number of"} elements; the Browser runtime requires exactly one`,
      ["Read the current tab again and choose a more specific exact role/name or visible-text target."]
    );
  }
  if (/TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ACTION_TARGET_NOT_VISIBLE",
      "The prepared Browser target is no longer visible",
      ["Read current page state and prepare the action again."]
    );
  }
  if (/TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ACTION_TARGET_NOT_ENABLED",
      "The prepared Browser target is currently disabled",
      ["Read current page state and wait for or choose an enabled target before preparing again."]
    );
  }
  if (/TOOLWIRE_BROWSER_TAB_STALE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_TAB_STALE",
      "The referenced Chrome tab is closed or no longer matches the current browser session",
      ["Call codex.browser_tabs again and use a fresh tabRef."]
    );
  }
  if (/extension|browser.*connect|no.*browser|not connected/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_CHROME_NOT_CONNECTED",
      message,
      ["Open/restore the supported Chrome extension/backend and retry codex.browser_status."]
    );
  }
  return new BrowserPreviewError(
    "BROWSER_RUNTIME_ERROR",
    message,
    ["Call codex.browser_status for current Browser/node_repl diagnostics before retrying."]
  );
}
