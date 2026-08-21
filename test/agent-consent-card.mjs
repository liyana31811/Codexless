import assert from "node:assert/strict";
import { createAgentPreviewState, registerAgentPreviewTools } from "../src/agent-tools.mjs";

const tools = new Map();
const server = {
  registerTool(name, definition, handler) { tools.set(name, { definition, handler }); },
  registerResource() {},
};

let starts = 0;
let lastStartArgs = null;
const agentExecutor = {
  async listModels() {
    return {
      models: [
        {
          id: "fake-default", model: "fake-default", displayName: "Fake Default", hidden: false, isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "ultra", description: "Deep" },
          ],
        },
        {
          id: "fake-fast", model: "fake-fast", displayName: "Fake Fast", hidden: false, isDefault: false,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
        },
      ],
      nextCursor: null,
    };
  },
  async start(args) {
    const { clientRequestId, reasoningEffort = null } = args;
    starts += 1;
    lastStartArgs = structuredClone(args);
    return {
      agentRef: "agent_fake",
      threadId: "thread_fake",
      turnId: "turn_fake",
      status: "idle",
      latestTurnStatus: "completed",
      canSend: true,
      pendingApproval: null,
      finalResult: `FAKE_OK:${clientRequestId}`,
      resourceReceipt: null,
      latestError: null,
      createdAt: 1,
      updatedAt: 2,
      timing: { startedAt: 1, endedAt: 2, durationMs: 1 },
      execution: {
        requestedModel: args.model ?? null,
        ...(reasoningEffort ? { requestedReasoningEffort: reasoningEffort } : {}),
        resolvedModel: args.model ?? "fake-default",
        modelProvider: "fake",
        serviceTier: null,
        reasoningEffort,
      },
      events: [],
      nextSeq: 0,
    };
  },
  async show() { throw new Error("show should not be needed for this terminal fake start"); },
  async send() { throw new Error("send not used"); },
  async resolveApproval() { throw new Error("approval not used"); },
  async rejectApproval() { throw new Error("reject not used"); },
  async cancel() { throw new Error("cancel not used"); },
};

const authorityExecutor = {
  async resolveAuthority({ cwd = null } = {}) {
    return {
      effectiveCwd: cwd ?? "C:\\workspace",
      permissionProfile: ":read-only",
    };
  },
};

const state = createAgentPreviewState({
  meteredConsentMode: "always",
  meteredQuotaProvider: async () => ({
    status: "ok",
    observedAt: "2026-08-19T12:00:00.000Z",
    usage: { status: "ok" },
    rateLimits: {
      status: "ok",
      value: {
        limits: [{
          key: "codex",
          limitName: "Codex",
          windows: [
            { kind: "primary", usedPercent: 27, resetsAt: 1800000000, windowDurationMins: 300 },
            { kind: "secondary", usedPercent: 41, resetsAt: null, windowDurationMins: 10_080 },
          ],
        }],
      },
    },
  }),
});
registerAgentPreviewTools(server, {
  agentExecutor,
  authorityExecutor,
  meteredConsentMode: "always",
  meteredQuotaProvider: null,
  agentPreviewState: state,
});

const start = tools.get("codex.agent_start").handler;
const render = tools.get("codex.agent_card_render").handler;
const decline = tools.get("codex.agent_decline").handler;
const commit = tools.get("codex.agent_commit").handler;

const prepared = await start({ prompt: "fake approval card start", requestId: "fake-request-1" });
assert.equal(prepared.isError, false);
assert.equal(prepared.structuredContent.status, "consent_required");
assert.equal(prepared.structuredContent.execution.requestedModel, "fake-default", "Rich Card state must expose the resolved default model before approval");
assert.equal(prepared.structuredContent.execution.requestedReasoningEffort, "medium", "Rich Card state must expose the resolved default effort before approval");
assert.equal(starts, 0);
const consentRef = prepared.structuredContent.meteredConsent.consentRef;

const card = await render({ consentRef });
assert.equal(card.isError, false);
const commitToken = card._meta?.codexlessCommitToken;
assert.match(commitToken ?? "", /^commit_/);
assert.equal(JSON.stringify(card.structuredContent).includes(commitToken), false);
assert.equal(card.content[0].text.includes(commitToken), false);

