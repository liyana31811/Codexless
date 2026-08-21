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

  const terminalExactFile = path.join(root, "terminal-exact.json");
  const terminalLedger = createAgentTaskLedger({ mode: "off", taskStateFile: terminalExactFile });
  const terminalRecord = terminalLedger.createTask({
    action: "start",
    requestId: "terminal-exact",
    payload: startPayload,
    cwd: "/workspace",
    permissionProfile: ":read-only",
    authorized: true,
  });
  const terminalSnapshot = terminalLedger.freeze(terminalRecord, {
    agentRef: "terminal-agent",
    turnId: "terminal-turn",
    status: "completed",
    canSend: false,
    pendingApproval: null,
    finalResult: "terminal result A",
    meteredConsent: { status: "approved", quota: null },
    resourceReceipt: { tokenUsage: { turn: { totalTokens: 7 } } },
    timing: { startedAt: 1, endedAt: 2, durationMs: 1 },
    execution: { requestedModel: "fixture", resolvedModel: "fixture" },
    latestError: null,
    events: [{ seq: 1, type: "turn/accepted" }],
    nextSeq: 2,
  });
  const terminalRestart = createAgentTaskLedger({ mode: "off", taskStateFile: terminalExactFile });
  assert.deepEqual(
    terminalRestart.recover(terminalRecord.taskRef),
    terminalSnapshot,
    "a successfully renamed terminal snapshot must replay the exact first projection",
  );

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

// Concurrent callers must share one namespaced consent identity and one
// remote dispatch even though the public handlers await authority/model work
// before creating their task record.
let quotaCalls = 0;
let releaseQuota;
const quotaGate = new Promise((resolve) => { releaseQuota = resolve; });
const concurrentLedger = createAgentTaskLedger({
  mode: "always",
  quotaProvider: async () => {
    quotaCalls += 1;
    await quotaGate;
    return { status: "ok", observedAt: "2026-08-20T00:00:00.000Z", usage: { status: "ok" }, rateLimits: { status: "ok", value: { limits: [] } } };
  },
});
const concurrentA = concurrentLedger.authorize({ action: "start", requestId: "concurrent", payload: startPayload });
const concurrentB = concurrentLedger.authorize({ action: "start", requestId: "concurrent", payload: startPayload });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(quotaCalls, 1, "concurrent same-key consent preparation must capture quota once");
releaseQuota();
const [consentA, consentB] = await Promise.all([concurrentA, concurrentB]);
assert.equal(consentA.consent.consentRef, consentB.consent.consentRef);
assert.equal(consentA.duplicate, false);
assert.equal(consentB.duplicate, true);

const concurrentTools = new Map();
const concurrentServer = {
  registerTool(name, definition, handler) { concurrentTools.set(name, { definition, handler }); },
  registerResource() {},
};
let concurrentStarts = 0;
let releaseStart;
const startGate = new Promise((resolve) => { releaseStart = resolve; });
registerAgentPreviewTools(concurrentServer, {
  agentPreviewState: createAgentPreviewState({ meteredConsentMode: "off" }),
  authorityExecutor: {
    async resolveAuthority({ cwd = null } = {}) {
      await Promise.resolve();
      return { effectiveCwd: cwd ?? "/workspace", permissionProfile: ":read-only" };
    },
  },
  agentExecutor: {
    async listModels() { return { models: [], nextCursor: null }; },
    async start() {
      concurrentStarts += 1;
      await startGate;
      return { agentRef: "concurrent-agent", turnId: "concurrent-turn", status: "completed", canSend: false, finalResult: "ok", resourceReceipt: null, timing: { startedAt: 1, endedAt: 2, durationMs: 1 }, execution: {}, events: [], nextSeq: 0 };
    },
    async show() { return {}; },
    async send() { throw new Error("send not used"); },
    async resolveApproval() { throw new Error("approval not used"); },
    async cancel() { throw new Error("cancel not used"); },
  },
});
const concurrentStart = concurrentTools.get("codex.agent_start").handler;
const concurrentCallA = concurrentStart({ prompt: "same concurrent task", requestId: "same-concurrent-start" });
const concurrentCallB = concurrentStart({ prompt: "same concurrent task", requestId: "same-concurrent-start" });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(concurrentStarts, 1, "same task record must not dispatch twice while the first dispatch is in flight");
releaseStart();
const [concurrentResultA, concurrentResultB] = await Promise.all([concurrentCallA, concurrentCallB]);
assert.equal(concurrentResultA.isError, false);
assert.equal(concurrentResultB.isError, false);
assert.equal(concurrentResultA.structuredContent.taskRef, concurrentResultB.structuredContent.taskRef);
assert.equal(concurrentResultB.structuredContent.duplicate, true);

