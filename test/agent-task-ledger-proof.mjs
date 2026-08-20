import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentTaskLedger } from "../src/agent-task-ledger.mjs";
import { createAgentPreviewState, registerAgentPreviewTools } from "../src/agent-tools.mjs";

const quotaProvider = async () => ({
  status: "ok",
  observedAt: "2026-08-20T00:00:00.000Z",
  usage: { status: "ok" },
  rateLimits: { status: "ok", value: { limits: [] } },
});

// Pure ledger transition/model checks: consent identity, namespaced request
// keys, terminal first-wins, and duplicate/changed-payload behavior.
const ledger = createAgentTaskLedger({ mode: "always", quotaProvider });
const startPayload = { prompt: "model-start", cwd: "/workspace", model: null, permissionProfile: ":read-only" };
const prepared = await ledger.authorize({ action: "start", requestId: "same-key", payload: startPayload });
assert.equal(prepared.authorized, false);
assert.equal(prepared.duplicate, false);
const duplicate = await ledger.authorize({ action: "start", requestId: "same-key", payload: startPayload });
assert.equal(duplicate.authorized, false);
assert.equal(duplicate.duplicate, true);
await assert.rejects(
  () => ledger.authorize({ action: "start", requestId: "same-key", payload: { ...startPayload, prompt: "changed" } }),
  /different metered start request/,
);
const record = ledger.createTask({
  consent: prepared.consent,
  action: "start",
  payload: startPayload,
  cwd: "/workspace",
  permissionProfile: ":read-only",
});
const first = ledger.freeze(record, { status: "completed", agentRef: "agent-A", turnId: "turn-A", finalResult: "A", events: [], nextSeq: 0 });
const later = ledger.freeze(record, { status: "failed", agentRef: "agent-A", turnId: "turn-A", finalResult: "B", events: [], nextSeq: 1 });
assert.equal(first.finalResult, "A");
assert.equal(later.finalResult, "A", "terminal snapshot A must remain latched over later B");

// Filesystem boundary checks: exact v1 order/mode, orphan temp ignored, and
// corrupt state blocks before an executor dispatch.
const root = mkdtempSync(path.join(os.tmpdir(), "codexless-ledger-proof-"));
try {
  const file = path.join(root, "state.json");
  const persisted = createAgentTaskLedger({ mode: "off", taskStateFile: file });
  const persistedRecord = persisted.createTask({
    action: "start",
    requestId: "persisted",
    payload: startPayload,
    cwd: "/workspace",
    permissionProfile: ":read-only",
    authorized: true,
  });
  const document = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(document.version, 1);
  assert.deepEqual(Object.keys(document.records[0]), [
    "taskRef", "consentRef", "requestId", "action", "payloadHash", "taskCard", "subjectRef", "agentRef", "turnId", "phase", "terminalSnapshot", "updatedAt",
  ]);
  const mode = (await import("node:fs")).statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  writeFileSync(`${file}.tmp-orphan`, JSON.stringify({ version: 1, records: [{ taskRef: "orphan", phase: "terminal" }] }));
  const restarted = createAgentTaskLedger({ mode: "off", taskStateFile: file });
  assert.equal(restarted.recover(persistedRecord.taskRef).status, "lost");
  assert.equal(restarted.recover(persistedRecord.taskRef).terminalAt > 0, true);
  assert.ok(readdirSync(root).some((name) => name.includes("tmp-orphan")), "temporary remnants stay non-authoritative");

  const corrupt = path.join(root, "corrupt.json");
  writeFileSync(corrupt, "{not-json");
  let starts = 0;
  const tools = new Map();
  registerAgentPreviewTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); }, registerResource() {} }, {
    agentPreviewState: createAgentPreviewState({ meteredConsentMode: "off", taskStateFile: corrupt }),
    authorityExecutor: { async resolveAuthority({ cwd = null } = {}) { return { effectiveCwd: cwd ?? "/workspace", permissionProfile: ":read-only" }; } },
    agentExecutor: {
      async listModels() { return { models: [], nextCursor: null }; },
      async start() { starts += 1; return {}; },
    },
  });
  const blocked = await tools.get("codex.agent_start").handler({ prompt: "blocked", requestId: "blocked" });
  assert.equal(blocked.isError, true);
  assert.equal(starts, 0, "corrupt persistence must block remote dispatch");
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Invalid pre-dispatch durability path: no executor call is allowed.
let dispatches = 0;
const invalidState = createAgentPreviewState({ meteredConsentMode: "off", taskStateFile: "/dev/null/codexless/state.json" });
const invalidTools = new Map();
registerAgentPreviewTools({ registerTool(name, definition, handler) { invalidTools.set(name, { definition, handler }); }, registerResource() {} }, {
  agentPreviewState: invalidState,
  authorityExecutor: { async resolveAuthority({ cwd = null } = {}) { return { effectiveCwd: cwd ?? "/workspace", permissionProfile: ":read-only" }; } },
  agentExecutor: { async listModels() { return { models: [], nextCursor: null }; }, async start() { dispatches += 1; return {}; } },
});
const blockedWrite = await invalidTools.get("codex.agent_start").handler({ prompt: "durability", requestId: "durability" });
assert.equal(blockedWrite.isError, true);
assert.equal(dispatches, 0, "failed pre-dispatch durability must not call executor");