const missing = await commit({ consentRef, commitToken: "commit_wrong" });
assert.equal(missing.isError, true);
assert.equal(starts, 0);

const accepted = await commit({ consentRef, commitToken });
assert.equal(accepted.isError, false);
assert.equal(starts, 1);
assert.equal(accepted.structuredContent.finalResult, "FAKE_OK:fake-request-1");
assert.equal(accepted.structuredContent.terminal, true);

const duplicate = await commit({ consentRef, commitToken });
assert.equal(duplicate.isError, false);
assert.equal(duplicate.structuredContent.duplicate, true);
assert.equal(starts, 1, "repeated exact card commit must not start a second logical Codex turn");

const declinePrepared = await start({ prompt: "fake decline card start", requestId: "fake-request-decline-1" });
assert.equal(declinePrepared.isError, false);
assert.equal(declinePrepared.structuredContent.status, "consent_required");
const declineConsentRef = declinePrepared.structuredContent.meteredConsent.consentRef;
const declineCard = await render({ consentRef: declineConsentRef });
const declineCommitToken = declineCard._meta?.codexlessCommitToken;
assert.match(declineCommitToken ?? "", /^commit_/);

const declined = await decline({ consentRef: declineConsentRef });
assert.equal(declined.isError, false);
assert.equal(declined.structuredContent.status, "rejected");
assert.equal(declined.structuredContent.terminal, true);
assert.equal(declined.structuredContent.agentRef, null);
assert.equal(declined.structuredContent.turnId, null);
assert.equal(starts, 1, "declining a prepared card must not start Codex");

const declinedAgain = await decline({ consentRef: declineConsentRef });
assert.equal(declinedAgain.isError, false);
assert.equal(declinedAgain.structuredContent.status, "rejected");
assert.equal(starts, 1, "duplicate decline must remain terminal without starting Codex");

const cachedCommitAfterNo = await commit({ consentRef: declineConsentRef, commitToken: declineCommitToken });
assert.equal(cachedCommitAfterNo.isError, false);
assert.equal(cachedCommitAfterNo.structuredContent.status, "rejected");
assert.equal(cachedCommitAfterNo.structuredContent.terminal, true);
assert.equal(cachedCommitAfterNo.structuredContent.duplicate, true);
assert.equal(starts, 1, "a cached Yes/commit after No must not revive or start the rejected task");

const replayAfterNo = await start({ prompt: "fake decline card start", requestId: "fake-request-decline-1" });
assert.equal(replayAfterNo.isError, false);
assert.equal(replayAfterNo.structuredContent.status, "rejected");
assert.equal(replayAfterNo.structuredContent.terminal, true);
assert.equal(starts, 1, "same requestId replay after No must stay rejected and start nothing");

