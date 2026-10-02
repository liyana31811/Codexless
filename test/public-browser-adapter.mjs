import assert from "node:assert/strict";
import path from "node:path";
import { CodexBrowserExecutor } from "../src/codex-browser-executor.mjs";
import { CodexPublicBrowserWorkbenchAdapter } from "../src/public-browser-workbench-adapter.mjs";

const cwd = path.resolve("C:/codexless-public-browser-adapter-fixture");
class FakePublicContext {
  constructor() { this.generation = 1; this.calls = []; this.prerequisiteCalls = []; }
  async browserPrerequisites(request = {}) {
    this.prerequisiteCalls.push(structuredClone(request));
    return { status: "ok", chromeSkillPath: path.join(cwd, "skills", "chrome", "SKILL.md"), nodeRepl: true, nodeReplError: null };
  }
  async nodeReplCall(request) {
    this.calls.push(structuredClone(request));
    const title = request?.arguments?.title ?? "";
    const code = request?.arguments?.code ?? "";
    if (title === "Check connected browser backends") return ok([{ id: "fixture-chrome-0", name: "Chrome", family: "chrome", type: "extension", capabilities: { listTabs: true, claimTabs: true, openTab: true, explicitRelease: true } }]);
    if (title === "List current Chrome tabs") return ok([{ providerTabId: "provider-a", title: "A", url: "https://example.com/a", lastOpened: "2026-08-19T00:00:00Z" }]);
    if (title === "Read existing Chrome tab DOM") return ok({ title: "A", url: "https://example.com/a", lastOpened: "2026-08-19T00:00:00Z", snapshot: "A snapshot", lifecycleMode: "session-resume" });
    if (title === "Adapter passthrough probe") return { isError: true, text: "generic downstream error" };
    throw new Error(`unexpected fake Browser call: ${title} / ${code.slice(0,80)}`);
  }
}
const ok = (value) => ({ isError: false, text: JSON.stringify(value) });
const context = new FakePublicContext();
const neutralRuntimeCwd = path.resolve("C:/codexless-browser-runtime-neutral");
const adapter = new CodexPublicBrowserWorkbenchAdapter({ context, runtimeCwd: neutralRuntimeCwd });
assert.equal(adapter.generation, 1);
assert.deepEqual(await adapter.catalog({ kind: "skills", cwd }), { skills: [{ name: "chrome:control-chrome", path: path.join(cwd, "skills", "chrome", "SKILL.md"), enabled: true }] });
assert.deepEqual(await adapter.catalog({ kind: "mcp", cwd }), { servers: [{ name: "node_repl", tools: [{ name: "js" }], error: null }] });
assert.equal(context.prerequisiteCalls.at(-1)?.cwd, cwd, "tool/thread cwd must survive a neutral Browser process cwd");
await assert.rejects(() => adapter.mcpCall({ server: "other", tool: "js", cwd }), /only exposes node_repl.*js/i);
const passthrough = await adapter.mcpCall({ server: "node_repl", tool: "js", cwd, arguments: { title: "Adapter passthrough probe", code: "x" }, expectedGeneration: 1 });
assert.deepEqual(passthrough, { isError: true, text: "generic downstream error" });
assert.equal(context.calls.at(-1)?.cwd, cwd, "node_repl thread/tool call must keep the caller cwd");
await adapter.mcpCall({ server: "node_repl", tool: "js", arguments: { title: "Adapter passthrough probe", code: "x" }, expectedGeneration: 1 });
assert.equal(context.calls.at(-1)?.cwd, neutralRuntimeCwd, "neutral cwd is only the fallback when the Browser tool has no cwd");

const browser = new CodexBrowserExecutor({ workbench: adapter, defaultCwd: cwd });
const first = await browser.listTabs({ cwd });
assert.equal(first.count, 1);
const firstRef = first.tabs[0].tabRef;
const firstListCall = context.calls.find((call) => call?.arguments?.title === "List current Chrome tabs");
const firstSessionId = firstListCall?.meta?.["x-codex-turn-metadata"]?.session_id;
assert.match(firstSessionId ?? "", /^toolwire-browser-/);
context.generation += 1;
assert.equal(adapter.generation, 2, "adapter generation must follow the public context singleton lifecycle");
const second = await browser.listTabs({ cwd });
assert.equal(second.count, 1);
assert.notEqual(second.tabs[0].tabRef, firstRef, "public context generation advance must retire old opaque Browser refs");
const listCalls = context.calls.filter((call) => call?.arguments?.title === "List current Chrome tabs");
assert.match(listCalls.at(-1)?.meta?.["x-codex-turn-metadata"]?.session_id ?? "", /^toolwire-browser-/);
await assert.rejects(() => browser.readTab({ tabRef: firstRef, cwd, maxChars: 1000 }), (error) => error?.code === "BROWSER_TAB_REF_UNKNOWN");

const staleAdapter = new CodexPublicBrowserWorkbenchAdapter({ context: {
  generation: 3,
  async browserPrerequisites() { return { status: "ok", chromeSkillPath: "C:/fake/SKILL.md", nodeRepl: true }; },
  async nodeReplCall() { throw new Error("PUBLIC_CONTEXT_GENERATION_STALE: expected 2, current 3"); },
} });
await assert.rejects(() => staleAdapter.mcpCall({ server: "node_repl", tool: "js", cwd, arguments: {} }), /WORKBENCH_GENERATION_STALE:PUBLIC_CONTEXT_GENERATION_STALE/i);
console.log("Public Browser workbench adapter lifecycle PASS");
