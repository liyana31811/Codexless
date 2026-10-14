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
    clientFactory: ({ serverRequestHandler }) => { fake.approval = serverRequestHandler; return fake; },
  });
}


const fake = new FakeSteerClient();
const baseRequest = fake.request.bind(fake);
let release;
let earlyProgress = false;
fake.request = async (method, params) => {
  if (method === "turn/steer" && params.input[0].text === "DELAY") {
    const reply = await baseRequest(method, params);
    await new Promise(resolve => { release = resolve; });
    return reply;
  }
  if (method === "turn/steer" && params.input[0].text === "WRONG_TURN") {
    await baseRequest(method, params);
    return { turnId: "unrelated-turn" };
  }
  const result = await baseRequest(method, params);
  if (method === "turn/start" && earlyProgress) {
    fake.emit({ method: "turn/plan/updated", params: {threadId: fake.thread.id, turnId: result.turn.id, plan: [{step: "EARLY_PROGRESS", status: "in_progress"}]}});
  }
  return result;
};
const executor = makeExecutor(fake);
await executor.open();
const started = await executor.start({task: "LONG_RUNNING", clientRequestId: "start-boundaries"});
const input = {agentRef: started.agentRef, message: "DELAY", expectedTurnId: started.turnId, clientRequestId: "concurrent"};
const first = executor.steer(input);
while (!release) await new Promise(resolve => setTimeout(resolve, 1));
const duplicate = await executor.steer(input);
assert.equal(duplicate.duplicate, true);
assert.equal(fake.count("turn/steer"), 1);
release();
assert.equal((await first).controlAcceptance, "accepted");
assert.equal((await executor.steer(input)).controlAcceptance, "accepted");
const wrong = {...input, message: "WRONG_TURN", clientRequestId: "wrong-turn"};
assert.equal((await executor.steer(wrong)).controlAcceptance, "unknown");
assert.equal((await executor.steer(wrong)).controlAcceptance, "unknown");
assert.equal(fake.count("turn/steer"), 2);
fake.approval({id: "approval-1", method: "item/commandExecution/requestApproval", params: {threadId: fake.thread.id, turnId: started.turnId, itemId: "cmd"}, reject() {}, resolve() {}});
await assert.rejects(() => executor.steer({...input, clientRequestId: "pending-block"}), /pending Codex approval/);
assert.equal(fake.count("turn/steer"), 2);
console.log("PASS: concurrent request deduplication, wrong-turn unknown/no replay, pending approval blocks steer");
await executor.close();
const earlyFake = new FakeSteerClient();
const original = earlyFake.request.bind(earlyFake);
earlyFake.request = async (method, params) => {
 const result = await original(method, params);
 if (method === "turn/start") earlyFake.emit({method: "turn/plan/updated", params: {threadId: earlyFake.thread.id, turnId: result.turn.id, plan: [{step: "EARLY_PROGRESS", status: "in_progress"}]}});
 return result;
};
const earlyExecutor = makeExecutor(earlyFake);
await earlyExecutor.open();
const earlyStarted = await earlyExecutor.start({task: "test early notification", clientRequestId: "early"});
assert.equal(earlyStarted.progress.plan?.plan[0]?.step, "EARLY_PROGRESS", "progress emitted before turn/start response must survive response handling");
earlyFake.currentTurn().status = "completed";
const earlySend = await earlyExecutor.send({agentRef: earlyStarted.agentRef, message: "follow up", clientRequestId: "early-followup"});
assert.equal(earlySend.progress.plan?.plan[0]?.step, "EARLY_PROGRESS", "followup progress emitted before turn/start response must survive response handling");
await earlyExecutor.close();
console.log("PASS: early progress survives turn/start response");