const portablePrepared = await start({ prompt: "portable fallback approval", requestId: "portable-request-1" });
assert.equal(portablePrepared.isError, false);
assert.equal(portablePrepared.structuredContent.status, "consent_required");
const portableConsentRef = portablePrepared.structuredContent.meteredConsent.consentRef;
const portableCard = await render({ consentRef: portableConsentRef });
assert.equal(portableCard.isError, false);
assert.doesNotMatch(portableCard.content?.[0]?.text ?? "", /[┌┐└┘│─]/, "Portable Card fallback should stay plain-text and let the host provide visual framing");
assert.match(portableCard.content?.[0]?.text ?? "", /Call Codex\?|调用 Codex？|Codexを呼び出しますか？/i);
assert.match(portableCard.content?.[0]?.text ?? "", /Yes/);
assert.match(portableCard.content?.[0]?.text ?? "", /No/);
assert.match(portableCard.content?.[0]?.text ?? "", /reply|回复|返信/i);
assert.match(portableCard.content?.[0]?.text ?? "", /Fake Default/i);
assert.doesNotMatch(portableCard.content?.[0]?.text ?? "", /Fake Default \(fake-default\)/i, "Portable Card should not duplicate display name and internal model id");
assert.doesNotMatch(portableCard.content?.[0]?.text ?? "", /Fake Fast|fake-fast/i);
assert.doesNotMatch(portableCard.content?.[0]?.text ?? "", /Available models|可选模型|選択可能なモデル/);
assert.match(portableCard.content?.[0]?.text ?? "", /Reasoning effort|推理强度|推論強度/);
assert.match(portableCard.content?.[0]?.text ?? "", /medium/i);
assert.doesNotMatch(portableCard.content?.[0]?.text ?? "", /Available efforts|可选推理强度|選択可能な推論強度/);
assert.doesNotMatch(portableCard.content?.[0]?.text ?? "", /change the model|换模型|モデルや推論強度|重新准备|再準備|Yes .*only|Yes 只批准|Yes は/i);
assert.deepEqual(portableCard.structuredContent.manualFallback?.choices, ["Yes", "No"]);
assert.equal(portableCard.structuredContent.manualFallback?.modelSelection?.source, "codex.model_list");
assert.equal(portableCard.structuredContent.manualFallback?.modelSelection?.selectedModel, "fake-default");
assert.equal(portableCard.structuredContent.manualFallback?.modelSelection?.selectedReasoningEffort, "medium");
assert.equal(portableCard.structuredContent.manualFallback?.rebind?.requiresNewRequestId, true);
assert.match(portableCard.content?.[0]?.text ?? "", /5h/);
assert.match(portableCard.content?.[0]?.text ?? "", /73%/);
assert.match(portableCard.content?.[0]?.text ?? "", /7d/);
assert.match(portableCard.content?.[0]?.text ?? "", /59%/);
assert.match(portableCard.content?.[0]?.text ?? "", /unavailable|not provided|未提供|提供なし/i);
const portableTaskId = portableCard.structuredContent.manualFallback?.taskId;
assert.match(portableTaskId ?? "", /^C-[A-F0-9]{10}$/);
assert.equal((portableCard.content?.[0]?.text ?? "").includes(portableTaskId), false, "short task id stays in structured content, not the user-facing fallback text");
assert.equal(portableCard.structuredContent.manualFallback?.decision?.approveTool, "codex.agent_commit");
assert.equal(portableCard.structuredContent.manualFallback?.decision?.declineTool, "codex.agent_decline");
assert.equal(tools.get("codex.agent_commit").definition._meta?.ui?.visibility, undefined, "commit must remain model-callable for Portable Card fallback");
assert.equal(tools.get("codex.agent_decline").definition._meta?.ui?.visibility, undefined, "decline must remain model-callable for Portable Card fallback");
assert.equal(tools.get("codex.agent_commit").definition.inputSchema.safeParse({ taskId: portableTaskId, prompt: "override" }).success, false);

const wrongPortable = await commit({ taskId: "C-0000000000" });
assert.equal(wrongPortable.isError, true);
assert.equal(starts, 1, "wrong Portable Card task id must fail closed");

const portableAccepted = await commit({ taskId: portableTaskId });
assert.equal(portableAccepted.isError, false);
assert.equal(starts, 2, "explicit Portable Card commit starts exactly one logical turn");
const portableDuplicate = await commit({ taskId: portableTaskId });
assert.equal(portableDuplicate.isError, false);
assert.equal(portableDuplicate.structuredContent.duplicate, true);
assert.equal(starts, 2);

const portableDeclinePrepared = await start({ prompt: "portable fallback decline", requestId: "portable-request-decline" });
const portableDeclineCard = await render({ consentRef: portableDeclinePrepared.structuredContent.meteredConsent.consentRef });
const portableDeclineTaskId = portableDeclineCard.structuredContent.manualFallback?.taskId;
assert.match(portableDeclineTaskId ?? "", /^C-[A-F0-9]{10}$/);
const portableDeclined = await decline({ taskId: portableDeclineTaskId });
assert.equal(portableDeclined.isError, false);
assert.equal(portableDeclined.structuredContent.status, "rejected");
assert.equal(starts, 2, "Portable Card decline must never start Codex");
const portableRevive = await commit({ taskId: portableDeclineTaskId });
assert.equal(portableRevive.isError, false);
assert.equal(portableRevive.structuredContent.status, "rejected");
assert.equal(portableRevive.structuredContent.duplicate, true);
assert.equal(starts, 2, "Portable Card No stays terminal and cannot be revived by later Yes");

