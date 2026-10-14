import assert from "node:assert/strict";
import path from "node:path";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { CodexRpcError } from "../src/codex-app-server-client.mjs";
import { LazyCodexAgentExecutor } from "../src/lazy-codex-agent-executor.mjs";
import { registerAgentPreviewTools } from "../src/agent-tools.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

class FakeSteerClient {
  constructor() {
    this.running = false;
    this.initializedResult = { userAgent: "fake-steer-client/1" };
    this.handlers = new Set();
    this.requests = [];
    this.thread = {
      id: "thread-steer-1",
      status: { type: "active", activeFlags: ["waitingOnModel"] },
      canAcceptDirectInput: true,
      model: "fake-default",
      modelProvider: "openai",
      serviceTier: "default",
      reasoningEffort: "medium",
      turns: [],
    };
  }

  async start() {
    this.running = true;
    return this.initializedResult;
  }

  onNotification(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close() {
    this.running = false;
    this.handlers.clear();
  }

  emit(message) {
    for (const handler of this.handlers) handler(structuredClone(message));
  }

  count(method) {
    return this.requests.filter((entry) => entry.method === method).length;
  }

  currentTurn() {
    return this.thread.turns.at(-1) ?? null;
  }

  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "thread/start") {
      return {
        thread: structuredClone(this.thread),
        model: this.thread.model,
        modelProvider: this.thread.modelProvider,
        serviceTier: this.thread.serviceTier,
        reasoningEffort: this.thread.reasoningEffort,
      };
    }
    if (method === "turn/start") {
      const turn = {
        id: `turn-${this.thread.turns.length + 1}`,
        status: "inProgress",
        items: [],
        error: null,
      };
      this.thread.turns.push(turn);
      return { turn: structuredClone(turn) };
    }
    if (method === "thread/turns/list") {
      return { data: structuredClone([...this.thread.turns].reverse()), nextCursor: null };
    }
    if (method === "thread/resume") {
      return {
        thread: structuredClone(this.thread),
        model: this.thread.model,
        modelProvider: this.thread.modelProvider,
        serviceTier: this.thread.serviceTier,
        reasoningEffort: this.thread.reasoningEffort,
      };
    }
    if (method === "turn/steer") {
      const turn = this.thread.turns.find((candidate) => candidate.id === params.expectedTurnId);
      if (!turn || turn.status !== "inProgress") {
        throw new CodexRpcError("turn/steer", { code: -32602, message: "turn is no longer active" });
      }
      const text = params.input?.find((item) => item?.type === "text")?.text ?? "";
      if (text === "RPC_REJECT") {
        throw new CodexRpcError("turn/steer", { code: -32602, message: "steer rejected by fake app server" });
      }
      const item = {
        type: "userMessage",
        id: `steer-${params.clientUserMessageId}`,
        clientId: params.clientUserMessageId,
        content: structuredClone(params.input ?? []),
      };
      turn.items.push(item);
      this.emit({ method: "item/started", params: { threadId: this.thread.id, turnId: turn.id, item } });
      this.emit({ method: "item/started", params: { threadId: this.thread.id, turnId: turn.id, item } });
      if (text === "TRANSPORT_LOSS") throw new Error("simulated transport loss after steer dispatch");
      return { turnId: turn.id };
    }
    throw new Error(`unexpected fake request: ${method}`);
  }
}

function makeExecutor(fake) {
  return new CodexAgentExecutor({
    defaultCwd: projectRoot,
    requestTimeoutMs: 1_000,
    clientFactory: () => fake,
  });
}

const fake = new FakeSteerClient();
const executor = makeExecutor(fake);
await executor.open();
const started = await executor.start({ task: "LONG_RUNNING", clientRequestId: "start-steer-1" });
assert.equal(started.status, "running");
assert.equal(started.turnId, "turn-1");

const accepted = await executor.steer({
  agentRef: started.agentRef,
  message: "COURSE_CORRECTION",
  expectedTurnId: started.turnId,
  clientRequestId: "steer-accepted-1",
});
assert.equal(accepted.controlAcceptance, "accepted");
assert.equal(accepted.duplicate, false);
assert.equal(fake.count("turn/steer"), 1);
assert.equal(accepted.events.filter((event) => event.type === "turn/steer-consumed").length, 1);

const duplicate = await executor.steer({
  agentRef: started.agentRef,
  message: "COURSE_CORRECTION",
  expectedTurnId: started.turnId,
  clientRequestId: "steer-accepted-1",
});
assert.equal(duplicate.controlAcceptance, "accepted");
assert.equal(duplicate.duplicate, true);
assert.equal(fake.count("turn/steer"), 1, "confirmed duplicate must not dispatch a second steer");
await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "CHANGED_MEANING",
    expectedTurnId: started.turnId,
    clientRequestId: "steer-accepted-1",
  }),
  /different agent control action/
);
assert.equal(fake.count("turn/steer"), 1);

