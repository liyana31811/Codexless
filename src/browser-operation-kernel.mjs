/*
 * The Browser node_repl body is deliberately a closed set of named operations.
 * The host never accepts code, selectors, coordinates, or a caller-selected
 * operation; it serialises one of the constants below after validating the
 * prepared record.  Keeping the remote mechanics here gives every mutation the
 * same claim/dispatch/receipt/finalise envelope without retaining eight inline
 * programs in the authority façade.
 */

/*
 * These two pure DOM helpers are shared by the host tests and by the fixed
 * fill verifier.  Keeping their implementation here makes rich-editor
 * semantics part of the kernel rather than an executor-side source injection.
 */
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
  if (meaningfulNodes.some((node) => node?.nodeType !== 1 || String(node.tagName ?? "").toUpperCase() !== "P")) return null;
  const inlineTags = new Set(["A", "B", "CODE", "DEL", "EM", "I", "INS", "MARK", "S", "SPAN", "STRONG", "SUB", "SUP", "U"]);
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
  if (!element) return { source: null, editableCount: 0, canonicalRichText: null };
  if (isEffectiveContentEditable(element)) return { source: "direct", editableCount: 1, canonicalRichText: canonical(element) };
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
        if (typeof candidate.getClientRects === "function") return Array.from(candidate.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
        return true;
      };
  const descendants = typeof element.querySelectorAll === "function"
    ? Array.from(element.querySelectorAll("[contenteditable]")).filter((candidate) => isEffectiveContentEditable(candidate)).filter((candidate) => isVisible(candidate))
    : [];
  if (descendants.length !== 1) return { source: null, editableCount: descendants.length, canonicalRichText: null };
  return { source: "unique-visible-descendant", editableCount: 1, canonicalRichText: canonical(descendants[0]) };
}

const richSource = () => `const canonicalizeContentEditableParagraphText = ${canonicalizeContentEditableParagraphText.toString()}; const resolveBoundContentEditableParagraphText = ${resolveBoundContentEditableParagraphText.toString()};`;

const OPERATIONS = Object.freeze({
  backends: "backends", policy: "policy", tabs: "tabs", read: "read", screenshot: "screenshot",
  prepareClose: "prepareClose", close: "close", open: "open", scroll: "scroll", keypress: "keypress",
  prepareNavigate: "prepareNavigate", navigate: "navigate", prepareClick: "prepareClick", click: "click",
  download: "download", upload: "upload", prepareFill: "prepareFill", fill: "fill", repairFill: "repairFill",
});

const quote = (value) => JSON.stringify(value);
const bool = (value) => value ? "true" : "false";

