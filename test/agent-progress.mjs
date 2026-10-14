import assert from "node:assert/strict";
import path from "node:path";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { registerAgentPreviewTools } from "../src/agent-tools.mjs";

class FakeClient {
  constructor() {
    this.running = false;
    this.initializedResult = null;
    this.serverRequestMethods = [];
    this.requests = [];
    this.threadId = "thread-progress-1";
    this.currentTurnId = null;
    this.turnStatus = null;
    this.turnCounter = 0;
    this.notificationHandler = null;
  }

  async start() {
    this.running = true;
    this.initializedResult = { ok: true };
    return this.initializedResult;
  }

  onNotification(handler) {
    this.notificationHandler = handler;
    return () => {
      if (this.notificationHandler === handler) this.notificationHandler = null;
    };
  }

  emit(method, params) {
    if (method === "turn/completed") this.turnStatus = params?.turn?.status ?? "completed";
    this.notificationHandler?.({ method, params: structuredClone(params) });
  }

  async close() {
    this.running = false;
  }

  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "thread/start") {
      return {
        thread: { id: this.threadId, canAcceptDirectInput: true },
        model: "fake-model",
        modelProvider: "openai",
        serviceTier: null,
        reasoningEffort: "medium",
      };
    }
    if (method === "turn/start") {
      this.turnCounter += 1;
      this.currentTurnId = `turn-progress-${this.turnCounter}`;
      this.turnStatus = "inProgress";
      return { turn: { id: this.currentTurnId, status: this.turnStatus, items: [] } };
    }
    if (method === "thread/turns/list") {
      return {
        data: this.currentTurnId
          ? [{ id: this.currentTurnId, status: this.turnStatus, items: [] }]
          : [],
      };
    }
    if (method === "thread/resume") {
      return {
        thread: { id: this.threadId, canAcceptDirectInput: true },
        model: "fake-model",
        modelProvider: "openai",
        serviceTier: null,
        reasoningEffort: "medium",
      };
    }
    throw new Error(`unexpected fake request: ${method}`);
  }
}

const fake = new FakeClient();
const executor = new CodexAgentExecutor({
  defaultCwd: path.resolve("."),
  clientFactory: () => fake,
});
await executor.open();

const started = await executor.start({
  task: "Inspect harmless local fixture and report bounded progress",
  clientRequestId: "progress-start-1",
});
assert.equal(started.status, "running");
assert.deepEqual(started.progress, { latestAgentMessage: null, plan: null, activeItem: null });

const currentTurnId = started.turnId;
const hugeExplanation = `explain:${"e".repeat(9_000)}`;
const hugeMessage = `prefix-secret-${"m".repeat(9_000)}-VISIBLE_TAIL`;
const hugeStep = `step:${"s".repeat(3_000)}`;
const plan = Array.from({ length: 70 }, (_, index) => ({
  step: index === 0 ? hugeStep : `step-${index}`,
  status: index === 1 ? "inProgress" : "pending",
}));

fake.emit("turn/plan/updated", {
  threadId: fake.threadId,
  turnId: currentTurnId,
  explanation: hugeExplanation,
  plan,
});
fake.emit("item/started", {
  threadId: fake.threadId,
  turnId: currentTurnId,
  item: {
    id: "message-current",
    type: "agentMessage",
    phase: "commentary",
    status: "inProgress",
    text: hugeMessage,
  },
});
fake.emit("item/started", {
  threadId: fake.threadId,
  turnId: currentTurnId,
  item: {
    id: "command-current",
    type: "commandExecution",
    status: "inProgress",
    command: "SECRET_COMMAND_MUST_NOT_LEAK --token super-secret",
    aggregatedOutput: "SECRET_OUTPUT_MUST_NOT_LEAK",
  },
});

fake.emit("turn/plan/updated", {
  threadId: fake.threadId,
  turnId: "turn-stale",
  explanation: "STALE_PLAN_MUST_NOT_REPLACE_CURRENT",
  plan: [{ step: "stale", status: "inProgress" }],
});
fake.emit("item/agentMessage/delta", {
  threadId: fake.threadId,
  turnId: "turn-stale",
  itemId: "message-stale",
  delta: "STALE_MESSAGE_MUST_NOT_REPLACE_CURRENT",
});

let progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.progress.plan.plan.length, 64);
assert.equal(progressSnapshot.progress.plan.truncated, true);
assert.equal(progressSnapshot.progress.plan.explanation.length, 8_192);
assert.equal(progressSnapshot.progress.plan.plan[0].step.length, 2_048);
assert.equal(progressSnapshot.progress.latestAgentMessage.text.length, 8_192);
assert.equal(progressSnapshot.progress.latestAgentMessage.text.endsWith("VISIBLE_TAIL"), true);
assert.equal(progressSnapshot.progress.latestAgentMessage.truncated, true);
assert.deepEqual(
  {
    id: progressSnapshot.progress.activeItem.id,
    type: progressSnapshot.progress.activeItem.type,
    status: progressSnapshot.progress.activeItem.status,
  },
  { id: "command-current", type: "commandExecution", status: "inProgress" },
);
assert.doesNotMatch(JSON.stringify(progressSnapshot.progress), /SECRET_COMMAND|SECRET_OUTPUT|super-secret/);
assert.doesNotMatch(JSON.stringify(progressSnapshot.progress), /STALE_PLAN|STALE_MESSAGE/);
assert.equal(
  progressSnapshot.events.some((event) => event.type === "stale-turn-notification-ignored"),
  true,
);

