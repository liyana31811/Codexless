import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CodexBrowserExecutor } from "../src/codex-browser-executor.mjs";
import { registerBrowserPreviewTools } from "../src/browser-tools.mjs";
import { normalizeBrowserReaderHealth } from "../src/doctor-health.mjs";

function fixture(profiles = ["Personal", "Work"]) {
  const inventory = profiles.map((profileName, index) => ({ id: `private-provider-${index}`, name: "Chrome", family: "chrome", profileName, type: "extension", metadata: { extensionInstanceId: `private-extension-${index}` } }));
  const effects = [];
  const gets = [];
  const browsers = new Map();
  for (const info of inventory) {
    // Intentionally identical tab identity and URL in both profiles. The backend
    // must distinguish them even when every tab-level comparison would match.
    const row = { providerTabId: "same-tab-id", id: "tab", title: "Fixture", url: "https://example.test/fixture" };
    const tab = { id: "tab", async url() { return row.url; }, async title() { return row.title; },
      async goto(url) { effects.push([info.id, "goto", url]); row.url = url; },
      async close() { effects.push([info.id, "close"]); },
      playwright: {
        async domSnapshot() { return `- heading "${info.profileName}"`; },
        locator() { return { filter() { return this; }, async evaluateAll() { return []; } }; },
        async waitForTimeout() {},
      },
      dom_cua: { async keypress() { effects.push([info.id, "keypress"]); } },
    };
    const browser = { browserId: info.id, user: { async openTabs() { return [row]; }, async claimTab(actual) { assert.equal(actual, row); effects.push([info.id, "claim"]); return tab; } },
      tabs: { async new() { effects.push([info.id, "new"]); return tab; }, async finalize() { effects.push([info.id, "release"]); } }, tab,
    };
    browsers.set(info.id, browser);
  }
  const agent = { browsers: {
    async list() { return structuredClone(inventory); },
    async get(id) { gets.push(id); assert.ok(browsers.has(id), "selection must use an exact discovered provider ID"); return browsers.get(id); },
  } };
  let result;
  const context = vm.createContext({ __toolwireBrowserAgent: agent, nodeRepl: { write(value) { result = value; } } });
  const calls = [];
  const workbench = { generation: 1, beforeDispatch: null,
    async catalog({ kind }) { return kind === "skills" ? { skills: [{ name: "chrome:control-chrome", path: "C:/fixture/chrome/skills/control-chrome/SKILL.md", enabled: true }] } : { servers: [{ name: "node_repl", tools: [{ name: "js" }] }] }; },
    async mcpCall(request) {
      if (request.expectedGeneration !== this.generation) throw new Error("WORKBENCH_GENERATION_STALE");
      calls.push(request);
      if (this.beforeDispatch) await this.beforeDispatch(request);
      result = undefined;
      try { await vm.runInContext(`(async () => {${request.arguments.code}\n})()`, context); return { isError: false, text: result }; }
      catch (error) { return { isError: true, text: error.message }; }
    },
  };
  const executor = new CodexBrowserExecutor({ workbench, defaultCwd: "C:/fixture" });
  return { executor, workbench, inventory, browsers, effects, gets, calls };
}
const fails = (code) => (error) => { assert.equal(error.code, code); return true; };

test("one Chrome backend stays automatic and public results contain no provider IDs", async () => {
  const f = fixture(["Personal"]);
  const status = await f.executor.status();
  assert.equal(status.status, "ok");
  assert.equal(status.selectionRequired, false);
  assert.match(status.chrome.backendRef, /^browser_backend_/);
  const listed = await f.executor.listTabs();
  assert.equal(listed.backendRef, status.chrome.backendRef);
  assert.equal(listed.tabs[0].backendRef, status.chrome.backendRef);
  const read = await f.executor.readTab({ tabRef: listed.tabs[0].tabRef });
  assert.match(read.snapshot, /Personal/);
  assert.doesNotMatch(JSON.stringify([status, listed, read]), /private-provider|private-extension|same-tab-id/);
  assert.ok(f.gets.every((id) => id === f.inventory[0].id));
});