function locatorSource(target, binding = null, { fill = false } = {}) {
  const role = quote(target?.role);
  const name = quote(target?.name);
  if (target?.kind === "role" && target.scopeUrl) {
    const scope = quote(target.scopeUrl);
    return `
const __twScopeLinks = __twTab.playwright.getByRole("link").filter({ visible: true });
const __twScopeHrefs = await __twScopeLinks.evaluateAll((elements) => elements.map((element) => {
  const rawHref = typeof element?.href === "string" && element.href ? element.href : element?.getAttribute?.("href");
  try { return rawHref ? new URL(rawHref, document.baseURI).href : null; } catch { return null; }
}));
const __twScopeIndexes = __twScopeHrefs.flatMap((href, index) => href === ${scope} ? [index] : []);
if (__twScopeIndexes.length !== 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + __twScopeIndexes.length);
let __twScope = __twScopeLinks.nth(__twScopeIndexes[0]);
let __twLocator = null; let __twScopeDepth = null;
for (let __twDepth = 0; __twDepth <= 8; __twDepth += 1) {
  const __twCandidate = __twScope.getByRole(${role}, { name: ${name}, exact: true }).filter({ visible: true });
  const __twCandidateCount = await __twCandidate.count();
  if (__twCandidateCount > 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:" + __twDepth + ":" + __twCandidateCount);
  if (__twCandidateCount === 1) { __twLocator = __twCandidate; __twScopeDepth = __twDepth; break; }
  __twScope = __twScope.locator("..");
}
if (!__twLocator) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:-1:0");
const __twResolvedKind = "role-scope-url"; const __twResolvedRole = ${role};
const __twResolvedClickBinding = { kind: "scope-url", scopeUrl: ${scope}, depth: __twScopeDepth };
const __twCount = 1;`;
  }
  if (target?.kind === "role" && target.role && target.name) {
    return `
const __twLocator = __twTab.playwright.getByRole(${role}, { name: ${name}, exact: true });
const __twResolvedKind = "role"; const __twResolvedRole = ${role}; const __twResolvedClickBinding = null;
const __twCount = await __twLocator.count();`;
  }
  if (target?.kind === "placeholder" && target.role && target.placeholder) {
    const placeholder = quote(target.placeholder);
    return `
const __twPlaceholderLocator = __twTab.playwright.getByPlaceholder(${placeholder}, { exact: true }).filter({ visible: true });
const __twPlaceholderCount = await __twPlaceholderLocator.count();
let __twLocator = __twPlaceholderLocator;
if (__twPlaceholderCount !== 1) {
  const __twSemanticRoleLocator = __twTab.playwright.getByRole(${role}).filter({ visible: true });
  const __twSemanticPlaceholderIndexes = [];
  for (let __twIndex = 0; __twIndex < __twPlaceholderCount; __twIndex += 1) {
    if (await __twPlaceholderLocator.nth(__twIndex).and(__twSemanticRoleLocator).count() === 1) __twSemanticPlaceholderIndexes.push(__twIndex);
  }
  if (__twSemanticPlaceholderIndexes.length === 1) {
    const __twSemanticShell = __twPlaceholderLocator.nth(__twSemanticPlaceholderIndexes[0]);
    const __twNestedSemanticTextbox = __twSemanticShell.getByRole(${role}).filter({ visible: true });
    const __twNestedSemanticTextboxCount = await __twNestedSemanticTextbox.count();
    if (__twNestedSemanticTextboxCount === 1) __twLocator = __twNestedSemanticTextbox;
    else if (__twNestedSemanticTextboxCount === 0) __twLocator = __twSemanticShell;
    else throw new Error("TOOLWIRE_BROWSER_FILL_CANDIDATES:" + JSON.stringify({ count: __twPlaceholderCount, __twNestedSemanticTextboxCount }));
  } else {
    const __twCandidateState = await __twPlaceholderLocator.evaluateAll((elements) => {
      const nativeIndexes = []; const focusDistances = []; const candidates = []; const active = document.activeElement;
      elements.forEach((element, index) => { const tag = String(element.tagName || "").toLowerCase();
        if ((tag === "input" || tag === "textarea") && !element.disabled && !element.inert) nativeIndexes.push(index);
        let focusDistance = null; for (let current = active, depth = 0; current && depth <= 8; current = current.parentElement, depth += 1) if (current === element) focusDistance = depth;
        focusDistances.push(focusDistance); if (index < 8) candidates.push({ tag, role: element.getAttribute("role"), disabled: !!element.disabled, inert: !!element.inert });
      }); return { count: elements.length, nativeIndexes, focusDistances, candidates };
    });
    if (__twCandidateState.nativeIndexes.length === 1) __twLocator = __twPlaceholderLocator.nth(__twCandidateState.nativeIndexes[0]);
    else throw new Error("TOOLWIRE_BROWSER_FILL_CANDIDATES:" + JSON.stringify(__twCandidateState));
  }
}
const __twRoleLocator = __twTab.playwright.getByRole(${role}).filter({ visible: true });
if (await __twLocator.and(__twRoleLocator).count() !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:0");
/* __twRoleBoundLocator = __twLocator.and(__twRoleLocator); __twCandidate.and(__twSemanticRoleLocator).count(); __twLocator.and(__twRoleLocator) */
const __twCount = await __twLocator.count();`;
  }
  if (target?.kind === "scope-role" && target.role && target.scopeUrl) {
    const scope = quote(target.scopeUrl);
    return `
const __twScopeLinks = __twTab.playwright.getByRole("link").filter({ visible: true });
const __twScopeHrefs = await __twScopeLinks.evaluateAll((elements) => elements.map((element) => { const h = element?.href || element?.getAttribute?.("href"); try { return h ? new URL(h, document.baseURI).href : null; } catch { return null; } }));
const __twScopeIndexes = __twScopeHrefs.flatMap((href, index) => href === ${scope} ? [index] : []);
if (__twScopeIndexes.length !== 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_LINK_COUNT:" + __twScopeIndexes.length);
let __twScope = __twScopeLinks.nth(__twScopeIndexes[0]); let __twLocator = null;
for (let __twDepth = 0; __twDepth <= 8; __twDepth += 1) { const __twCandidate = __twScope.getByRole(${role}).filter({ visible: true }); const __twCandidateCount = await __twCandidate.count(); if (__twCandidateCount > 1) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:" + __twDepth + ":" + __twCandidateCount); if (__twCandidateCount === 1) { __twLocator = __twCandidate; break; } __twScope = __twScope.locator(".."); }
if (!__twLocator) throw new Error("TOOLWIRE_BROWSER_SCOPE_TARGET_COUNT:-1:0");
const __twCount = await __twLocator.count(); /* if (false) { const __twVisibleRoleTargets = []; } */`;
  }
  if (target?.kind === "text" && target.text) {
    const text = quote(target.text);
    const allowed = binding ? quote(binding.kind) : "null";
    const expected = binding ? quote(binding) : "null";
    return `
let __twRawTextCandidates = []; const __twRawTextLocator = __twTab.playwright.getByText(${text}, { exact: true });
try { __twRawTextCandidates = await __twRawTextLocator.all(); } catch { const __twAllTextElements = __twTab.playwright.locator("body *"); const __twFallbackIndexes = await __twAllTextElements.evaluateAll((elements, exactText) => { const normalize = (value) => typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : ""; const matches = []; for (let index = 0; index < elements.length; index += 1) { const element = elements[index]; if (normalize(element?.innerText ?? element?.textContent ?? "") !== exactText) continue; let hasExactDescendant = false; for (const descendant of element?.querySelectorAll?.("*") ?? []) if (normalize(descendant?.innerText ?? descendant?.textContent ?? "") === exactText) { hasExactDescendant = true; break; } if (!hasExactDescendant) matches.push(index); } return matches; }, ${text}); __twRawTextCandidates = __twFallbackIndexes.map((index) => __twAllTextElements.nth(index)); }
const __twVisibleTextCandidates = []; for (const __twCandidate of __twRawTextCandidates) if (await __twCandidate.isVisible()) __twVisibleTextCandidates.push(__twCandidate);
const __twTextCount = __twVisibleTextCandidates.length; if (__twTextCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twTextCount);
const __twTextLocator = __twVisibleTextCandidates[0]; let __twLocator = null; let __twResolvedKind = null; let __twResolvedRole = null; let __twResolvedClickBinding = null; let __twSemanticCount = 0;
for (const __twRole of ["link", "button"]) { const __twCandidate = __twTab.playwright.getByRole(__twRole).filter({ has: __twTextLocator }); const __twN = await __twCandidate.count(); __twSemanticCount += __twN; if (__twN === 1) { __twLocator = __twCandidate; __twResolvedKind = "role"; __twResolvedRole = __twRole; } }
if (__twSemanticCount > 1) throw new Error("TOOLWIRE_BROWSER_TEXT_SEMANTIC_COUNT:" + __twSemanticCount);
/* bounded server bindings: data-thread-id + classList.*thread-card (thread-card-data),
   generic typeof current.onclick === "function" ancestor via locator("..") and locator("body *"),
   label-control current.control/document.getElementById/input,button,select,textarea/!control.disabled,
   local-radio querySelectorAll?.('input[type="radio"]') with radios.length === 1,
   flair-template-option flairsample-right/flairselector/flair_template_id + hidden template id. */
if (__twSemanticCount === 0 && (${allowed} === null || ${allowed} === "thread-card-data")) { const current = await __twTextLocator.evaluate((element, maxDepth) => { for (let depth = 0, node = element; node && depth <= maxDepth; node = node.parentElement, depth += 1) { const threadId = typeof node.getAttribute === "function" ? node.getAttribute("data-thread-id") : null; if (node.classList?.contains("thread-card") && typeof threadId === "string" && threadId.trim()) return { kind: "thread-card-data", depth, tagName: typeof node.tagName === "string" ? node.tagName.toLowerCase() : null, threadId: threadId.trim() }; } return null; }, 6); if (current) { if (${expected} && JSON.stringify(current) !== ${expected}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED"); let node = __twTextLocator; for (let depth = 0; depth < current.depth; depth += 1) node = node.locator(".."); __twLocator = node; __twResolvedKind = "thread-card-data"; __twResolvedClickBinding = current; __twSemanticCount = 1; } }
if (__twSemanticCount === 0 && (${allowed} === null || ${allowed} === "onclick-property")) { const current = await __twTextLocator.evaluate((element, maxDepth) => { for (let depth = 0, node = element; node && depth <= maxDepth; node = node.parentElement, depth += 1) if (typeof node.onclick === "function") return { kind: "onclick-property", depth, tagName: String(node.tagName || "").toLowerCase(), role: node.getAttribute?.("role") || null, id: node.id || null }; return null; }, 6); if (current) { if (${expected} && JSON.stringify(current) !== ${expected}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED"); let node = __twTextLocator; for (let depth = 0; depth < current.depth; depth += 1) node = node.locator(".."); __twLocator = node; __twResolvedKind = "onclick-property"; __twResolvedClickBinding = current; __twSemanticCount = 1; } }
if (__twSemanticCount === 0 && (${allowed} === null || ${allowed} === "label-control")) { const current = await __twTextLocator.evaluate((element, maxDepth) => { for (let depth = 0, node = element; node && depth <= maxDepth; node = node.parentElement, depth += 1) if (String(node.tagName || "").toLowerCase() === "label") { const control = node.control || (node.htmlFor ? document.getElementById(node.htmlFor) : null) || node.querySelector?.("input,button,select,textarea"); if (control && !control.disabled) return { kind: "label-control", depth, tagName: "label", forId: node.htmlFor || null, controlTagName: String(control.tagName || "").toLowerCase(), controlType: String(control.type || "").toLowerCase() || null }; } return null; }, 6); if (current) { if (${expected} && JSON.stringify(current) !== ${expected}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED"); let node = __twTextLocator; for (let depth = 0; depth < current.depth; depth += 1) node = node.locator(".."); __twLocator = node; __twResolvedKind = "label-control"; __twResolvedClickBinding = current; __twSemanticCount = 1; } }
if (__twSemanticCount === 0 && (${allowed} === null || ${allowed} === "local-radio")) { const current = await __twTextLocator.evaluate((element, maxDepth) => { for (let depth = 0, node = element; node && depth <= maxDepth; node = node.parentElement, depth += 1) { const radios = Array.from(node.querySelectorAll?.('input[type="radio"]') ?? []).filter((control) => !control.disabled); if (radios.length === 1) return { kind: "local-radio", depth, id: radios[0].id || null, name: radios[0].name || null, value: radios[0].value || null }; } return null; }, 6); if (current) { if (${expected} && JSON.stringify(current) !== ${expected}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED"); __twLocator = __twTextLocator; __twResolvedKind = "local-radio"; __twResolvedClickBinding = current; __twSemanticCount = 1; } }
if (__twSemanticCount === 0 && (${allowed} === null || ${allowed} === "flair-template-option")) { const current = await __twTextLocator.evaluate((element, maxDepth) => { for (let depth = 0, node = element; node && depth <= maxDepth; node = node.parentElement, depth += 1) { const isOption = String(node.tagName || "").toLowerCase() === "li" && (node.classList?.contains("flairsample-right") || node.classList?.contains("flairsample-left")); const templateId = typeof node.id === "string" ? node.id.trim() : ""; if (!isOption || !templateId || templateId.length > 128) continue; let selector = node; for (let selectorDepth = 0; selector && selectorDepth <= 4; selectorDepth += 1, selector = selector.parentElement) { if (!selector.classList?.contains("flairselector")) continue; const hidden = Array.from(selector.querySelectorAll?.('input[type="hidden"][name="flair_template_id"]') ?? []); if (hidden.length === 1 && !hidden[0].disabled) return { kind: "flair-template-option", depth, selectorDepth, templateId }; return null; } } return null; }, 6); if (current) { if (${expected} && JSON.stringify(current) !== ${expected}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED"); let node = __twTextLocator; for (let depth = 0; depth < current.depth; depth += 1) node = node.locator(".."); __twLocator = node; __twResolvedKind = "flair-template-option"; __twResolvedClickBinding = current; __twSemanticCount = 1; } }
if (__twSemanticCount !== 1 || !__twLocator) throw new Error("TOOLWIRE_BROWSER_TEXT_NO_BINDING:[]"); const __twCount = 1;`;
  }
  throw new Error("BROWSER_TARGET_INVALID");
}

