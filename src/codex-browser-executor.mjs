import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveAuthorizedExistingFile } from "./construction-tools.mjs";
import { browserModelRouteRuntimeParserSource } from "./browser-model-route-probe.mjs";
import { BrowserElementRefRegistry, browserElementNodesFromVisibleDom } from "./browser-element-ref.mjs";

const CHROME_SKILL_NAME = "chrome:control-chrome";
const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_TOOL = "js";
const DEFAULT_MAX_SNAPSHOT_CHARS = 80_000;
const MAX_SNAPSHOT_CHARS = 200_000;
const BROWSER_ACTION_APPROVAL_TTL_MS = 5 * 60_000;
const MAX_BROWSER_BULK_CLOSE_TABS = 100;
const BROWSER_POST_ACTION_MAX_CHARS = 20_000;
const BROWSER_FILL_ROLES = new Set(["textbox", "searchbox"]);
const BROWSER_FIXED_KEYS = new Set(["Enter", "Tab", "Escape"]);
const MAX_BROWSER_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 5_000_000;
const MAX_WEBMCP_DESCRIPTOR_BYTES = 256_000;
const MAX_WEBMCP_INPUT_BYTES = 256_000;
const MAX_WEBMCP_RESULT_BYTES = 200_000;
const MAX_WEBMCP_HANDLES = 64;
const BROWSER_MODEL_ROUTE_PROBE_TEXT = "你现在是什么模型？";
const BROWSER_MODEL_ROUTE_RUNTIME_PARSER_SOURCE = browserModelRouteRuntimeParserSource();
const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const JPEG_SIGNATURE_HEX = "ffd8ff";

export function sanitizePasswordDomSnapshot(snapshot, descriptors = []) {
  if (typeof snapshot !== "string" || !snapshot) {
    return { snapshot, redactedNodeCount: 0, protectedDescriptorCount: 0 };
  }

  const normalizeText = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const parseRenderedScalar = (value) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try { return normalizeText(JSON.parse(raw)); } catch {}
    }
    return normalizeText(raw);
  };
  const protectedDescriptors = (Array.isArray(descriptors) ? descriptors : []).map((descriptor) => {
    const type = normalizeText(descriptor?.type).toLowerCase();
    const role = normalizeText(descriptor?.role).toLowerCase();
    if (type !== "password" && role !== "password") return null;
    const candidateNames = new Set(
      (Array.isArray(descriptor?.candidateNames) ? descriptor.candidateNames : [])
        .map(normalizeText)
        .filter(Boolean)
    );
    return { type, role, candidateNames };
  }).filter(Boolean);

  const lineEnding = snapshot.includes("\r\n") ? "\r\n" : "\n";
  const lines = snapshot.split(/\r?\n/);
  const semanticNodes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+("(?:\\.|[^"\\])*"))?/);
    if (!header || header[2] === "text") continue;
    const indent = header[1].length;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const peer = lines[next].match(/^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+|:|$)/);
      if (peer && peer[1].length <= indent) {
        end = next;
        break;
      }
    }
    let name = "";
    if (header[3]) {
      try { name = normalizeText(JSON.parse(header[3])); } catch {}
    }
    const renderedNames = new Set(name ? [name] : []);
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const placeholder = lines[cursor].match(/^\s*-\s+\/placeholder:\s*(.*)$/);
      if (placeholder) {
        const rendered = parseRenderedScalar(placeholder[1]);
        if (rendered) renderedNames.add(rendered);
      }
    }
    semanticNodes.push({ index, end, indent, role: header[2].toLowerCase(), renderedNames });
  }

  const protectedNodeIndexes = new Set(
    semanticNodes.filter((node) => node.role === "password").map((node) => node.index)
  );
  const bindDescriptorByExactRenderedName = (descriptor, candidateRoles, claimedIndexes) => {
    if (descriptor.candidateNames.size === 0) {
      throw new Error("BROWSER_PASSWORD_SNAPSHOT_BINDING_AMBIGUOUS");
    }
    const matches = semanticNodes.filter((node) => {
      if (!candidateRoles.has(node.role) || claimedIndexes.has(node.index)) return false;
      for (const renderedName of node.renderedNames) {
        if (descriptor.candidateNames.has(renderedName)) return true;
      }
      return false;
    });
    if (matches.length !== 1) {
      throw new Error("BROWSER_PASSWORD_SNAPSHOT_BINDING_AMBIGUOUS");
    }
    claimedIndexes.add(matches[0].index);
    protectedNodeIndexes.add(matches[0].index);
  };

  const fallbackDescriptors = protectedDescriptors.filter((descriptor) => descriptor.role !== "password");
  if (fallbackDescriptors.length > 0) {
    const claimedFallbackIndexes = new Set();
    for (const descriptor of fallbackDescriptors) {
      bindDescriptorByExactRenderedName(descriptor, new Set(["textbox", "searchbox"]), claimedFallbackIndexes);
    }
  }

  const normalizedRolePasswordDescriptors = protectedDescriptors.filter((descriptor) => descriptor.role === "password");
  if (normalizedRolePasswordDescriptors.length > 0) {
    const literalPasswordNodes = semanticNodes.filter((node) => node.role === "password");
    const claimedGenericIndexes = new Set();
    for (const descriptor of normalizedRolePasswordDescriptors) {
      const representedAsLiteralPassword = literalPasswordNodes.some((node) => {
        if (descriptor.candidateNames.size === 0) return true;
        for (const renderedName of node.renderedNames) {
          if (descriptor.candidateNames.has(renderedName)) return true;
        }
        return false;
      });
      if (representedAsLiteralPassword) continue;
      bindDescriptorByExactRenderedName(descriptor, new Set(["generic"]), claimedGenericIndexes);
    }
  }

  let redactedNodeCount = 0;
  for (const node of semanticNodes) {
    if (!protectedNodeIndexes.has(node.index)) continue;
    let changed = false;
    const inline = lines[node.index].match(/^(\s*-\s+[A-Za-z][\w-]*(?:\s+"(?:\\.|[^"\\])*")?(?:\s+\[[^\]]+\])*)(:\s*)(.*)$/);
    if (inline && inline[3].trim()) {
      lines[node.index] = `${inline[1]}${inline[2]}[PASSWORD_REDACTED]`;
      changed = true;
    }
    for (let cursor = node.index + 1; cursor < node.end; cursor += 1) {
      const childIndent = lines[cursor].match(/^(\s*)/)?.[1]?.length ?? 0;
      if (childIndent <= node.indent) continue;
      const textChild = lines[cursor].match(/^(\s*-\s+text:\s*)(.*)$/);
      if (textChild && textChild[2].trim()) {
        lines[cursor] = `${textChild[1]}[PASSWORD_REDACTED]`;
        changed = true;
      }
    }
    if (changed) redactedNodeCount += 1;
  }

  return {
    snapshot: lines.join(lineEnding),
    redactedNodeCount,
    protectedDescriptorCount: protectedDescriptors.length,
  };
}

const BROWSER_PASSWORD_SNAPSHOT_SANITIZER_SOURCE = `
const sanitizePasswordDomSnapshot = ${sanitizePasswordDomSnapshot.toString()};
async function sanitizeBrowserDomSnapshot(tab) {
  const snapshot = await tab.playwright.domSnapshot();
  if (typeof snapshot !== "string" || !snapshot) return snapshot;
  const descriptors = await tab.playwright
    .locator('input[type="password"], [role="password"]')
    .filter({ visible: true })
    .evaluateAll((elements) => elements.map((element) => {
      const normalize = (value) => typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : "";
      const candidateNames = [];
      const add = (value) => {
        const normalized = normalize(value);
        if (normalized && !candidateNames.includes(normalized)) candidateNames.push(normalized);
      };
      add(element.getAttribute("aria-label"));
      add(element.getAttribute("placeholder"));
      add(element.getAttribute("title"));
      try {
        for (const label of Array.from(element.labels ?? [])) add(label.innerText ?? label.textContent);
      } catch {}
      const labelledBy = normalize(element.getAttribute("aria-labelledby"));
      if (labelledBy) {
        try {
          for (const id of labelledBy.split(/\\s+/)) {
            const label = element.ownerDocument?.getElementById?.(id);
            if (label) add(label.innerText ?? label.textContent);
          }
        } catch {}
      }
      return {
        type: normalize(element.getAttribute("type")).toLowerCase(),
        role: normalize(element.getAttribute("role")).toLowerCase(),
        candidateNames,
      };
    }));
  return sanitizePasswordDomSnapshot(snapshot, descriptors).snapshot;
}
`;

const BROWSER_MUTATION_DEFINITIVE_RESPONSE_CODES = new Set([
  "BROWSER_FILL_NOT_APPLIED",
  "BROWSER_FILL_VERIFICATION_UNAVAILABLE",
  "BROWSER_FILL_VERIFY_MISMATCH",
  "BROWSER_FILL_VALUE_UNREADABLE",
  "BROWSER_FILL_TARGET_NOT_EDITABLE",
  "BROWSER_ACTION_PAGE_CHANGED",
  "BROWSER_ACTION_TARGET_CHANGED",
  "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE",
  "BROWSER_ACTION_SCOPE_NOT_FOUND",
  "BROWSER_ACTION_SCOPE_AMBIGUOUS",
  "BROWSER_ACTION_TARGET_NOT_FOUND_IN_SCOPE",
  "BROWSER_ACTION_TARGET_AMBIGUOUS",
  "BROWSER_ACTION_TARGET_NOT_VISIBLE",
  "BROWSER_ACTION_TARGET_NOT_ENABLED",
  "BROWSER_EXISTING_TAB_RELEASE_UNAVAILABLE",
  "BROWSER_TAB_STALE",
  "BROWSER_MODEL_ROUTE_HOST_DENIED",
  "BROWSER_MODEL_ROUTE_LOGIN_REQUIRED",
  "BROWSER_MODEL_ROUTE_CHAT_SURFACE_REQUIRED",
  "BROWSER_MODEL_ROUTE_CDP_UNAVAILABLE",
  "BROWSER_MODEL_ROUTE_LOGIN_OR_PAGE_NOT_READY",
  "BROWSER_MODEL_ROUTE_EDITOR_NOT_UNIQUE",
  "BROWSER_MODEL_ROUTE_EDITOR_NOT_EMPTY",
  "BROWSER_MODEL_ROUTE_EDITOR_FILL_FAILED",
  "BROWSER_BULK_CLOSE_TAB_STALE",
  "BROWSER_BULK_CLOSE_TARGET_CHANGED",
  "BROWSER_BULK_CLOSE_URL_UNAVAILABLE",
  "BROWSER_BULK_CLOSE_PREDISPATCH_RELEASE_UNPROVEN",
  "BROWSER_WEBMCP_REF_STALE",
  "BROWSER_WEBMCP_PAGE_CHANGED",
  "BROWSER_WEBMCP_TOOL_NOT_LISTED",
  "BROWSER_ELEMENT_STALE",
  "BROWSER_ELEMENT_TARGET_CHANGED",
  "BROWSER_ELEMENT_VISIBLE_DOM_INVALID",
  "BROWSER_ELEMENT_ACTION_UNSUPPORTED",
]);

export function browserFillEditableElementProfile(element) {
  const tag = typeof element?.tagName === "string" ? element.tagName.toLowerCase() : "";
  const contentEditableAttr = typeof element?.getAttribute === "function" ? element.getAttribute("contenteditable") : null;
  const normalizedContentEditableAttr = typeof contentEditableAttr === "string" ? contentEditableAttr.trim().toLowerCase() : null;
  const effectiveContentEditable = element?.isContentEditable === true
    || normalizedContentEditableAttr === ""
    || normalizedContentEditableAttr === "true"
    || normalizedContentEditableAttr === "plaintext-only";
  const disabled = element?.disabled === true
    || element?.inert === true
    || (typeof element?.getAttribute === "function" && String(element.getAttribute("aria-disabled") ?? "").trim().toLowerCase() === "true");
  const readOnly = element?.readOnly === true
    || (typeof element?.hasAttribute === "function" && element.hasAttribute("readonly"))
    || (typeof element?.getAttribute === "function" && String(element.getAttribute("aria-readonly") ?? "").trim().toLowerCase() === "true");
  const inputType = tag === "input"
    ? String((typeof element?.getAttribute === "function" ? element.getAttribute("type") : null) ?? element?.type ?? "text").trim().toLowerCase() || "text"
    : null;
  const textInputType = inputType === null || ["text", "search", "email", "url", "tel", "password"].includes(inputType);
  const blocksSemanticShell = tag === "input"
    || tag === "textarea"
    || typeof contentEditableAttr === "string"
    || element?.isContentEditable === true
    || disabled
    || readOnly;
  if (disabled || readOnly) {
    return {
      supported: false,
      kind: null,
      tag,
      inputType,
      effectiveContentEditable,
      blocksSemanticShell,
    };
  }
  if (tag === "textarea") {
    return { supported: true, kind: "textarea", tag, inputType: null, effectiveContentEditable: false, blocksSemanticShell: true };
  }
  if (tag === "input") {
    return {
      supported: textInputType,
      kind: textInputType ? "input" : null,
      tag,
      inputType,
      effectiveContentEditable: false,
      blocksSemanticShell: true,
    };
  }
  if (effectiveContentEditable) {
    return { supported: true, kind: "contenteditable", tag, inputType: null, effectiveContentEditable: true, blocksSemanticShell: true };
  }
  return { supported: false, kind: null, tag, inputType: null, effectiveContentEditable: false, blocksSemanticShell };
}

export function resolveBoundFillEditableElement(element, isVisibleOverride = null) {
  if (!element) return { source: null, editableCount: 0, kind: null };
  const direct = browserFillEditableElementProfile(element);
  const isVisible = typeof isVisibleOverride === "function"
    ? isVisibleOverride
    : (candidate) => {
        if (!candidate || candidate.nodeType !== 1) return false;
        const view = candidate.ownerDocument?.defaultView ?? globalThis.window ?? null;
        const getComputedStyle = typeof view?.getComputedStyle === "function" ? view.getComputedStyle.bind(view) : null;
        if (getComputedStyle) {
          const style = getComputedStyle(candidate);
          if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= 0.01) return false;
        }
        if (typeof candidate.getClientRects === "function") {
          return Array.from(candidate.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
        }
        return true;
      };
  const rawDescendants = typeof element.querySelectorAll === "function"
    ? Array.from(element.querySelectorAll("input, textarea, [contenteditable]"))
    : [];
  const visibleKnownDescendants = rawDescendants.filter((candidate) => isVisible(candidate));
  const editableDescendants = visibleKnownDescendants.filter((candidate) => browserFillEditableElementProfile(candidate).supported);
  if (direct.supported) {
    if (editableDescendants.length > 0) {
      return { source: null, editableCount: 1 + editableDescendants.length, kind: null };
    }
    return { source: "direct", editableCount: 1, kind: direct.kind };
  }
  if (editableDescendants.length === 1) {
    return {
      source: "unique-visible-descendant",
      editableCount: 1,
      kind: browserFillEditableElementProfile(editableDescendants[0]).kind,
    };
  }
  if (editableDescendants.length > 1) {
    return { source: null, editableCount: editableDescendants.length, kind: null };
  }
  if (direct.blocksSemanticShell || visibleKnownDescendants.length > 0) {
    return { source: null, editableCount: 0, kind: null };
  }
  return { source: "semantic-shell", editableCount: 0, kind: "semantic-shell" };
}

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

const BROWSER_FILL_EDITABLE_ELEMENT_PROFILE_SOURCE = browserFillEditableElementProfile.toString();
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

export function normalizeBrowserLifecycleShape(browser, tab = null) {
  const hasExplicitFinalize = typeof browser?.tabs?.finalize === "function";
  const hasMarkDeliverable = typeof tab?.markDeliverable === "function";
  const hasMarkHandoff = typeof tab?.markHandoff === "function";
  if (hasExplicitFinalize) {
    return {
      shape: "legacy-explicit-finalize",
      existingTabRelease: "explicit-finalize",
      deliverable: "explicit-finalize",
    };
  }
  if (tab === null || tab === undefined) {
    return {
      shape: "finalize-absent-release-unproven",
      existingTabRelease: "unavailable",
      deliverable: "unknown-until-tab",
    };
  }
  if (hasMarkDeliverable || hasMarkHandoff) {
    return {
      shape: "finalize-absent-turn-cleanup",
      existingTabRelease: "turn-boundary-auto-release",
      continuation: hasMarkHandoff ? "markHandoff" : "unavailable",
      deliverable: hasMarkDeliverable ? "markDeliverable" : "unavailable",
    };
  }
  return {
    shape: "unknown",
    existingTabRelease: "unavailable",
    deliverable: "unavailable",
  };
}

export function assertBrowserExistingTabReleaseAvailable(browser) {
  const lifecycle = normalizeBrowserLifecycleShape(browser);
  if (lifecycle.shape !== "legacy-explicit-finalize") {
    throw new Error(`TOOLWIRE_BROWSER_EXISTING_TAB_RELEASE_UNAVAILABLE:${lifecycle.shape}`);
  }
  return lifecycle;
}

export async function cleanupBrowserClaim(browser, tab) {
  const lifecycle = normalizeBrowserLifecycleShape(browser, tab);
  if (lifecycle.shape === "legacy-explicit-finalize") {
    await browser.tabs.finalize({ keep: [] });
    return {
      cleanupStatus: "released",
      cleanupReason: "explicit-finalize",
      lifecycleShape: lifecycle.shape,
    };
  }
  return {
    cleanupStatus: lifecycle.shape === "finalize-absent-turn-cleanup" ? "deferred" : "unavailable",
    cleanupReason: lifecycle.shape === "finalize-absent-turn-cleanup"
      ? "turn-boundary-auto-release"
      : "explicit-release-unavailable",
    lifecycleShape: lifecycle.shape,
  };
}

export async function releaseBrowserClaim(browser, tab) {
  return cleanupBrowserClaim(browser, tab);
}

export async function markBrowserHandoff(browser, tab) {
  const lifecycle = normalizeBrowserLifecycleShape(browser, tab);
  if (lifecycle.shape === "finalize-absent-turn-cleanup" && lifecycle.continuation === "markHandoff") {
    await tab.markHandoff();
    return lifecycle.shape;
  }
  throw new Error(`TOOLWIRE_BROWSER_HANDOFF_API_UNAVAILABLE:${lifecycle.shape}`);
}

export async function markBrowserDeliverable(browser, tab) {
  const lifecycle = normalizeBrowserLifecycleShape(browser, tab);
  if (lifecycle.shape === "legacy-explicit-finalize") {
    await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });
    return lifecycle.shape;
  }
  if (lifecycle.shape === "finalize-absent-turn-cleanup" && lifecycle.deliverable === "markDeliverable") {
    await tab.markDeliverable();
    return lifecycle.shape;
  }
  throw new Error(`TOOLWIRE_BROWSER_DELIVERABLE_API_UNAVAILABLE:${lifecycle.shape}`);
}

const BROWSER_LIFECYCLE_ADAPTER_SOURCE = [
  normalizeBrowserLifecycleShape.toString(),
  assertBrowserExistingTabReleaseAvailable.toString(),
  cleanupBrowserClaim.toString(),
  releaseBrowserClaim.toString(),
  markBrowserHandoff.toString(),
  markBrowserDeliverable.toString(),
].join("\n");

export class CodexBrowserExecutor {
  #workbench;
  #defaultCwd;
  #runtimeCwd;
  #authorityExecutor;
  #runtimeCompatibility = null;
  #runtimeCompatibilityFailure = null;
  #runtimeCompatibilityResolver = null;
  #sessionId = `toolwire-browser-${randomUUID()}`;
  #turnSeq = 0;
  #browserClientUrl = null;
  #tabs = new Map();
  #providerToRef = new Map();
  #webMcpHandles = new Map();
  #actionApprovals = new Map();
  #activeMutations = new Map();
  #elementRefs = new BrowserElementRefRegistry();
  #emergencyResetInProgress = false;
  #workbenchGeneration = 0;

