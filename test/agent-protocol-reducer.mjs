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
await assert.rejects(
  cancelExecutor.cancel({ agentRef: cancelStart.agentRef, clientRequestId: "cancel-2", expectedTurnId: cancelStart.turnId }),
  /cancel was already dispatched/
);
assert.equal(cancelClient.requests.filter((request) => request.method === "turn/interrupt").length, interruptsAfterUnknown);
const cancelRetry = await cancelExecutor.cancel({ agentRef: cancelStart.agentRef, clientRequestId: "cancel-1", expectedTurnId: cancelStart.turnId });
assert.equal(cancelRetry.duplicate, true);
assert.equal(cancelClient.requests.filter((request) => request.method === "turn/interrupt").length, interruptsAfterUnknown);

await executor.close();
await cancelExecutor.close();

// Concurrent identical sends must reserve one namespaced request before either
// caller can cross the turn/start boundary.
const concurrentClient = new ProtocolClient();
let releaseConcurrentResume;
let concurrentResumeCalls = 0;
const concurrentResumeGate = new Promise((resolve) => { releaseConcurrentResume = resolve; });
const concurrentRequest = concurrentClient.request.bind(concurrentClient);
concurrentClient.request = async (method, params = {}) => {
  if (method === "thread/resume") {
    concurrentResumeCalls += 1;
    await concurrentResumeGate;
  }
  return concurrentRequest(method, params);
};
const concurrentExecutor = new CodexAgentExecutor({ defaultCwd: path.resolve("."), clientFactory: () => concurrentClient });
await concurrentExecutor.open();
const concurrentStart = await concurrentExecutor.start({ task: "concurrent baseline", clientRequestId: "concurrent-start" });
concurrentClient.notify("turn/completed", { id: concurrentStart.turnId, status: "completed", items: [{ type: "agentMessage", text: "baseline" }] });
const concurrentFirst = concurrentExecutor.send({ agentRef: concurrentStart.agentRef, message: "same send", clientRequestId: "concurrent-send" });
const concurrentSecond = concurrentExecutor.send({ agentRef: concurrentStart.agentRef, message: "same send", clientRequestId: "concurrent-send" });
const concurrentDifferent = concurrentExecutor.send({ agentRef: concurrentStart.agentRef, message: "different send", clientRequestId: "concurrent-other" });
for (let index = 0; index < 10 && concurrentResumeCalls < 3; index += 1) await new Promise((resolve) => setImmediate(resolve));
assert.equal(concurrentResumeCalls, 3);
releaseConcurrentResume();
const concurrentResults = await Promise.all([concurrentFirst, concurrentSecond]);
await assert.rejects(concurrentDifferent, /is not idle/);
assert.equal(concurrentClient.requests.filter((request) => request.method === "turn/start").length, 2);
assert.equal(concurrentResults.filter((result) => result.duplicate === true).length, 1);
await assert.rejects(
  concurrentExecutor.send({ agentRef: concurrentStart.agentRef, message: "active second turn", clientRequestId: "concurrent-other" }),
  /is not idle/
);
await concurrentExecutor.close();

// Start reserves its namespace before asynchronous model validation as well.
const concurrentStartClient = new ProtocolClient();
let releaseStartCatalog;
const startCatalogGate = new Promise((resolve) => { releaseStartCatalog = resolve; });
let startCatalogCalls = 0;
const concurrentStartRequest = concurrentStartClient.request.bind(concurrentStartClient);
concurrentStartClient.request = async (method, params = {}) => {
  if (method === "model/list") {
    startCatalogCalls += 1;
    await startCatalogGate;
  }
  return concurrentStartRequest(method, params);
};
const concurrentStartExecutor = new CodexAgentExecutor({ defaultCwd: path.resolve("."), clientFactory: () => concurrentStartClient });
await concurrentStartExecutor.open();
const concurrentStartFirst = concurrentStartExecutor.start({ task: "same start", clientRequestId: "concurrent-start", reasoningEffort: "medium" });
const concurrentStartSecond = concurrentStartExecutor.start({ task: "same start", clientRequestId: "concurrent-start", reasoningEffort: "medium" });
for (let index = 0; index < 10 && startCatalogCalls < 1; index += 1) await new Promise((resolve) => setImmediate(resolve));
assert.equal(startCatalogCalls, 1);
releaseStartCatalog();
const concurrentStartResults = await Promise.all([concurrentStartFirst, concurrentStartSecond]);
assert.equal(concurrentStartClient.requests.filter((request) => request.method === "thread/start").length, 1);
assert.equal(concurrentStartResults.filter((result) => result.duplicate === true).length, 1);
await concurrentStartExecutor.close();