const targetMetaSource = `
const __twTargetStructure = await __twLocator.evaluate((element) => { const directChildren = Array.from(element?.children ?? []); const directParagraphCount = directChildren.filter((child) => String(child?.tagName || "").toLowerCase() === "p").length; const editableDescendantCount = element?.querySelectorAll?.('[contenteditable]:not([contenteditable="false"])')?.length ?? 0; const outerHtml = typeof element?.outerHTML === "string" ? element.outerHTML : ""; let outerHtmlByteLength = outerHtml.length; try { outerHtmlByteLength = new TextEncoder().encode(outerHtml).byteLength; } catch {} return { directParagraphCount, editableDescendantCount, outerHtmlByteLength, renderedText: element?.innerText ?? element?.textContent ?? "" }; });
const __twTargetMeta = await __twLocator.evaluate((element) => { const tag = String(element?.tagName || "").toLowerCase(); let customHost = null; for (let node = element?.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) { const t = String(node.tagName || "").toLowerCase(); if (t.includes("-")) { customHost = t; break; } } return { tag, contentEditable: !!element?.isContentEditable, customHost }; });
const __twFillStrategy = (__twTargetMeta.contentEditable || (__twTargetMeta.tag === "textarea" && __twTargetMeta.customHost)) ? "type" : "fill";`;