  constructor({
    workbench,
    defaultCwd,
    authorityExecutor = null,
    runtimeCompatibility = null,
    runtimeCompatibilityResolver = null,
  }) {
    if (!workbench) throw new Error("CodexBrowserExecutor requires workbench");
    if (!defaultCwd) throw new Error("CodexBrowserExecutor requires defaultCwd");
    if (runtimeCompatibilityResolver !== null && typeof runtimeCompatibilityResolver !== "function") {
      throw new Error("runtimeCompatibilityResolver must be null or a function");
    }
    this.#workbench = workbench;
    this.#defaultCwd = path.resolve(defaultCwd);
    const browserRuntimeCwd = runtimeCompatibility?.status === "ok"
      && typeof runtimeCompatibility?.browserRuntimeCwd === "string"
      && runtimeCompatibility.browserRuntimeCwd.trim()
      ? runtimeCompatibility.browserRuntimeCwd
      : defaultCwd;
    this.#runtimeCwd = path.resolve(browserRuntimeCwd);
    this.#authorityExecutor = authorityExecutor;
    if (runtimeCompatibility?.status === "unavailable") {
      this.#runtimeCompatibilityFailure = normalizeRuntimeCompatibilityFailure(runtimeCompatibility);
    } else {
      this.#runtimeCompatibility = normalizeRuntimeCompatibilityBinding(runtimeCompatibility);
    }
    this.#runtimeCompatibilityResolver = runtimeCompatibilityResolver;
    if (this.#runtimeCompatibility && !this.#runtimeCompatibilityResolver) {
      throw new Error("runtimeCompatibilityResolver is required with a Browser runtime compatibility binding");
    }
    this.#browserClientUrl = this.#runtimeCompatibility
      ? pathToFileURL(this.#runtimeCompatibility.browserClientPath).href
      : null;
    this.#workbenchGeneration = this.#currentWorkbenchGeneration();
  }

  #currentWorkbenchGeneration() {
    return Number.isInteger(this.#workbench?.generation) ? this.#workbench.generation : 0;
  }

  #resetLocalBrowserControlBindings(nextGeneration = this.#currentWorkbenchGeneration()) {
    this.#tabs.clear();
    this.#providerToRef.clear();
    this.#webMcpHandles.clear();
    this.#actionApprovals.clear();
    this.#elementRefs.clear();
    this.#browserClientUrl = null;
    this.#sessionId = `toolwire-browser-${randomUUID()}`;
    this.#turnSeq = 0;
    this.#workbenchGeneration = nextGeneration;
  }

  #syncWorkbenchGeneration() {
    const current = this.#currentWorkbenchGeneration();
    if (current === this.#workbenchGeneration) return false;
    this.#resetLocalBrowserControlBindings(current);
    return true;
  }