await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "STALE",
    expectedTurnId: "turn-stale",
    clientRequestId: "steer-stale-1",
  }),
  /agent task turn changed/
);
assert.equal(fake.count("turn/steer"), 1);

await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "RPC_REJECT",
    expectedTurnId: started.turnId,
    clientRequestId: "steer-rejected-1",
  }),
  (error) => error instanceof CodexRpcError && /steer rejected/.test(error.message)
);
assert.equal(fake.count("turn/steer"), 2);
await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "RPC_REJECT",
    expectedTurnId: started.turnId,
    clientRequestId: "steer-rejected-1",
  }),
  /turn\/steer failed/
);
assert.equal(fake.count("turn/steer"), 2, "explicit rejection retry must not redispatch");

const uncertain = await executor.steer({
  agentRef: started.agentRef,
  message: "TRANSPORT_LOSS",
  expectedTurnId: started.turnId,
  clientRequestId: "steer-uncertain-1",
});
assert.equal(uncertain.controlAcceptance, "unknown");
assert.match(uncertain.latestError, /do not replay automatically/);
assert.equal(fake.count("turn/steer"), 3);
const uncertainRetry = await executor.steer({
  agentRef: started.agentRef,
  message: "TRANSPORT_LOSS",
  expectedTurnId: started.turnId,
  clientRequestId: "steer-uncertain-1",
});
assert.equal(uncertainRetry.controlAcceptance, "unknown");
assert.equal(uncertainRetry.duplicate, true);
assert.equal(fake.count("turn/steer"), 3, "uncertain acceptance must never auto-replay");

fake.currentTurn().status = "completed";
await assert.rejects(
  () => executor.steer({
    agentRef: started.agentRef,
    message: "TOO_LATE",
    expectedTurnId: started.turnId,
    clientRequestId: "steer-terminal-1",
  }),
  /no steerable active turn/
);
assert.equal(fake.count("turn/steer"), 3);
await executor.close();

const tools = new Map();
const mockServer = {
  registerTool(name, config, handler) { tools.set(name, { config, handler }); },
};
registerAgentPreviewTools(mockServer, {
  agentExecutor: {
    running: true,
    async listModels() { return { models: [], nextCursor: null }; },
    async show() { return { status: "unknown", agentRef: "agent-test" }; },
  },
  authorityExecutor: { async resolveAuthority() { return { profileId: ":workspace" }; } },
});
const steerTool = tools.get("codex.agent_steer");
assert.ok(steerTool, "agent_steer must be registered");
assert.equal(steerTool.config.inputSchema.safeParse({
  agentRef: "agent-test",
  message: "adjust",
  expectedTurnId: "turn-test",
  requestId: "steer-test",
}).success, true);
for (const forbidden of ["model", "reasoningEffort", "cwd", "sandbox", "permissionProfile", "approvalPolicy", "outputSchema"]) {
  assert.equal(steerTool.config.inputSchema.safeParse({
    agentRef: "agent-test",
    message: "adjust",
    expectedTurnId: "turn-test",
    requestId: "steer-test",
    [forbidden]: "forbidden",
  }).success, false, `agent_steer schema must reject ${forbidden}`);
}
assert.equal(steerTool.config.inputSchema.safeParse({
  agentRef: "agent-test",
  message: "adjust",
  requestId: "steer-test",
}).success, false, "expectedTurnId is required");

let lazySteerInput = null;
const lazy = new LazyCodexAgentExecutor({
  factory: async () => ({
    running: true,
    async open() {},
    async close() {},
    async steer(input) { lazySteerInput = input; return { controlAcceptance: "accepted" }; },
  }),
});
await lazy.open();
const lazyResult = await lazy.steer({ agentRef: "a", message: "m", expectedTurnId: "t", clientRequestId: "r" });
assert.equal(lazyResult.controlAcceptance, "accepted");
assert.deepEqual(lazySteerInput, { agentRef: "a", message: "m", expectedTurnId: "t", clientRequestId: "r" });
await lazy.close();

console.log(JSON.stringify({
  passed: true,
  checks: {
    acceptedSteerUsesActiveTurn: true,
    confirmedDuplicateDoesNotRedispatch: true,
    requestIdMeaningIsStable: true,
    staleTurnFailsClosed: true,
    explicitRpcRejectIsDistinctAndNoReplay: true,
    uncertainTransportIsNoReplay: true,
    terminalTurnFailsClosed: true,
    correlatedUserMessageProducesOneConsumedReceipt: true,
    minimalStrictSchema: true,
    lazyDelegation: true,
  },
}, null, 2));