test("two extension profiles are healthy, preserve display names, and require exact selection", async () => {
  const f = fixture(); const status = await f.executor.status();
  assert.equal(status.status, "ok"); assert.equal(status.selectionRequired, true); assert.equal(status.chrome, null);
  assert.deepEqual(status.connectedBrowsers.map((b) => b.profileName), ["Personal", "Work"]);
  assert.equal(normalizeBrowserReaderHealth(status).status, "available");
  await assert.rejects(() => f.executor.listTabs(), fails("BROWSER_FAMILY_BACKEND_AMBIGUOUS"));
  await assert.rejects(() => f.executor.prepareOpenTab({ family: "chrome", url: "https://example.test/new" }), fails("BROWSER_FAMILY_BACKEND_AMBIGUOUS"));
  assert.equal(f.effects.length, 0);
  const [a,b] = status.connectedBrowsers;
  const first = await f.executor.listTabs({ backendRef: a.backendRef });
  const second = await f.executor.listTabs({ backendRef: b.backendRef });
  assert.notEqual(first.tabs[0].tabRef, second.tabs[0].tabRef);
  assert.match((await f.executor.readTab({ tabRef: first.tabs[0].tabRef })).snapshot, /Personal/);
  assert.match((await f.executor.readTab({ tabRef: second.tabs[0].tabRef })).snapshot, /Work/);
  // Listing profile B must not retire profile A's tab mapping.
  assert.match((await f.executor.readTab({ tabRef: first.tabs[0].tabRef })).snapshot, /Personal/);
  const prepared = await f.executor.prepareNavigate({ tabRef: second.tabs[0].tabRef, url: "https://example.test/next" });
  await f.executor.navigate({ actionApprovalRef: prepared.actionApprovalRef });
  assert.deepEqual(f.effects.filter((e) => e[1] === "goto"), [[f.inventory[1].id, "goto", "https://example.test/next"]]);
  await assert.rejects(() => f.executor.navigate({ actionApprovalRef: prepared.actionApprovalRef }), fails("BROWSER_ACTION_REF_EXPIRED"));
  await assert.rejects(() => f.executor.prepareBulkCloseTabs({ tabRefs: [first.tabs[0].tabRef, second.tabs[0].tabRef] }), fails("BROWSER_BULK_CLOSE_BACKEND_MIXED"));
});

test("new-tab preparation retains the selected backend even when inventory order changes", async () => {
  const f = fixture(); const b = (await f.executor.status()).connectedBrowsers[1];
  const prepared = await f.executor.prepareOpenTab({ family: "chrome", backendRef: b.backendRef, url: "https://example.test/new" });
  assert.equal(prepared.action.backendRef, b.backendRef);
  f.inventory.reverse();
  await f.executor.openTab({ actionApprovalRef: prepared.actionApprovalRef });
  assert.deepEqual(f.effects.filter((e) => e[1] === "new"), [["private-provider-1", "new"]]);
});

test("backend/tab/action refs expire after runtime generation change, even with reused provider IDs", async () => {
  const f = fixture(["Personal"]); const b = (await f.executor.status()).chrome;
  const tab = (await f.executor.listTabs()).tabs[0];
  const prepared = await f.executor.prepareOpenTab({ family: "chrome", backendRef: b.backendRef, url: "https://example.test/new" });
  f.workbench.generation++;
  await assert.rejects(() => f.executor.listTabs({ backendRef: b.backendRef }), fails("BROWSER_BACKEND_REF_STALE"));
  await assert.rejects(() => f.executor.readTab({ tabRef: tab.tabRef }), fails("BROWSER_TAB_REF_UNKNOWN"));
  await assert.rejects(() => f.executor.openTab({ actionApprovalRef: prepared.actionApprovalRef }), fails("BROWSER_ACTION_REF_EXPIRED"));
  assert.notEqual((await f.executor.status()).chrome.backendRef, b.backendRef);
  assert.equal(f.effects.length, 0);
});