  async #readyPreparedAction(actionApprovalRef, prepared) {
    const effectiveCwd = prepared.cwd;
    const assertPreparedGeneration = () => {
      if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
        throw new BrowserPreviewError(
          "BROWSER_ACTION_RUNTIME_RESTARTED",
          "The prepared Browser action belongs to an older Codex Workbench generation and cannot be dispatched",
          ["Refresh browser_tabs and prepare a fresh exact action from the current Browser runtime."]
        );
      }
    };

    try {
      await this.#requireReady(effectiveCwd, normalizeBrowserFamily(prepared.family ?? "chrome"));
    } catch (error) {
      assertPreparedGeneration();
      const classified = classifyBrowserError(error);
      if (classified.code !== "BROWSER_NODE_REPL_DISCOVERY_FAILED") throw classified;
      try {
        await this.#requireReady(effectiveCwd, normalizeBrowserFamily(prepared.family ?? "chrome"));
      } catch (retryError) {
        assertPreparedGeneration();
        const retryClassified = classifyBrowserError(retryError);
        if (retryClassified.code !== "BROWSER_NODE_REPL_DISCOVERY_FAILED") throw retryClassified;
        throw new BrowserPreviewError(
          "BROWSER_NODE_REPL_DISCOVERY_FAILED",
          "Browser node_repl discovery remained unavailable after one bounded pre-dispatch rediscovery attempt; no Browser mutation was dispatched and the prepared action ref remains unconsumed.",
          ["Retry the same prepared actionApprovalRef after Browser/node_repl recovers. A browser_status warm-up or full re-prepare is not required unless the Browser runtime generation or page state changed."],
          {
            failureLayer: "pre_dispatch_discovery",
            preDispatch: true,
            safeToRetry: true,
            internalRediscoveryAttempts: 1,
            actionRefRetained: true,
          }
        );
      }
    }

    assertPreparedGeneration();
    this.#actionApprovals.delete(actionApprovalRef);
    return effectiveCwd;
  }

  async status({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const dependency = await this.#dependencyStatus(effectiveCwd);
    if (dependency.status !== "ok") return dependency;

    try {
      const backends = await this.#listBackends(effectiveCwd);
      const chromeBackends = backends.filter((backend) => backend.family === "chrome");
      if (chromeBackends.length === 0) {
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
      if (chromeBackends.length > 1) {
        return chromeBackendAmbiguous(backends, chromeBackends);
      }
      const [chrome] = chromeBackends;
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

  async emergencyResetControlState({ cwd = this.#defaultCwd } = {}) {
    path.resolve(cwd);
    this.#syncWorkbenchGeneration();
    if (typeof this.#workbench?.restart !== "function") {
      throw new BrowserPreviewError(
        "BROWSER_EMERGENCY_RESET_UNAVAILABLE",
        "This Browser runtime does not expose the dedicated Workbench restart primitive required for bounded emergency control-state reset",
        ["Do not kill Chrome or close user tabs as a substitute. Use a runtime that exposes the dedicated Browser Workbench restart path."]
      );
    }
    if (this.#emergencyResetInProgress) {
      throw new BrowserPreviewError(
        "BROWSER_EMERGENCY_RESET_IN_PROGRESS",
        "A Browser emergency control-state reset is already in progress",
        ["Do not start another reset or mutation until the current reset returns a receipt."]
      );
    }
    const activeMutations = [...this.#activeMutations.values()];
    if (activeMutations.length > 0) {
      throw new BrowserPreviewError(
        "BROWSER_EMERGENCY_RESET_MUTATION_IN_FLIGHT",
        "Emergency Browser control-state reset was refused because this Codexless Browser runtime can prove a mutation is still in flight",
        ["Wait for the current mutation receipt. If its result is uncertain, read current state and follow the no-replay rule before considering a reset."],
        {
          activeMutationCount: activeMutations.length,
          activeMutationKinds: [...new Set(activeMutations.map((entry) => entry.kind))].sort(),
          generation: this.#workbenchGeneration,
        }
      );
    }

    const before = {
      generation: this.#workbenchGeneration,
      tabBindingCount: this.#tabs.size,
      preparedActionCount: this.#actionApprovals.size,
      activeMutationCount: 0,
    };
    this.#emergencyResetInProgress = true;
    try {
      await this.#workbench.restart();
      const afterGeneration = this.#currentWorkbenchGeneration();
      this.#resetLocalBrowserControlBindings(afterGeneration);
      return {
        status: "reset",
        action: "browser_control_state_emergency_reset",
        before,
        after: {
          generation: afterGeneration,
          tabBindingCount: 0,
          preparedActionCount: 0,
          activeMutationCount: 0,
        },
        generationAdvanced: afterGeneration > before.generation,
        chromeTabsClosed: 0,
        browserMutationReplayed: false,
        note: "Emergency reset restarted only the dedicated Browser Workbench/control plane, invalidated all prior Browser tabRef/prepared-action bindings, and did not close, navigate, click, fill, submit, or replay any Chrome page action. This is an administrator fallback, not a replacement for normal claim handback/stale-owner recovery.",
      };
    } catch (error) {
      const afterGeneration = this.#currentWorkbenchGeneration();
      this.#resetLocalBrowserControlBindings(afterGeneration);
      throw new BrowserPreviewError(
        "BROWSER_EMERGENCY_RESET_FAILED",
        `Emergency Browser control-state reset did not complete cleanly: ${error instanceof Error ? error.message : String(error)}`,
        ["Treat all prior Browser tabRef/prepared-action refs as invalid. Check browser_status/browser_tabs before any fresh action; do not replay a prior mutation automatically."],
        {
          beforeGeneration: before.generation,
          afterGeneration,
          localBindingsInvalidated: true,
          chromeTabsClosed: 0,
        }
      );
    } finally {
      this.#emergencyResetInProgress = false;
    }
  }

  async listTabs({ family = "chrome", cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const browserFamily = normalizeBrowserFamily(family);
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const rawTabs = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twTabs = await __twBrowser.user.openTabs();
nodeRepl.write(JSON.stringify(__twTabs.map((tab) => ({
  providerTabId: tab.providerTabId,
  title: tab.title ?? null,
  url: tab.url ?? null,
  lastOpened: tab.lastOpened ?? null,
}))));
`, "List current Chrome tabs");

    if (!Array.isArray(rawTabs)) {
      throw new BrowserPreviewError("BROWSER_PROTOCOL_ERROR", `${browserFamily} openTabs returned a non-array result`);
    }

    const currentProviders = new Set();
    const tabs = [];
    for (const raw of rawTabs) {
      const providerTabId = typeof raw?.providerTabId === "string" ? raw.providerTabId : null;
      if (!providerTabId) continue;
      const providerKey = `${browserFamily}:${providerTabId}`;
      currentProviders.add(providerKey);
      let tabRef = this.#providerToRef.get(providerKey);
      if (!tabRef) {
        tabRef = `browser_tab_${randomUUID()}`;
        this.#providerToRef.set(providerKey, tabRef);
      }
      const state = {
        tabRef,
        family: browserFamily,
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

    for (const [providerKey, tabRef] of this.#providerToRef.entries()) {
      if (!providerKey.startsWith(`${browserFamily}:`)) continue;
      if (!currentProviders.has(providerKey)) {
        this.#providerToRef.delete(providerKey);
        this.#tabs.delete(tabRef);
        this.#elementRefs.invalidateTab(tabRef);
      }
    }

    return {
      status: "ok",
      browser: browserFamily,
      count: tabs.length,
      tabs,
      note: `tabRef values are opaque, bound to the ${browserFamily} family, and valid only while this Workbench runtime can still match the same open tab. Call codex.browser_tabs again after a backend restart or when a tab closes/moves unexpectedly.`,
    };
  }

  async readTab({ tabRef, cwd = this.#defaultCwd, maxChars = DEFAULT_MAX_SNAPSHOT_CHARS }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > MAX_SNAPSHOT_CHARS) {
      throw new BrowserPreviewError(
        "BROWSER_MAX_CHARS_INVALID",
        `maxChars must be an integer between 1000 and ${MAX_SNAPSHOT_CHARS}`
      );
    }
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current browser family."]
      );
    }
    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const familyLiteral = JSON.stringify(browserFamily);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twCleanup = null;
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
  if (__twTab) __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
}
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
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
      browser: browserFamily,
      tab: publicTab(current),
      snapshot: truncated ? snapshot.slice(0, maxChars) : snapshot,
      snapshotChars: snapshot.length,
      snapshotTruncated: truncated,
      ...browserCleanupReceipt(result),
      authState: "site_specific_unknown",
      note: "This is a read-only snapshot of the existing tab. The Browser runtime did not navigate, click, submit, or change page state. If the site redirected to a login page, inspect the returned current URL/snapshot instead of assuming authentication.",
    };
  }

  async #discardWebMcpNodeHandle(cwd, webMcpRef, expectedGeneration = null) {
    this.#webMcpHandles.delete(webMcpRef);
    try {
      const refLiteral = JSON.stringify(webMcpRef);
      await this.#runJson(cwd, `
globalThis.__codexlessWebMcpHandles?.delete(${refLiteral});
nodeRepl.write(JSON.stringify({ discarded: true }));
`, "Discard current Browser WebMCP handle", { expectedGeneration });
      return true;
    } catch {
      return false;
    }
  }

  async discoverWebMcp({ tabRef, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current browser family."]
      );
    }
    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);

    const webMcpRef = `browser_webmcp_${randomUUID()}`;
    const refLiteral = JSON.stringify(webMcpRef);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const familyLiteral = JSON.stringify(browserFamily);
    let result;
    try {
      result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twCleanup = null;
let __twTools = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (typeof __twUrl !== "string" || !__twUrl) throw new Error("TOOLWIRE_BROWSER_WEBMCP_URL_UNAVAILABLE");
  const __twWebMcp = await __twTab.capabilities.get("webmcp");
  __twTools = await __twWebMcp.fetchTools();
  const __twDescription = __twTools.description();
  if (typeof __twDescription !== "string") throw new Error("TOOLWIRE_BROWSER_WEBMCP_PROTOCOL_ERROR:description");
  const __twDescriptionBytes = Buffer.byteLength(__twDescription, "utf8");
  if (__twDescriptionBytes > ${MAX_WEBMCP_DESCRIPTOR_BYTES}) throw new Error("TOOLWIRE_BROWSER_WEBMCP_DESCRIPTOR_TOO_LARGE:" + __twDescriptionBytes);
  __twPayload = {
    title: __twInfo.title ?? null,
    url: __twUrl,
    lastOpened: __twInfo.lastOpened ?? null,
    description: __twDescription,
    descriptionBytes: __twDescriptionBytes,
  };
} finally {
  if (__twTab) __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
}
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
if (__twPayload && __twTools) {
  globalThis.__codexlessWebMcpHandles ??= new Map();
  while (globalThis.__codexlessWebMcpHandles.size >= ${MAX_WEBMCP_HANDLES}) {
    const __twOldest = globalThis.__codexlessWebMcpHandles.keys().next().value;
    if (__twOldest === undefined) break;
    globalThis.__codexlessWebMcpHandles.delete(__twOldest);
  }
  globalThis.__codexlessWebMcpHandles.set(${refLiteral}, { tools: __twTools, family: ${familyLiteral}, providerTabId: ${providerLiteral}, url: __twPayload.url });
}
nodeRepl.write(JSON.stringify(__twPayload));
`, "Discover current Browser WebMCP tools", { expectedGeneration: state.workbenchGeneration });
    } catch (error) {
      await this.#discardWebMcpNodeHandle(effectiveCwd, webMcpRef, state.workbenchGeneration);
      throw error;
    }

    const description = typeof result?.description === "string" ? result.description : null;
    if (description === null) {
      await this.#discardWebMcpNodeHandle(effectiveCwd, webMcpRef, state.workbenchGeneration);
      throw new BrowserPreviewError("BROWSER_WEBMCP_PROTOCOL_ERROR", "The stock Browser WebMCP capability returned no tool description");
    }
    const current = {
      ...state,
      title: stringOrNull(result?.title) ?? state.title,
      url: stringOrNull(result?.url) ?? state.url,
      lastOpened: stringOrNull(result?.lastOpened) ?? state.lastOpened,
      seenAt: Date.now(),
    };
    this.#tabs.set(tabRef, current);
    while (this.#webMcpHandles.size >= MAX_WEBMCP_HANDLES) {
      const oldest = this.#webMcpHandles.keys().next().value;
      if (oldest === undefined) break;
      const oldestBinding = this.#webMcpHandles.get(oldest);
      await this.#discardWebMcpNodeHandle(
        oldestBinding?.cwd ?? effectiveCwd,
        oldest,
        oldestBinding?.workbenchGeneration ?? state.workbenchGeneration
      );
    }
    this.#webMcpHandles.set(webMcpRef, {
      webMcpRef,
      tabRef,
      family: browserFamily,
      providerTabId: state.providerTabId,
      expectedUrl: current.url,
      cwd: effectiveCwd,
      workbenchGeneration: state.workbenchGeneration,
    });
    return {
      status: "discovered",
      browser: browserFamily,
      webMcpRef,
      tab: publicTab(current),
      description,
      descriptionBytes: Number.isInteger(result?.descriptionBytes) ? result.descriptionBytes : Buffer.byteLength(description, "utf8"),
      ...browserCleanupReceipt(result),
      note: "This directly reuses the stock Codex Browser tab WebMCP capability and its fetched tool handle. Call only a tool listed in description. This opaque webMcpRef is single-dispatch: once a page-defined call is attempted, Codexless consumes it so an uncertain or successful side effect cannot be replayed through the same ref. Rediscover from the same server-bound browser family/current page for any later distinct call. If description says no WebMCP tools are available, use the existing DOM Browser path instead.",
    };
  }

  async callWebMcp({ webMcpRef, toolName, input, timeoutMs = undefined }) {
    if (typeof webMcpRef !== "string" || !webMcpRef.startsWith("browser_webmcp_")) {
      throw new BrowserPreviewError("BROWSER_WEBMCP_REF_INVALID", "webMcpRef must be the opaque reference returned by codex.browser_webmcp_discover");
    }
    const normalizedToolName = typeof toolName === "string" ? toolName.trim() : "";
    if (!normalizedToolName || normalizedToolName.length > 256) {
      throw new BrowserPreviewError("BROWSER_WEBMCP_TOOL_NAME_INVALID", "toolName must be a non-empty listed WebMCP tool name of at most 256 characters");
    }
    if (input === undefined) {
      throw new BrowserPreviewError("BROWSER_WEBMCP_INPUT_REQUIRED", "input is required; use null only when the listed WebMCP tool accepts null");
    }
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) {
      throw new BrowserPreviewError("BROWSER_WEBMCP_TIMEOUT_INVALID", "timeoutMs must be an integer between 1 and 120000 when provided");
    }
    const binding = this.#webMcpHandles.get(webMcpRef);
    if (!binding) {
      throw new BrowserPreviewError(
        "BROWSER_WEBMCP_REF_UNKNOWN",
        "The WebMCP handle is unknown or no longer bound to this Browser runtime",
        ["Rediscover WebMCP tools from the current tab only if the page still needs a page-defined tool."]
      );
    }
    const state = this.#tabs.get(binding.tabRef);
    const browserFamily = normalizeBrowserFamily(binding.family ?? state?.family ?? "chrome");
    if (
      !state
      || state.providerTabId !== binding.providerTabId
      || normalizeBrowserFamily(state.family ?? "chrome") !== browserFamily
      || state.workbenchGeneration !== binding.workbenchGeneration
    ) {
      await this.#discardWebMcpNodeHandle(binding.cwd, webMcpRef, binding.workbenchGeneration);
      throw new BrowserPreviewError(
        "BROWSER_WEBMCP_REF_STALE",
        "The WebMCP handle no longer matches the server-bound Browser tab/runtime/family",
        ["Refresh browser_tabs and rediscover WebMCP tools from the current page; do not replay a prior WebMCP call automatically."]
      );
    }
    const effectiveCwd = binding.cwd;
    await this.#requireReady(effectiveCwd, browserFamily);
    if (binding.workbenchGeneration !== this.#workbenchGeneration) {
      await this.#discardWebMcpNodeHandle(effectiveCwd, webMcpRef, binding.workbenchGeneration);
      throw new BrowserPreviewError(
        "BROWSER_WEBMCP_REF_STALE",
        "The WebMCP handle belongs to an older Browser Workbench generation",
        ["Refresh browser_tabs and rediscover WebMCP tools from the current page."]
      );
    }

    let inputLiteral;
    try { inputLiteral = JSON.stringify(input); } catch {}
    if (inputLiteral === undefined) {
      throw new BrowserPreviewError("BROWSER_WEBMCP_INPUT_INVALID", "input must be JSON-serializable");
    }
    const inputBytes = Buffer.byteLength(inputLiteral, "utf8");
    if (inputBytes > MAX_WEBMCP_INPUT_BYTES) {
      throw new BrowserPreviewError(
        "BROWSER_WEBMCP_INPUT_TOO_LARGE",
        `WebMCP input is ${inputBytes} bytes, above the Browser runtime's ${MAX_WEBMCP_INPUT_BYTES}-byte remote projection limit`,
        ["Reduce the page-defined tool input instead of widening the remote projection automatically."]
      );
    }
    const refLiteral = JSON.stringify(webMcpRef);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(binding.providerTabId);
    const expectedUrlLiteral = JSON.stringify(binding.expectedUrl);
    const toolNameLiteral = JSON.stringify(normalizedToolName);
    const timeoutLiteral = timeoutMs === undefined ? "undefined" : String(timeoutMs);
    let result;
    try {
      result = await this.#runJson(effectiveCwd, `
const __twEntry = globalThis.__codexlessWebMcpHandles?.get(${refLiteral});
if (!__twEntry || __twEntry.family !== ${familyLiteral} || __twEntry.providerTabId !== ${providerLiteral} || __twEntry.url !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_WEBMCP_HANDLE_STALE");
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) {
  globalThis.__codexlessWebMcpHandles.delete(${refLiteral});
  throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
}
if ((__twInfo.url ?? null) !== ${expectedUrlLiteral}) {
  globalThis.__codexlessWebMcpHandles.delete(${refLiteral});
  throw new Error("TOOLWIRE_BROWSER_WEBMCP_PAGE_CHANGED");
}
let __twTab = null;
let __twPayload = null;
let __twCleanup = null;
let __twCleanupError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twCurrentUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twCurrentUrl !== ${expectedUrlLiteral}) {
    globalThis.__codexlessWebMcpHandles.delete(${refLiteral});
    throw new Error("TOOLWIRE_BROWSER_WEBMCP_PAGE_CHANGED");
  }
  let __twDispatchAttempted = false;
  try {
    globalThis.__codexlessWebMcpHandles.delete(${refLiteral});
    __twDispatchAttempted = true;
    const __twResult = await __twEntry.tools.call(${toolNameLiteral}, ${inputLiteral}, {
      ...(${timeoutLiteral} === undefined ? {} : { timeoutMs: ${timeoutLiteral} }),
    });
    let __twResultJson = null;
    try { __twResultJson = JSON.stringify(__twResult); } catch {}
    const __twResultBytes = typeof __twResultJson === "string" ? Buffer.byteLength(__twResultJson, "utf8") : 0;
    __twPayload = typeof __twResultJson !== "string" || __twResultBytes > ${MAX_WEBMCP_RESULT_BYTES}
      ? { resultOmitted: true, resultBytes: __twResultBytes }
      : { result: __twResult, resultOmitted: false, resultBytes: __twResultBytes };
  } catch (__twError) {
    const __twMessage = __twError instanceof Error ? __twError.message : String(__twError);
    if (/registration is stale/i.test(__twMessage)) {
      globalThis.__codexlessWebMcpHandles.delete(${refLiteral});
      throw new Error("TOOLWIRE_BROWSER_WEBMCP_HANDLE_STALE");
    }
    if (/is not available in this snapshot/i.test(__twMessage)) {
      if (__twDispatchAttempted) globalThis.__codexlessWebMcpHandles.set(${refLiteral}, __twEntry);
      throw new Error("TOOLWIRE_BROWSER_WEBMCP_TOOL_NOT_LISTED");
    }
    throw __twError;
  }
} finally {
  if (__twTab) {
    try { __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab); } catch (__twError) { __twCleanupError = __twError; }
  }
}
if (__twPayload && __twCleanupError) {
  const __twCleanupMessage = __twCleanupError instanceof Error ? __twCleanupError.message : String(__twCleanupError);
  throw new Error("TOOLWIRE_BROWSER_WEBMCP_CALL_RESULT_UNCERTAIN:cleanup failed after confirmed WebMCP call: " + __twCleanupMessage);
}
if (__twCleanupError) throw __twCleanupError;
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
nodeRepl.write(JSON.stringify(__twPayload));
`, "Call current Browser WebMCP tool", { mutationKind: "webmcp_call", expectedGeneration: binding.workbenchGeneration });
    } catch (error) {
      const reusablePreDispatch = error instanceof BrowserPreviewError
        && ["BROWSER_WEBMCP_TOOL_NOT_LISTED", "BROWSER_TAB_BUSY"].includes(error.code);
      if (!reusablePreDispatch) {
        await this.#discardWebMcpNodeHandle(effectiveCwd, webMcpRef, binding.workbenchGeneration);
      }
      throw error;
    }

    this.#webMcpHandles.delete(webMcpRef);
    const resultOmitted = result?.resultOmitted === true;
    const resultBytes = Number.isInteger(result?.resultBytes) ? result.resultBytes : 0;
    return {
      status: "called",
      browser: browserFamily,
      webMcpRef,
      toolName: normalizedToolName,
      callConfirmed: true,
      tabRef: binding.tabRef,
      ...(resultOmitted ? { resultOmitted: true, resultBytes } : { result: result?.result, resultOmitted: false, resultBytes }),
      ...browserCleanupReceipt(result),
      noAutomaticReplay: true,
      note: resultOmitted
        ? "The stock WebMCP tool call returned successfully, but Codexless omitted the oversized or non-serializable result from the remote projection. Do not replay the call merely to recover output; read the page/current task state first."
        : "The listed page-defined tool was called through the stock WebMCP handle. Upstream Browser confirmation/security semantics remain authoritative. This webMcpRef is now consumed and cannot be used again; rediscover from the same server-bound browser family/current page only for a later distinct call. If the call's side effect matters, read the bound tab/page state before deciding whether another action is needed.",
    };
  }

  async screenshotTab({ tabRef, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current browser family."]
      );
    }
    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);

    const providerLiteral = JSON.stringify(state.providerTabId);
    const familyLiteral = JSON.stringify(browserFamily);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twCleanup = null;
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
  if (__twTab) __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
}
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
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
      browser: browserFamily,
      tab: publicTab(current),
      mimeType,
      byteLength: bytes.length,
      width,
      height,
      fullPage: false,
      dataBase64,
      ...browserCleanupReceipt(result),
      note: "This is a read-only screenshot of the current visible viewport from the existing tab. The Browser runtime did not navigate, click, type, submit, scroll, or expose raw provider tab IDs. The image is returned as MCP image content rather than embedded inside structured JSON.",
    };
  }

  async prepareCloseTab({ tabRef, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current Chrome session."]
      );
    }

    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
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
    this.#cleanupActionApprovals();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + BROWSER_ACTION_APPROVAL_TTL_MS;
    const prepared = {
      actionApprovalRef,
      kind: "close_tab",
      tabRef,
      family: browserFamily,
      providerTabId: state.providerTabId,
      expectedUrl: currentUrl,
      cwd: effectiveCwd,
      workbenchGeneration: state.workbenchGeneration,
      expiresAt,
    };
    this.#actionApprovals.set(actionApprovalRef, prepared);
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
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_INVALID",
        "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_close_tab"
      );
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "close_tab") {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared tab close",
        ["Call codex.browser_tabs and codex.browser_prepare_close_tab again only if the exact tab still needs to be closed."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        "The prepared tab close belongs to an older Codex Workbench generation and cannot be dispatched",
        ["Call codex.browser_tabs and prepare the close again from the current Browser runtime only if the tab still needs to be closed."]
      );
    }
    const state = this.#tabs.get(prepared.tabRef);
    const browserFamily = normalizeBrowserFamily(prepared.family ?? state?.family ?? "chrome");
    if (!state || state.providerTabId !== prepared.providerTabId || normalizeBrowserFamily(state.family ?? "chrome") !== browserFamily) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        "The prepared tab close no longer matches a current Browser runtime tab or Browser family",
        ["Call codex.browser_tabs and prepare a fresh close only for the exact current tab that still needs closing."]
      );
    }

    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
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
      await cleanupBrowserClaim(__twBrowser, __twTab);
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
    const providerKey = `${browserFamily}:${prepared.providerTabId}`;
    if (this.#providerToRef.get(providerKey) === prepared.tabRef) {
      this.#providerToRef.delete(providerKey);
    }
    return {
      status: "closed",
      browser: browserFamily,
      action: { kind: "close_tab" },
      tab: publicTab({
        ...state,
        url: prepared.expectedUrl,
      }),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      note: "Exactly one previously prepared existing Chrome tab was closed through the official Tab.close() primitive after the Browser runtime consumed the single-use ref and revalidated the same Workbench generation, provider identity, and current URL. The Browser runtime removed its local tabRef/provider mapping after the confirmed close. It did not close a window, batch-close tabs, navigate, reload, go back, focus another tab, or retry the close.",
    };
  }

  async prepareBulkCloseTabs({ tabRefs, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    if (!Array.isArray(tabRefs) || tabRefs.length < 1 || tabRefs.length > MAX_BROWSER_BULK_CLOSE_TABS) {
      throw new BrowserPreviewError(
        "BROWSER_BULK_CLOSE_TAB_REFS_INVALID",
        `tabRefs must contain between 1 and ${MAX_BROWSER_BULK_CLOSE_TABS} opaque refs returned by codex.browser_tabs`
      );
    }
    if (!tabRefs.every((value) => typeof value === "string" && value.startsWith("browser_tab_"))) {
      throw new BrowserPreviewError(
        "BROWSER_BULK_CLOSE_TAB_REFS_INVALID",
        "Every bulk-close target must be an opaque browser_tab_ ref returned by codex.browser_tabs; raw provider ids, URLs, titles, selectors, and indexes are not accepted"
      );
    }
    if (new Set(tabRefs).size !== tabRefs.length) {
      throw new BrowserPreviewError(
        "BROWSER_BULK_CLOSE_DUPLICATE_TAB_REF",
        "Bulk-close tabRefs must be an exact set with no duplicate tabRef values"
      );
    }
    const requested = tabRefs.map((tabRef) => {
      const state = this.#tabs.get(tabRef);
      if (!state) {
        throw new BrowserPreviewError(
          "BROWSER_TAB_REF_UNKNOWN",
          `unknown or expired browser tabRef in bulk-close set: ${tabRef}`,
          ["Call codex.browser_tabs again and prepare a new exact set from current opaque tabRefs."]
        );
      }
      return state;
    });
    const requestedFamilies = [...new Set(requested.map((state) => normalizeBrowserFamily(state.family ?? "chrome")))];
    if (requestedFamilies.length !== 1) {
      throw new BrowserPreviewError(
        "BROWSER_BULK_CLOSE_FAMILY_MIXED",
        "Bulk-close tabRefs must all belong to the same server-bound Browser family",
        ["Prepare separate exact sets for Chrome and Edge; do not mix opaque refs across Browser families."]
      );
    }
    const browserFamily = requestedFamilies[0];
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const requestedLiteral = JSON.stringify(requested.map((state) => ({ providerTabId: state.providerTabId })));
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twRequested = ${requestedLiteral};
const __twRows = [];
for (let __twIndex = 0; __twIndex < __twRequested.length; __twIndex += 1) {
  const __twTarget = __twRequested[__twIndex];
  const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === __twTarget.providerTabId);
  if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_BULK_CLOSE_TAB_STALE:" + __twIndex);
  const __twUrl = typeof __twInfo.url === "string" ? __twInfo.url : null;
  if (!__twUrl) throw new Error("TOOLWIRE_BROWSER_BULK_CLOSE_URL_UNAVAILABLE:" + __twIndex);
  __twRows.push({
    providerTabId: __twTarget.providerTabId,
    title: __twInfo.title ?? null,
    url: __twUrl,
    lastOpened: __twInfo.lastOpened ?? null,
  });
}
nodeRepl.write(JSON.stringify({ rows: __twRows }));
`, "Prepare exact-set Chrome bulk tab close", { expectedGeneration: this.#workbenchGeneration });

    const rows = Array.isArray(result?.rows) ? result.rows : [];
    if (rows.length !== requested.length) {
      throw new BrowserPreviewError(
        "BROWSER_PROTOCOL_ERROR",
        "Bulk-close preparation did not return one current binding for every requested tabRef"
      );
    }
    const targets = rows.map((row, index) => {
      const prior = requested[index];
      if (row?.providerTabId !== prior.providerTabId || typeof row?.url !== "string" || !row.url) {
        throw new BrowserPreviewError(
          "BROWSER_PROTOCOL_ERROR",
          "Bulk-close preparation returned a mismatched provider identity or missing URL"
        );
      }
      const current = {
        ...prior,
        title: stringOrNull(row.title) ?? prior.title,
        url: row.url,
        lastOpened: stringOrNull(row.lastOpened) ?? prior.lastOpened,
        seenAt: Date.now(),
      };
      this.#tabs.set(prior.tabRef, current);
      return {
        tabRef: prior.tabRef,
        family: browserFamily,
        providerTabId: prior.providerTabId,
        expectedUrl: row.url,
        title: current.title,
        lastOpened: current.lastOpened,
      };
    });

    this.#cleanupActionApprovals();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + BROWSER_ACTION_APPROVAL_TTL_MS;
    const prepared = {
      actionApprovalRef,
      kind: "bulk_close_tabs",
      family: browserFamily,
      targets,
      cwd: effectiveCwd,
      workbenchGeneration: this.#workbenchGeneration,
      expiresAt,
    };
    this.#actionApprovals.set(actionApprovalRef, prepared);
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      action: {
        kind: "bulk_close_tabs",
        count: targets.length,
        tabs: targets.map((target) => ({
          tabRef: target.tabRef,
          family: target.family,
          title: target.title,
          url: target.expectedUrl,
          lastOpened: target.lastOpened,
        })),
      },
      nextAction: "This is an explicitly destructive administrator action because closing real Chrome tabs can discard unsaved page state. Apply the current Browser confirmation policy and user authorization to this exact prepared set, then call codex.browser_bulk_close_tabs with only this opaque actionApprovalRef. Preparing did not claim or close any tab.",
    };
  }

  async bulkCloseTabs({ actionApprovalRef }) {
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_INVALID",
        "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_bulk_close_tabs"
      );
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "bulk_close_tabs" || !Array.isArray(prepared.targets) || prepared.targets.length < 1) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared exact-set bulk tab close",
        ["Call codex.browser_tabs and prepare a new exact set only for tabs that still need closing."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        "The prepared bulk tab-close set belongs to an older Browser Workbench generation and cannot be dispatched",
        ["Refresh browser_tabs and prepare a fresh exact set. Do not reuse or replay the old bulk-close ref."]
      );
    }

    const browserFamily = normalizeBrowserFamily(prepared.family ?? prepared.targets[0]?.family ?? "chrome");
    if (prepared.targets.some((target) => normalizeBrowserFamily(target.family ?? "chrome") !== browserFamily)) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        "The prepared bulk tab-close set no longer has one consistent server-bound Browser family",
        ["Refresh browser_tabs and prepare separate exact sets per Browser family."]
      );
    }
    const familyLiteral = JSON.stringify(browserFamily);
    const confirmedClosed = [];
    const publicTarget = (target) => ({
      tabRef: target.tabRef,
      family: target.family ?? browserFamily,
      title: target.title,
      url: target.expectedUrl,
      lastOpened: target.lastOpened,
    });
    for (let index = 0; index < prepared.targets.length; index += 1) {
      const target = prepared.targets[index];
      const providerLiteral = JSON.stringify(target.providerTabId);
      const expectedUrlLiteral = JSON.stringify(target.expectedUrl);
      let result;
      try {
        result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_BULK_CLOSE_TAB_STALE");
const __twObservedUrl = typeof __twInfo.url === "string" ? __twInfo.url : null;
if (__twObservedUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_BULK_CLOSE_URL_CHANGED");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twCleanup = null;
let __twCleanupError = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twObservedUrl;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_BULK_CLOSE_URL_CHANGED");
  __twDispatchAttempted = true;
  await __twTab.close();
  __twPayload = { beforeUrl: __twBeforeUrl, closed: true };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab && !__twDispatchAttempted) {
    try {
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
    } catch (__twError) {
      __twCleanupError = __twError;
    }
  }
}
if (!__twDispatchAttempted && __twTab && (__twCleanupError || __twCleanup?.cleanupStatus !== "released")) {
  const __twReason = __twCleanupError instanceof Error
    ? __twCleanupError.message
    : (__twCleanup?.cleanupReason ?? "unknown");
  throw new Error("TOOLWIRE_BROWSER_BULK_CLOSE_PREDISPATCH_RELEASE_UNPROVEN:" + __twReason);
}
if (__twDispatchAttempted && __twActionError) {
  const __twMessage = __twActionError instanceof Error ? __twActionError.message : String(__twActionError);
  if (/TOOLWIRE_BROWSER_BULK_CLOSE_RESULT_UNCERTAIN/i.test(__twMessage)) throw __twActionError;
  throw new Error("TOOLWIRE_BROWSER_BULK_CLOSE_RESULT_UNCERTAIN:" + __twMessage);
}
if (__twActionError) throw __twActionError;
nodeRepl.write(JSON.stringify(__twPayload));
`, `Execute prepared Chrome bulk tab close ${index + 1}/${prepared.targets.length}`, {
          mutationKind: "bulk_close_tab",
          expectedGeneration: prepared.workbenchGeneration,
        });
      } catch (error) {
        const classified = classifyBrowserError(error);
        const uncertain = classified.code === "BROWSER_BULK_CLOSE_RESULT_UNCERTAIN";
        return {
          status: "partial",
          browser: browserFamily,
          action: { kind: "bulk_close_tabs" },
          requestedCount: prepared.targets.length,
          confirmedClosedCount: confirmedClosed.length,
          confirmedClosed,
          stoppedAtIndex: index,
          stoppedAt: publicTarget(target),
          unprocessedCount: prepared.targets.length - index - 1,
          unprocessed: prepared.targets.slice(index + 1).map(publicTarget),
          stopReason: {
            errorCode: classified.code ?? "BROWSER_BULK_CLOSE_STOPPED",
            message: classified.message,
            uncertain,
          },
          noAutomaticReplay: true,
          note: "Bulk close stopped at the first drift, busy claim, pre-dispatch release problem, or uncertain close. Only tabs listed in confirmedClosed are proven closed. The stopped target may be uncertain when stopReason.uncertain=true, and no remaining target was attempted after the stop. Never auto-retry this consumed prepared ref.",
        };
      }
      if (result?.closed !== true) {
        return {
          status: "partial",
          browser: browserFamily,
          action: { kind: "bulk_close_tabs" },
          requestedCount: prepared.targets.length,
          confirmedClosedCount: confirmedClosed.length,
          confirmedClosed,
          stoppedAtIndex: index,
          stoppedAt: publicTarget(target),
          unprocessedCount: prepared.targets.length - index - 1,
          unprocessed: prepared.targets.slice(index + 1).map(publicTarget),
          stopReason: {
            errorCode: "BROWSER_BULK_CLOSE_RESULT_UNCERTAIN",
            message: "Bulk-close item returned without a confirmed close receipt after dispatch may have occurred.",
            uncertain: true,
          },
          noAutomaticReplay: true,
        };
      }
      this.#tabs.delete(target.tabRef);
      const providerKey = `${browserFamily}:${target.providerTabId}`;
      if (this.#providerToRef.get(providerKey) === target.tabRef) {
        this.#providerToRef.delete(providerKey);
      }
      confirmedClosed.push({
        ...publicTarget(target),
        beforeUrl: stringOrNull(result?.beforeUrl) ?? target.expectedUrl,
      });
    }

    return {
      status: "closed",
      browser: browserFamily,
      action: { kind: "bulk_close_tabs" },
      requestedCount: prepared.targets.length,
      confirmedClosedCount: confirmedClosed.length,
      confirmedClosed,
      noAutomaticReplay: true,
      note: "Every tab in the prepared exact set was independently revalidated against its server-bound provider identity, URL, and Browser Workbench generation and then closed exactly once through the official Tab.close() primitive. No URL pattern, domain filter, selector, raw provider id, or automatic retry was used.",
    };
  }

  async prepareOpenTab({ family, url, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    const browserFamily = normalizeBrowserFamily(family);
    const targetUrl = normalizeBrowserHttpUrl(url);
    await this.#requireReady(effectiveCwd, browserFamily);
    this.#cleanupActionApprovals();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + BROWSER_ACTION_APPROVAL_TTL_MS;
    const prepared = {
      actionApprovalRef,
      kind: "open_tab",
      family: browserFamily,
      targetUrl,
      cwd: effectiveCwd,
      workbenchGeneration: this.#workbenchGeneration,
      expiresAt,
    };
    this.#actionApprovals.set(actionApprovalRef, prepared);
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      action: {
        kind: "open_tab",
        family: browserFamily,
        toUrl: targetUrl,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context. If this bounded task does not require confirmation, or its task-level verbal confirmation is already satisfied, call codex.browser_open_tab immediately with this actionApprovalRef. Do not ask merely because the legacy ref name contains Approval. Preparing did not open or navigate any tab.",
    };
  }

  async openTab({ actionApprovalRef }) {
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_INVALID",
        "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_open_tab"
      );
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "open_tab") {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared new-tab action",
        ["Call codex.browser_prepare_open_tab again to prepare a fresh exact URL."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        "The prepared new-tab action belongs to an older Codex Workbench generation and cannot be dispatched",
        ["Prepare the new tab again from the current Browser runtime."]
      );
    }

    const browserFamily = normalizeBrowserFamily(prepared.family);
    const familyLiteral = JSON.stringify(browserFamily);
    const targetUrlLiteral = JSON.stringify(prepared.targetUrl);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
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
      await markBrowserDeliverable(__twBrowser, __twTab);
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
`, `Execute prepared ${browserFamily === "edge" ? "Edge" : "Chrome"} new tab`, { mutationKind: "open_tab", expectedGeneration: prepared.workbenchGeneration });

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    const snapshotTruncated = snapshot.length > BROWSER_POST_ACTION_MAX_CHARS;
    const afterUrl = stringOrNull(result?.afterUrl) ?? prepared.targetUrl;
    return {
      status: "opened",
      family: browserFamily,
      action: {
        kind: "open_tab",
        family: browserFamily,
        toUrl: prepared.targetUrl,
      },
      requestedUrl: prepared.targetUrl,
      afterUrl,
      redirected: afterUrl !== prepared.targetUrl,
      title: stringOrNull(result?.afterTitle),
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: `Exactly one previously prepared ${browserFamily} tab was created with the official browser.tabs.new(), navigated to the bound http(s) URL, and finalized as a user-visible deliverable tab. Call codex.browser_tabs with family=${browserFamily} to obtain its normal opaque tabRef before later read/click/fill/scroll work.`,
    };
  }

  async scrollTab({ tabRef, direction = "down", amount = "page", cwd = this.#defaultCwd, maxChars = DEFAULT_MAX_SNAPSHOT_CHARS }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
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
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current Chrome session."]
      );
    }

    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const expectedUrlLiteral = JSON.stringify(state.url);
    const deltaY = (amount === "small" ? 400 : 800) * (direction === "down" ? 1 : -1);
    const keyName = amount === "page"
      ? (direction === "down" ? "PageDown" : "PageUp")
      : (direction === "down" ? "ArrowDown" : "ArrowUp");
    const keypresses = amount === "page" ? [keyName] : Array(6).fill(keyName);
    const keypressesLiteral = JSON.stringify(keypresses);
    const dispatch = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twScrollReturned = false;