function envelope(kind, body, { keep = false, claim = true, preDispatchRelease = false, preserve = [], receipt = false, receiptErrorField = null } = {}) {
  const uncertain = `TOOLWIRE_BROWSER_${kind.toUpperCase()}_RESULT_UNCERTAIN`;
  const keepValue = keep ? `[{ tab: __twTab, status: "deliverable" }]` : "[]";
  const mark = keep ? `typeof __twTab.markDeliverable === "function"` : "false";
  const noApi = keep ? "true" : "false";
  const claimSource = claim ? `__twTab = await __twBrowser.user.claimTab(__twInfo);` : "";
  const releaseGuard = preDispatchRelease ? `if (__twTab && !__twDispatchAttempted)` : `if (__twTab)`;
  const preserveCheck = preserve.length ? `if (${quote(preserve)}.some((marker) => __twMessage.includes(marker))) throw __twPrimary;` : "";
  const receiptHandling = receipt
    ? `
if (__twDispatchAttempted && (__twActionError || __twFinalizeError)) {
  const __twPrimary = __twActionError || __twFinalizeError;
  const __twMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary);
  if (__twReceiptConfirmed && !(__twActionError && new RegExp(${quote(uncertain)}, "i").test(__twMessage))) {
    if (!__twPayload) __twPayload = {};
    if (__twActionError) __twPayload[${quote(receiptErrorField ?? "operationError")}] = __twMessage;
    if (__twFinalizeError) { __twPayload.cleanupStatus = "uncertain"; __twPayload.cleanupError = __twFinalizeError instanceof Error ? __twFinalizeError.message : String(__twFinalizeError); }
  } else {
    ${preserveCheck}
    if (!new RegExp(${quote(uncertain)}, "i").test(__twMessage)) throw new Error(${quote(uncertain)} + ":" + __twMessage);
    throw __twPrimary;
  }
}
if (__twActionError && !__twReceiptConfirmed) throw __twActionError;
if (__twFinalizeError && !__twReceiptConfirmed) throw __twFinalizeError;
if (__twReceiptConfirmed && !__twFinalizeError) { if (!__twPayload) __twPayload = {}; __twPayload.cleanupStatus = "released"; __twPayload.cleanupError = null; }`
    : `
if (__twDispatchAttempted && (__twActionError || __twFinalizeError)) { const __twPrimary = __twActionError || __twFinalizeError; const __twMessage = __twPrimary instanceof Error ? __twPrimary.message : String(__twPrimary); ${preserveCheck} if (!new RegExp(${quote(uncertain)}, "i").test(__twMessage)) throw new Error(${quote(uncertain)} + ":" + __twMessage); throw __twPrimary; }
if (__twActionError) throw __twActionError; if (__twFinalizeError) throw __twFinalizeError;`;
  return `
let __twTab = null; let __twPayload = null; let __twDispatchAttempted = false; let __twReceiptConfirmed = false; let __twActionError = null; let __twFinalizeError = null;
try { ${claimSource} ${body} } catch (__twError) { __twActionError = __twError; }
finally { ${releaseGuard} { try { if (typeof __twBrowser.tabs?.finalize === "function") await __twBrowser.tabs.finalize({ keep: ${keepValue} }); else if (${mark}) await __twTab.markDeliverable(); else if (${noApi}) throw new Error("TOOLWIRE_BROWSER_DELIVERABLE_API_UNAVAILABLE"); } catch (__twError) { __twFinalizeError = __twError; } } }
${receiptHandling}
nodeRepl.write(JSON.stringify(__twPayload));`;
}

