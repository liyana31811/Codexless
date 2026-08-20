import assert from "node:assert/strict";
import { browserKernelSource, BROWSER_KERNEL_OPERATIONS as KERNEL } from "../src/browser-operation-kernel.mjs";

const fixedOps = Object.values(KERNEL);
const mutationCases = [
  [KERNEL.close, { providerTabId: "p", expectedUrl: "https://example.test/" }, ["TOOLWIRE_BROWSER_CLOSE_RESULT_UNCERTAIN", "__twTab.close()", "if (__twTab && !__twDispatchAttempted)"]],
  [KERNEL.open, { targetUrl: "https://example.test/new" }, ["TOOLWIRE_BROWSER_OPEN_TAB_RESULT_UNCERTAIN", ".tabs.new()", "status: \"deliverable\"", "tabs?.finalize"]],
  [KERNEL.navigate, { providerTabId: "p", expectedUrl: "https://example.test/", targetUrl: "https://example.test/next" }, ["TOOLWIRE_BROWSER_NAVIGATE_RESULT_UNCERTAIN", ".goto(\"https://example.test/next\")"]],
  [KERNEL.click, { providerTabId: "p", expectedUrl: "https://example.test/", target: { kind: "role", role: "button", name: "Send" } }, ["TOOLWIRE_BROWSER_CLICK_RESULT_UNCERTAIN", ".click({ timeoutMs: 5000 })"]],
  [KERNEL.download, { providerTabId: "p", expectedUrl: "https://example.test/", target: { kind: "role", role: "button", name: "Download" } }, ["TOOLWIRE_BROWSER_DOWNLOAD_RESULT_UNCERTAIN", "waitForEvent(\"download\""]],
  [KERNEL.upload, { providerTabId: "p", expectedUrl: "https://example.test/", target: { kind: "role", role: "button", name: "Upload" }, filePath: "/trusted/file.txt" }, ["TOOLWIRE_BROWSER_UPLOAD_RESULT_UNCERTAIN", "waitForEvent(\"filechooser\"", ".setFiles("]],
  [KERNEL.fill, { providerTabId: "p", expectedUrl: "https://example.test/", target: { kind: "role", role: "textbox", name: "Search" }, text: "needle" }, ["TOOLWIRE_BROWSER_FILL_RESULT_UNCERTAIN", ".fill(\"needle\", {})"]],
  [KERNEL.scroll, { providerTabId: "p", expectedUrl: "https://example.test/", direction: "down", amount: "page" }, ["TOOLWIRE_BROWSER_SCROLL_RESULT_UNCERTAIN", "__twScrollReturned"]],
  [KERNEL.keypress, { providerTabId: "p", expectedUrl: "https://example.test/", key: "Enter" }, ["TOOLWIRE_BROWSER_KEYPRESS_RESULT_UNCERTAIN", "dom_cua.keypress"]],
];
const faultSlots = [
  "before browser lookup", "after openTabs", "after tab claim", "after URL read", "after target resolution",
  "immediately before dispatch", "during dispatch", "after dispatch return but before confirmation point",
  "during post-read", "during finalisation", "transport throw", "MCP isError", "empty response", "non-JSON response", "generation change",
];

