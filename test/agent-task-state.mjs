import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentPreviewState, registerAgentPreviewTools } from "../src/agent-tools.mjs";

const stateFixture = JSON.parse(readFileSync(new URL("./fixtures/agent-task-state-v1.json", import.meta.url), "utf8"));

function createServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) { tools.set(name, { definition, handler }); },
    registerResource() {},
  };
}

function createAuthority() {
  return {
    async resolveAuthority({ cwd = null } = {}) {
      return { effectiveCwd: cwd ?? "/workspace", permissionProfile: ":read-only" };
    },
  };
}

function createExecutor({ failStart = false, startStatus = "idle" } = {}) {
  let starts = 0;
  return {
    get starts() { return starts; },
    async listModels() {
      return {
        models: [{
          id: "fixture-model",
          model: "fixture-model",
          displayName: "Fixture Model",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        }],
        nextCursor: null,
      };
    },
    async start(args) {
      starts += 1;
      if (failStart) throw new Error("fixture start failed");
      return {
        agentRef: "agent_fixture",
        turnId: "turn_fixture",
        status: startStatus,
        canSend: startStatus === "idle",
        pendingApproval: null,
        finalResult: startStatus === "running" ? null : `started:${args.clientRequestId}`,
        resourceReceipt: null,
        timing: { startedAt: 1, endedAt: startStatus === "running" ? null : 2, durationMs: startStatus === "running" ? null : 1 },
        execution: {
          requestedModel: args.model,
          resolvedModel: args.model ?? "fixture-model",
          modelProvider: "fixture",
          serviceTier: null,
          reasoningEffort: args.reasoningEffort,
        },
        events: [],
        nextSeq: 0,
      };
    },
    async show() {
      return {
        agentRef: "agent_fixture",
        turnId: "turn_fixture",
        status: "idle",
        canSend: true,
        pendingApproval: null,
        finalResult: null,
        resourceReceipt: null,
        timing: { startedAt: 1, endedAt: null, durationMs: null },
        execution: {
          requestedModel: "fixture-model",
          resolvedModel: "fixture-model",
          modelProvider: "fixture",
          serviceTier: null,
          reasoningEffort: "medium",
        },
        events: [],
        nextSeq: 0,
      };
    },
    async send() { throw new Error("fixture send not used"); },
    async resolveApproval() { throw new Error("fixture approval not used"); },
    async cancel() { throw new Error("fixture cancel not used"); },
  };
}

function register({ state, executor }) {
  const server = createServer();
  registerAgentPreviewTools(server, {
    agentExecutor: executor,
    authorityExecutor: createAuthority(),
    agentPreviewState: state,
  });
  return server.tools;
}