// A remote acceptance-unknown result is active, not failed: an exact retry
// re-reads official state and never issues a second start request.
const unknownTools = new Map();
const unknownServer = {
  registerTool(name, definition, handler) { unknownTools.set(name, { definition, handler }); },
  registerResource() {},
};
let unknownStarts = 0;
registerAgentPreviewTools(unknownServer, {
  agentPreviewState: createAgentPreviewState({ meteredConsentMode: "off" }),
  authorityExecutor: { async resolveAuthority({ cwd = null } = {}) { return { effectiveCwd: cwd ?? "/workspace", permissionProfile: ":read-only" }; } },
  agentExecutor: {
    async listModels() { return { models: [], nextCursor: null }; },
    async start() {
      unknownStarts += 1;
      return { agentRef: "unknown-agent", turnId: "unknown-turn", status: "unknown", canSend: false, finalResult: null, latestError: "turn/start acceptance unknown", resourceReceipt: null, timing: { startedAt: 1, endedAt: null, durationMs: null }, execution: {}, events: [{ seq: 1, type: "turn/acceptance-unknown" }], nextSeq: 2 };
    },
    async show() {
      return { agentRef: "unknown-agent", turnId: "unknown-turn", status: "unknown", canSend: false, finalResult: null, latestError: "turn/start acceptance unknown", resourceReceipt: null, timing: { startedAt: 1, endedAt: null, durationMs: null }, execution: {}, events: [{ seq: 1, type: "turn/acceptance-unknown" }], nextSeq: 2 };
    },
    async send() { throw new Error("send not used"); },
    async resolveApproval() { throw new Error("approval not used"); },
    async cancel() { throw new Error("cancel not used"); },
  },
});
const unknownStart = unknownTools.get("codex.agent_start").handler;
const unknownFirst = await unknownStart({ prompt: "accepted but response lost", requestId: "acceptance-unknown" });
assert.equal(unknownFirst.isError, false);
assert.equal(unknownFirst.structuredContent.status, "unknown");
const unknownRetry = await unknownStart({ prompt: "accepted but response lost", requestId: "acceptance-unknown" });
assert.equal(unknownRetry.isError, false);
assert.equal(unknownRetry.structuredContent.status, "unknown");
assert.equal(unknownStarts, 1, "acceptance-unknown retry must not dispatch a second start");

// Authority/current-turn revalidation happens before consuming the server-only
// commit capability. A stale card remains pending and can be committed again
// after authority is restored; no executor call occurs on the failed attempt.
const authorityTools = new Map();
const authorityServer = {
  registerTool(name, definition, handler) { authorityTools.set(name, { definition, handler }); },
  registerResource() {},
};
let authorityCalls = 0;
let authorityStarts = 0;
registerAgentPreviewTools(authorityServer, {
  agentPreviewState: createAgentPreviewState({ meteredConsentMode: "always" }),
  authorityExecutor: {
    async resolveAuthority({ cwd = null } = {}) {
      authorityCalls += 1;
      return authorityCalls === 2
        ? { effectiveCwd: "/moved", permissionProfile: ":read-only" }
        : { effectiveCwd: cwd ?? "/workspace", permissionProfile: ":read-only" };
    },
  },
  agentExecutor: {
    async listModels() {
      return { models: [{ id: "adversary-model", model: "adversary-model", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: null };
    },
    async start() {
      authorityStarts += 1;
      return { agentRef: "authority-agent", turnId: "authority-turn", status: "completed", canSend: false, finalResult: "ok", resourceReceipt: null, timing: { startedAt: 1, endedAt: 2, durationMs: 1 }, execution: {}, events: [], nextSeq: 0 };
    },
    async show() { return {}; },
    async send() { throw new Error("send not used"); },
    async resolveApproval() { throw new Error("approval not used"); },
    async cancel() { throw new Error("cancel not used"); },
  },
});
const authorityStart = authorityTools.get("codex.agent_start").handler;
const authorityRender = authorityTools.get("codex.agent_card_render").handler;
const authorityCommit = authorityTools.get("codex.agent_commit").handler;
const authorityPrepared = await authorityStart({ prompt: "authority revalidation", requestId: "authority-revalidation" });
const authorityConsentRef = authorityPrepared.structuredContent.meteredConsent.consentRef;
const authorityCard = await authorityRender({ consentRef: authorityConsentRef });
const authorityToken = authorityCard._meta.codexlessCommitToken;
const staleCommit = await authorityCommit({ consentRef: authorityConsentRef, commitToken: authorityToken });
assert.equal(staleCommit.isError, true);
assert.equal(authorityStarts, 0, "stale authority must block dispatch before commit");
const stillPending = await authorityRender({ consentRef: authorityConsentRef });
assert.equal(stillPending.isError, false);
assert.equal(stillPending.structuredContent.status, "consent_required", "failed preflight must not consume approval capability");
const restoredCommit = await authorityCommit({ consentRef: authorityConsentRef, commitToken: authorityToken });
assert.equal(restoredCommit.isError, false);
assert.equal(authorityStarts, 1);

console.log("agent task ledger model + filesystem fault proof PASS");