test("disappearance or changed extension identity never falls back to the other profile", async () => {
  for (const changeIdentity of [false,true]) {
    const f = fixture(); const b = (await f.executor.status()).connectedBrowsers[0];
    const tab = (await f.executor.listTabs({ backendRef: b.backendRef })).tabs[0];
    const prepared = await f.executor.prepareNavigate({ tabRef: tab.tabRef, url: "https://example.test/next" });
    if (changeIdentity) f.inventory[0].metadata.extensionInstanceId = "replacement-extension";
    else f.inventory.shift();
    await assert.rejects(() => f.executor.readTab({ tabRef: tab.tabRef }), fails("BROWSER_BACKEND_REF_STALE"));
    await assert.rejects(() => f.executor.navigate({ actionApprovalRef: prepared.actionApprovalRef }), fails("BROWSER_BACKEND_REF_STALE"));
    assert.equal(f.effects.length, 0);
    // If a removed ID reappears later it receives a new opaque ref.
    if (!changeIdentity) { f.inventory.unshift({ id: "private-provider-0", name: "Chrome", family: "chrome", type: "extension", metadata: { extensionInstanceId: "private-extension-0" } }); }
    assert.notEqual((await f.executor.status()).connectedBrowsers[0].backendRef, b.backendRef);
  }
});

test("backend disappearance between readiness and dispatch fails before claim or mutation", async () => {
  const f = fixture(); const b = (await f.executor.status()).connectedBrowsers[0];
  const tab = (await f.executor.listTabs({ backendRef: b.backendRef })).tabs[0];
  const prepared = await f.executor.prepareNavigate({ tabRef: tab.tabRef, url: "https://example.test/next" });
  f.workbench.beforeDispatch = async (request) => { if (request.arguments.code.includes("__twTab.goto(")) f.inventory.shift(); };
  await assert.rejects(() => f.executor.navigate({ actionApprovalRef: prepared.actionApprovalRef }), fails("BROWSER_BACKEND_REF_STALE"));
  assert.equal(f.effects.length, 0);
});

test("duplicate profile names never select by name; renaming is dynamic display data", async () => {
  const f = fixture(["Same", "Same"]); const before = await f.executor.status();
  assert.notEqual(before.connectedBrowsers[0].backendRef, before.connectedBrowsers[1].backendRef);
  await assert.rejects(() => f.executor.listTabs(), fails("BROWSER_FAMILY_BACKEND_AMBIGUOUS"));
  await assert.rejects(() => f.executor.listTabs({ backendRef: "Same" }), fails("BROWSER_BACKEND_REF_INVALID"));
  await assert.rejects(() => f.executor.listTabs({ backendRef: f.inventory[0].id }), fails("BROWSER_BACKEND_REF_INVALID"));
  f.inventory[0].profileName = "Renamed";
  const after = await f.executor.status();
  assert.equal(after.connectedBrowsers[0].profileName, "Renamed");
  assert.equal(after.connectedBrowsers[0].backendRef, before.connectedBrowsers[0].backendRef);
});

test("documented methods are feature detected and missing backend/tab APIs fail explicitly", async () => {
  const f = fixture(["Personal"]); const browser = f.browsers.get(f.inventory[0].id);
  const b = (await f.executor.status()).chrome;
  delete browser.tabs.new;
  assert.equal((await f.executor.status()).chrome.capabilities.openTab, false);
  await assert.rejects(() => f.executor.prepareOpenTab({ family: "chrome", backendRef: b.backendRef, url: "https://example.test/new" }), fails("BROWSER_OPERATION_UNSUPPORTED"));
  const tab = (await f.executor.listTabs()).tabs[0];
  delete browser.tab.playwright.domSnapshot;
  await assert.rejects(() => f.executor.readTab({ tabRef: tab.tabRef }), fails("BROWSER_OPERATION_UNSUPPORTED"));
  assert.equal(f.effects.filter((e) => e[1] === "release").length, 1, "normal cleanup must run after failed tab capability check");
  delete browser.user.openTabs;
  const status = await f.executor.status();
  assert.equal(status.connectedBrowsers[0].capabilities.listTabs, false);
  await assert.rejects(() => f.executor.listTabs({ backendRef: b.backendRef }), fails("BROWSER_OPERATION_UNSUPPORTED"));
});

test("CDP/IAB/MCP Apps are inventoried without assuming extension semantics", async () => {
  const f = fixture(["Personal"]);
  for (const type of ["cdp", "iab", "mcpapps"]) f.inventory.push({ id: `private-${type}`, name: type, family: "chrome", type, profileName: "Other" });
  const status = await f.executor.status();
  assert.equal(status.selectionRequired, false);
  for (const backend of status.connectedBrowsers.slice(1)) {
    assert.equal(backend.supported, false); assert.equal(backend.capabilities.claimTabs, false);
    await assert.rejects(() => f.executor.listTabs({ backendRef: backend.backendRef }), fails("BROWSER_OPERATION_UNSUPPORTED"));
  }
  assert.ok(f.gets.every((id) => id === f.inventory[0].id), "unsupported backend types must not be accessed through extension APIs");
});