const startDefinition = tools.get("codex.agent_start").definition;
assert.equal(startDefinition.inputSchema.safeParse({ prompt: "effort", requestId: "effort-schema", reasoningEffort: "ultra" }).success, true);
assert.equal(startDefinition.inputSchema.safeParse({ prompt: "effort", requestId: "effort-schema", reasoningEffort: "" }).success, false);

const effortPrepared = await start({
  prompt: "portable reasoning effort",
  requestId: "portable-effort-1",
  reasoningEffort: "ultra",
});
assert.equal(effortPrepared.isError, false);
assert.equal(effortPrepared.structuredContent.status, "consent_required");
assert.equal(effortPrepared.structuredContent.taskCard.requestedReasoningEffort, "ultra");
assert.equal(effortPrepared.structuredContent.execution.requestedReasoningEffort, "ultra");
const effortConsentRef = effortPrepared.structuredContent.meteredConsent.consentRef;
const effortCard = await render({ consentRef: effortConsentRef });
assert.equal(effortCard.isError, false);
assert.match(effortCard.content?.[0]?.text ?? "", /Reasoning effort|推理强度|推論強度/i);
assert.match(effortCard.content?.[0]?.text ?? "", /ultra/i);
assert.equal(effortCard.structuredContent.taskCard.requestedReasoningEffort, "ultra");
const effortCommitToken = effortCard._meta?.codexlessCommitToken;
const effortAccepted = await commit({ consentRef: effortConsentRef, commitToken: effortCommitToken });
assert.equal(effortAccepted.isError, false);
assert.equal(starts, 3);
assert.equal(lastStartArgs.model, "fake-default", "approved card must dispatch the exact selected model shown before consent");
assert.equal(lastStartArgs.reasoningEffort, "ultra", "approved card must dispatch only the server-bound requested effort");
assert.equal(effortAccepted.structuredContent.execution.requestedReasoningEffort, "ultra");
assert.equal(effortAccepted.structuredContent.execution.reasoningEffort, "ultra");

const beforeRebindStarts = starts;
const rebindFirst = await start({ prompt: "natural language rebind", requestId: "portable-rebind-default" });
const rebindFirstCard = await render({ consentRef: rebindFirst.structuredContent.meteredConsent.consentRef });
const rebindFirstTaskId = rebindFirstCard.structuredContent.manualFallback.taskId;
const rebindChanged = await start({ prompt: "natural language rebind", requestId: "portable-rebind-fast", model: "fake-fast", reasoningEffort: "low" });
const rebindChangedCard = await render({ consentRef: rebindChanged.structuredContent.meteredConsent.consentRef });
const rebindChangedTaskId = rebindChangedCard.structuredContent.manualFallback.taskId;
assert.notEqual(rebindChangedTaskId, rebindFirstTaskId);
assert.equal(rebindChangedCard.structuredContent.manualFallback.modelSelection.selectedModel, "fake-fast");
assert.match(rebindChangedCard.content?.[0]?.text ?? "", /Fake Fast/i);
assert.doesNotMatch(rebindChangedCard.content?.[0]?.text ?? "", /Fake Fast \(fake-fast\)/i);
assert.deepEqual(rebindChangedCard.structuredContent.manualFallback.modelSelection.supportedReasoningEfforts, ["low"]);
const rebindAccepted = await commit({ taskId: rebindChangedTaskId });
assert.equal(rebindAccepted.isError, false);
assert.equal(starts, beforeRebindStarts + 1);
assert.equal(lastStartArgs.model, "fake-fast");
assert.equal(lastStartArgs.reasoningEffort, "low");

const unsupportedBefore = starts;
const unsupported = await start({ prompt: "unsupported effort", requestId: "portable-effort-unsupported", model: "fake-fast", reasoningEffort: "ultra" });
assert.equal(unsupported.isError, true);
assert.match(unsupported.structuredContent.error, /fake-fast.*ultra.*supported efforts: low/i);
assert.equal(starts, unsupportedBefore, "unsupported model/effort pair must fail before Codex dispatch");

console.log("agent Rich Card + Portable Card fallback hardening PASS");