fake.emit("turn/completed", {
  threadId: fake.threadId,
  turn: {
    id: currentTurnId,
    status: "completed",
    items: [{ id: "final", type: "agentMessage", text: "Final bounded result" }],
  },
});
progressSnapshot = await executor.show({ agentRef: started.agentRef });
assert.equal(progressSnapshot.status, "idle");
assert.equal(progressSnapshot.progress.activeItem, null);

const second = await executor.send({
  agentRef: started.agentRef,
  message: "Start a clean second turn",
  clientRequestId: "progress-send-2",
});
assert.equal(second.status, "running");
assert.notEqual(second.turnId, currentTurnId);
assert.deepEqual(second.progress, { latestAgentMessage: null, plan: null, activeItem: null });

function captureServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
    registerResource() {},
  };
}

const publicServer = captureServer();
const maliciousSnapshot = {
  agentRef: "agent-public-progress",
  turnId: "turn-public-progress",
  status: "running",
  canSend: false,
  pendingApproval: null,
  finalResult: null,
  progress: {
    latestAgentMessage: {
      itemId: "m".repeat(700),
      phase: "commentary",
      text: `hidden-prefix-${"x".repeat(9_000)}-PUBLIC_TAIL`,
      truncated: false,
      status: "inProgress",
      updatedAt: 100,
      rawReasoning: "SECRET_REASONING_MUST_NOT_LEAK",
    },
    plan: {
      explanation: `plan:${"p".repeat(9_000)}`,
      plan: Array.from({ length: 70 }, (_, index) => ({
        step: index === 0 ? "z".repeat(3_000) : `public-step-${index}`,
        status: "pending",
        privateExtra: "DROP_ME",
      })),
      truncated: false,
      updatedAt: 101,
      privateExtra: "DROP_ME",
    },
    activeItem: {
      id: "cmd-public",
      type: "commandExecution",
      status: "inProgress",
      updatedAt: 102,
      command: "SECRET_COMMAND_MUST_NOT_LEAK",
      output: "SECRET_OUTPUT_MUST_NOT_LEAK",
    },
    reasoning: "SECRET_REASONING_MUST_NOT_LEAK",
    transcript: "SECRET_TRANSCRIPT_MUST_NOT_LEAK",
  },
  resourceReceipt: null,
  timing: { startedAt: 1, endedAt: null, durationMs: null },
  execution: {
    requestedModel: "fake-model",
    resolvedModel: "fake-model",
    modelProvider: "fake",
    serviceTier: null,
    reasoningEffort: "medium",
  },
  latestError: null,
  events: [],
  nextSeq: 0,
};
const publicExecutor = {
  async listModels() { return { models: [], nextCursor: null }; },
  async show({ agentRef }) {
    assert.equal(agentRef, maliciousSnapshot.agentRef);
    return structuredClone(maliciousSnapshot);
  },
};
registerAgentPreviewTools(publicServer, {
  agentExecutor: publicExecutor,
  authorityExecutor: {
    async resolveAuthority({ cwd }) {
      return {
        effectiveCwd: path.resolve(cwd ?? "."),
        permissionProfile: ":read-only",
        permissionCeiling: ":read-only",
        authoritySource: "test",
        trustedAncestor: path.resolve("."),
      };
    },
  },
  meteredConsentMode: "off",
});

const showTool = publicServer.tools.get("codex.agent_show");
assert.match(showTool.definition.description, /bounded native progress/i);
assert.match(showTool.definition.description, /excludes raw reasoning, command output, file diffs\/patches, MCP payload\/output/i);
const publicShow = await showTool.handler({ agentRef: maliciousSnapshot.agentRef, afterSeq: 0 });
assert.equal(publicShow.isError, false);
assert.equal(publicShow.structuredContent.progress.latestAgentMessage.text.length, 8_192);
assert.equal(publicShow.structuredContent.progress.latestAgentMessage.text.endsWith("PUBLIC_TAIL"), true);
assert.equal(publicShow.structuredContent.progress.latestAgentMessage.itemId.length, 512);
assert.equal(publicShow.structuredContent.progress.plan.plan.length, 64);
assert.equal(publicShow.structuredContent.progress.plan.plan[0].step.length, 2_048);
assert.equal(publicShow.structuredContent.progress.plan.truncated, true);
assert.deepEqual(publicShow.structuredContent.progress.activeItem, {
  id: "cmd-public",
  type: "commandExecution",
  status: "inProgress",
  updatedAt: 102,
});
assert.doesNotMatch(
  JSON.stringify(publicShow.structuredContent.progress),
  /DROP_ME|SECRET_COMMAND|SECRET_OUTPUT|SECRET_REASONING|SECRET_TRANSCRIPT/,
);

await executor.close();
console.log("bounded native agent progress PASS");
