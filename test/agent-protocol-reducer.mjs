import assert from "node:assert/strict";
import path from "node:path";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";

class ProtocolClient {
  constructor() {
    this.running = false;
    this.initializedResult = { ok: true };
    this.serverRequestMethods = [];
    this.notifications = null;
    this.requests = [];
    this.threadSeq = 0;
    this.turnSeq = 0;
    this.current = null;
    this.failTurnStart = false;
    this.failInterrupt = false;
  }

  async start() {
    this.running = true;
    return this.initializedResult;
  }

  onNotification(handler) {
    this.notifications = handler;
    return () => { this.notifications = null; };
  }

  async close() {
    this.running = false;
  }

  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "model/list") {
      return {
        data: [{ id: "protocol-default", model: "protocol-default", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      this.threadSeq += 1;
      return {
        thread: { id: `thread-${this.threadSeq}`, canAcceptDirectInput: true },
        model: "protocol-default",
        modelProvider: "fixture",
        serviceTier: null,
        reasoningEffort: "medium",
      };
    }
    if (method === "thread/resume") {
      return {
        thread: { id: params.threadId, canAcceptDirectInput: true },
        model: "protocol-default",
        modelProvider: "fixture",
        serviceTier: null,
        reasoningEffort: "medium",
      };
    }
    if (method === "turn/start") {
      if (this.failTurnStart) {
        this.failTurnStart = false;
        throw new Error("turn response lost after remote acceptance");
      }
      this.turnSeq += 1;
      this.current = { id: `turn-${this.turnSeq}`, status: "inProgress", items: [] };
      return { turn: structuredClone(this.current) };
    }
    if (method === "turn/interrupt") {
      if (this.failInterrupt) {
        this.failInterrupt = false;
        throw new Error("interrupt response lost after remote acceptance");
      }
      this.current = { ...this.current, status: "interrupted" };
      return {};
    }
    if (method === "thread/turns/list") return { data: this.current ? [structuredClone(this.current)] : [] };
    throw new Error(`unexpected protocol fixture request: ${method}`);
  }

  notify(method, turn) {
    this.current = structuredClone(turn);
    this.notifications?.({ method, params: { threadId: "thread-1", turnId: turn.id, turn } });
  }
}

const client = new ProtocolClient();
const executor = new CodexAgentExecutor({ defaultCwd: path.resolve("."), clientFactory: () => client });
await executor.open();

// Start and Send use independent namespaces for the same caller key.
const started = await executor.start({ task: "namespace start", clientRequestId: "same-key" });
assert.equal(started.duplicate, false);
client.notify("turn/completed", { id: started.turnId, status: "completed", items: [{ type: "agentMessage", text: "terminal A" }] });
const sent = await executor.send({ agentRef: started.agentRef, message: "namespace send", clientRequestId: "same-key" });
assert.equal(sent.duplicate, false);
assert.equal(client.requests.filter((request) => request.method === "turn/start").length, 2);

// First terminal observation wins over a later terminal observation and refresh.
client.notify("turn/completed", { id: sent.turnId, status: "completed", items: [{ type: "agentMessage", text: "terminal A" }] });
client.notify("turn/completed", { id: sent.turnId, status: "failed", error: { message: "terminal B" }, items: [] });
const final = await executor.show({ agentRef: started.agentRef });
assert.equal(final.status, "idle");
assert.equal(final.finalResult, "terminal A");
assert.equal(final.latestError, null);
assert.equal(final.timing.endedAt !== null, true);

// A turn/start response lost after the request boundary is acceptance-unknown;
// the exact key cannot issue a second turn/start.
client.failTurnStart = true;
const unknown = await executor.send({ agentRef: started.agentRef, message: "uncertain send", clientRequestId: "uncertain-send" });
assert.equal(unknown.status, "unknown");
const turnsAfterUnknown = client.requests.filter((request) => request.method === "turn/start").length;
const unknownRetry = await executor.send({ agentRef: started.agentRef, message: "uncertain send", clientRequestId: "uncertain-send" });
assert.equal(unknownRetry.duplicate, true);
assert.equal(client.requests.filter((request) => request.method === "turn/start").length, turnsAfterUnknown);

// Cancel reserves before interrupt; an uncertain interrupt is not replayed.
const cancelClient = new ProtocolClient();
const cancelExecutor = new CodexAgentExecutor({ defaultCwd: path.resolve("."), clientFactory: () => cancelClient });
await cancelExecutor.open();
const cancelStart = await cancelExecutor.start({ task: "cancel boundary", clientRequestId: "cancel-start" });
cancelClient.failInterrupt = true;
const cancelUnknown = await cancelExecutor.cancel({ agentRef: cancelStart.agentRef, clientRequestId: "cancel-1", expectedTurnId: cancelStart.turnId });
assert.equal(cancelUnknown.controlAcceptance, "unknown");
const interruptsAfterUnknown = cancelClient.requests.filter((request) => request.method === "turn/interrupt").length;
const cancelRetry = await cancelExecutor.cancel({ agentRef: cancelStart.agentRef, clientRequestId: "cancel-1", expectedTurnId: cancelStart.turnId });
assert.equal(cancelRetry.duplicate, true);
assert.equal(cancelClient.requests.filter((request) => request.method === "turn/interrupt").length, interruptsAfterUnknown);

await executor.close();
await cancelExecutor.close();
console.log("agent protocol reducer/finality proof PASS");