let __twActionError = null;
let __twFinalizeError = null;
let __twCleanup = null;
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
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
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
Object.assign(__twPayload, __twCleanup ?? {
  cleanupStatus: "uncertain",
  cleanupReason: __twFinalizeError ? "explicit-finalize-failed" : "cleanup-receipt-missing",
});
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
      browser: browserFamily,
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
      ...browserCleanupReceipt(dispatch),
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
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    if (!BROWSER_FIXED_KEYS.has(key)) {
      throw new BrowserPreviewError("BROWSER_KEYPRESS_KEY_INVALID", "key must be exactly Enter, Tab, or Escape");
    }
    if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > MAX_SNAPSHOT_CHARS) {
      throw new BrowserPreviewError(
        "BROWSER_MAX_CHARS_INVALID",
        `maxChars must be an integer between 1000 and ${MAX_SNAPSHOT_CHARS}`
      );
    }
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current Chrome session."]
      );
    }

    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const expectedUrlLiteral = JSON.stringify(state.url);
    const keyLiteral = JSON.stringify(key);
    const dispatch = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twKeypressReturned = false;
let __twActionError = null;
let __twFinalizeError = null;
let __twCleanup = null;
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
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
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
Object.assign(__twPayload, __twCleanup ?? {
  cleanupStatus: "uncertain",
  cleanupReason: __twFinalizeError ? "explicit-finalize-failed" : "cleanup-receipt-missing",
});
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
      browser: browserFamily,
      tab: publicTab(current),
      key,
      inputMethod: stringOrNull(dispatch?.inputMethod) ?? "focused-keypress",
      dispatchStatus: "confirmed",
      keypressReturned: dispatch?.keypressReturned === true,
      settleCompleted: dispatch?.settleCompleted === true,
      settleError: stringOrNull(dispatch?.settleError),
      ...browserCleanupReceipt(dispatch),
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

  async modelRouteProbe({ tabRef, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef for the exact user-selected ChatGPT Web chat surface."]
      );
    }
    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    if (browserFamily !== "chrome") {
      throw new BrowserPreviewError(
        "BROWSER_MODEL_ROUTE_FAMILY_DENIED",
        "Model-route probing is Chrome-specific and refuses a tabRef bound to another Browser family",
        ["Call codex.browser_tabs for Chrome and use a fresh Chrome tabRef for the exact user-selected ChatGPT Web chat surface."]
      );
    }
    await this.#requireReady(effectiveCwd, browserFamily);
    let initialUrl;
    try {
      initialUrl = new URL(state.url ?? "");
    } catch {
      throw new BrowserPreviewError("BROWSER_MODEL_ROUTE_HOST_DENIED", "Model-route probing requires a user-selected https://chatgpt.com Web chat tab");
    }
    const initialLoginHost = initialUrl.hostname === "auth.openai.com" || initialUrl.hostname.endsWith(".auth.openai.com");
    const initialLoginPath = initialUrl.hostname === "chatgpt.com" && /\/(?:auth\/)?(?:log-?in|login)(?:\/|$)/i.test(initialUrl.pathname);
    if (initialLoginHost || initialLoginPath) {
      throw new BrowserPreviewError(
        "BROWSER_MODEL_ROUTE_LOGIN_REQUIRED",
        "The target Chrome does not currently expose a usable ChatGPT login state for model-route verification.",
        ["Sign in to ChatGPT once in the target Chrome profile and keep the Browser extension connected; later probes can then run unattended from any normal request entry."]
      );
    }
    if (initialUrl.protocol !== "https:" || initialUrl.hostname !== "chatgpt.com") {
      throw new BrowserPreviewError("BROWSER_MODEL_ROUTE_HOST_DENIED", "Model-route probing is restricted to https://chatgpt.com");
    }
    const initialChatSurface = initialUrl.pathname === "/"
      || initialUrl.pathname.startsWith("/c/")
      || initialUrl.pathname.startsWith("/g/");
    if (!initialChatSurface) {
      throw new BrowserPreviewError(
        "BROWSER_MODEL_ROUTE_CHAT_SURFACE_REQUIRED",
        "Model-route probing requires a user-selected ChatGPT Web chat surface, not an arbitrary chatgpt.com page.",
        ["Use the current/opened ChatGPT Web conversation, or open a new ChatGPT Web chat in the user-chosen Temporary/normal and project/non-project context, then retry with its fresh tabRef."]
      );
    }
    const verificationContext = {
      temporaryChat: initialUrl.searchParams.get("temporary-chat") === "true",
      projectScoped: initialUrl.pathname.startsWith("/g/"),
      existingConversation: initialUrl.pathname.includes("/c/"),
    };

    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const expectedUrlLiteral = JSON.stringify(state.url);
    const probeTextLiteral = JSON.stringify(BROWSER_MODEL_ROUTE_PROBE_TEXT);
    const result = await this.#runJson(effectiveCwd, `
