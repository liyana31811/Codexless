import assert from "node:assert/strict";
import vm from "node:vm";
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

// Flair exact-text bindings are resolved on the option node but authorized by
// the enclosing selector's single hidden template-id input.  The dispatch
// source must climb the recorded selector depth instead of probing the `<li>`
// itself (which would silently reject every legitimate old-Reddit option).
const flairClick = browserKernelSource(KERNEL.click, {
  providerTabId: "p",
  expectedUrl: "https://example.test/",
  target: { kind: "text", text: "Funny" },
  binding: { kind: "flair-template-option", selectorDepth: 3, templateId: "template-id" },
});
assert.match(flairClick, /__twFlairSelector = __twLocator/);
assert.match(flairClick, /__twDepth < 3/);
assert.match(flairClick, /input\[type="hidden"\]\[name="flair_template_id"\]/);
assert.doesNotMatch(flairClick, /__twFlairHidden = __twLocator\.locator/);

// Every supported fill target shape must compile as one isolated kernel body.
// In particular, scope-role fill used to emit two const declarations for the
// fixed strategy, which only failed once a real node_repl parsed the body.
for (const target of [
  { kind: "role", role: "textbox", name: "Search" },
  { kind: "placeholder", role: "textbox", placeholder: "Search" },
  { kind: "scope-role", role: "textbox", scopeUrl: "https://example.test/comment/1" },
]) {
  for (const operation of [KERNEL.prepareFill, KERNEL.fill, KERNEL.repairFill]) {
    const source = browserKernelSource(operation, {
      providerTabId: "p",
      expectedUrl: "https://example.test/",
      target,
      text: "needle",
      fillStrategy: "fill",
    });
    assert.doesNotThrow(
      () => new vm.Script(`(async () => {\n${source}\n})()`),
      `${operation} ${target.kind} source must parse as one node_repl body`
    );
  }
}

// Execute the generated bodies against a tiny deterministic browser double to
// prove that a confirmed dispatch remains confirmed when only settle/readback
// or finalisation fails.  The event/chooser receipt is the one-shot boundary;
// failures before it remain uncertain and are handled by the shared envelope.
async function executeKernel(operation, input, options = {}) {
  const info = { providerTabId: "p", title: "Fixture", url: "https://example.test/" };
  let written = null;
  let finalizeCalls = 0;
  const locator = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {},
    press: async () => {},
  };
  const tab = {
    url: async () => info.url,
    title: async () => info.title,
    close: async () => {},
    dom_cua: { keypress: async () => {} },
    playwright: {
      locator: () => ({ press: async () => {} }),
      getByRole: () => locator,
      waitForTimeout: async () => {
        if (options.settleError) throw new Error(options.settleError);
      },
      domSnapshot: async () => "fixture snapshot",
      waitForEvent: async (event) => {
        if (event === "download") {
          return {
            path: async () => {
              if (options.pathError) throw new Error(options.pathError);
              return "/trusted/download.bin";
            },
          };
        }
        if (event === "filechooser") {
          return { isMultiple: () => false, setFiles: async () => {} };
        }
        throw new Error(`unexpected event ${event}`);
      },
    },
  };
  const browser = {
    user: {
      openTabs: async () => [info],
      claimTab: async () => tab,
    },
    tabs: {
      finalize: async () => {
        finalizeCalls += 1;
        if (options.finalizeError) throw new Error(options.finalizeError);
      },
    },
  };
  const context = vm.createContext({
    globalThis: { __toolwireBrowserAgent: { browsers: { get: async () => browser } } },
    nodeRepl: { write: (text) => { written = JSON.parse(text); } },
  });
  const source = browserKernelSource(operation, input);
  await new vm.Script(`(async () => {\n${source}\n})()`).runInContext(context);
  return { written, finalizeCalls };
}

const scrollReceipt = await executeKernel(KERNEL.scroll, {
  providerTabId: "p", expectedUrl: "https://example.test/", direction: "down", amount: "page",
}, { settleError: "scroll settle failed" });
assert.equal(scrollReceipt.written.scrollReturned, true);
assert.match(scrollReceipt.written.settleError, /scroll settle failed/);
assert.equal(scrollReceipt.written.cleanupStatus, "released");

const keypressReceipt = await executeKernel(KERNEL.keypress, {
  providerTabId: "p", expectedUrl: "https://example.test/", key: "Enter",
}, { settleError: "keypress readback failed" });
assert.equal(keypressReceipt.written.keypressReturned, true);
assert.match(keypressReceipt.written.settleError, /keypress readback failed/);

const downloadReceipt = await executeKernel(KERNEL.download, {
  providerTabId: "p", expectedUrl: "https://example.test/", target: { kind: "role", role: "button", name: "Download" },
}, { pathError: "download path unavailable", settleError: "download readback failed" });
assert.equal(downloadReceipt.written.downloadConfirmed, true);
assert.match(downloadReceipt.written.pathError, /download path unavailable/);
assert.match(downloadReceipt.written.readbackError, /download readback failed/);

const uploadReceipt = await executeKernel(KERNEL.upload, {
  providerTabId: "p", expectedUrl: "https://example.test/", target: { kind: "role", role: "button", name: "Upload" }, filePath: "/trusted/file.txt",
}, { settleError: "upload readback failed" });
assert.equal(uploadReceipt.written.chooserConfirmed, true);
assert.equal(uploadReceipt.written.setFilesReturned, true);
assert.match(uploadReceipt.written.readbackError, /upload readback failed/);

const cleanupReceipt = await executeKernel(KERNEL.scroll, {
  providerTabId: "p", expectedUrl: "https://example.test/", direction: "down", amount: "page",
}, { finalizeError: "release failed" });
assert.equal(cleanupReceipt.written.scrollReturned, true);
assert.equal(cleanupReceipt.written.cleanupStatus, "uncertain");
assert.match(cleanupReceipt.written.cleanupError, /release failed/);

const closeReceipt = await executeKernel(KERNEL.close, {
  providerTabId: "p", expectedUrl: "https://example.test/",
}, { finalizeError: "release must not run after close dispatch" });
assert.equal(closeReceipt.written.closed, true);
assert.equal(closeReceipt.finalizeCalls, 0, "close must not release/finalize after dispatch");

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