// A delayed follow-up turn must ignore a late notification for the prior
// terminal turn while its new turn/start response is still in flight.
const staleClient = new ProtocolClient();
let releaseStaleTurn;
staleClient.deferTurnStart = false;
const staleRequest = staleClient.request.bind(staleClient);
staleClient.request = async (method, params = {}) => {
  if (method !== "turn/start" || staleClient.turnSeq < 1 || !staleClient.deferTurnStart) return staleRequest(method, params);
  staleClient.requests.push({ method, params: structuredClone(params) });
  staleClient.turnSeq += 1;
  const turn = { id: `turn-${staleClient.turnSeq}`, status: "inProgress", items: [] };
  staleClient.current = structuredClone(turn);
  return await new Promise((resolve) => {
    releaseStaleTurn = () => resolve({ turn: structuredClone(turn) });
  });
};
const staleExecutor = new CodexAgentExecutor({ defaultCwd: path.resolve("."), clientFactory: () => staleClient });
await staleExecutor.open();
const staleStart = await staleExecutor.start({ task: "stale baseline", clientRequestId: "stale-start" });
staleClient.notify("turn/completed", { id: staleStart.turnId, status: "completed", items: [{ type: "agentMessage", text: "old terminal" }] });
staleClient.deferTurnStart = true;
const staleSendPromise = staleExecutor.send({ agentRef: staleStart.agentRef, message: "fresh turn", clientRequestId: "stale-send" });
await new Promise((resolve) => setImmediate(resolve));
staleClient.notify("turn/completed", { id: staleStart.turnId, status: "completed", items: [{ type: "agentMessage", text: "late old terminal" }] });
staleClient.notifications?.({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: staleStart.turnId, tokenUsage: { last: { totalTokens: 999 } } } });
releaseStaleTurn();
const staleSend = await staleSendPromise;
assert.equal(staleSend.status, "running");
assert.notEqual(staleSend.turnId, staleStart.turnId);
assert.equal(staleSend.finalResult, null);
assert.equal(staleSend.events.filter((event) => event.type === "stale-turn-notification-ignored").length, 1);
staleClient.notify("turn/completed", { id: staleSend.turnId, status: "completed", items: [{ type: "agentMessage", text: "fresh terminal" }] });
const staleTerminal = await staleExecutor.show({ agentRef: staleStart.agentRef });
assert.equal(staleTerminal.resourceReceipt?.tokenUsage, null);
await staleExecutor.close();

// A receipt promise for terminal turn A must never be reused for terminal
// turn B when a follow-up begins while A's telemetry is still pending.
const receiptClient = new ProtocolClient();
let releaseReceipt;
const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
let receiptCalls = 0;
const receiptExecutor = new CodexAgentExecutor({
  defaultCwd: path.resolve("."),
  clientFactory: () => receiptClient,
  resourceSnapshotProvider: async () => {
    receiptCalls += 1;
    await receiptGate;
    return { status: "ok", observedAt: "2026-08-21T00:00:00.000Z", usage: { status: "ok" }, rateLimits: { status: "ok", value: { limits: [] } } };
  },
});
await receiptExecutor.open();
const receiptStart = await receiptExecutor.start({ task: "receipt A", clientRequestId: "receipt-start" });
receiptClient.notify("turn/completed", { id: receiptStart.turnId, status: "completed", items: [{ type: "agentMessage", text: "A" }] });
const receiptA = receiptExecutor.show({ agentRef: receiptStart.agentRef });
for (let index = 0; index < 10 && receiptCalls === 0; index += 1) await new Promise((resolve) => setImmediate(resolve));
assert.equal(receiptCalls, 1);
const receiptBStart = await receiptExecutor.send({ agentRef: receiptStart.agentRef, message: "receipt B", clientRequestId: "receipt-send" });
receiptClient.notify("turn/completed", { id: receiptBStart.turnId, status: "completed", items: [{ type: "agentMessage", text: "B" }] });
const receiptB = receiptExecutor.show({ agentRef: receiptStart.agentRef });
await new Promise((resolve) => setImmediate(resolve));
releaseReceipt();
const receiptBResult = await receiptB;
assert.equal(receiptBResult.resourceReceipt?.turnId, receiptBStart.turnId);
assert.equal(receiptBResult.events.filter((event) => event.type === "resource-receipt/ready" && event.turnId === receiptBStart.turnId).length, 1);
await receiptA;
await receiptExecutor.close();

console.log("agent protocol reducer/finality proof PASS");