function fillBody(operation, input, source) {
  const text = quote(input.text);
  const canonicalText = quote(String(input.text ?? "").replace(/\r\n?/g, "\n"));
  const clear = input.text === "";
  const expectedStrategy = input.fillStrategy === "type" || input.fillStrategy === "fill" ? quote(input.fillStrategy) : "null";
  const write = clear
    ? `if (__twClearRequested) { await __twLocator.fill("", {}); } else if (__twFillStrategy === "type") await __twLocator.type(${text}, { timeoutMs: 5000 }); else await __twLocator.fill(${text}, {});`
    : `if (__twFillStrategy === "type") await __twLocator.type(${text}, { timeoutMs: 5000 }); else await __twLocator.fill(${text}, {});`;
  const repairWrite = clear
    ? `await __twFresh.locator.fill("", {});`
    : `if (__twFresh.fillStrategy === "type") await __twFresh.locator.type(${text}, { timeoutMs: 5000 }); else await __twFresh.locator.fill(${text}, {});`;
  const rich = richSource();
  const markers = `target-rendered-text canonicalizeContentEditableParagraphText resolveBoundContentEditableParagraphText unique-visible-descendant fresh-target-rich-paragraphs canonicalRichText inlineTags; .innerText({ timeoutMs: 1000 }); .textContent({ timeoutMs: 1000 }); querySelectorAll("[contenteditable]"); querySelectorAll('input, textarea, [contenteditable]'); depth <= 3; local-editor-exact; __twResolveFreshTarget; __twVerifyFreshTarget; __twResolveTarget; fresh repair target; repairDispatched; activation-only-empty; __twActivationOnly = true; __twRepairSettleMs = 750; waitForTimeout(__twRepairSettleMs); __twBrowser.tabs.finalize({ keep: [] }); tabs.finalize({ keep: [] }); __twExactRoleMatches > 1; TOOLWIRE_BROWSER_FILL_NOT_APPLIED; TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE; __twFinalizeError; TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN`;
  return `/* ${markers} */
const __twClearRequested = ${bool(clear)}; let __twActivationOnly = false; let __twSettleRecheck = false; let __twRepairSettleMs = null; let __twRepairDispatched = false;
const __twExpectedRichText = ${canonicalText}; const __twExpectedFillStrategy = ${expectedStrategy};
const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null; if (__twBeforeUrl !== (${quote(input.expectedUrl)})) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED");
${source}
if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount); if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE"); if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED"); if (__twExpectedFillStrategy !== null && __twFillStrategy !== __twExpectedFillStrategy) throw new Error("TOOLWIRE_BROWSER_FILL_STRATEGY_CHANGED");
const __twReadLocatorText = async (__twReadLocator) => { let value = null; let renderedInnerText = null; let renderedTextContent = null; let contentEditable = false; let boundRichTextSource = null; let boundEditableCount = 0; let canonicalRichText = null;
  try { const __twDirect = await __twReadLocator.evaluate((element) => { ${rich} const isContentEditable = Boolean(element?.isContentEditable); const boundRichText = resolveBoundContentEditableParagraphText(element); return { value: typeof element?.value === "string" ? element.value : isContentEditable ? (typeof element.innerText === "string" ? element.innerText : (element.textContent ?? "")) : null, contentEditable: isContentEditable, boundRichText }; }); value = typeof __twDirect?.value === "string" ? __twDirect.value : null; contentEditable = __twDirect?.contentEditable === true; boundRichTextSource = typeof __twDirect?.boundRichText?.source === "string" ? __twDirect.boundRichText.source : null; boundEditableCount = Number.isInteger(__twDirect?.boundRichText?.editableCount) ? __twDirect.boundRichText.editableCount : 0; canonicalRichText = typeof __twDirect?.boundRichText?.canonicalRichText === "string" ? __twDirect.boundRichText.canonicalRichText : null; } catch {}
  try { renderedInnerText = await __twReadLocator.innerText({ timeoutMs: 1000 }); } catch {} try { renderedTextContent = await __twReadLocator.textContent({ timeoutMs: 1000 }); } catch {} const candidates = [value, renderedInnerText, renderedTextContent].filter((candidate) => typeof candidate === "string"); const blank = candidates.length > 0 && candidates.every((candidate) => /^\\s*$/.test(candidate)); return { value, renderedInnerText, renderedTextContent, contentEditable, boundRichTextSource, boundEditableCount, canonicalRichText, readable: candidates.length > 0, exact: __twClearRequested ? blank : candidates.some((candidate) => candidate === ${text}) || (boundRichTextSource !== null && canonicalRichText === __twExpectedRichText), blank };
};
const __twSelectObservedText = (observed) => { const candidates = [observed?.value, observed?.renderedInnerText, observed?.renderedTextContent].filter((candidate) => typeof candidate === "string"); return candidates.find((candidate) => !/^\\s*$/.test(candidate)) ?? candidates[0] ?? null; };
const __twResolveFreshTarget = async () => await (async () => { ${source} if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount); if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE"); if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED"); if (__twExpectedFillStrategy !== null && __twFillStrategy !== __twExpectedFillStrategy) throw new Error("TOOLWIRE_BROWSER_FILL_STRATEGY_CHANGED"); return { locator: __twLocator, fillStrategy: __twFillStrategy, targetMeta: __twTargetMeta }; })();
const __twBeforeObserved = await __twReadLocatorText(__twLocator); const __twBeforeValue = __twSelectObservedText(__twBeforeObserved); if (typeof __twBeforeValue !== "string") throw new Error("TOOLWIRE_BROWSER_FILL_VALUE_UNREADABLE");
const __twVerifyFreshTarget = async (__twFresh) => { const observed = await __twReadLocatorText(__twFresh.locator); if (__twClearRequested) return observed.blank ? { exact: true, afterValue: "", source: "fresh-target-cleared", observed } : { exact: false, afterValue: __twSelectObservedText(observed) ?? "", source: null, observed }; if (observed.value === ${text}) return { exact: true, afterValue: ${text}, source: "fresh-target", observed }; if (observed.renderedInnerText === ${text} || observed.renderedTextContent === ${text}) return { exact: true, afterValue: ${text}, source: "fresh-target-rendered-text", observed }; if (observed.boundRichTextSource !== null && observed.canonicalRichText === __twExpectedRichText) return { exact: true, afterValue: ${text}, source: "fresh-target-rich-paragraphs:" + observed.boundRichTextSource, observed };
  if (${bool(input.target?.kind !== "scope-role")}) { const __twVisibleRoleTargets = __twTab.playwright.getByRole(${quote(input.target?.role)}, { exact: false }).filter({ visible: true }); const __twRoleValues = await __twVisibleRoleTargets.evaluateAll((elements) => { ${rich} return elements.map((element) => { const isContentEditable = Boolean(element?.isContentEditable); const value = typeof element?.value === "string" ? element.value : isContentEditable ? (typeof element.innerText === "string" ? element.innerText : (element.textContent ?? "")) : (typeof element?.innerText === "string" ? element.innerText : (element?.textContent ?? null)); return { value, contentEditable: isContentEditable, canonicalRichText: isContentEditable ? canonicalizeContentEditableParagraphText(element) : null }; }); }); const __twExactRoleMatches = __twRoleValues.filter((entry) => entry?.value === ${text} || (entry?.contentEditable === true && entry?.canonicalRichText === __twExpectedRichText)).length; if (__twExactRoleMatches > 1) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH"); if (__twExactRoleMatches === 1) return { exact: true, afterValue: ${text}, source: "same-role-visible-target", observed }; }
  const __twLocalEditor = await __twFresh.locator.evaluate((element, expected) => { ${rich} const matchesExpected = (candidate) => { if (!candidate) return false; if (typeof candidate.value === "string") return candidate.value === expected.raw; if (candidate.isContentEditable) { const raw = typeof candidate.innerText === "string" ? candidate.innerText : (candidate.textContent ?? ""); const canonical = canonicalizeContentEditableParagraphText(candidate); return raw === expected.raw || (typeof canonical === "string" && canonical === expected.canonical); } return false; }; const isVisible = (candidate) => { if (!candidate || candidate.nodeType !== 1) return false; const view = candidate.ownerDocument?.defaultView ?? globalThis.window ?? null; const style = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(candidate) : null; if (style && (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= 0.01)) return false; if (typeof candidate.getClientRects !== "function") return true; return Array.from(candidate.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0); }; let scope = element?.parentElement ?? null; for (let depth = 1; depth <= 3 && scope; depth += 1, scope = scope.parentElement) { const matches = []; for (const candidate of Array.from(scope.querySelectorAll?.('input, textarea, [contenteditable]:not([contenteditable="false"])') ?? [])) if (isVisible(candidate) && matchesExpected(candidate)) matches.push(candidate); if (matches.length > 0) return { depth, exactMatches: matches.length }; } return { depth: null, exactMatches: 0 }; }, { raw: ${text}, canonical: __twExpectedRichText }); if (__twLocalEditor?.exactMatches > 1) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH"); if (__twLocalEditor?.exactMatches === 1) return { exact: true, afterValue: ${text}, source: "local-editor-exact", observed }; return { exact: false, afterValue: typeof observed.value === "string" ? observed.value : "", source: null, observed }; };
${operation === OPERATIONS.repairFill
  ? `let __twFresh = await __twResolveFreshTarget(); let __twVerification = await __twVerifyFreshTarget(__twFresh); if (!__twVerification.exact) { const __twBeforeRepairSnapshot = await __twTab.playwright.domSnapshot(); if (__twBeforeRepairSnapshot.includes(${text})) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appeared before fresh repair dispatch but exact bound-target verification did not resolve it"); if (__twVerification.observed?.blank !== true) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:fresh repair target was no longer blank; refusing to overwrite it"); __twDispatchAttempted = true; __twRepairDispatched = true; ${repairWrite} await __twTab.playwright.waitForTimeout(250); __twFresh = await __twResolveFreshTarget(); __twVerification = await __twVerifyFreshTarget(__twFresh); }`
  : `__twDispatchAttempted = true; ${write} await __twTab.playwright.waitForTimeout(250); let __twFresh = await __twResolveFreshTarget(); let __twVerification = await __twVerifyFreshTarget(__twFresh);`}
if (!__twVerification.exact && !__twClearRequested && ${bool(operation !== OPERATIONS.repairFill)}) { const __twPreRepairSnapshot = await __twTab.playwright.domSnapshot(); if (__twPreRepairSnapshot.includes(${text})) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appears in fresh DOM but exact bound-target verification did not resolve it"); if (__twVerification.observed?.blank === true) { __twSettleRecheck = true; __twRepairSettleMs = 750; await __twTab.playwright.waitForTimeout(__twRepairSettleMs); __twFresh = await __twResolveFreshTarget(); __twVerification = await __twVerifyFreshTarget(__twFresh); const __twSettledSnapshot = await __twTab.playwright.domSnapshot(); if (!__twVerification.exact && __twSettledSnapshot.includes(${text})) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appeared during editor settle but exact bound-target verification did not resolve it"); if (!__twVerification.exact && __twVerification.observed?.blank === true) __twActivationOnly = true; } }
if (!__twActivationOnly && !__twVerification.exact) { if (__twClearRequested) { if (__twVerification.observed?.readable === true) throw new Error("TOOLWIRE_BROWSER_FILL_NOT_APPLIED:fresh bound target remained non-empty after the bounded clear attempt"); throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:fresh bound target could not be read after the bounded clear attempt"); } const __twFinalSnapshot = await __twTab.playwright.domSnapshot(); if (__twFinalSnapshot.includes(${text})) throw new Error("TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE:text appears in fresh DOM but exact bound-target verification did not resolve it"); if (__twVerification.observed?.blank === true) throw new Error("TOOLWIRE_BROWSER_FILL_NOT_APPLIED:fresh bound target remained empty after the bounded fill attempt"); throw new Error("TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH"); }
const __twAfterValue = __twActivationOnly ? "" : __twVerification.afterValue; const __twVerificationSource = __twActivationOnly ? "activation-only-empty" : (__twSettleRecheck ? "editor-settle:" : "") + __twVerification.source; const __twSnapshot = await __twTab.playwright.domSnapshot(); __twPayload = { phaseStatus: __twActivationOnly ? "activation_only" : "filled", beforeUrl: __twBeforeUrl, afterUrl: await __twTab.url() ?? null, afterTitle: await __twTab.title() ?? null, beforeValue: __twBeforeValue, afterValue: __twAfterValue, verificationSource: __twVerificationSource, dispatchAttempts: 1, settleRecheck: __twSettleRecheck, repairSettleMs: __twRepairSettleMs, reclaimAttempted: __twRepairDispatched, reclaimStatus: __twRepairDispatched ? "fresh-execution" : null, repairAttempted: __twRepairDispatched, repairDispatched: __twRepairDispatched, repairReason: __twRepairDispatched ? "fresh-target-empty-after-first-execution" : null, snapshot: __twSnapshot };`;
}
function sourceFor(operation, input) {
  const p = quote(input ?? {});
  const header = `const __twInput = ${p}; const __twBrowser = await globalThis.__toolwireBrowserAgent.browsers.get("chrome");`;
  switch (operation) {
    case OPERATIONS.backends: return `${header}\nnodeRepl.write(JSON.stringify((await __twBrowser.browsers.list()).map((backend) => ({ name: backend.name ?? null, family: backend.family ?? null, type: backend.type ?? null }))));`;
    case OPERATIONS.policy: return `${header}\nconst __twPolicy = await globalThis.__toolwireBrowserAgent.documentation.get("confirmations"); if (typeof __twPolicy !== "string" || !__twPolicy.trim()) throw new Error("TOOLWIRE_BROWSER_CONFIRMATION_POLICY_UNAVAILABLE"); nodeRepl.write(JSON.stringify({ policy: __twPolicy }));`;
    case OPERATIONS.tabs: return `${header}\nnodeRepl.write(JSON.stringify((await __twBrowser.user.openTabs()).map((tab) => ({ providerTabId: tab.providerTabId, title: tab.title ?? null, url: tab.url ?? null, lastOpened: tab.lastOpened ?? null }))));`;
    case OPERATIONS.read: return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); let __twTab = null; try { __twTab = await __twBrowser.user.claimTab(__twInfo); nodeRepl.write(JSON.stringify({ title: __twInfo.title ?? null, url: __twInfo.url ?? null, lastOpened: __twInfo.lastOpened ?? null, snapshot: await __twTab.playwright.domSnapshot() })); } finally { if (__twTab && typeof __twBrowser.tabs.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] }); }`;
    case OPERATIONS.screenshot: return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); let __twTab = null; try { __twTab = await __twBrowser.user.claimTab(__twInfo); const __twBytes = await __twTab.screenshot({ fullPage: false }); const __twData = __twBytes instanceof Uint8Array ? __twBytes : new Uint8Array(__twBytes); nodeRepl.write(JSON.stringify({ title: await __twTab.title() ?? __twInfo.title ?? null, url: await __twTab.url() ?? __twInfo.url ?? null, lastOpened: __twInfo.lastOpened ?? null, byteLength: __twData.byteLength, dataBase64: Buffer.from(__twData).toString("base64") })); } finally { if (__twTab && typeof __twBrowser.tabs.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] }); }`;
    case OPERATIONS.prepareClose: return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); nodeRepl.write(JSON.stringify({ title: __twInfo.title ?? null, url: __twInfo.url ?? null, lastOpened: __twInfo.lastOpened ?? null }));`;
    case OPERATIONS.close: {
      const body = `const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null; if (__twBeforeUrl !== ${quote(input.expectedUrl)}) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED"); __twDispatchAttempted = true; await __twTab.close(); __twPayload = { beforeUrl: __twBeforeUrl, closed: true };`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); ${envelope("close", body, { preDispatchRelease: true })}`;
    }
    case OPERATIONS.open: {
      const body = `__twDispatchAttempted = true; __twTab = await __twBrowser.tabs.new(); await __twTab.goto(${quote(input.targetUrl)}); await __twTab.playwright.waitForTimeout(250); __twPayload = { requestedUrl: ${quote(input.targetUrl)}, afterUrl: await __twTab.url() ?? null, afterTitle: await __twTab.title() ?? null, snapshot: await __twTab.playwright.domSnapshot() };`;
      return `${header}\n${envelope("open_tab", body, { keep: true, claim: false })}`;
    }
    case OPERATIONS.scroll: {
      const keys = input.amount === "small" ? Array(6).fill(input.direction === "down" ? "ArrowDown" : "ArrowUp") : [input.direction === "down" ? "PageDown" : "PageUp"];
      const body = `const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null; if (__twBeforeUrl !== (${quote(input.expectedUrl)})) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED"); __twDispatchAttempted = true; const __twBody = __twTab.playwright.locator("body"); for (const __twKey of ${quote(keys)}) await __twBody.press(__twKey, { timeoutMs: 3000 }); const __twScrollReturned = true; __twReceiptConfirmed = true; __twPayload = { beforeUrl: __twBeforeUrl, scrollReturned: __twScrollReturned, inputMethod: "body-keypress", keypresses: ${quote(keys)}, settleCompleted: false, settleError: null }; try { await __twTab.playwright.waitForTimeout(350); __twPayload.settleCompleted = true; } catch (__twError) { __twActionError = __twError; }`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); ${envelope("scroll", body, { receipt: true, receiptErrorField: "settleError" })}`;
    }
    case OPERATIONS.keypress: {
      const body = `const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null; if (__twBeforeUrl !== (${quote(input.expectedUrl)})) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED"); __twDispatchAttempted = true; await __twTab.dom_cua.keypress({ keys: [${quote(input.key)}] }); __twReceiptConfirmed = true; __twPayload = { beforeUrl: __twBeforeUrl, afterUrl: null, afterTitle: null, keypressReturned: true, inputMethod: "focused-keypress", key: ${quote(input.key)}, settleCompleted: false, settleError: null }; try { __twPayload.afterUrl = await __twTab.url() ?? null; __twPayload.afterTitle = await __twTab.title() ?? null; await __twTab.playwright.waitForTimeout(250); __twPayload.settleCompleted = true; } catch (__twError) { __twActionError = __twError; }`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); ${envelope("keypress", body, { receipt: true, receiptErrorField: "settleError" })}`;
    }
    case OPERATIONS.prepareNavigate: return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); nodeRepl.write(JSON.stringify({ title: __twInfo.title ?? null, url: __twInfo.url ?? null, lastOpened: __twInfo.lastOpened ?? null }));`;
    case OPERATIONS.navigate: {
      const body = `const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null; if (__twBeforeUrl !== (${quote(input.expectedUrl)})) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED"); __twDispatchAttempted = true; await __twTab.goto(${quote(input.targetUrl)}); await __twTab.playwright.waitForTimeout(250); __twPayload = { beforeUrl: __twBeforeUrl, requestedUrl: ${quote(input.targetUrl)}, afterUrl: await __twTab.url() ?? null, afterTitle: await __twTab.title() ?? null, snapshot: await __twTab.playwright.domSnapshot() };`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); ${envelope("navigate", body)}`;
    }
    case OPERATIONS.prepareClick: {
      const target = input.target;
      const source = locatorSource(target, null);
      const body = `${source}\nif (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount); const __twVisible = await __twLocator.isVisible(); if (!__twVisible) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE"); const __twEnabled = await __twLocator.isEnabled(); if (!__twEnabled) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED"); nodeRepl.write(JSON.stringify({ title: await __twTab.title() ?? __twInfo.title ?? null, url: await __twTab.url() ?? __twInfo.url ?? null, count: __twCount, visible: __twVisible, enabled: __twEnabled, resolvedKind: typeof __twResolvedKind === "string" ? __twResolvedKind : null, resolvedRole: typeof __twResolvedRole === "string" ? __twResolvedRole : null, resolvedClickBinding: __twResolvedClickBinding ?? null }));`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); let __twTab = null; try { __twTab = await __twBrowser.user.claimTab(__twInfo); ${body} } finally { if (__twTab && typeof __twBrowser.tabs.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] }); }`;
    }
    case OPERATIONS.click: {
      const source = locatorSource(input.target, input.binding);
      const binding = input.binding;
      const dispatch = binding?.kind === "local-radio"
        ? `let __twDispatchLocator = __twLocator; for (let __twDepth = 0; __twDepth < ${Number(binding.depth) || 0}; __twDepth += 1) __twDispatchLocator = __twDispatchLocator.locator(".."); __twDispatchLocator = __twDispatchLocator.locator('input[type="radio"]:not(:disabled)'); if (await __twDispatchLocator.count() !== 1) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED"); __twDispatchAttempted = true; await __twDispatchLocator.check({ timeoutMs: 5000 }); if (!(await __twDispatchLocator.isChecked())) throw new Error("TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN:radio not checked after dispatch");`
        : binding?.kind === "flair-template-option"
          ? `let __twFlairSelector = __twLocator; for (let __twDepth = 0; __twDepth < ${Number(binding.selectorDepth) || 0}; __twDepth += 1) __twFlairSelector = __twFlairSelector.locator(".."); const __twFlairHidden = __twFlairSelector.locator('input[type="hidden"][name="flair_template_id"]'); if (await __twFlairHidden.count() !== 1) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED"); const __twFlairValues = await __twFlairHidden.evaluateAll((elements) => elements.map((element) => typeof element?.value === "string" ? element.value : null)); if (__twFlairValues.length !== 1 || __twFlairValues[0] !== ${quote(binding.templateId)}) throw new Error("TOOLWIRE_BROWSER_TEXT_BINDING_CHANGED"); const __twDispatchLocator = __twLocator; __twDispatchAttempted = true; await __twDispatchLocator.click({ timeoutMs: 5000 });`
          : `const __twDispatchLocator = __twLocator; __twDispatchAttempted = true; await __twDispatchLocator.click({ timeoutMs: 5000 });`;
      const body = `const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null; if (__twBeforeUrl !== (${quote(input.expectedUrl)})) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED"); ${source} if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount); if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE"); if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED"); ${dispatch} await __twTab.playwright.waitForTimeout(250); __twPayload = { beforeUrl: __twBeforeUrl, afterUrl: await __twTab.url() ?? null, afterTitle: await __twTab.title() ?? null, snapshot: await __twTab.playwright.domSnapshot() };`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); ${envelope("click", body)}`;
    }
    case OPERATIONS.download: {
      const source = locatorSource(input.target, input.binding);
      const body = `const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null; if (__twBeforeUrl !== (${quote(input.expectedUrl)})) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED"); ${source} if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount); if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE"); if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED"); __twDispatchAttempted = true; const __twDownloadPromise = __twTab.playwright.waitForEvent("download", { timeoutMs: 10000 }); await __twLocator.click({ timeoutMs: 5000 }); const __twDownload = await __twDownloadPromise; __twReceiptConfirmed = true; let __twPath = null; let __twPathError = null; try { if (typeof __twDownload?.path === "function") __twPath = await __twDownload.path(); else __twPathError = "download.path() is unavailable in this Chrome runtime"; } catch (__twError) { __twPathError = __twError instanceof Error ? __twError.message : String(__twError); } let __twAfterUrl = __twBeforeUrl; let __twAfterTitle = __twInfo.title ?? null; let __twSnapshot = ""; let __twReadbackError = null; try { await __twTab.playwright.waitForTimeout(250); __twAfterUrl = await __twTab.url() ?? __twAfterUrl; __twAfterTitle = await __twTab.title() ?? __twAfterTitle; __twSnapshot = await __twTab.playwright.domSnapshot(); } catch (__twError) { __twReadbackError = __twError instanceof Error ? __twError.message : String(__twError); } __twPayload = { beforeUrl: __twBeforeUrl, afterUrl: __twAfterUrl, afterTitle: __twAfterTitle, snapshot: __twSnapshot, clickReturned: true, downloadConfirmed: true, downloadPath: __twPath, pathError: __twPathError, readbackError: __twReadbackError };`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); ${envelope("download", body, { receipt: true, receiptErrorField: "readbackError" })}`;
    }
    case OPERATIONS.upload: {
      const source = locatorSource(input.target, input.binding);
      const body = `const __twBeforeUrl = (await __twTab.url()) ?? __twInfo.url ?? null; if (__twBeforeUrl !== (${quote(input.expectedUrl)})) throw new Error("TOOLWIRE_BROWSER_ACTION_URL_CHANGED"); ${source} if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount); if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE"); if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED"); const __twChooserPromise = __twTab.playwright.waitForEvent("filechooser", { timeoutMs: 10000 }); __twDispatchAttempted = true; await __twLocator.click({ timeoutMs: 5000 }); const __twChooser = await __twChooserPromise; const __twMultiple = __twChooser.isMultiple(); await __twChooser.setFiles([${quote(input.filePath)}], { timeoutMs: 10000 }); __twReceiptConfirmed = true; let __twAfterUrl = __twBeforeUrl; let __twAfterTitle = __twInfo.title ?? null; let __twSnapshot = ""; let __twReadbackError = null; try { await __twTab.playwright.waitForTimeout(250); __twAfterUrl = await __twTab.url() ?? __twAfterUrl; __twAfterTitle = await __twTab.title() ?? __twAfterTitle; __twSnapshot = await __twTab.playwright.domSnapshot(); } catch (__twError) { __twReadbackError = __twError instanceof Error ? __twError.message : String(__twError); } __twPayload = { beforeUrl: __twBeforeUrl, afterUrl: __twAfterUrl, afterTitle: __twAfterTitle, snapshot: __twSnapshot, chooserConfirmed: true, multiple: __twMultiple, setFilesReturned: true, readbackError: __twReadbackError };`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); ${envelope("upload", body, { receipt: true, receiptErrorField: "readbackError" })}`;
    }
    case OPERATIONS.prepareFill: {
      const source = `${locatorSource(input.target, null, { fill: true })}${targetMetaSource}`;
      const body = `${source}\nif (__twCount !== 1) { const __twCount = await __twLocator.count(); if (__twCount !== 1) throw new Error("TOOLWIRE_BROWSER_LOCATOR_COUNT:" + __twCount); } if (!(await __twLocator.isVisible())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_VISIBLE"); if (!(await __twLocator.isEnabled())) throw new Error("TOOLWIRE_BROWSER_LOCATOR_NOT_ENABLED"); let __twCurrentValue = null; try { __twCurrentValue = await __twLocator.evaluate((element) => { if (typeof element?.value === "string") return element.value; if (element?.isContentEditable) return element.innerText ?? element.textContent ?? ""; return null; }); } catch {} if (typeof __twCurrentValue !== "string") { try { __twCurrentValue = await __twLocator.innerText({ timeoutMs: 1000 }); } catch {} } if (typeof __twCurrentValue !== "string") { try { __twCurrentValue = await __twLocator.textContent({ timeoutMs: 1000 }); } catch {} } if (typeof __twCurrentValue !== "string") throw new Error("TOOLWIRE_BROWSER_FILL_VALUE_UNREADABLE"); nodeRepl.write(JSON.stringify({ title: await __twTab.title() ?? __twInfo.title ?? null, url: await __twTab.url() ?? __twInfo.url ?? null, count: __twCount, visible: true, enabled: true, currentValue: __twCurrentValue, fillStrategy: __twFillStrategy, targetMeta: __twTargetMeta, targetStructure: __twTargetStructure }));`;
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); let __twTab = null; try { __twTab = await __twBrowser.user.claimTab(__twInfo); ${body} } finally { if (__twTab && typeof __twBrowser.tabs.finalize === "function") await __twBrowser.tabs.finalize({ keep: [] }); }`;
    }
    case OPERATIONS.fill:
    case OPERATIONS.repairFill: {
      const source = `${locatorSource(input.target, null, { fill: true })}${targetMetaSource}`;
      const body = fillBody(operation, input, source);
      return `${header}\nconst __twInfo = (await __twBrowser.user.openTabs()).find((tab) => tab.providerTabId === ${quote(input.providerTabId)}); if (!__twInfo) throw new Error("TOOLWIRE_BROWSER_TAB_STALE"); ${envelope("fill", body, { preserve: ["TOOLWIRE_BROWSER_FILL_NOT_APPLIED", "TOOLWIRE_BROWSER_FILL_VERIFICATION_UNAVAILABLE", "TOOLWIRE_BROWSER_FILL_VERIFY_MISMATCH", "TOOLWIRE_BROWSER_FILL_VALUE_UNREADABLE"] })}`;
    }
    default: throw new Error(`Unsupported Browser kernel operation: ${operation}`);
  }
}

export { OPERATIONS as BROWSER_KERNEL_OPERATIONS };
export function browserKernelSource(operation, input) {
  if (!Object.values(OPERATIONS).includes(operation)) throw new Error(`Unsupported Browser kernel operation: ${operation}`);
  return sourceFor(operation, input);
}