// Real process-boundary checks: a child is killed after a durable active write
// and after a durable terminal rename. Recovery must never replay active work,
// while the terminal snapshot remains the exact first snapshot.
async function crashAfter(script, file) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child crash proof timed out")), 5_000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("READY")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== "SIGKILL") { clearTimeout(timer); reject(new Error(`unexpected child exit ${code}/${signal}`)); }
    });
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.ok(readdirSync(path.dirname(file)).some((name) => name === path.basename(file)));
}

const crashRoot = mkdtempSync(path.join(os.tmpdir(), "codexless-ledger-crash-"));
try {
  const activeFile = path.join(crashRoot, "active.json");
  const modulePath = path.resolve("src/agent-task-ledger.mjs");
  await crashAfter(`import { createAgentTaskLedger } from ${JSON.stringify(`file://${modulePath}`)}; const l=createAgentTaskLedger({mode:"off",taskStateFile:${JSON.stringify(activeFile)}}); const r=l.createTask({action:"start",requestId:"crash-active",payload:{prompt:"crash",cwd:"/workspace",model:null,permissionProfile:":read-only"},cwd:"/workspace",permissionProfile:":read-only",authorized:true}); l.markActive(r); console.log("READY"); setInterval(()=>{},1000);`, activeFile);
  const activeRestart = createAgentTaskLedger({ mode: "off", taskStateFile: activeFile });
  assert.equal(activeRestart.recover(JSON.parse(readFileSync(activeFile, "utf8")).records[0].taskRef).status, "lost");

  const terminalFile = path.join(crashRoot, "terminal.json");
  await crashAfter(`import { createAgentTaskLedger } from ${JSON.stringify(`file://${modulePath}`)}; const l=createAgentTaskLedger({mode:"off",taskStateFile:${JSON.stringify(terminalFile)}}); const r=l.createTask({action:"start",requestId:"crash-terminal",payload:{prompt:"terminal",cwd:"/workspace",model:null,permissionProfile:":read-only"},cwd:"/workspace",permissionProfile:":read-only",authorized:true}); l.freeze(r,{status:"completed",agentRef:null,turnId:null,finalResult:"terminal-A",events:[],nextSeq:0}); console.log("READY"); setInterval(()=>{},1000);`, terminalFile);
  const terminalDocument = JSON.parse(readFileSync(terminalFile, "utf8"));
  const terminalRestart = createAgentTaskLedger({ mode: "off", taskStateFile: terminalFile });
  const terminal = terminalRestart.recover(terminalDocument.records[0].taskRef);
  assert.equal(terminal.finalResult, "terminal-A");
} finally {
  rmSync(crashRoot, { recursive: true, force: true });
}

console.log("agent task ledger model + filesystem fault proof PASS");