${BROWSER_MODEL_ROUTE_RUNTIME_PARSER_SOURCE}
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twCleanup = null;
let __twCleanupError = null;
let __twMessageSubmitted = false;
let __twPayload = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  let __twParsedUrl = null;
  try { __twParsedUrl = new URL(__twBeforeUrl); } catch {}
  if (!__twParsedUrl || __twParsedUrl.protocol !== "https:" || __twParsedUrl.hostname !== "chatgpt.com") {
    throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_HOST_DENIED");
  }
  const __twChatSurface = __twParsedUrl.pathname === "/"
    || __twParsedUrl.pathname.startsWith("/c/")
    || __twParsedUrl.pathname.startsWith("/g/");
  if (!__twChatSurface) throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_CHAT_SURFACE_REQUIRED");

  await globalThis.__toolwireBrowserAgent.documentation.get("confirmations");
  await globalThis.__toolwireBrowserAgent.documentation.get("capabilities/tab/cdp");
  const __twCapabilities = __twTab.capabilities;
  if (!__twCapabilities || typeof __twCapabilities.get !== "function") {
    throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_CDP_UNAVAILABLE");
  }
  const __twCdp = await __twCapabilities.get("cdp");
  if (!__twCdp || typeof __twCdp.send !== "function" || typeof __twCdp.readEvents !== "function") {
    throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_CDP_UNAVAILABLE");
  }

  const __twReadEditorText = async (locator) => {
    let direct = null;
    try {
      direct = await locator.evaluate((element) => ({
        value: typeof element?.value === "string" ? element.value : null,
        innerText: typeof element?.innerText === "string" ? element.innerText : null,
        textContent: typeof element?.textContent === "string" ? element.textContent : null,
      }));
    } catch {}
    const values = [direct?.value, direct?.innerText, direct?.textContent].filter((value) => typeof value === "string");
    return {
      values,
      blank: values.length > 0 && values.every((value) => /^\\s*$/.test(value)),
      exact: values.some((value) => value === ${probeTextLiteral}),
    };
  };
  const __twResolveEditor = async () => {
    const all = await __twTab.playwright.getByRole("textbox").all();
    const visible = [];
    for (const locator of all) {
      let isVisible = false;
      let isEnabled = false;
      try { isVisible = await locator.isVisible(); } catch {}
      try { isEnabled = await locator.isEnabled(); } catch {}
      if (isVisible && isEnabled) visible.push(locator);
    }
    if (visible.length === 0) throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_LOGIN_OR_PAGE_NOT_READY");
    if (visible.length !== 1) throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_EDITOR_NOT_UNIQUE:" + visible.length);
    return visible[0];
  };

  const __twReadSurfaceMode = async () => {
    for (const [mode, name] of [["chat", "Chat"], ["work", "Work"]]) {
      try {
        const radios = await __twTab.playwright.getByRole("radio", { name, exact: true }).all();
        const visible = [];
        for (const radio of radios) {
          let isVisible = false;
          try { isVisible = await radio.isVisible(); } catch {}
          if (isVisible) visible.push(radio);
        }
        if (visible.length === 1) {
          let checked = false;
          try { checked = await visible[0].isChecked(); } catch {}
          if (checked) return mode;
        }
      } catch {}
    }
    return "unknown";
  };

  let __twEditor = await __twResolveEditor();
  let __twEditorState = await __twReadEditorText(__twEditor);
  if (__twEditorState.values.length > 0 && !__twEditorState.blank) {
    throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_EDITOR_NOT_EMPTY");
  }
  const __twSurfaceMode = await __twReadSurfaceMode();

  await __twCdp.send("Network.enable", {});
  const __twMethods = [
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Network.webSocketFrameReceived",
  ];
  const __twBaseline = await __twCdp.readEvents({ methods: __twMethods, limit: 1, timeoutMs: 1 });
  let __twCursor = Number(__twBaseline?.cursor) || 0;

  await __twEditor.fill(${probeTextLiteral}, {});
  await __twTab.playwright.waitForTimeout(250);
  __twEditor = await __twResolveEditor();
  __twEditorState = await __twReadEditorText(__twEditor);
  if (!__twEditorState.exact) {
    if (!__twEditorState.blank) throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_EDITOR_FILL_FAILED");
    await __twEditor.fill(${probeTextLiteral}, {});
    await __twTab.playwright.waitForTimeout(250);
    __twEditor = await __twResolveEditor();
    __twEditorState = await __twReadEditorText(__twEditor);
    if (!__twEditorState.exact) throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_EDITOR_FILL_FAILED");
  }

  __twMessageSubmitted = true;
  await __twTab.dom_cua.keypress({ keys: ["Enter"] });

  const __twRequests = new Map();
  const __twFound = emptyRouteSets();
  let __twResponse = null;
  let __twLoadingFinished = false;
  let __twLoadingFailed = false;
  let __twBodyAvailable = false;
  let __twBodyError = null;
  let __twAssistantClaim = { text: null, truncated: false };
  const __twStartedAt = Date.now();
  const __twDeadline = __twStartedAt + 25_000;
  let __twFinishedAt = null;
  while (Date.now() < __twDeadline) {
    const batch = await __twCdp.readEvents({
      afterSequence: __twCursor,
      methods: __twMethods,
      timeoutMs: Math.min(1000, Math.max(1, __twDeadline - Date.now())),
      limit: 200,
    });
    __twCursor = Math.max(__twCursor, Number(batch?.cursor) || 0);
    for (const event of batch?.events ?? []) {
      const requestId = event?.params?.requestId;
      if (event?.method === "Network.requestWillBeSent" && requestId) {
        const request = event?.params?.request;
        __twRequests.set(requestId, { method: request?.method ?? null, url: request?.url ?? null });
        continue;
      }
      if (event?.method === "Network.responseReceived" && requestId) {
        const request = __twRequests.get(requestId);
        let responseUrl = null;
        try { responseUrl = new URL(event?.params?.response?.url ?? ""); } catch {}
        if (
          request?.method === "POST"
          && responseUrl?.protocol === "https:"
          && responseUrl?.hostname === "chatgpt.com"
          && responseUrl.pathname.endsWith("/conversation")
          && !responseUrl.pathname.endsWith("/conversation/prepare")
          && !responseUrl.pathname.endsWith("/conversation/init")
        ) {
          __twResponse = {
            requestId,
            origin: responseUrl.origin,
            pathname: responseUrl.pathname,
            status: event?.params?.response?.status ?? null,
            mimeType: event?.params?.response?.mimeType ?? null,
          };
        }
        continue;
      }
      if (event?.method === "Network.webSocketFrameReceived") {
        collectRouteFieldsFromTransportText(event?.params?.response?.payloadData, __twFound);
        continue;
      }
      if (__twResponse?.requestId && requestId === __twResponse.requestId) {
        if (event?.method === "Network.loadingFailed") {
          __twLoadingFailed = true;
          __twFinishedAt = Date.now();
        }
        if (event?.method === "Network.loadingFinished") {
          __twLoadingFinished = true;
          __twFinishedAt = Date.now();
        }
      }
    }
    const __twHaveAny = __twFound.resolved_model_slug.size > 0
      || __twFound.serverSteModelSlug.size > 0
      || __twFound.requested_model_experience.size > 0;
    const __twHaveAll = __twFound.resolved_model_slug.size > 0
      && __twFound.serverSteModelSlug.size > 0
      && __twFound.requested_model_experience.size > 0;
    if (__twResponse && __twLoadingFinished && __twHaveAll) break;
    if (__twResponse && __twFinishedAt !== null && __twHaveAny && Date.now() - __twFinishedAt >= 1500) break;
    if (__twResponse && __twFinishedAt !== null && Date.now() - __twFinishedAt >= 10_000) break;
  }

  if (__twResponse?.requestId && __twLoadingFinished) {
    try {
      const bodyResult = await __twCdp.send("Network.getResponseBody", { requestId: __twResponse.requestId });
      const body = bodyResult?.base64Encoded
        ? Buffer.from(String(bodyResult?.body ?? ""), "base64").toString("utf8")
        : String(bodyResult?.body ?? "");
      collectRouteFieldsFromTransportText(body, __twFound);
      const __twClaims = [];
      collectAssistantClaimsFromTransportText(body, __twClaims);
      __twAssistantClaim = __twClaims.filter((claim) => claim?.text && claim.text !== ${probeTextLiteral}).at(-1) ?? { text: null, truncated: false };
      __twBodyAvailable = true;
    } catch (error) {
      __twBodyError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!__twAssistantClaim.text) {
    try {
      const __twAssistantHeadings = await __twTab.playwright.getByRole("heading", { name: "ChatGPT:" }).all();
      const __twLatestAssistantHeading = __twAssistantHeadings.at(-1) ?? null;
      if (__twLatestAssistantHeading) {
        const __twDomClaim = await __twLatestAssistantHeading.evaluate((element, maxChars) => {
          let sibling = element?.nextElementSibling ?? null;
          while (sibling) {
            const raw = typeof sibling.innerText === "string" ? sibling.innerText : sibling.textContent;
            const text = typeof raw === "string" ? raw.trim() : "";
            if (text) return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
            sibling = sibling.nextElementSibling;
          }
          return { text: null, truncated: false };
        }, MAX_ASSISTANT_CLAIM_CHARS);
        if (__twDomClaim?.text && __twDomClaim.text !== ${probeTextLiteral}) __twAssistantClaim = __twDomClaim;
      }
    } catch {}
  }

  const __twFields = routeFieldsFromSets(__twFound);
  const __twHasRoute = Boolean(
    __twFields.resolved_model_slug
    || __twFields.server_ste_metadata?.model_slug
    || __twFields.requested_model_experience
  );
  __twPayload = {
    status: __twHasRoute ? "ok" : "route_fields_not_found",
    origin: "https://chatgpt.com",
    probeMessage: "server_fixed_non_sensitive",
    submitted: true,
    responseObserved: Boolean(__twResponse),
    streamFinished: __twLoadingFinished,
    streamFailed: __twLoadingFailed,
    response: __twResponse ? {
      origin: __twResponse.origin,
      pathname: __twResponse.pathname,
      status: __twResponse.status,
      mimeType: __twResponse.mimeType,
    } : null,
    assistantClaim: __twAssistantClaim,
    surfaceMode: __twSurfaceMode,
    fields: __twFields,
    evidence: {
      cdpCapability: true,
      networkEnabledBeforeSubmit: true,
      eventBaselineBeforeSubmit: true,
      websocketFramesObserved: __twFound.resolved_model_slug.size > 0
        || __twFound.serverSteModelSlug.size > 0
        || __twFound.requested_model_experience.size > 0,
      responseBodyAvailable: __twBodyAvailable,
      responseBodyError: __twBodyError ? "unavailable" : null,
    },
  };
} catch (__twError) {
  if (__twMessageSubmitted) {
    const message = __twError instanceof Error ? __twError.message : String(__twError);
    throw new Error("TOOLWIRE_BROWSER_MODEL_ROUTE_PROBE_RESULT_UNCERTAIN:" + message);
  }
  throw __twError;
} finally {
  if (__twTab) {
    try {
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
    } catch (__twError) {
      __twCleanupError = __twError instanceof Error ? __twError.message : String(__twError);
    }
  }
}
if (__twPayload) {
  __twPayload.cleanupStatus = __twCleanup?.cleanupStatus ?? "unavailable";
  __twPayload.cleanupReason = __twCleanup?.cleanupReason ?? (__twCleanupError ? "cleanup_error" : "unknown");
  __twPayload.lifecycleShape = __twCleanup?.lifecycleShape ?? null;
}
nodeRepl.write(JSON.stringify(__twPayload));
`, "Probe ChatGPT actual model route", { mutationKind: "model_route_probe", expectedGeneration: state.workbenchGeneration });

    if (!result || typeof result !== "object") {
      throw new BrowserPreviewError("BROWSER_MODEL_ROUTE_PROTOCOL_ERROR", "Model-route probe returned no structured result");
    }
    const assistantClaim = {
      text: stringOrNull(result?.assistantClaim?.text),
      truncated: result?.assistantClaim?.truncated === true,
    };
    const fields = {
      resolved_model_slug: stringOrNull(result?.fields?.resolved_model_slug),
      server_ste_metadata: { model_slug: stringOrNull(result?.fields?.server_ste_metadata?.model_slug) },
      requested_model_experience: stringOrNull(result?.fields?.requested_model_experience),
      observedValues: {
        resolved_model_slug: Array.isArray(result?.fields?.observedValues?.resolved_model_slug)
          ? result.fields.observedValues.resolved_model_slug.filter((value) => typeof value === "string").slice(0, 20)
          : [],
        server_ste_metadata_model_slug: Array.isArray(result?.fields?.observedValues?.server_ste_metadata_model_slug)
          ? result.fields.observedValues.server_ste_metadata_model_slug.filter((value) => typeof value === "string").slice(0, 20)
          : [],
        requested_model_experience: Array.isArray(result?.fields?.observedValues?.requested_model_experience)
          ? result.fields.observedValues.requested_model_experience.filter((value) => typeof value === "string").slice(0, 20)
          : [],
      },
    };
    return {
      status: result.status === "ok" ? "ok" : "route_fields_not_found",
      browser: browserFamily,
      tabRef,
      origin: "https://chatgpt.com",
      verificationContext: {
        ...verificationContext,
        surfaceMode: result?.surfaceMode === "chat" || result?.surfaceMode === "work" ? result.surfaceMode : "unknown",
      },
      probe: {
        message: "server_fixed_non_sensitive",
        submitted: result?.submitted === true,
        responseObserved: result?.responseObserved === true,
        streamFinished: result?.streamFinished === true,
        streamFailed: result?.streamFailed === true,
      },
      response: result?.response && typeof result.response === "object" ? {
        origin: result.response.origin === "https://chatgpt.com" ? result.response.origin : null,
        pathname: typeof result.response.pathname === "string" ? result.response.pathname : null,
        status: Number.isFinite(result.response.status) ? result.response.status : null,
        mimeType: typeof result.response.mimeType === "string" ? result.response.mimeType : null,
      } : null,
      assistantClaim,
      fields,
      evidence: {
        cdpCapability: result?.evidence?.cdpCapability === true,
        networkEnabledBeforeSubmit: result?.evidence?.networkEnabledBeforeSubmit === true,
        eventBaselineBeforeSubmit: result?.evidence?.eventBaselineBeforeSubmit === true,
        websocketFramesObserved: result?.evidence?.websocketFramesObserved === true,
        responseBodyAvailable: result?.evidence?.responseBodyAvailable === true,
        responseBodyError: result?.evidence?.responseBodyError === "unavailable" ? "unavailable" : null,
      },
      cleanupStatus: stringOrNull(result?.cleanupStatus) ?? "unavailable",
      cleanupReason: stringOrNull(result?.cleanupReason),
      lifecycleShape: stringOrNull(result?.lifecycleShape),
      privacy: {
        returnedFieldsOnly: ["assistant_claim", "requested_model_experience", "resolved_model_slug", "server_ste_metadata.model_slug"],
        responseBodyReturned: false,
        fixedProbeAssistantClaimReturned: Boolean(assistantClaim.text),
        unrelatedMessageContentReturned: false,
        cookiesReturned: false,
        authorizationReturned: false,
        headersReturned: false,
      },
      note: "This bounded household probe uses Full CDP only inside the Browser runtime for one user-selected https://chatgpt.com Web chat surface, either the current/opened conversation or a newly opened chat. It asks the fixed non-sensitive question '你现在是什么模型？', reports the actually observed Chat/Work surface mode when available, returns only the bounded assistant self-report for that probe plus allowlisted model-routing fields and minimal evidence, and never exposes raw CDP, cookies, Authorization, headers, response bodies, or unrelated conversation content. It verifies the newly submitted Web turn, not an already-completed phone turn. Do not auto-retry an uncertain result because the fixed probe message may already have been submitted.",
    };
  }

  async prepareNavigate({ tabRef, url, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    const targetUrl = normalizeBrowserHttpUrl(url);
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current browser family."]
      );
    }
    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
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
    this.#cleanupActionApprovals();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + BROWSER_ACTION_APPROVAL_TTL_MS;
    const prepared = {
      actionApprovalRef,
      kind: "navigate",
      tabRef,
      family: browserFamily,
      providerTabId: state.providerTabId,
      expectedUrl: currentUrl,
      targetUrl,
      cwd: effectiveCwd,
      workbenchGeneration: state.workbenchGeneration,
      expiresAt,
    };
    this.#actionApprovals.set(actionApprovalRef, prepared);
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
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_INVALID",
        "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_navigate"
      );
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "navigate") {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared navigation",
        ["Call codex.browser_tabs and codex.browser_prepare_navigate again to prepare a fresh exact navigation."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        "The prepared navigation belongs to an older Codex Workbench generation and cannot be dispatched",
        ["Call codex.browser_tabs and prepare the navigation again from current page state."]
      );
    }
    const state = this.#tabs.get(prepared.tabRef);
    const browserFamily = normalizeBrowserFamily(prepared.family ?? state?.family ?? "chrome");
    if (!state || state.providerTabId !== prepared.providerTabId || normalizeBrowserFamily(state.family ?? "chrome") !== browserFamily) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        "The prepared navigation no longer matches a current Browser runtime tab or Browser family",
        ["Call codex.browser_tabs and prepare the navigation again from current page state."]
      );
    }

    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const targetUrlLiteral = JSON.stringify(prepared.targetUrl);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
let __twCleanup = null;
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
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
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
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
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
      ...browserCleanupReceipt(result),
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: "Exactly one previously prepared existing-tab navigation was dispatched after the caller applied the current Browser confirmation policy and task context. The legacy actionApprovalRef is only an exact-action binding, not proof of user approval. The Browser runtime revalidated the same starting tab URL, used the official Chrome tab.goto() for the bound http(s) destination, and read back the resulting page state without clicking, filling, submitting, or opening a new tab. Existing-tab cleanup is reported separately: finalize-absent runtimes are never described as released unless an explicit release was actually proven.",
    };
  }

  async discoverElements({ tabRef, cwd = this.#defaultCwd, maxNodes = 256 }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 2_000) {
      throw new BrowserPreviewError("BROWSER_ELEMENT_MAX_NODES_INVALID", "maxNodes must be an integer between 1 and 2000");
    }
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current browser family."]
      );
    }
    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twCleanup = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  const __twTitle = (await __twTab.title()) ?? __twInfo.title ?? null;
  const __twVisibleDom = await __twTab.dom_cua.get_visible_dom();
  if (typeof __twVisibleDom !== "string") throw new Error("TOOLWIRE_BROWSER_ELEMENT_VISIBLE_DOM_INVALID");
  __twPayload = { title: __twTitle, url: __twUrl, visibleDom: __twVisibleDom };
} finally {
  if (__twTab) __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
}
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
nodeRepl.write(JSON.stringify(__twPayload));
`, "Discover opaque Browser elements", { expectedGeneration: state.workbenchGeneration });

    const visibleDom = typeof result?.visibleDom === "string" ? result.visibleDom : null;
    if (visibleDom === null) {
      throw new BrowserPreviewError("BROWSER_ELEMENT_VISIBLE_DOM_INVALID", "The stock Browser visible-DOM primitive returned no string snapshot");
    }
    const current = {
      ...state,
      title: stringOrNull(result?.title) ?? state.title,
      url: stringOrNull(result?.url) ?? state.url,
      seenAt: Date.now(),
    };
    if (!current.url) {
      throw new BrowserPreviewError("BROWSER_ELEMENT_URL_UNAVAILABLE", "The current tab did not expose a stable URL for opaque element binding");
    }
    this.#tabs.set(tabRef, current);
    const nodes = browserElementNodesFromVisibleDom(visibleDom, { maxNodes });
    const observed = this.#elementRefs.observe({
      tabRef,
      family: browserFamily,
      providerTabId: state.providerTabId,
      url: current.url,
      workbenchGeneration: state.workbenchGeneration,
      nodes,
    });
    return {
      status: "ok",
      browser: browserFamily,
      tab: publicTab(current),
      observedAt: observed.observedAt,
      expiresAt: observed.expiresAt,
      count: observed.elements.length,
      elements: observed.elements,
      ...browserCleanupReceipt(result),
      note: "Fresh stock visible DOM was projected into short-lived Codexless opaque elementRef values. Raw stock node ids, selectors, coordinates, indexes, JavaScript, and provider ids are not returned and are not accepted as later target input.",
    };
  }

  async prepareElementAction({ tabRef, elementRef, action, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    if (typeof elementRef !== "string" || !elementRef.startsWith("browser_element_")) {
      throw new BrowserPreviewError("BROWSER_ELEMENT_REF_REQUIRED", "elementRef must be an opaque ref returned by the fresh element discovery path");
    }
    const normalizedAction = typeof action === "string" ? action.trim().toLowerCase() : "";
    if (!new Set(["click", "double_click"]).has(normalizedAction)) {
      throw new BrowserPreviewError("BROWSER_ELEMENT_ACTION_UNSUPPORTED", "Opaque element actions currently support only click or double_click");
    }
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs and the opaque element discovery path again."]
      );
    }
    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twCleanup = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  const __twTitle = (await __twTab.title()) ?? __twInfo.title ?? null;
  const __twVisibleDom = await __twTab.dom_cua.get_visible_dom();
  if (typeof __twVisibleDom !== "string") throw new Error("TOOLWIRE_BROWSER_ELEMENT_VISIBLE_DOM_INVALID");
  __twPayload = { title: __twTitle, url: __twUrl, visibleDom: __twVisibleDom };
} finally {
  if (__twTab) __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
}
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
nodeRepl.write(JSON.stringify(__twPayload));
`, "Prepare opaque Browser element action", { expectedGeneration: state.workbenchGeneration });

    const currentUrl = stringOrNull(result?.url) ?? state.url;
    if (!currentUrl || typeof result?.visibleDom !== "string") {
      throw new BrowserPreviewError("BROWSER_ELEMENT_VISIBLE_DOM_INVALID", "Opaque element preparation could not obtain a stable current URL and visible DOM");
    }
    const nodes = browserElementNodesFromVisibleDom(result.visibleDom);
    let bound;
    try {
      bound = this.#elementRefs.bindAction({
        elementRef,
        action: normalizedAction,
        current: {
          tabRef,
          family: browserFamily,
          providerTabId: state.providerTabId,
          url: currentUrl,
          workbenchGeneration: state.workbenchGeneration,
          nodes,
        },
      });
    } catch (error) {
      throw browserElementBindingError(error);
    }
    const current = {
      ...state,
      title: stringOrNull(result?.title) ?? state.title,
      url: currentUrl,
      seenAt: Date.now(),
    };
    this.#tabs.set(tabRef, current);
    this.#cleanupActionApprovals();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + BROWSER_ACTION_APPROVAL_TTL_MS;
    this.#actionApprovals.set(actionApprovalRef, {
      actionApprovalRef,
      kind: "element_action",
      action: normalizedAction,
      elementRef,
      descriptor: bound.descriptor,
      rawNodeId: bound.rawNodeId,
      fingerprint: bound.fingerprint,
      tabRef,
      family: browserFamily,
      providerTabId: state.providerTabId,
      expectedUrl: currentUrl,
      cwd: effectiveCwd,
      workbenchGeneration: state.workbenchGeneration,
      expiresAt,
    });
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      ...browserCleanupReceipt(result),
      action: {
        kind: normalizedAction,
        tab: publicTab(current),
        elementRef,
        descriptor: bound.descriptor,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context. The opaque ref binds only the exact fresh target and is not permission evidence. Dispatch only if the task still requires this action; do not supply or reconstruct a raw node id, selector, coordinate, index, or JavaScript target.",
    };
  }

  async elementAction({ actionApprovalRef }) {
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError("BROWSER_ACTION_REF_INVALID", "actionApprovalRef must be the opaque single-use ref returned by opaque element action preparation");
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "element_action") {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "Opaque element action ref is invalid, expired, or already consumed",
        ["Refresh browser_tabs, rediscover opaque elements, and prepare a fresh exact action only if it is still needed."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
    const state = this.#tabs.get(prepared.tabRef);
    const browserFamily = normalizeBrowserFamily(prepared.family ?? state?.family ?? "chrome");
    if (
      !state
      || state.providerTabId !== prepared.providerTabId
      || normalizeBrowserFamily(state.family ?? "chrome") !== browserFamily
      || prepared.workbenchGeneration !== this.#workbenchGeneration
    ) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        "The opaque element action no longer matches a current Browser runtime tab/family/generation",
        ["Refresh browser_tabs and rediscover the target instead of replaying the old action."]
      );
    }
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const rawNodeIdLiteral = JSON.stringify(prepared.rawNodeId);
    const fingerprintLiteral = JSON.stringify(prepared.fingerprint);
    const actionLiteral = JSON.stringify(prepared.action);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twCleanupError = null;
let __twCleanup = null;
try {
  __twTab = await __twBrowser.user.claimTab(__twInfo);
  const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null;
  if (__twBeforeUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ELEMENT_TARGET_CHANGED");
  const __twVisibleDom = await __twTab.dom_cua.get_visible_dom();
  if (typeof __twVisibleDom !== "string") throw new Error("TOOLWIRE_BROWSER_ELEMENT_VISIBLE_DOM_INVALID");
  const __twExpectedNodeId = ${rawNodeIdLiteral};
  let __twMatchedLine = null;
  for (const __twRawLine of __twVisibleDom.split(/\\r?\\n/)) {
    const __twNodeMatch = __twRawLine.match(/\\bnode_id=(?:\"([^\"]+)\"|'([^']+)'|([^\\s>]+))/i);
    if (!__twNodeMatch) continue;
    const __twNodeId = (__twNodeMatch[1] ?? __twNodeMatch[2] ?? __twNodeMatch[3] ?? "").trim();
    if (__twNodeId !== __twExpectedNodeId) continue;
    if (__twMatchedLine !== null) throw new Error("TOOLWIRE_BROWSER_ELEMENT_TARGET_CHANGED");
    __twMatchedLine = __twRawLine;
  }
  if (__twMatchedLine === null) throw new Error("TOOLWIRE_BROWSER_ELEMENT_STALE");
  const __twCanonical = __twMatchedLine
    .replace(/\\bnode_id=(?:\"[^\"]+\"|'[^']+'|[^\\s>]+)/i, "node_id=<server-bound>")
    .replace(/\\s+/g, " ")
    .trim();
  const { createHash: __twCreateHash } = await import("node:crypto");
  const __twFingerprint = __twCreateHash("sha256").update(__twCanonical, "utf8").digest("hex");
  if (__twFingerprint !== ${fingerprintLiteral}) throw new Error("TOOLWIRE_BROWSER_ELEMENT_TARGET_CHANGED");
  __twDispatchAttempted = true;
  if (${actionLiteral} === "click") {
    await __twTab.dom_cua.click({ node_id: __twExpectedNodeId });
  } else if (${actionLiteral} === "double_click") {
    await __twTab.dom_cua.double_click({ node_id: __twExpectedNodeId });
  } else {
    throw new Error("TOOLWIRE_BROWSER_ELEMENT_ACTION_UNSUPPORTED");
  }
  await __twTab.playwright.waitForTimeout(250);
  const __twAfterUrl = (await __twTab.url()) ?? null;
  const __twAfterTitle = (await __twTab.title()) ?? null;
  __twPayload = { beforeUrl: __twBeforeUrl, afterUrl: __twAfterUrl, afterTitle: __twAfterTitle, action: ${actionLiteral} };
} catch (__twError) {
  __twActionError = __twError;
} finally {
  if (__twTab) {
    try { __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab); }
    catch (__twError) { __twCleanupError = __twError; }
  }
}
if (__twDispatchAttempted && (__twActionError || __twCleanupError)) {
  const __twPrimary = __twActionError ?? __twCleanupError;
  const __twPrimaryMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  const __twCleanupSuffix = __twCleanupError && __twActionError
    ? "; cleanup also failed: " + (__twCleanupError instanceof Error ? __twCleanupError.message : String(__twCleanupError))
    : "";
  if (/TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN/i.test(__twPrimaryMessage)) throw __twPrimary;
  throw new Error("TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:" + __twPrimaryMessage + __twCleanupSuffix);
}
if (__twActionError) throw __twActionError;
if (__twCleanupError) throw __twCleanupError;
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute opaque Browser element action", { mutationKind: "click", expectedGeneration: prepared.workbenchGeneration });

    const current = {
      ...state,
      title: stringOrNull(result?.afterTitle) ?? state.title,
      url: stringOrNull(result?.afterUrl) ?? state.url,
      seenAt: Date.now(),
    };
    this.#tabs.set(prepared.tabRef, current);
    if (current.url !== prepared.expectedUrl) this.#elementRefs.invalidateTab(prepared.tabRef);
    return {
      status: prepared.action === "double_click" ? "double_clicked" : "clicked",
      action: {
        kind: prepared.action,
        elementRef: prepared.elementRef,
        descriptor: prepared.descriptor,
      },
      tab: publicTab(current),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      afterUrl: current.url,
      ...browserCleanupReceipt(result),
      note: "Exactly one prepared opaque-element action was dispatched through the maintained stock DOM-CUA node primitive after fresh URL/node/fingerprint revalidation. Raw stock node ids remain server-side, and uncertain dispatch is never replayed automatically.",
    };
  }

  async prepareClick({ tabRef, role, name, text, scopeUrl, button = "left", cwd = this.#defaultCwd }, { allowStableElementId = true } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const normalizedButton = typeof button === "string" ? button.trim().toLowerCase() : "";
    if (!new Set(["left", "right"]).has(normalizedButton)) {
      throw new BrowserPreviewError("BROWSER_CLICK_BUTTON_UNSUPPORTED", "button must be exactly left or right");
    }
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
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
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current browser family."]
      );
    }
    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const clickLocatorSetupSource = browserClickLocatorSetupSource(clickTarget, { allowStableElementId });
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twCleanup = null;
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
  if (__twTab) __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
}
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
nodeRepl.write(JSON.stringify(__twPayload));
`, "Prepare exact Chrome click", { expectedGeneration: state.workbenchGeneration });

    this.#cleanupActionApprovals();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + BROWSER_ACTION_APPROVAL_TTL_MS;
    const prepared = {
      actionApprovalRef,
      kind: "click",
      tabRef,
      family: browserFamily,
      providerTabId: state.providerTabId,
      expectedUrl: stringOrNull(result?.url) ?? state.url,
      cwd: effectiveCwd,
      target: clickTarget,
      button: normalizedButton,
      textBinding: clickTarget.kind === "text"
        ? browserTextBindingFromPrepareResult(result)
        : null,
      workbenchGeneration: state.workbenchGeneration,
      expiresAt,
    };
    this.#actionApprovals.set(actionApprovalRef, prepared);
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      ...browserCleanupReceipt(result),
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
        button: normalizedButton,
        exact: true,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context to the prepared target. If this click is ordinary navigation/expansion or the bounded task's required verbal confirmation is already satisfied, call codex.browser_click immediately with this actionApprovalRef. Ask only when the policy/task actually requires it; do not ask merely because this is a click or because the legacy ref name contains Approval. Preparing did not click or mutate the page.",
    };
  }

  async click({ actionApprovalRef }) {
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_INVALID",
        "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_click"
      );
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "click") {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "actionApprovalRef is invalid, expired, or already consumed",
        ["Call codex.browser_tabs and codex.browser_prepare_click again to prepare a fresh exact click."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        "The prepared click belongs to an older Codex Workbench generation and cannot be dispatched",
        ["Call codex.browser_tabs and prepare the click again from current page state."]
      );
    }
    const state = this.#tabs.get(prepared.tabRef);
    const browserFamily = normalizeBrowserFamily(prepared.family ?? state?.family ?? "chrome");
    if (!state || state.providerTabId !== prepared.providerTabId || normalizeBrowserFamily(state.family ?? "chrome") !== browserFamily) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        "The prepared click no longer matches a current Browser runtime tab or Browser family",
        ["Call codex.browser_tabs and prepare the click again from current page state."]
      );
    }

    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const clickLocatorSetupSource = browserClickLocatorSetupSource(prepared.target, {
      binding: prepared.textBinding,
    });
    const localRadioBinding = prepared.button === "left" && prepared.textBinding?.kind === "local-radio" ? prepared.textBinding : null;
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
      : prepared.button === "right"
        ? `await __twDispatchLocator.click({ button: "right", timeoutMs: 5000 });`
        : `await __twDispatchLocator.click({ timeoutMs: 5000 });`;
    const flairTemplateBinding = prepared.button === "left" && prepared.textBinding?.kind === "flair-template-option" ? prepared.textBinding : null;
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
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
let __twCleanup = null;
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
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
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
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
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
        button: prepared.button ?? "left",
        exact: true,
      },
      tab: publicTab(current),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      afterUrl: current.url,
      ...browserCleanupReceipt(result),
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: `Exactly one previously prepared ${prepared.button === "right" ? "right-click" : "left-click"} was dispatched after the caller applied the current Browser confirmation policy and task context. The legacy actionApprovalRef is only an exact-action binding, not proof of user approval. The Browser runtime revalidated the tab URL and the same unique visible enabled exact target immediately before dispatch, then read back current page state. Existing-tab cleanup is reported separately and is never called released on finalize-absent runtimes without proof.`,
    };
  }

  async prepareDownload({ tabRef, role, name, text, cwd = this.#defaultCwd }) {
    const preparedClick = await this.prepareClick({ tabRef, role, name, text, cwd }, { allowStableElementId: false });
    const prepared = this.#actionApprovals.get(preparedClick.actionApprovalRef);
    if (!prepared || prepared.kind !== "click") {
      throw new BrowserPreviewError(
        "BROWSER_DOWNLOAD_PREPARE_FAILED",
        "Browser download preparation could not bind the exact target"
      );
    }
    prepared.kind = "download";
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
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_INVALID",
        "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_download"
      );
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "download") {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared download",
        ["Call codex.browser_tabs and codex.browser_prepare_download again to prepare a fresh exact download."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        "The prepared download belongs to an older Codex Workbench generation and cannot be dispatched",
        ["Call codex.browser_tabs and prepare the download again from current page state."]
      );
    }
    const state = this.#tabs.get(prepared.tabRef);
    const browserFamily = normalizeBrowserFamily(prepared.family ?? state?.family ?? "chrome");
    if (!state || state.providerTabId !== prepared.providerTabId || normalizeBrowserFamily(state.family ?? "chrome") !== browserFamily) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        "The prepared download no longer matches a current Browser runtime tab or Browser family",
        ["Call codex.browser_tabs and prepare the download again from current page state."]
      );
    }

    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const clickLocatorSetupSource = browserClickLocatorSetupSource(prepared.target, {
      binding: prepared.textBinding,
      allowStableElementId: false,
    });
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
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
let __twCleanup = null;
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
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
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
Object.assign(__twPayload, __twCleanup ?? {
  cleanupStatus: "uncertain",
  cleanupReason: __twFinalizeError ? "explicit-finalize-failed" : "cleanup-receipt-missing",
});
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
      ...browserCleanupReceipt(result),
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
    }, { allowStableElementId: false });
    const prepared = this.#actionApprovals.get(preparedClick.actionApprovalRef);
    if (!prepared || prepared.kind !== "click") {
      throw new BrowserPreviewError(
        "BROWSER_UPLOAD_PREPARE_FAILED",
        "Browser upload preparation could not bind the exact file chooser target"
      );
    }
    prepared.kind = "upload";
    prepared.uploadFile = {
      path: authorizedFile.path,
      fileName: path.basename(authorizedFile.path),
      byteLength: authorizedFile.byteLength,
      sha256: authorizedFile.sha256,
      trustedAncestor: authorizedFile.trustedAncestor,
    };
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
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_INVALID",
        "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_upload"
      );
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "upload" || !prepared.uploadFile?.path) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared upload",
        ["Call codex.browser_tabs and codex.browser_prepare_upload again to prepare a fresh exact upload."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
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
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        "The prepared upload belongs to an older Codex Workbench generation and cannot be dispatched",
        ["Call codex.browser_tabs and prepare the upload again from current page state."]
      );
    }
    const state = this.#tabs.get(prepared.tabRef);
    const browserFamily = normalizeBrowserFamily(prepared.family ?? state?.family ?? "chrome");
    if (!state || state.providerTabId !== prepared.providerTabId || normalizeBrowserFamily(state.family ?? "chrome") !== browserFamily) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        "The prepared upload no longer matches a current Browser runtime tab or Browser family",
        ["Call codex.browser_tabs and prepare the upload again from current page state."]
      );
    }

    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const uploadPathLiteral = JSON.stringify(prepared.uploadFile.path);
    const clickLocatorSetupSource = browserClickLocatorSetupSource(prepared.target, {
      binding: prepared.textBinding,
      allowStableElementId: false,
    });
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
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
let __twCleanup = null;
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
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
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
Object.assign(__twPayload, __twCleanup ?? {
  cleanupStatus: "uncertain",
  cleanupReason: __twFinalizeError ? "explicit-finalize-failed" : "cleanup-receipt-missing",
});
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
      ...browserCleanupReceipt(result),
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
      postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
      postSnapshotChars: snapshot.length,
      postSnapshotTruncated: snapshotTruncated,
      note: "Exactly one authority-bounded existing local file from the current Codex trusted authority root was handed to the webpage through the official Chrome filechooser/setFiles flow after revalidating the exact prepared semantic target. The Browser runtime binds canonical path + byte length + SHA-256 at prepare time, revalidates the same fingerprint immediately before Browser dispatch, and checks it again after setFiles returns. This catches ordinary source-file drift but is not represented as an operating-system write lock against a hostile concurrent writer in the narrow dispatch window. setFiles returning confirms browser-side file selection/change delivery, not necessarily remote server acceptance; use page state for any stronger upload-complete claim. The Browser runtime never retries an uncertain upload automatically.",
    };
  }

  async prepareFill({ tabRef, role, name, placeholder, scopeUrl, text, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserPreviewError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
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
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserPreviewError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current Chrome session."]
      );
    }

    const browserFamily = normalizeBrowserFamily(state.family ?? "chrome");
    await this.#requireReady(effectiveCwd, browserFamily);
    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(state.providerTabId);
    const fillLocatorSetupSource = browserFillLocatorSetupSource(fillTarget);
    const result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twCleanup = null;
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
  const __twNativePasswordTarget = __twTargetMeta?.tag === "input" && __twTargetMeta?.inputType === "password";
  const __twTargetStructure = __twNativePasswordTarget ? null : await __twLocator.evaluate((element) => {
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
  let __twCurrentValue = null;
  if (!__twNativePasswordTarget) {
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
    __twCurrentValue = __twCurrentCandidates.find((candidate) => !/^\\s*$/.test(candidate)) ?? __twCurrentCandidates[0];
  }
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
  if (__twTab) __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
}
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
nodeRepl.write(JSON.stringify(__twPayload));
`, "Prepare exact Chrome fill", { expectedGeneration: state.workbenchGeneration });

    const editableSource = stringOrNull(result?.targetMeta?.editableSource);
    const editableKind = stringOrNull(result?.targetMeta?.editableKind);
    if (!new Set(["direct", "unique-visible-descendant", "semantic-shell"]).has(editableSource)
      || !new Set(["input", "textarea", "contenteditable", "semantic-shell"]).has(editableKind)) {
      throw new BrowserPreviewError(
        "BROWSER_FILL_TARGET_INVALID",
        "The prepared Browser textbox resolved without one bounded editable target classification"
      );
    }
    const nativePasswordBinding = fillTarget.kind === "placeholder"
      && fillTarget.role === "textbox"
      && stringOrNull(result?.targetMeta?.tag) === "input"
      && stringOrNull(result?.targetMeta?.inputType) === "password"
      && stringOrNull(result?.targetMeta?.placeholder) === fillTarget.placeholder
      ? { tag: "input", type: "password", placeholder: fillTarget.placeholder }
      : null;
    this.#cleanupActionApprovals();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + BROWSER_ACTION_APPROVAL_TTL_MS;
    const prepared = {
      actionApprovalRef,
      kind: "fill",
      tabRef,
      family: browserFamily,
      providerTabId: state.providerTabId,
      expectedUrl: stringOrNull(result?.url) ?? state.url,
      cwd: effectiveCwd,
      target: fillTarget,
      text,
      fillStrategy: result?.fillStrategy === "type" ? "type" : "fill",
      editableBinding: { source: editableSource, kind: editableKind },
      nativePasswordBinding,
      targetMeta: result?.targetMeta ?? null,
      workbenchGeneration: state.workbenchGeneration,
      expiresAt,
    };
    this.#actionApprovals.set(actionApprovalRef, prepared);
    return {
      status: "prepared",
      actionApprovalRef,
      expiresAt,
      ...browserCleanupReceipt(result),
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
        ...(nativePasswordBinding
          ? {
              textLength: prepared.text.length,
              targetBinding: nativePasswordBinding,
            }
          : {
              text: prepared.text,
              currentValue: stringOrNull(result?.currentValue) ?? "",
              targetStructure: result?.targetStructure ?? null,
            }),
        fillStrategy: prepared.fillStrategy,
      },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context to this exact fill. If the text is ordinary non-sensitive task content and no policy-covered transmission confirmation is needed, or the bounded task's required verbal confirmation is already satisfied, call codex.browser_fill immediately with this actionApprovalRef. Ask only when the policy/task actually requires it; do not ask merely because this is Fill or because the legacy ref name contains Approval. Preparing did not modify the field, click, press Enter, or submit the page.",
    };
  }

  async fill({ actionApprovalRef }) {
    this.#cleanupActionApprovals();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("browser_action_")) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_INVALID",
        "actionApprovalRef must be the opaque single-use reference returned by codex.browser_prepare_fill"
      );
    }
    const prepared = this.#actionApprovals.get(actionApprovalRef);
    if (!prepared || prepared.kind !== "fill") {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_REF_EXPIRED",
        "actionApprovalRef is invalid, expired, already consumed, or does not refer to a prepared fill",
        ["Call codex.browser_tabs and codex.browser_prepare_fill again to prepare a fresh exact fill."]
      );
    }
    const effectiveCwd = await this.#readyPreparedAction(actionApprovalRef, prepared);
    if (prepared.workbenchGeneration !== this.#workbenchGeneration) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_RUNTIME_RESTARTED",
        "The prepared fill belongs to an older Codex Workbench generation and cannot be dispatched",
        ["Call codex.browser_tabs and prepare the fill again from current page state."]
      );
    }
    const state = this.#tabs.get(prepared.tabRef);
    const browserFamily = normalizeBrowserFamily(prepared.family ?? state?.family ?? "chrome");
    if (!state || state.providerTabId !== prepared.providerTabId || normalizeBrowserFamily(state.family ?? "chrome") !== browserFamily) {
      throw new BrowserPreviewError(
        "BROWSER_ACTION_TAB_STALE",
        "The prepared fill no longer matches a current Browser runtime tab or Browser family",
        ["Call codex.browser_tabs and prepare the fill again from current page state."]
      );
    }

    const familyLiteral = JSON.stringify(browserFamily);
    const providerLiteral = JSON.stringify(prepared.providerTabId);
    const expectedUrlLiteral = JSON.stringify(prepared.expectedUrl);
    const fillLocatorSetupSource = browserFillLocatorSetupSource(prepared.target);
    const textLiteral = JSON.stringify(prepared.text);
    const canonicalRichTextLiteral = JSON.stringify(prepared.text.replace(/\r\n?/g, "\n"));
    const nativePasswordBindingLiteral = JSON.stringify(prepared.nativePasswordBinding ?? null);
    const nativePasswordFillLiteral = JSON.stringify(Boolean(prepared.nativePasswordBinding));
    let result = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
let __twCleanup = null;
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
  if (__twTargetMeta?.editableSource !== ${JSON.stringify(prepared.editableBinding.source)}
    || __twTargetMeta?.editableKind !== ${JSON.stringify(prepared.editableBinding.kind)}
    || __twFillStrategy !== ${JSON.stringify(prepared.fillStrategy)}) {
    throw new Error("TOOLWIRE_BROWSER_FILL_TARGET_CHANGED");
  }
  const __twPreparedNativePasswordBinding = ${nativePasswordBindingLiteral};
  const __twNativePasswordFill = ${nativePasswordFillLiteral};
  const __twAssertNativePasswordBinding = (meta) => {
    if (!__twNativePasswordFill) return;
    if (meta?.tag !== __twPreparedNativePasswordBinding?.tag
      || meta?.inputType !== __twPreparedNativePasswordBinding?.type
      || meta?.placeholder !== __twPreparedNativePasswordBinding?.placeholder) {
      throw new Error("TOOLWIRE_BROWSER_FILL_TARGET_CHANGED");
    }
  };
  __twAssertNativePasswordBinding(__twTargetMeta);
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
    __twAssertNativePasswordBinding(__twFresh.targetMeta);
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
  let __twBeforeValue = null;
  if (!__twNativePasswordFill) {
    const __twBeforeObserved = await __twReadLocatorText(__twLocator);
    __twBeforeValue = __twSelectObservedText(__twBeforeObserved);
    if (typeof __twBeforeValue !== "string") throw new Error("TOOLWIRE_BROWSER_FILL_VALUE_UNREADABLE");
  }
  const __twVerifyFreshTarget = async (fresh) => {
    if (__twNativePasswordFill) {
      __twAssertNativePasswordBinding(fresh.targetMeta);
      return { exact: true, afterValue: null, source: "fresh-native-password-binding", observed: null };
    }
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
  if (__twAfterUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
  const __twAfterTitle = (await __twTab.title()) ?? null;
  const __twSnapshot = __twNativePasswordFill ? null : await __twTab.playwright.domSnapshot();
  __twPayload = {
    phaseStatus: __twActivationOnly ? "activation_only" : "filled",
    beforeUrl: __twBeforeUrl,
    afterUrl: __twAfterUrl,
    afterTitle: __twAfterTitle,
    beforeValue: __twNativePasswordFill ? null : __twBeforeValue,
    afterValue: __twNativePasswordFill ? null : __twAfterValue,
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
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
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
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
nodeRepl.write(JSON.stringify(__twPayload));
`, "Execute prepared Chrome fill", { mutationKind: "fill", expectedGeneration: prepared.workbenchGeneration });

    if (result?.phaseStatus === "activation_only") {
      const activation = result;
      const repair = await this.#runJson(effectiveCwd, `
const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get(${familyLiteral});
const __twOpenTabs = await __twBrowser.user.openTabs();
const __twInfo = __twOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE");
let __twTab = null;
let __twPayload = null;
let __twDispatchAttempted = false;
let __twActionError = null;
let __twFinalizeError = null;
let __twCleanup = null;
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
  if (__twAfterUrl !== ${expectedUrlLiteral}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
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
      __twCleanup = await cleanupBrowserClaim(__twBrowser, __twTab);
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
if (__twPayload && __twCleanup) Object.assign(__twPayload, __twCleanup);
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

    const nativePasswordFill = Boolean(prepared.nativePasswordBinding);
    const snapshot = !nativePasswordFill && typeof result?.snapshot === "string" ? result.snapshot : "";
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
      ...browserCleanupReceipt(result),
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
        ...(nativePasswordFill ? { targetBinding: prepared.nativePasswordBinding } : {}),
      },
      tab: publicTab(current),
      beforeUrl: stringOrNull(result?.beforeUrl) ?? prepared.expectedUrl,
      afterUrl: current.url,
      ...(nativePasswordFill
        ? {}
        : {
            beforeValue: stringOrNull(result?.beforeValue) ?? "",
            afterValue: stringOrNull(result?.afterValue) ?? "",
          }),
      verificationSource: stringOrNull(result?.verificationSource) ?? "fresh-target",
      dispatchAttempts: Number.isInteger(result?.dispatchAttempts) ? result.dispatchAttempts : 1,
      settleRecheck: result?.settleRecheck === true,
      repairSettleMs: Number.isInteger(result?.repairSettleMs) ? result.repairSettleMs : null,
      reclaimAttempted: result?.reclaimAttempted === true,
      reclaimStatus: stringOrNull(result?.reclaimStatus),
      repairAttempted: result?.repairAttempted === true,
      repairReason: stringOrNull(result?.repairReason),
      ...(nativePasswordFill
        ? {}
        : {
            postSnapshot: snapshotTruncated ? snapshot.slice(0, BROWSER_POST_ACTION_MAX_CHARS) : snapshot,
            postSnapshotChars: snapshot.length,
            postSnapshotTruncated: snapshotTruncated,
          }),
      note: nativePasswordFill
        ? "Exactly one prepared native password fill was dispatched through the official fill API after revalidating the same tab URL and exact placeholder-bound input tag/type/placeholder plus visibility/enabled state. The Browser runtime does not read or return the password value, does not return the prepared text body, and does not enter the activation-repair path; receipts retain only the prepared text length and bounded target identity."
        : "Exactly one previously prepared fill was dispatched after the caller applied the current Browser confirmation policy and task context. The legacy actionApprovalRef is only an exact-action binding, not proof of user approval. The Browser runtime revalidated the same tab URL and original exact semantic target, resolved only that target or its unique visible supported editable descendant, verified exact bound text on a freshly re-resolved target, and read back current page state. Existing-tab cleanup is reported separately and finalize-absent runtimes are not claimed released without proof. It did not click, press Enter, navigate, or submit the page, and it did not implement website persistence/Save behavior.",
    };
  }

  async #boundRuntimeCompatibilityStatus(cwd, { skillPath = null, pluginBuild = null } = {}) {
    if (!this.#runtimeCompatibility) return null;
    let current;
    try {
      current = normalizeRuntimeCompatibilityBinding(
        await this.#runtimeCompatibilityResolver({ cwd, chromeSkillPath: skillPath, chromePluginBuild: pluginBuild })
      );
    } catch {
      current = null;
    }
    if (!current || !runtimeCompatibilityBindingsMatch(this.#runtimeCompatibility, current)) {
      return {
        status: "unavailable",
        reason: "BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED",
        chromeSkill: "changed",
        nodeRepl: "unknown",
        nextActions: [
          "Restart the main Codexless household runtime so Browser compatibility, isolated node_repl overrides, and the canonical browser client/service fingerprint are rebound together.",
          "Do not hot-switch the Browser child to the newly discovered plugin inside the current main runtime.",
        ],
      };
    }
    this.#browserClientUrl = pathToFileURL(this.#runtimeCompatibility.browserClientPath).href;
    return null;
  }

  async #dependencyStatus(cwd) {
    let skills;
    let chromePlugin = null;
    try {
      [skills, chromePlugin] = await Promise.all([
        this.#workbench.catalog({ kind: "skills", cwd, query: CHROME_SKILL_NAME }),
        typeof this.#workbench.currentChromePlugin === "function"
          ? this.#workbench.currentChromePlugin({ cwd })
          : Promise.resolve(null),
      ]);
      this.#syncWorkbenchGeneration();
    } catch (error) {
      this.#syncWorkbenchGeneration();
      return browserUnavailable(new BrowserPreviewError(
        "BROWSER_CHROME_DISCOVERY_FAILED",
        `Could not read current Codex Chrome plugin/Skill state: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
    const skill = (skills?.skills ?? []).find((entry) => entry?.name === CHROME_SKILL_NAME && entry?.enabled !== false);
    const skillPath = skill?.path ?? null;
    const pluginBuild = typeof chromePlugin?.localVersion === "string" && chromePlugin.localVersion.trim()
      ? chromePlugin.localVersion.trim()
      : null;
    if (!skillPath && !pluginBuild) {
      return {
        status: "unavailable",
        reason: "chrome_skill_unavailable",
        chromeSkill: "missing",
        nodeRepl: "unknown",
        nextActions: [
          "Install/enable the current bundled Codex Chrome plugin, then retry codex.browser_status.",
          "Do not use CUA as an automatic fallback for a missing Browser plugin.",
        ],
      };
    }
    if (this.#runtimeCompatibilityFailure) {
      return runtimeCompatibilityUnavailable(this.#runtimeCompatibilityFailure);
    }
    const compatibilityStatus = await this.#boundRuntimeCompatibilityStatus(cwd, { skillPath, pluginBuild });
    if (compatibilityStatus) return compatibilityStatus;

    try {
      const mcp = await this.#workbench.catalog({ kind: "mcp", cwd: this.#runtimeCwd, query: NODE_REPL_TOOL });
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

    if (!this.#runtimeCompatibility) {
      if (!skillPath) {
        return {
          status: "unavailable",
          reason: "BROWSER_RUNTIME_COMPATIBILITY_UNAVAILABLE",
          chromeSkill: "not_required",
          nodeRepl: "ok",
          nextActions: [
            "Use a Codexless runtime that binds the current skill-less Chrome plugin build to its browser client/service pair before Browser dispatch.",
          ],
        };
      }
      this.#browserClientUrl = this.#browserClientUrl ?? deriveBrowserClientUrl(skillPath);
    }
    return { status: "ok", skillPathResolved: Boolean(skillPath), chromePluginResolved: Boolean(pluginBuild), browserClientResolved: true };
  }

  async #requireReady(cwd, family = "chrome") {
    const browserFamily = normalizeBrowserFamily(family);
    const dependency = await this.#dependencyStatus(cwd);
    if (dependency.status !== "ok") {
      throw new BrowserPreviewError(
        dependency.reason ?? "BROWSER_UNAVAILABLE",
        `Browser dependencies are unavailable: ${dependency.reason ?? "unknown"}`,
        dependency.nextActions ?? ["Call codex.browser_status for current diagnostics."]
      );
    }
    const backends = await this.#listBackends(cwd);
    const familyBackends = backends.filter((backend) => backend.family === browserFamily);
    if (familyBackends.length === 0) {
      throw new BrowserPreviewError(
        "BROWSER_FAMILY_NOT_CONNECTED",
        `The Codex Browser runtime is available but no connected ${browserFamily} extension/backend is visible`,
        [
          `Open ${browserFamily} with the supported Codex Browser extension/runtime enabled, then retry.`,
          "Call codex.browser_status to distinguish Browser setup from site login state.",
        ]
      );
    }
    if (familyBackends.length > 1) {
      if (browserFamily === "chrome") {
        const ambiguous = chromeBackendAmbiguous(backends, familyBackends);
        throw new BrowserPreviewError(ambiguous.reason, ambiguous.error, ambiguous.nextActions, {
          connectedBrowsers: ambiguous.connectedBrowsers,
        });
      }
      throw new BrowserPreviewError(
        "BROWSER_FAMILY_BACKEND_AMBIGUOUS",
        `Multiple connected ${browserFamily} Browser backends are visible and Codexless has no profile/backend selector`,
        ["Do not guess a backend/profile. Leave only one backend for the requested family connected, then retry."],
        { connectedBrowsers: backends.map(sanitizeBackend), family: browserFamily }
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
    let mutationToken = null;
    if (mutationKind) {
      if (this.#emergencyResetInProgress) {
        throw new BrowserPreviewError(
          "BROWSER_EMERGENCY_RESET_IN_PROGRESS",
          "Browser mutation was refused because an emergency control-state reset is in progress",
          ["Wait for the reset receipt, refresh browser_tabs, and prepare a fresh action. Do not replay the prior mutation automatically."]
        );
      }
      mutationToken = `browser_mutation_${randomUUID()}`;
      this.#activeMutations.set(mutationToken, {
        kind: mutationKind,
        startedAt: Date.now(),
        generation: expectedGeneration ?? this.#workbenchGeneration,
      });
    }
    try {
      const clientUrl = await this.#resolveBrowserClientUrl(cwd);
    const dispatchGeneration = expectedGeneration ?? this.#workbenchGeneration;
    const bootstrap = `
if (globalThis.__toolwireBrowserAgent?.browsers == null) {
  const { setupBrowserRuntime } = await import(${JSON.stringify(clientUrl)});
  globalThis.__toolwireBrowserAgent = await setupBrowserRuntime();
}
`;
    const lifecycleAdapterSource = body.includes("markBrowserDeliverable(") || body.includes("cleanupBrowserClaim(")
      ? `${BROWSER_LIFECYCLE_ADAPTER_SOURCE}\n`
      : "";
    const snapshotAwareBody = body.includes("await __twTab.playwright.domSnapshot()")
      ? body.replaceAll("await __twTab.playwright.domSnapshot()", "await sanitizeBrowserDomSnapshot(__twTab)")
      : body;
    const snapshotSanitizerSource = snapshotAwareBody !== body
      ? `${BROWSER_PASSWORD_SNAPSHOT_SANITIZER_SOURCE}\n`
      : "";
    let response;
    try {
      response = await this.#workbench.mcpCall({
        server: NODE_REPL_SERVER,
        tool: NODE_REPL_TOOL,
        cwd: this.#runtimeCwd,
        arguments: { code: `${bootstrap}\n{\n${lifecycleAdapterSource}${snapshotSanitizerSource}${snapshotAwareBody}\n}`, title },
        meta: this.#nextTurnMeta(),
        expectedGeneration: dispatchGeneration,
      });
      this.#syncWorkbenchGeneration();
    } catch (error) {
      const generationChanged = this.#syncWorkbenchGeneration();
      const message = error instanceof Error ? error.message : String(error);
      if (/WORKBENCH_GENERATION_STALE/i.test(message)) {
        throw new BrowserPreviewError(
          "BROWSER_WORKBENCH_RESTARTED",
          "The persistent Codex Workbench restarted before this Browser request could safely use its prior runtime state",
          ["Call codex.browser_tabs again and prepare a fresh Browser action from the current Workbench generation."]
        );
      }
      if (mutationKind) {
        throw browserMutationResultUncertain(
          mutationKind,
          generationChanged
            ? `Browser ${mutationKind} request may already have been dispatched before the Workbench generation changed, so its result is uncertain: ${message}`
            : `Browser ${mutationKind} request was sent but its MCP response was not received reliably: ${message}`
        );
      }
      if (generationChanged) {
        throw new BrowserPreviewError(
          "BROWSER_WORKBENCH_RESTARTED",
          "The persistent Codex Workbench restarted before this Browser request could safely use its prior runtime state",
          ["Call codex.browser_tabs again and prepare a fresh Browser action from the current Workbench generation."]
        );
      }
      throw classifyBrowserError(error);
    }
    if (response?.isError) {
      const classified = classifyBrowserError(new Error(response?.text ?? "node_repl browser call failed"));
      if (classified.code === "BROWSER_TAB_BUSY") throw classified;
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
    } finally {
      if (mutationToken) this.#activeMutations.delete(mutationToken);
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

function normalizeRuntimeCompatibilityBinding(value) {
  if (value === null || value === undefined) return null;
  if (value?.status !== "ok") {
    throw new Error("Browser runtime compatibility binding must have status=ok");
  }
  for (const field of ["build", "browserClientPath", "browserServicePath", "browserClientSha256"]) {
    if (typeof value?.[field] !== "string" || !value[field]) {
      throw new Error(`Browser runtime compatibility binding is missing ${field}`);
    }
  }
  const chromeSkillPath = typeof value?.chromeSkillPath === "string" && value.chromeSkillPath
    ? path.resolve(value.chromeSkillPath)
    : null;
  const chromePluginRoot = typeof value?.chromePluginRoot === "string" && value.chromePluginRoot
    ? path.resolve(value.chromePluginRoot)
    : chromeSkillPath
      ? path.resolve(path.dirname(chromeSkillPath), "..", "..")
      : null;
  if (!chromePluginRoot) {
    throw new Error("Browser runtime compatibility binding is missing chromePluginRoot/chromeSkillPath");
  }
  if (!/^[a-f0-9]{64}$/i.test(value.browserClientSha256)) {
    throw new Error("Browser runtime compatibility binding has an invalid browserClientSha256");
  }
  return {
    build: value.build,
    chromeSkillPath,
    chromePluginRoot,
    browserClientPath: path.resolve(value.browserClientPath),
    browserServicePath: path.resolve(value.browserServicePath),
    browserClientSha256: value.browserClientSha256.toLowerCase(),
  };
}

function normalizeRuntimeCompatibilityFailure(value) {
  if (value?.status !== "unavailable" || typeof value?.reason !== "string" || !value.reason) {
    throw new Error("Browser runtime compatibility failure must have status=unavailable and a reason");
  }
  return {
    reason: value.reason,
    build: typeof value.build === "string" ? value.build : null,
  };
}

function runtimeCompatibilityUnavailable(failure) {
  const mapped = failure.reason === "current_browser_plugin_manifest_mismatch"
    ? "BROWSER_RUNTIME_MANIFEST_MISMATCH"
    : failure.reason === "current_browser_plugin_pair_not_found"
      ? "BROWSER_RUNTIME_COMPONENT_MISSING"
      : failure.reason === "current_browser_plugin_path_escape" || failure.reason === "current_chrome_skill_path_untrusted"
        ? "BROWSER_RUNTIME_PATH_UNTRUSTED"
        : "BROWSER_RUNTIME_COMPATIBILITY_UNAVAILABLE";
  return {
    status: "unavailable",
    reason: mapped,
    compatibilityReason: failure.reason,
    ...(failure.build ? { build: failure.build } : {}),
    chromeSkill: "ok",
    nodeRepl: "not_started",
    nextActions: [
      "Restore or update the current Codex bundled chrome/browser plugin pair so the Skill, manifests, browser client, and browser service come from one matching build, then restart the Codexless household runtime.",
      "Do not diagnose this as an ordinary disconnected Chrome session; Browser startup was refused before backend attachment.",
    ],
  };
}

function runtimeCompatibilityPathMatches(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function runtimeCompatibilityBindingsMatch(bound, current) {
  return bound.build === current.build
    && bound.browserClientSha256 === current.browserClientSha256
    && runtimeCompatibilityPathMatches(bound.chromePluginRoot, current.chromePluginRoot)
    && runtimeCompatibilityPathMatches(bound.browserClientPath, current.browserClientPath)
    && runtimeCompatibilityPathMatches(bound.browserServicePath, current.browserServicePath);
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

function normalizeBrowserFamily(value) {
  if (value === "chrome" || value === "edge") return value;
  throw new BrowserPreviewError(
    "BROWSER_FAMILY_INVALID",
    "Browser family must be exactly chrome or edge",
    ["Use codex.browser_status to inspect currently connected stock Browser families."]
  );
}

function publicTab(state) {
  return {
    tabRef: state.tabRef,
    family: state.family ?? "chrome",
    title: state.title,
    url: state.url,
    lastOpened: state.lastOpened,
  };
}

function browserClickLocatorSetupSource(target, { binding = null, allowStableElementId = true } = {}) {
  if (target?.kind === "text" && typeof target.text === "string" && target.text) {
    const textLiteral = JSON.stringify(target.text);
    const bindingKind = binding?.kind === "role" || binding?.kind === "onclick-property" || binding?.kind === "label-control" || binding?.kind === "local-radio" || binding?.kind === "flair-template-option" || binding?.kind === "thread-card-data" || binding?.kind === "stable-element-id" ? binding.kind : null;
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
    const expectedStableIdBinding = bindingKind === "stable-element-id" ? JSON.stringify(binding) : null;
    const rolesLiteral = JSON.stringify(fixedRole ? [fixedRole] : bindingKind === "onclick-property" || bindingKind === "label-control" || bindingKind === "local-radio" || bindingKind === "flair-template-option" || bindingKind === "thread-card-data" || bindingKind === "stable-element-id" ? [] : ["link", "button", "menuitem"]);
    const allowOnclickProperty = bindingKind === null || bindingKind === "onclick-property";
    const allowLabelControl = bindingKind === null || bindingKind === "label-control";
    const allowLocalRadio = bindingKind === null || bindingKind === "local-radio";
    const allowFlairTemplateOption = bindingKind === null || bindingKind === "flair-template-option";
    const allowThreadCardData = bindingKind === null || bindingKind === "thread-card-data";
    const allowStableElementIdFallback = allowStableElementId && (bindingKind === null || bindingKind === "stable-element-id");
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
if (__twSemanticCount === 0 && ${allowStableElementIdFallback ? "true" : "false"}) {
  const __twStableIdBinding = await __twTextLocator.evaluate((element, maxDepth) => {
    const stableIdPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
    let current = element;
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
      const tagName = typeof current.tagName === "string" ? current.tagName.toLowerCase() : null;
      const stableId = typeof current.id === "string" ? current.id.trim() : "";
      const role = typeof current.getAttribute === "function" ? current.getAttribute("role") : null;
      const href = typeof current.getAttribute === "function" ? current.getAttribute("href") : null;
      const rawAriaDisabled = typeof current.getAttribute === "function" ? current.getAttribute("aria-disabled") : null;
      const ariaDisabled = rawAriaDisabled === null ? null : String(rawAriaDisabled).trim().toLowerCase();
      if (
        tagName === "a"
        && stableIdPattern.test(stableId)
        && (role === null || role === "")
        && href === null
        && ariaDisabled !== "true"
      ) {
        const duplicateIds = Array.from(document.querySelectorAll("[id]")).filter((candidate) => candidate?.id === stableId);
        if (duplicateIds.length === 1 && duplicateIds[0] === current) {
          return {
            kind: "stable-element-id",
            depth,
            tagName,
            id: stableId,
            role: role || null,
            href,
            ariaDisabled: ariaDisabled || null,
          };
        }
      }
      current = current.parentElement;
    }
    return null;
  }, 6);
  if (__twStableIdBinding) {
    ${expectedStableIdBinding === null ? "" : `if (
      __twStableIdBinding.kind !== ${JSON.stringify(binding?.kind ?? null)}
      || __twStableIdBinding.tagName !== ${JSON.stringify(binding?.tagName ?? null)}
      || __twStableIdBinding.id !== ${JSON.stringify(binding?.id ?? null)}
      || __twStableIdBinding.role !== ${JSON.stringify(binding?.role ?? null)}
      || __twStableIdBinding.href !== ${JSON.stringify(binding?.href ?? null)}
      || __twStableIdBinding.ariaDisabled !== ${JSON.stringify(binding?.ariaDisabled ?? null)}
    ) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED");`}
    let __twStableIdAncestor = __twTextLocator;
    for (let __twDepth = 0; __twDepth < __twStableIdBinding.depth; __twDepth += 1) {
      __twStableIdAncestor = __twStableIdAncestor.locator("..");
    }
    const __twStableIdAncestorCount = await __twStableIdAncestor.count();
    if (__twStableIdAncestorCount !== 1) throw new Error("TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + __twStableIdAncestorCount);
    __twLocator = __twStableIdAncestor;
    __twResolvedKind = "stable-element-id";
    __twResolvedClickBinding = __twStableIdBinding;
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
const __twSemanticCount = await __twSemanticLocator.count();
if (__twSemanticCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twSemanticCount);
if (!(await __twSemanticLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
if (!(await __twSemanticLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED");
const __twDirectEditableProfile = await __twSemanticLocator.evaluate((element) => {
  const browserFillEditableElementProfile = ${BROWSER_FILL_EDITABLE_ELEMENT_PROFILE_SOURCE};
  return browserFillEditableElementProfile(element);
});
const __twResolveBoundEditableLocator = async (__twBoundSemanticLocator) => {
  const __twRawEditableDescendants = __twBoundSemanticLocator.locator('input, textarea, [contenteditable]');
  const __twEditableDescendantLocators = await __twRawEditableDescendants.all();
  const __twVisibleEditableCandidates = [];
  let __twVisibleKnownEditableDescendants = 0;
  for (const __twCandidate of __twEditableDescendantLocators) {
    if (!(await __twCandidate.isVisible())) continue;
    __twVisibleKnownEditableDescendants += 1;
    const __twCandidateProfile = await __twCandidate.evaluate((element) => {
      const browserFillEditableElementProfile = ${BROWSER_FILL_EDITABLE_ELEMENT_PROFILE_SOURCE};
      return browserFillEditableElementProfile(element);
    });
    if (__twCandidateProfile?.supported !== true) continue;
    if (!(await __twCandidate.isEnabled())) throw new Error("TOOLWIRE_BROWSER_FILL_EDITABLE_NOT_ENABLED");
    __twVisibleEditableCandidates.push({ locator: __twCandidate, profile: __twCandidateProfile });
  }
  if (__twDirectEditableProfile?.supported === true) {
    if (__twVisibleEditableCandidates.length > 0) {
      throw new Error("TOOLWIRE_BROWSER_FILL_EDITABLE_COUNT:" + (1 + __twVisibleEditableCandidates.length));
    }
    return {
      locator: __twBoundSemanticLocator,
      source: "direct",
      kind: __twDirectEditableProfile.kind,
    };
  }
  if (__twVisibleEditableCandidates.length > 1) {
    throw new Error("TOOLWIRE_BROWSER_FILL_EDITABLE_COUNT:" + __twVisibleEditableCandidates.length);
  }
  if (__twVisibleEditableCandidates.length === 1) {
    return {
      locator: __twVisibleEditableCandidates[0].locator,
      source: "unique-visible-descendant",
      kind: __twVisibleEditableCandidates[0].profile.kind,
    };
  }
  if (__twDirectEditableProfile?.blocksSemanticShell === true || __twVisibleKnownEditableDescendants > 0) {
    throw new Error("TOOLWIRE_BROWSER_FILL_EDITABLE_COUNT:0");
  }
  return {
    locator: __twBoundSemanticLocator,
    source: "semantic-shell",
    kind: "semantic-shell",
  };
};
const __twResolvedEditable = await __twResolveBoundEditableLocator(__twSemanticLocator);
const __twLocator = __twResolvedEditable.locator;
if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE");
if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_FILL_EDITABLE_NOT_ENABLED");
const __twRuntimeTargetMeta = await __twLocator.evaluate((element) => {
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
    inputType: tag === "input"
      ? String(element?.type ?? (typeof element?.getAttribute === "function" ? element.getAttribute("type") : null) ?? "text").trim().toLowerCase() || "text"
      : null,
    placeholder: typeof element?.getAttribute === "function" ? element.getAttribute("placeholder") : null,
    contentEditable: Boolean(element?.isContentEditable),
    customHost,
  };
});
const __twTargetMeta = {
  ...__twRuntimeTargetMeta,
  editableSource: __twResolvedEditable.source,
  editableKind: __twResolvedEditable.kind,
  semanticTag: __twDirectEditableProfile?.tag ?? null,
  semanticContentEditable: __twDirectEditableProfile?.effectiveContentEditable === true,
};
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
let __twSemanticLocator = null;
for (let __twDepth = 0; __twDepth <= 8; __twDepth += 1) {
  const __twCandidate = __twScope.getByRole(${JSON.stringify(target.role)}).filter({ visible: true });
  const __twCandidateCount = await __twCandidate.count();
  if (__twCandidateCount > 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:" + __twDepth + ":" + __twCandidateCount);
  if (__twCandidateCount === 1) {
    __twSemanticLocator = __twCandidate;
    break;
  }
  __twScope = __twScope.locator("..");
}
if (!__twSemanticLocator) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:-1:0");
${strategyProbe}`;
  }
  if (target?.kind === "role" && typeof target.role === "string" && typeof target.name === "string") {
    return `
const __twSemanticLocator = __twTab.playwright.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true });
${strategyProbe}`;
  }
  if (
    target?.kind === "placeholder"
    && typeof target.role === "string"
    && typeof target.placeholder === "string"
    && target.placeholder
  ) {
    return `
const __twPlaceholderRoleLocator = __twTab.playwright.getByRole(${JSON.stringify(target.role)}).filter({ visible: true });
const __twPlaceholderRoleCandidates = await __twPlaceholderRoleLocator.all();
const __twPlaceholderSemanticMatches = [];
for (const __twCandidate of __twPlaceholderRoleCandidates) {
  const __twPlaceholderBinding = await __twCandidate.evaluate((element, expectedPlaceholder) => {
    const directPlaceholder = typeof element?.getAttribute === "function" ? element.getAttribute("placeholder") : null;
    const directAriaPlaceholder = typeof element?.getAttribute === "function" ? element.getAttribute("aria-placeholder") : null;
    const isVisible = (candidate) => {
      if (!(candidate instanceof Element)) return false;
      const style = window.getComputedStyle(candidate);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= 0.01) return false;
      return Array.from(candidate.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
    };
    let descendantPlaceholderMatches = 0;
    if (typeof element?.querySelectorAll === "function") {
      const descendants = element.querySelectorAll('input, textarea, [contenteditable]');
      for (const descendant of descendants) {
        if (!isVisible(descendant)) continue;
        if (descendant.getAttribute("placeholder") === expectedPlaceholder
          || descendant.getAttribute("aria-placeholder") === expectedPlaceholder) descendantPlaceholderMatches += 1;
      }
    }
    return {
      direct: directPlaceholder === expectedPlaceholder || directAriaPlaceholder === expectedPlaceholder,
      descendantPlaceholderMatches,
    };
  }, ${JSON.stringify(target.placeholder)});
  if (__twPlaceholderBinding?.descendantPlaceholderMatches > 1) {
    throw new Error("TOOLWIRE_BROWSER_FILL_PLACEHOLDER_DESCENDANT_COUNT:" + __twPlaceholderBinding.descendantPlaceholderMatches);
  }
  if (__twPlaceholderBinding?.direct === true || __twPlaceholderBinding?.descendantPlaceholderMatches === 1) {
    __twPlaceholderSemanticMatches.push(__twCandidate);
  }
}
if (__twPlaceholderSemanticMatches.length === 0 && ${JSON.stringify(target.role)} === "textbox") {
  const __twNativePasswordInputs = __twTab.playwright.locator('input');
  const __twNativePasswordLocators = await __twNativePasswordInputs.all();
  const __twNativePasswordCandidates = [];
  for (const __twCandidate of __twNativePasswordLocators) {
    if (!(await __twCandidate.isVisible())) continue;
    if (!(await __twCandidate.isEnabled())) continue;
    const __twPasswordBinding = await __twCandidate.evaluate((element, expectedPlaceholder) => ({
      tag: String(element?.tagName || "").toLowerCase(),
      type: String(element?.type ?? (typeof element?.getAttribute === "function" ? element.getAttribute("type") : null) ?? "text").trim().toLowerCase(),
      placeholder: typeof element?.getAttribute === "function" ? element.getAttribute("placeholder") : null,
      expectedPlaceholder,
    }), ${JSON.stringify(target.placeholder)});
    if (__twPasswordBinding?.tag === "input"
      && __twPasswordBinding?.type === "password"
      && __twPasswordBinding?.placeholder === __twPasswordBinding?.expectedPlaceholder) {
      __twNativePasswordCandidates.push(__twCandidate);
    }
  }
  if (__twNativePasswordCandidates.length > 0) {
    __twPlaceholderSemanticMatches.push(...__twNativePasswordCandidates);
  }
}
if (__twPlaceholderSemanticMatches.length !== 1) {
  throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twPlaceholderSemanticMatches.length);
}
const __twSemanticLocator = __twPlaceholderSemanticMatches[0];
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
  if (
    result?.resolvedKind === "stable-element-id"
    && clickBinding?.kind === "stable-element-id"
    && Number.isInteger(clickBinding.depth)
    && clickBinding.depth >= 0
    && clickBinding.depth <= 6
    && clickBinding.tagName === "a"
    && typeof clickBinding.id === "string"
    && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(clickBinding.id)
    && clickBinding.role === null
    && clickBinding.href === null
    && (clickBinding.ariaDisabled === null || clickBinding.ariaDisabled === "false")
  ) {
    return {
      kind: "stable-element-id",
      tagName: "a",
      id: clickBinding.id,
      role: null,
      href: null,
      ariaDisabled: clickBinding.ariaDisabled,
    };
  }
  throw new BrowserPreviewError(
    "BROWSER_TEXT_TARGET_NOT_SEMANTICALLY_CLICKABLE",
    "The exact visible text did not resolve to one stable semantic click target",
    ["Use an exact role/name target, or handle this action manually until the page exposes one stable link/button/menuitem, bounded onclick-property ancestor, server-recognized data binding, or a unique server-observed stable-id custom anchor that can be fingerprinted and revalidated before execution."]
  );
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function browserCleanupReceipt(value) {
  const cleanupStatus = value?.cleanupStatus === "released"
    ? "released"
    : value?.cleanupStatus === "deferred"
      ? "deferred"
      : value?.cleanupStatus === "unavailable"
        ? "unavailable"
        : "uncertain";
  return {
    cleanupStatus,
    cleanupReason: stringOrNull(value?.cleanupReason) ?? (cleanupStatus === "uncertain" ? "cleanup-receipt-missing" : null),
    cleanupError: stringOrNull(value?.cleanupError),
  };
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

function browserElementBindingError(error) {
  if (error instanceof BrowserPreviewError) return error;
  const code = error instanceof Error ? error.message : String(error);
  if (code === "BROWSER_ELEMENT_REF_UNKNOWN" || code === "BROWSER_ELEMENT_REF_EXPIRED") {
    return new BrowserPreviewError(
      code,
      "The opaque Browser element reference is unknown or expired.",
      ["Run fresh opaque element discovery on the current tab and prepare a new action; do not substitute a raw node id/selector/index/coordinate."]
    );
  }
  if (code === "BROWSER_ELEMENT_STALE" || code === "BROWSER_ELEMENT_TARGET_CHANGED") {
    return new BrowserPreviewError(
      code,
      code === "BROWSER_ELEMENT_STALE"
        ? "The opaque Browser element is no longer present in the fresh stock visible DOM."
        : "The opaque Browser element no longer matches the exact tab/page/generation/fingerprint binding.",
      ["Rediscover elements from the current tab and prepare a fresh action only if the intended target is still needed."]
    );
  }
  if (code === "BROWSER_ELEMENT_ACTION_UNSUPPORTED") {
    return new BrowserPreviewError(
      code,
      "This user-semantic action is not in the current opaque-element allowlist.",
      ["Use only the currently reviewed click/double_click slice; do not widen to raw selectors, node ids, coordinates, indexes, JavaScript, or CDP."]
    );
  }
  return new BrowserPreviewError("BROWSER_ELEMENT_BINDING_INVALID", `Opaque Browser element binding failed: ${code}`);
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

function chromeBackendAmbiguous(backends, chromeBackends) {
  return {
    status: "unavailable",
    reason: "BROWSER_CHROME_BACKEND_AMBIGUOUS",
    error: `The Codex Browser runtime reports ${chromeBackends.length} Chrome-family backends, but the current upstream API exposes only browsers.get(\"chrome\") and no profile/backend selector.`,
    chromeSkill: "ok",
    nodeRepl: "ok",
    connectedBrowsers: backends.map(sanitizeBackend),
    nextActions: [
      "Keep exactly one intended Chrome Browser backend active, then call codex.browser_status again.",
      "Do not guess a Chrome profile or backend index; the current upstream Browser API does not expose a supported selector for it.",
    ],
  };
}

function browserMutationResultUncertain(kind, message) {
  const normalizedKind = ["fill", "navigate", "open_tab", "close_tab", "bulk_close_tab", "scroll", "keypress", "download", "upload", "model_route_probe", "webmcp_call"].includes(kind) ? kind : "click";
  const errorCode = normalizedKind === "model_route_probe"
    ? "BROWSER_MODEL_ROUTE_PROBE_RESULT_UNCERTAIN"
    : normalizedKind === "fill"
    ? "BROWSER_FILL_RESULT_UNCERTAIN"
    : normalizedKind === "navigate"
      ? "BROWSER_NAVIGATE_RESULT_UNCERTAIN"
      : normalizedKind === "open_tab"
        ? "BROWSER_OPEN_TAB_RESULT_UNCERTAIN"
        : normalizedKind === "close_tab"
          ? "BROWSER_CLOSE_RESULT_UNCERTAIN"
          : normalizedKind === "bulk_close_tab"
            ? "BROWSER_BULK_CLOSE_RESULT_UNCERTAIN"
            : normalizedKind === "scroll"
            ? "BROWSER_SCROLL_RESULT_UNCERTAIN"
            : normalizedKind === "keypress"
              ? "BROWSER_KEYPRESS_RESULT_UNCERTAIN"
              : normalizedKind === "download"
                ? "BROWSER_DOWNLOAD_RESULT_UNCERTAIN"
                : normalizedKind === "upload"
                  ? "BROWSER_UPLOAD_RESULT_UNCERTAIN"
                  : normalizedKind === "webmcp_call"
                    ? "BROWSER_WEBMCP_CALL_RESULT_UNCERTAIN"
                    : "BROWSER_CLICK_RESULT_UNCERTAIN";
  return new BrowserPreviewError(
    errorCode,
    message,
    [
      `Do not retry this ${normalizedKind} automatically. The remote action may already have happened even though its MCP response was lost or unreadable.`,
      normalizedKind === "close_tab"
        ? "Call codex.browser_tabs to inspect current tab state. Do not close again automatically; prepare a fresh close only if the exact intended tab is still present and still needs closing."
        : normalizedKind === "bulk_close_tab"
          ? "Call codex.browser_tabs to inspect the exact prepared set. Treat the stopped target as possibly closed, do not retry it automatically, and prepare a new exact set only after current state is known."
          : normalizedKind === "scroll"
          ? "Re-read current tab/page state first, then scroll again only if more loaded content is still needed."
          : normalizedKind === "keypress"
            ? "Re-read current tab/page state first. Press the key again only if the intended effect is clearly still needed; never blindly repeat Enter/Tab/Escape."
            : normalizedKind === "download"
              ? "Do not start another download automatically. Inspect the browser's download location or current task state first because the file may already have been created."
              : normalizedKind === "upload"
                ? "Do not re-select the file automatically. The webpage may already have received the file selection/change event or started an upload; inspect page state first."
                : normalizedKind === "model_route_probe"
                  ? "Do not submit another probe message automatically. Inspect the selected Web chat and start a fresh independent probe only if another sample is still needed."
                  : normalizedKind === "webmcp_call"
                    ? "Do not call the page-defined tool again automatically. Read the bound tab/page and task state first because the WebMCP tool may already have completed its side effect."
                    : `Re-read current tab/page state first, then prepare a fresh ${normalizedKind} only if the intended action is still needed.`,

    ]
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
  if (/TOOLWIRE_BROWSER_ELEMENT_VISIBLE_DOM_INVALID/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ELEMENT_VISIBLE_DOM_INVALID",
      "The maintained stock Browser visible-DOM primitive returned an unexpected shape before opaque-element dispatch.",
      ["Treat this as Browser runtime compatibility drift; do not expose or substitute raw node ids/selectors/coordinates."]
    );
  }
  if (/TOOLWIRE_BROWSER_ELEMENT_STALE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ELEMENT_STALE",
      "The prepared opaque Browser element is stale or missing in the fresh visible DOM.",
      ["Rediscover opaque elements and prepare a new exact action only if the target is still needed."]
    );
  }
  if (/TOOLWIRE_BROWSER_ELEMENT_TARGET_CHANGED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ELEMENT_TARGET_CHANGED",
      "The prepared opaque Browser element changed page identity or semantic fingerprint before dispatch.",
      ["Rediscover opaque elements from current page state; do not replay the old action or substitute raw internals."]
    );
  }
  if (/TOOLWIRE_BROWSER_ELEMENT_ACTION_UNSUPPORTED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ELEMENT_ACTION_UNSUPPORTED",
      "The prepared opaque Browser action is outside the reviewed click/double_click slice.",
      ["Do not widen the caller surface to raw node ids, selectors, coordinates, indexes, JavaScript, or CDP."]
    );
  }
  if (/TOOLWIRE_BROWSER_WEBMCP_CALL_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_WEBMCP_CALL_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_WEBMCP_CALL_RESULT_UNCERTAIN:/, "WebMCP tool-call result is uncertain: "),
      ["Do not call the page-defined tool again automatically. Read the bound tab/page and task state first because the WebMCP tool may already have completed its side effect."]
    );
  }
  if (/TOOLWIRE_BROWSER_WEBMCP_HANDLE_STALE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_WEBMCP_REF_STALE",
      "The stock WebMCP tool handle is stale or no longer bound to this document",
      ["Rediscover WebMCP tools from the current tab, then call a currently listed tool only if the task still needs it. Do not replay the prior call automatically."]
    );
  }
  if (/TOOLWIRE_BROWSER_WEBMCP_PAGE_CHANGED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_WEBMCP_PAGE_CHANGED",
      "The bound Browser tab changed page before the WebMCP tool call could be dispatched",
      ["Read the current tab, rediscover WebMCP tools for the current page if appropriate, and do not replay the old handle automatically."]
    );
  }
  if (/TOOLWIRE_BROWSER_WEBMCP_TOOL_NOT_LISTED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_WEBMCP_TOOL_NOT_LISTED",
      "The requested tool name is not listed by this fetched stock WebMCP handle",
      ["Use exactly one tool name shown in the existing WebMCP description. Do not refetch merely to guess another name."]
    );
  }
  if (/TOOLWIRE_BROWSER_WEBMCP_DESCRIPTOR_TOO_LARGE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_WEBMCP_DESCRIPTOR_TOO_LARGE",
      "The stock WebMCP tool description is too large for the bounded remote projection",
      ["Use the existing DOM Browser path for this page instead of widening the WebMCP projection limit automatically."]
    );
  }
  if (/TOOLWIRE_BROWSER_WEBMCP_URL_UNAVAILABLE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_WEBMCP_URL_UNAVAILABLE",
      "The current tab did not expose a stable URL, so Codexless refused to bind a reusable WebMCP handle",
      ["Refresh browser_tabs after the page has a stable URL, or use the existing DOM Browser path."]
    );
  }
  if (/TOOLWIRE_BROWSER_WEBMCP_PROTOCOL_ERROR/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_WEBMCP_PROTOCOL_ERROR",
      "The stock Browser WebMCP capability returned an unexpected shape",
      ["Treat this as Browser runtime compatibility drift; do not implement a second WebMCP protocol stack."]
    );
  }
  if (/TOOLWIRE_BROWSER_EXISTING_TAB_RELEASE_UNAVAILABLE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_EXISTING_TAB_RELEASE_UNAVAILABLE",
      "The current Browser API shape does not expose an existing-tab release operation that Codexless can prove it can complete safely; existing-tab actions remain available, but cleanup cannot be reported as released without proof.",
      [
        "Use the cleanup receipt from the action: finalize-absent turn cleanup is deferred to the maintained turn boundary (turn-boundary-auto-release), not released in the same turn.",
        "If a later claim reports that the tab is already part of a Browser session, refresh tab state once and do not automatically replay any mutation; use a fresh tab when that safely fits the task.",
      ],
      { lifecycleShape: message.split(":").at(-1) ?? null }
    );
  }
  if (/TOOLWIRE_BROWSER_BULK_CLOSE_TAB_STALE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_BULK_CLOSE_TAB_STALE",
      "One tab in the prepared bulk-close set is no longer present under the same server-bound provider identity",
      ["Stop the consumed bulk-close action. Refresh browser_tabs and prepare a new exact set only for tabs that still need closing."]
    );
  }
  if (/TOOLWIRE_BROWSER_BULK_CLOSE_URL_UNAVAILABLE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_BULK_CLOSE_URL_UNAVAILABLE",
      "One tab in the bulk-close set did not expose a current URL, so Codexless refused to bind or close it",
      ["Refresh browser_tabs after the tab has a stable URL and prepare a new exact set; do not substitute a title/index/provider id."]
    );
  }
  if (/TOOLWIRE_BROWSER_BULK_CLOSE_URL_CHANGED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_BULK_CLOSE_TARGET_CHANGED",
      "One tab in the prepared bulk-close set changed URL before its close dispatch, so the exact-set action stopped before closing that target",
      ["Refresh browser_tabs and prepare a new exact set from current URLs. Do not continue the consumed bulk-close action."]
    );
  }
  if (/TOOLWIRE_BROWSER_BULK_CLOSE_PREDISPATCH_RELEASE_UNPROVEN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_BULK_CLOSE_PREDISPATCH_RELEASE_UNPROVEN",
      "Bulk close stopped before dispatch because a claimed target could not be proven released after a pre-dispatch failure",
      ["Use the explicit Browser emergency control-state reset if this runtime now needs claim recovery, then refresh browser_tabs. Do not retry the consumed bulk-close action automatically."]
    );
  }
  if (/TOOLWIRE_BROWSER_BULK_CLOSE_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_BULK_CLOSE_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_BULK_CLOSE_RESULT_UNCERTAIN:/, "Bulk tab-close result is uncertain: "),
      ["Stop immediately. Treat the current target as possibly closed, refresh browser_tabs, and never auto-retry the consumed exact-set action."]
    );
  }
  const tabBusy = /\bTab\s+.+?\s+is already part of browser session\s+\S+/i.test(message)
    || /\btab\b.*\balready (?:claimed|attached|owned) by (?:another )?browser session\b/i.test(message);
  if (tabBusy) {
    return new BrowserPreviewError(
      "BROWSER_TAB_BUSY",
      "The Chrome tab is visible, but this Browser call cannot claim it because it is already part of a Browser session.",
      [
        "Call codex.browser_tabs once to refresh the current visible-tab state. This refresh does not force or prove release of an existing claim.",
        "On finalize-absent Browser shapes, Codexless synthetic calls cannot prove the real turn-end cleanup that releases claimed user tabs; use a different/fresh tab if the task can safely continue there.",
        "Do not automatically replay click, fill, navigate, keypress, scroll, download, upload, or close. Re-read current state first and prepare a fresh mutation only if the intended effect is still clearly needed.",
      ],
      { claimStatus: "busy", recovery: "bounded-no-automatic-mutation-replay" }
    );
  }
  const protocolMismatch = /\bbrowser (?:extension |client |service )?protocol (?:version )?(?:mismatch|incompatible)\b/i.test(message)
    || /\bunsupported browser protocol version\b/i.test(message);
  if (protocolMismatch) {
    return new BrowserPreviewError(
      "BROWSER_RUNTIME_PROTOCOL_MISMATCH",
      message,
      [
        "Restart/update the Codex Browser runtime and Chrome extension as one matched bundle, then call codex.browser_status again.",
        "This is a protocol compatibility failure, not evidence that Chrome is merely disconnected.",
      ]
    );
  }
  const extensionPolicyBlocked = /\bextension(?:install)?blocklist\b/i.test(message)
    || /\b(?:chrome )?extension\b.*\bblocked by (?:the )?(?:administrator|enterprise|organization)\b/i.test(message)
    || /\bnative messaging host\b.*\b(?:forbidden|blocked|not allowed)\b/i.test(message);
  if (extensionPolicyBlocked) {
    return new BrowserPreviewError(
      "BROWSER_EXTENSION_POLICY_BLOCKED",
      message,
      ["Ask the machine or browser administrator to allow the supported Codex Chrome extension/native-messaging policy. Codexless will not bypass enterprise policy."],
      { source: "enterprise-extension-policy" }
    );
  }
  const executionPolicyBlocked = /\bAppLocker\b/i.test(message)
    || /\bWindows Defender Application Control\b|\bWDAC\b/i.test(message)
    || /\b(?:app|program|executable)\b.*\bblocked by (?:group policy|your system administrator)\b/i.test(message)
    || /\bERROR_ACCESS_DISABLED_BY_POLICY\b/i.test(message);
  if (executionPolicyBlocked) {
    return new BrowserPreviewError(
      "BROWSER_ENTERPRISE_EXECUTION_POLICY_BLOCKED",
      message,
      ["Ask the machine administrator to allow the signed Codex Browser/node_repl runtime. Codexless will not disable or bypass AppLocker, WDAC, or Group Policy."],
      { source: "enterprise-execution-policy" }
    );
  }
  if (/\bERR_BLOCKED_BY_ADMINISTRATOR\b/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ENTERPRISE_NETWORK_POLICY_BLOCKED",
      message,
      ["Use a destination allowed by the managed browser/network policy, or ask the administrator to change that policy. Reinstalling the extension is not an appropriate fix."],
      { source: "managed-browser-network-policy" }
    );
  }
  if (/TOOLWIRE_BROWSER_MODEL_ROUTE_HOST_DENIED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_MODEL_ROUTE_HOST_DENIED",
      "Model-route probing is restricted to https://chatgpt.com.",
      ["Use a user-selected ChatGPT Web chat tab; this probe never widens Full CDP to another origin."]
    );
  }
  if (/TOOLWIRE_BROWSER_MODEL_ROUTE_LOGIN_OR_PAGE_NOT_READY/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_MODEL_ROUTE_LOGIN_OR_PAGE_NOT_READY",
      "The selected ChatGPT Web chat did not expose a usable chat editor. A missing ChatGPT login state or an unready/redirected page is the usual prerequisite blocker.",
      [
        "Read the current tab once. If ChatGPT shows Sign in / Log in, sign in once in this Chrome profile, then retry with a user-selected Web chat.",
        "If already signed in, wait for or reopen the selected Web chat after the page is fully ready; do not broaden the probe to arbitrary selectors or coordinates.",
      ]
    );
  }
  if (/TOOLWIRE_BROWSER_MODEL_ROUTE_CHAT_SURFACE_REQUIRED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_MODEL_ROUTE_CHAT_SURFACE_REQUIRED",
      "Model-route probing requires a user-selected ChatGPT Web chat surface.",
      ["Use the current/opened ChatGPT Web conversation, or open a new chat in the user-chosen Temporary/normal and project/non-project context, refresh codex.browser_tabs, then retry with that tabRef."]
    );
  }
  if (/TOOLWIRE_BROWSER_MODEL_ROUTE_CDP_UNAVAILABLE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_MODEL_ROUTE_CDP_UNAVAILABLE",
      "The current claimed ChatGPT tab does not expose the bounded CDP capability required by the model-route probe.",
      ["Refresh the current Browser runtime/configuration and confirm Full CDP is enabled only for https://chatgpt.com, then retry on a user-selected ChatGPT Web chat tab."]
    );
  }
  if (/TOOLWIRE_BROWSER_MODEL_ROUTE_EDITOR_NOT_UNIQUE/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_MODEL_ROUTE_EDITOR_NOT_UNIQUE",
      "The selected ChatGPT Web chat did not expose exactly one visible enabled chat textbox, so the probe refused to guess a target.",
      ["Use a clean, fully loaded ChatGPT Web chat and retry; do not broaden the probe to arbitrary selectors or coordinates."]
    );
  }
  if (/TOOLWIRE_BROWSER_MODEL_ROUTE_EDITOR_NOT_EMPTY/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_MODEL_ROUTE_EDITOR_NOT_EMPTY",
      "The selected ChatGPT Web chat editor already contained text, so the probe refused to overwrite it.",
      ["Clear or send the user's existing draft first, or choose another empty Web chat before probing; do not overwrite user text."]
    );
  }
  if (/TOOLWIRE_BROWSER_MODEL_ROUTE_EDITOR_FILL_FAILED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_MODEL_ROUTE_EDITOR_FILL_FAILED",
      "The fixed non-sensitive route-probe text could not be verified in the selected Web chat editor before submission.",
      ["Refresh Browser compatibility and retry only on a clean empty user-selected Web chat; do not submit blindly."]
    );
  }
  if (/TOOLWIRE_BROWSER_MODEL_ROUTE_PROBE_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_MODEL_ROUTE_PROBE_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_MODEL_ROUTE_PROBE_RESULT_UNCERTAIN:/, "Model-route probe result is uncertain after the fixed message may have been submitted: "),
      ["Do not automatically retry on the same logical probe. Re-read/close the probe tab and start a fresh explicit probe only if another sample is still needed."]
    );
  }
  if (/TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_NAVIGATE_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN:/, "Browser navigation result is uncertain: "),
      ["Do not retry this navigation automatically. Re-read current tab/page state first, then prepare a fresh navigation only if the intended destination is still needed."]
    );
  }
  if (/TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_OPEN_TAB_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN:/, "Browser new-tab result is uncertain: "),
      ["Do not open another tab automatically. Call codex.browser_tabs first and inspect whether the requested URL is already open before preparing a fresh new-tab action."]
    );
  }
  if (/TOOLWIRE_BROWSER_CLOSE_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_CLOSE_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_CLOSE_RESULT_UNCERTAIN:/, "Browser tab-close result is uncertain: "),
      ["Do not close again automatically. Call codex.browser_tabs to inspect current tab state, then prepare a fresh close only if the exact intended tab is still present and still needs closing."]
    );
  }
  if (/TOOLWIRE_BROWSER_SCROLL_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_SCROLL_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_SCROLL_RESULT_UNCERTAIN:/, "Browser scroll result is uncertain: "),
      ["Re-read the current tab first. Scroll again only if more loaded content is still needed; do not blindly repeat the previous scroll."]
    );
  }
  if (/TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_KEYPRESS_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN:/, "Browser keypress result is uncertain: "),
      ["Do not retry Enter/Tab/Escape automatically. Re-read the current tab/page state first, then press again only if the intended effect is clearly still needed."]
    );
  }
  if (/TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_UPLOAD_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN:/, "Browser upload result is uncertain: "),
      [
        "Do not retry this upload automatically. The webpage may already have received the file selection/change event or started an upload; inspect current page state first.",
        "If Chromium file-chooser integration is unavailable, Google Chrome requires enabling 'Allow access to file URLs' for the ChatGPT browser extension before retrying a fresh, user-authorized upload.",
      ]
    );
  }
  if (/TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_DOWNLOAD_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN:/, "Browser download result is uncertain: "),
      ["Do not retry this download automatically. The target click may already have created a file in the browser's configured download location; inspect current state first."]
    );
  }
  if (/TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_CLICK_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:/, "Browser click result is uncertain: "),
      ["Do not retry this click automatically. Re-read current tab/page state first, then prepare a fresh click only if the intended action is still needed."]
    );
  }
  if (/TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_FILL_RESULT_UNCERTAIN",
      message.replace(/^.*TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN:/, "Browser fill result is uncertain: "),
      ["Do not retry this fill automatically. Re-read current tab/page state first, then prepare a fresh fill only if the intended text is still needed."]
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
  if (/TOOLWIRE_BROWSER_FILL_TARGET_CHANGED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ACTION_TARGET_CHANGED",
      "The prepared Browser fill target still had to satisfy the original semantic binding, but its bounded editable resolution changed before dispatch",
      ["Re-read the current page and prepare a fresh fill from the current exact role/name or role/placeholder target."]
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
      `The exact visible text resolved to ${match?.[1] ?? "an unexpected number of"} stable semantic click targets; the Browser runtime requires exactly one link, button, menuitem, bounded onclick-property ancestor, or server-recognized data binding`,
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
  if (/TOOLWIRE_BROWSER_FILL_EDITABLE_NOT_ENABLED/i.test(message)) {
    return new BrowserPreviewError(
      "BROWSER_ACTION_TARGET_NOT_ENABLED",
      "The exact Browser textbox/searchbox resolved to an editable node that is not currently enabled",
      ["Read current page state and prepare again only when the same semantic target exposes one enabled editable node."]
    );
  }
  if (/TOOLWIRE_BROWSER_FILL_PLACEHOLDER_DESCENDANT_COUNT:(\d+)/i.test(message)) {
    const match = message.match(/TOOLWIRE_BROWSER_FILL_PLACEHOLDER_DESCENDANT_COUNT:(\d+)/i);
    return new BrowserPreviewError(
      "BROWSER_ACTION_TARGET_AMBIGUOUS",
      `The exact role/placeholder Browser target contained ${match?.[1] ?? "multiple"} visible placeholder-matching editable descendants; the Browser runtime refuses to guess`,
      ["Re-read the current page and use the target only when the exact role/placeholder binding resolves to one semantic textbox with one editable node."]
    );
  }
  if (/TOOLWIRE_BROWSER_FILL_EDITABLE_COUNT:(\d+)/i.test(message)) {
    const match = message.match(/TOOLWIRE_BROWSER_FILL_EDITABLE_COUNT:(\d+)/i);
    const count = Number(match?.[1] ?? 0);
    return new BrowserPreviewError(
      count === 0 ? "BROWSER_FILL_TARGET_NOT_EDITABLE" : "BROWSER_ACTION_TARGET_AMBIGUOUS",
      count === 0
        ? "The exact Browser textbox/searchbox did not expose a supported writable input, textarea, contenteditable, or the existing direct semantic-shell fill path"
        : `The exact Browser textbox/searchbox contained ${count} visible supported editable descendants; the Browser runtime refuses to guess`,
      ["Re-read the current page and prepare again only when the same exact semantic target resolves to one bounded editable node."]
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
  const chromeDisconnected = /\bchrome extension (?:is |was )?(?:not connected|disconnected)\b/i.test(message)
    || /\bchrome (?:browser|backend) (?:is |was )?(?:not connected|disconnected)\b/i.test(message)
    || /\bno connected chrome (?:extension|browser|backend)\b/i.test(message)
    || /\bno chrome (?:extension|browser|backend) (?:is )?connected\b/i.test(message);
  if (chromeDisconnected) {
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