test("public contract adds only optional opaque selectors to the two entry points", async () => {
  const registered = new Map();
  registerBrowserPreviewTools({ registerTool(name, definition, handler) { registered.set(name,{definition,handler}); } }, {});
  assert.equal(registered.has("codex.browser_backends"), false);
  const backendRef = "browser_backend_00000000-0000-0000-0000-000000000000";
  assert.equal(registered.get("codex.browser_tabs").definition.inputSchema.safeParse({ backendRef }).success, true);
  assert.equal(registered.get("codex.browser_tabs").definition.inputSchema.safeParse({ backendRef: "private-provider-0" }).success, false);
  assert.equal(registered.get("codex.browser_prepare_open_tab").definition.inputSchema.safeParse({ family: "chrome", backendRef, url: "https://example.test/new" }).success, true);
  assert.equal(registered.get("codex.browser_read").definition.inputSchema.safeParse({ tabRef: "browser_tab_test", backendRef }).success, false);
});

test("capability rejection before navigation is definitive but failure after tab creation stays uncertain", async () => {
  const f = fixture(["Personal"]); const backend = f.browsers.get(f.inventory[0].id);
  const tab = (await f.executor.listTabs()).tabs[0];
  const prepared = await f.executor.prepareNavigate({ tabRef: tab.tabRef, url: "https://example.test/next" });
  delete backend.tab.goto;
  await assert.rejects(() => f.executor.navigate({ actionApprovalRef: prepared.actionApprovalRef }), fails("BROWSER_OPERATION_UNSUPPORTED"));
  assert.equal(f.effects.filter((e) => e[1] === "goto").length, 0);
  const open = await f.executor.prepareOpenTab({ family: "chrome", url: "https://example.test/new" });
  await assert.rejects(() => f.executor.openTab({ actionApprovalRef: open.actionApprovalRef }), fails("BROWSER_OPEN_TAB_RESULT_UNCERTAIN"));
  assert.equal(f.effects.filter((e) => e[1] === "new").length, 1);
  await assert.rejects(() => f.executor.openTab({ actionApprovalRef: open.actionApprovalRef }), fails("BROWSER_ACTION_REF_EXPIRED"));
});

test("missing/duplicate IDs and unbounded inventory fail closed", async () => {
  for (const mode of ["missing", "duplicate", "oversized"]) {
    const f = fixture(["Personal"]);
    if (mode === "missing") delete f.inventory[0].id;
    else if (mode === "duplicate") f.inventory.push({ ...f.inventory[0], metadata: { extensionInstanceId: "different" } });
    else f.inventory.push(...Array.from({ length: 64 }, (_, index) => ({ id: "other-" + index, name: "Other", type: "mcpapps" })));
    const status = await f.executor.status();
    assert.equal(status.status, "unavailable"); assert.equal(f.effects.length, 0);
    assert.doesNotMatch(JSON.stringify(status), /private-provider|private-extension/);
  }
});

test("a successful response from an older generation cannot mint new backend refs", async () => {
  const f = fixture(["Personal"]);
  f.workbench.beforeDispatch = async (request) => { if (request.arguments.title === "Check connected browser backends") f.workbench.generation++; };
  const status = await f.executor.status();
  assert.equal(status.reason, "BROWSER_WORKBENCH_RESTARTED");
  f.workbench.beforeDispatch = null;
  assert.equal((await f.executor.status()).status, "ok");
});

test("a selector cannot cross browser families or accept a wrongly resolved provider handle", async () => {
  const f = fixture(["Personal"]); const b = (await f.executor.status()).chrome;
  await assert.rejects(() => f.executor.listTabs({ family: "edge", backendRef: b.backendRef }), fails("BROWSER_BACKEND_FAMILY_MISMATCH"));
  f.workbench.beforeDispatch = async (request) => { if (request.arguments.title === "List current Chrome tabs") f.browsers.get(f.inventory[0].id).browserId = "wrong-profile"; };
  await assert.rejects(() => f.executor.listTabs({ backendRef: b.backendRef }), fails("BROWSER_BACKEND_REF_STALE"));
  assert.equal(f.effects.length, 0);
});