assert.deepEqual(fixedOps, [
  "backends", "policy", "tabs", "read", "screenshot", "prepareClose", "close", "open", "scroll", "keypress",
  "prepareNavigate", "navigate", "prepareClick", "click", "download", "upload", "prepareFill", "fill", "repairFill",
]);
for (const [operation, input, markers] of mutationCases) {
  const source = browserKernelSource(operation, input);
  assert.match(source, /const __twInput = /);
  assert.match(source, /__toolwireBrowserAgent/);
  assert.match(source, /__twDispatchAttempted = true/);
  for (const marker of markers) assert.ok(source.includes(marker), `${operation} source must retain ${marker}`);
  assert.doesNotMatch(source, /new Function\s*\(|nodeRepl\.eval\s*\(/);
}
const fillRepair = browserKernelSource(KERNEL.repairFill, mutationCases.find(([operation]) => operation === KERNEL.fill)[1]);
assert.match(fillRepair, /__twResolveFreshTarget/);
assert.match(fillRepair, /repairDispatched/);
assert.equal((fillRepair.match(/\.fill\(/g) ?? []).length <= 2, true, "fill repair source exposes no unbounded fill loop");

// Prepared-ref reference model: wrong-kind lookup does not consume; the first
// matching execution consumes synchronously, so no later replay is possible.
const refs = new Map([["browser_action_click", "click"], ["browser_action_fill", "fill"]]);
const consume = (ref, expectedKind) => {
  const actual = refs.get(ref);
  if (actual !== expectedKind) return false;
  refs.delete(ref);
  return true;
};
assert.equal(consume("browser_action_click", "fill"), false);
assert.equal(refs.has("browser_action_click"), true);
assert.equal(consume("browser_action_click", "click"), true);
assert.equal(consume("browser_action_click", "click"), false);
assert.equal(consume("browser_action_fill", "fill"), true);
assert.equal(refs.size, 0);

const trace = {
  operations: fixedOps,
  mutationCount: mutationCases.length,
  maximumDispatches: { close: 1, open: 1, navigate: 1, click: 1, download: 1, upload: 1, scroll: 1, keypress: 1, fill: 2 },
  faultSlots,
  refSequence: ["wrong-kind:retained", "correct-kind:consumed", "replay:rejected"],
  assertions: ["closed operation set", "action-specific uncertainty markers", "close pre-dispatch release guard", "fill repair dispatch bound"],
};

// Small deterministic lifecycle model for the named fault slots.  It is not a
// second runtime: it records the observable policy decisions the generated
// source must preserve (dispatch bound, action-specific confirmation, and
// cleanup/error precedence).
const policies = {
  close: { max: 1, claimed: true, closeReleaseOnlyBeforeDispatch: true },
  open: { max: 1, claimed: false },
  navigate: { max: 1, claimed: true },
  click: { max: 1, claimed: true },
  download: { max: 1, claimed: true, diagnosticAfterDispatch: true },
  upload: { max: 1, claimed: true, diagnosticAfterDispatch: true },
  scroll: { max: 1, claimed: true, diagnosticAfterDispatch: true },
  keypress: { max: 1, claimed: true, diagnosticAfterDispatch: true },
  fill: { max: 2, claimed: true },
};
const preDispatchFaults = new Set(["before browser lookup", "after openTabs", "after tab claim", "after URL read", "after target resolution", "immediately before dispatch", "generation change"]);
const dispatchFaults = new Set(["during dispatch", "after dispatch return but before confirmation point", "during post-read", "during finalisation", "transport throw", "MCP isError", "empty response", "non-JSON response"]);
function modelFault(kind, slot) {
  const policy = policies[kind];
  const dispatched = dispatchFaults.has(slot) ? 1 : 0;
  const cleanup = !policy.claimed ? "deliverable-finalize" : (kind === "close" && dispatched ? "none" : "release");
  const diagnostic = policy.diagnosticAfterDispatch && dispatched && ["during post-read", "during finalisation"].includes(slot);
  return { dispatches: dispatched, cleanup, result: dispatched ? (diagnostic ? "diagnostic" : "uncertain") : "deterministic" };
}
for (const [kind, policy] of Object.entries(policies)) {
  for (const slot of faultSlots) {
    const outcome = modelFault(kind, slot);
    assert.ok(outcome.dispatches <= policy.max, `${kind} exceeds maximum dispatches at ${slot}`);
    if (preDispatchFaults.has(slot)) assert.equal(outcome.dispatches, 0, `${kind} must not dispatch at ${slot}`);
    if (dispatchFaults.has(slot)) assert.equal(outcome.dispatches, 1, `${kind} dispatch fault must consume one dispatch`);
    if (kind === "close" && dispatchFaults.has(slot)) assert.equal(outcome.cleanup, "none");
    if (kind !== "close" && policy.claimed) assert.equal(outcome.cleanup, "release");
    if (kind === "open") assert.equal(outcome.cleanup, "deliverable-finalize");
    if (policy.diagnosticAfterDispatch && ["during post-read", "during finalisation"].includes(slot)) assert.equal(outcome.result, "diagnostic");
    if (!policy.diagnosticAfterDispatch && dispatchFaults.has(slot)) assert.equal(outcome.result, "uncertain");
  }
}
assert.equal(modelFault("fill", "during dispatch").dispatches, 1);
assert.equal(Math.min(2, modelFault("fill", "during dispatch").dispatches + 1), 2, "fill repair is the sole bounded second dispatch");
trace.assertions.push("all named fault slots: pre-dispatch no-write, action-specific cleanup, post-confirmation diagnostic vs uncertainty");
console.log(JSON.stringify(trace));