const root = mkdtempSync(path.join(os.tmpdir(), "codexless-agent-task-state-"));
try {
  const pendingFile = path.join(root, "pending.json");
  const pendingExecutor = createExecutor();
  const pendingState = createAgentPreviewState({
    meteredConsentMode: "always",
    taskStateFile: pendingFile,
  });
  const pendingTools = register({ state: pendingState, executor: pendingExecutor });
  const pending = await pendingTools.get("codex.agent_start").handler({ prompt: "pending fixture task", requestId: "fixture-pending-1" });
  assert.equal(pending.isError, false);
  assert.equal(pending.structuredContent.status, "consent_required");
  assert.equal(pendingExecutor.starts, 0, "metered preparation must not dispatch");
  const taskRef = pending.structuredContent.taskRef;
  assert.match(taskRef, /^task_/);

  const pendingStored = JSON.parse(readFileSync(pendingFile, "utf8"));
  assert.equal(pendingStored.version, stateFixture.version);
  assert.equal(pendingStored.records.length, 1);
  assert.equal(pendingStored.records[0].phase, stateFixture.pending.phase);
  assert.equal(pendingStored.records[0].consentRef, pending.structuredContent.meteredConsent.consentRef);
  assert.deepEqual(pendingStored.records[0].terminalSnapshot, stateFixture.pending.terminalSnapshot);
  assert.match(pendingStored.records[0].payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(statSync(pendingFile).mode & 0o777, 0o600);

  const recoveredExecutor = createExecutor();
  const recoveredState = createAgentPreviewState({ meteredConsentMode: "always", taskStateFile: pendingFile });
  const recoveredTools = register({ state: recoveredState, executor: recoveredExecutor });
  const recovered = await recoveredTools.get("codex.agent_card_state").handler({ taskRef });
  assert.equal(recovered.isError, false);
  assert.equal(recovered.structuredContent.status, "lost");
  assert.equal(recovered.structuredContent.terminal, true);
  assert.equal(recoveredExecutor.starts, 0, "restart recovery must never replay pending work");
  const recoveredAgain = await recoveredTools.get("codex.agent_card_state").handler({ taskRef });
  assert.equal(recoveredAgain.structuredContent.status, recovered.structuredContent.status);
  assert.equal(recoveredAgain.structuredContent.terminalAt, recovered.structuredContent.terminalAt, "first terminal recovery timestamp must win");
  assert.equal(recoveredAgain.structuredContent.latestError, recovered.structuredContent.latestError);
  assert.deepEqual(
    JSON.parse(readFileSync(pendingFile, "utf8")).records[0].terminalSnapshot,
    recoveredAgain.structuredContent,
    "persisted terminal recovery snapshot must remain stable",
  );

  const activeFile = path.join(root, "active.json");
  const activeExecutor = createExecutor({ startStatus: "running" });
  const activeState = createAgentPreviewState({ taskStateFile: activeFile });
  const activeTools = register({ state: activeState, executor: activeExecutor });
  const active = await activeTools.get("codex.agent_start").handler({ prompt: "active restart fixture", requestId: "fixture-active-restart-1" });
  assert.equal(active.structuredContent.status, "running");
  const activeTaskRef = active.structuredContent.taskRef;
  const activeRestartExecutor = createExecutor();
  const activeRestartState = createAgentPreviewState({ taskStateFile: activeFile });
  const activeRestartTools = register({ state: activeRestartState, executor: activeRestartExecutor });
  const activeLost = await activeRestartTools.get("codex.agent_card_state").handler({ taskRef: activeTaskRef });
  assert.equal(activeLost.structuredContent.status, "lost", "persisted active work must recover as terminal LOST");
  assert.equal(activeLost.structuredContent.terminal, true);
  assert.equal(activeRestartExecutor.starts, 0, "persisted active work must never replay after restart");

  const sendPendingExecutor = createExecutor();
  const sendPendingState = createAgentPreviewState({ meteredConsentMode: "always" });
  const sendPendingTools = register({ state: sendPendingState, executor: sendPendingExecutor });
  const sendPending = await sendPendingTools.get("codex.agent_send").handler({
    agentRef: "agent_fixture",
    message: "pending fixture follow-up",
    requestId: "fixture-send-pending-1",
  });
  assert.equal(sendPending.isError, false);
  assert.equal(sendPending.structuredContent.status, "consent_required");
  assert.equal(sendPending.structuredContent.agentRef, "agent_fixture");
  assert.equal(sendPending.structuredContent.execution.resolvedModel, "fixture-model");

  const failedSendFile = path.join(root, "failed-send.json");
  const failedSendExecutor = createExecutor();
  const failedSendState = createAgentPreviewState({ taskStateFile: failedSendFile });
  const failedSendTools = register({ state: failedSendState, executor: failedSendExecutor });
  const failedSend = await failedSendTools.get("codex.agent_send").handler({
    agentRef: "agent_fixture",
    message: "failed fixture follow-up",
    requestId: "fixture-send-failed-1",
  });
  assert.equal(failedSend.isError, false);
  assert.equal(failedSend.structuredContent.status, "failed");
  assert.equal(failedSend.structuredContent.agentRef, "agent_fixture");
  const failedSendReplay = await failedSendTools.get("codex.agent_send").handler({
    agentRef: "agent_fixture",
    message: "failed fixture follow-up",
    requestId: "fixture-send-failed-1",
  });
  assert.equal(failedSendReplay.structuredContent.duplicate, true);

  const failedFile = path.join(root, "failed.json");
  const failedExecutor = createExecutor({ failStart: true });
  const failedState = createAgentPreviewState({ taskStateFile: failedFile });
  const failedTools = register({ state: failedState, executor: failedExecutor });
  const failed = await failedTools.get("codex.agent_start").handler({ prompt: "failed fixture task", requestId: "fixture-failed-1" });
  assert.equal(failed.isError, false);
  assert.equal(failed.structuredContent.status, "failed");
  assert.equal(failed.structuredContent.terminal, true);
  assert.equal(failedExecutor.starts, 1);
  const failedStored = JSON.parse(readFileSync(failedFile, "utf8"));
  assert.equal(failedStored.records[0].phase, stateFixture.terminal.phase);
  assert.equal(failedStored.records[0].terminalSnapshot.terminal, stateFixture.terminal.terminal);
  assert.equal(failedStored.records[0].terminalSnapshot.status, "failed");

  const failedReplay = await failedTools.get("codex.agent_start").handler({ prompt: "failed fixture task", requestId: "fixture-failed-1" });
  assert.equal(failedReplay.isError, false);
  assert.equal(failedReplay.structuredContent.duplicate, true);
  assert.equal(failedReplay.structuredContent.latestError, failed.structuredContent.latestError);
  assert.equal(failedExecutor.starts, 1, "terminal request replay must not dispatch twice");

  const restartedExecutor = createExecutor();
  const restartedState = createAgentPreviewState({ taskStateFile: failedFile });
  const restartedTools = register({ state: restartedState, executor: restartedExecutor });
  const restartedReplay = await restartedTools.get("codex.agent_start").handler({ prompt: "failed fixture task", requestId: "fixture-failed-1" });
  assert.equal(restartedReplay.isError, false);
  assert.equal(restartedReplay.structuredContent.duplicate, true);
  assert.equal(restartedReplay.structuredContent.status, "failed");
  assert.equal(restartedExecutor.starts, 0, "persisted terminal replay must not dispatch after restart");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("agent task-state consolidation contract PASS");
