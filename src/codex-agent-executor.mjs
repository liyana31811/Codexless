import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { buildAgentResourceReceipt } from "./agent-resource.mjs";
import { projectCodexModel } from "./codex-model-catalog.mjs";

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const DEFAULT_MAX_EVENTS = 128;
const MAX_EVENT_TEXT_CHARS = 2_048;

function hashRequest(cwd, task, model = null, reasoningEffort = null) {
  const base = `${cwd}\0${task}\0${model ?? ""}`;
  const material = reasoningEffort === null ? base : `${base}\0reasoningEffort=${reasoningEffort}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function normalizeModel(model) {
  if (model === null || model === undefined) return null;
  if (typeof model !== "string" || !model.trim()) throw new Error("model must be a non-empty string when provided");
  return model.trim();
}

function normalizeReasoningEffort(reasoningEffort) {
  if (reasoningEffort === null || reasoningEffort === undefined) return null;
  if (typeof reasoningEffort !== "string" || !reasoningEffort.trim()) {
    throw new Error("reasoningEffort must be a non-empty string when provided");
  }
  const normalized = reasoningEffort.trim();
  if (normalized.length > 128) throw new Error("reasoningEffort must be at most 128 characters");
  return normalized;
}

function modelIdentity(entry) {
  return typeof entry?.model === "string" && entry.model
    ? entry.model
    : typeof entry?.id === "string" && entry.id
      ? entry.id
      : null;
}

function supportedReasoningEfforts(entry) {
  return Array.isArray(entry?.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
        .map((option) => typeof option?.reasoningEffort === "string" ? option.reasoningEffort : null)
        .filter(Boolean)
    : [];
}

function normalizeAgentStatus(turnStatus) {
  if (turnStatus === "inProgress" || turnStatus === "running") return "running";
  if (turnStatus === "completed") return "idle";
  if (turnStatus === "failed") return "failed";
  if (turnStatus === "interrupted") return "interrupted";
  return "unknown";
}

function lastAgentMessage(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "agentMessage" && typeof item.text === "string") return item.text;
  }
  return null;
}

function notificationThreadId(message) {
  return message?.params?.threadId ?? message?.params?.thread?.id ?? null;
}

function notificationTurn(message) {
  return message?.params?.turn ?? null;
}

function notificationTurnId(message) {
  return message?.params?.turnId ?? notificationTurn(message)?.id ?? null;
}

function notificationRequestId(message) {
  return message?.params?.requestId ?? null;
}

function controlRequestHash(action, agentRef, targetId) {
  return createHash("sha256").update(`${action}\0${agentRef}\0${targetId ?? ""}`, "utf8").digest("hex");
}

function approvalResponseFor(handle, decision) {
  const params = handle?.params && typeof handle.params === "object" ? handle.params : {};
  if (handle?.method === "item/commandExecution/requestApproval") {
    const wanted = decision === "approve" ? "accept" : "decline";
    if (Array.isArray(params.availableDecisions) && !params.availableDecisions.some((entry) => entry === wanted)) {
      throw new Error(`Codex approval does not offer ${wanted} for this command request`);
    }
    return { decision: wanted };
  }
  if (handle?.method === "item/fileChange/requestApproval") {
    return { decision: decision === "approve" ? "accept" : "decline" };
  }
  if (handle?.method === "item/permissions/requestApproval") {
    return {
      permissions: decision === "approve" ? structuredClone(params.permissions ?? {}) : {},
      scope: "turn",
      strictAutoReview: false,
    };
  }
  throw new Error(`unsupported Codex approval request method: ${String(handle?.method ?? "unknown")}`);
}

function boundedApprovalValue(value, maxChars = 16_384) {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxChars) return structuredClone(value);
    return { truncated: true, preview: text.slice(0, maxChars) };
  } catch {
    return null;
  }
}

function approvalDetails(request, item = null) {
  const params = request?.params && typeof request.params === "object" ? request.params : {};
  if (request?.method === "item/commandExecution/requestApproval") {
    return {
      kind: "command",
      command: typeof params.command === "string" ? params.command.slice(0, 16_384) : null,
      cwd: typeof params.cwd === "string" ? params.cwd.slice(0, 32_768) : null,
      commandActions: boundedApprovalValue(params.commandActions ?? item?.commandActions ?? null),
      networkApprovalContext: boundedApprovalValue(params.networkApprovalContext ?? null),
      additionalPermissions: boundedApprovalValue(params.additionalPermissions ?? null),
    };
  }
  if (request?.method === "item/fileChange/requestApproval") {
    return {
      kind: "fileChange",
      grantRoot: typeof params.grantRoot === "string" ? params.grantRoot.slice(0, 32_768) : null,
      changes: boundedApprovalValue(item?.changes ?? null),
    };
  }
  if (request?.method === "item/permissions/requestApproval") {
    return {
      kind: "permissions",
      cwd: typeof params.cwd === "string" ? params.cwd.slice(0, 32_768) : null,
      permissions: boundedApprovalValue(params.permissions ?? {}),
    };
  }
  const humanText = [params.message, params.reason, params.prompt, params.title, params.description]
    .find((value) => typeof value === "string" && value.trim());
  return {
    kind: "unknown",
    humanText: humanText ? humanText.trim().slice(0, 16_384) : null,
    schema: boundedApprovalValue(params.schema ?? params.requestSchema ?? params.inputSchema ?? null),
    availableDecisions: boundedApprovalValue(params.availableDecisions ?? null),
  };
}

function approvalSummary(request, item = null) {
  const params = request?.params && typeof request.params === "object" ? request.params : {};
  const summary = {
    requestId: request.id,
    method: request.method,
    threadId: params.threadId ?? null,
    turnId: params.turnId ?? null,
    itemId: params.itemId ?? params.item?.id ?? null,
    receivedAt: Date.now(),
    details: approvalDetails(request, item),
  };
  if (typeof params.reason === "string") summary.reason = params.reason.slice(0, MAX_EVENT_TEXT_CHARS);
  return summary;
}

function compactNotification(message) {
  const event = { type: message.method, at: Date.now() };
  const turnId = notificationTurnId(message);
  if (turnId) event.turnId = turnId;

  if (message.method === "item/agentMessage/delta") {
    const delta = message?.params?.delta;
    if (typeof delta === "string") event.text = delta.slice(-MAX_EVENT_TEXT_CHARS);
  }
  if (message.method === "item/mcpToolCall/progress") {
    const messageText = message?.params?.message;
    if (typeof messageText === "string") event.text = messageText.slice(-MAX_EVENT_TEXT_CHARS);
  }
  if (message.method === "thread/tokenUsage/updated" && message?.params?.tokenUsage) {
    event.tokenUsage = message.params.tokenUsage;
  }
  return event;
}

export class CodexAgentExecutor {
  #client;
  #defaultCwd;
  #agents = new Map();
  #clientRequestIds = new Map();
  #sendRequestIds = new Map();
  #controlRequestIds = new Map();
  #unsubscribe = null;
  #opened = false;
  #closed = false;
  #maxEvents;
  #nextEventSeq = 1;
  #resourceSnapshotProvider;

  constructor({
    codexBin = null,
    defaultCwd,
    configOverrides = [],
    requestTimeoutMs = 30_000,
    maxEvents = DEFAULT_MAX_EVENTS,
    clientFactory = null,
    resourceSnapshotProvider = null,
  }) {
    if (!defaultCwd) throw new Error("CodexAgentExecutor requires defaultCwd");
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("maxEvents must be a positive integer");
    if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
      throw new Error("configOverrides must be an array of non-empty Codex -c key=value strings");
    }
    if (!clientFactory && !codexBin) throw new Error("CodexAgentExecutor requires codexBin or clientFactory");
    if (resourceSnapshotProvider !== null && typeof resourceSnapshotProvider !== "function") {
      throw new Error("resourceSnapshotProvider must be a function when provided");
    }

    this.#defaultCwd = path.resolve(defaultCwd);
    this.#maxEvents = maxEvents;
    this.#resourceSnapshotProvider = resourceSnapshotProvider;
    const serverRequestHandler = (request) => this.#onServerRequest(request);
    this.#client = clientFactory
      ? clientFactory({ cwd: this.#defaultCwd, requestTimeoutMs, serverRequestHandler })
      : new CodexAppServerClient({
          cwd: this.#defaultCwd,
          launch: () => ({
            command: codexBin,
            args: [
              ...configOverrides.flatMap((value) => ["-c", value]),
              "app-server",
              "--stdio",
            ],
            options: { cwd: this.#defaultCwd },
          }),
          requestTimeoutMs,
          initializeCapabilities: { experimentalApi: true },
          serverRequestHandler,
          clientInfo: {
            name: "codexless_agent",
            title: "Codexless Agent",
            version: "0.1.50-household-workspace",
          },
        });
  }

  get running() {
    return this.#opened && !this.#closed && this.#client.running;
  }

  async open() {
    if (this.#closed) throw new Error("CodexAgentExecutor is closed");
    if (this.#opened) return this.#client.initializedResult;
    const initialized = await this.#client.start();
    this.#unsubscribe = this.#client.onNotification((message) => this.#onNotification(message));
    this.#opened = true;
    return initialized;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#agents.clear();
    this.#clientRequestIds.clear();
    this.#sendRequestIds.clear();
    this.#controlRequestIds.clear();
    await this.#client.close();
  }

  async listModels({ cursor = null, limit = null, includeHidden = false } = {}) {
    this.#assertOpen();
    if (cursor !== null && (typeof cursor !== "string" || !cursor)) throw new Error("cursor must be a non-empty string when provided");
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) throw new Error("limit must be an integer from 1 to 200 when provided");
    if (typeof includeHidden !== "boolean") throw new Error("includeHidden must be a boolean");
    const result = await this.#client.request("model/list", {
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
      includeHidden,
    });
    return {
      models: Array.isArray(result?.data) ? result.data.map(projectCodexModel).filter(Boolean) : [],
      nextCursor: typeof result?.nextCursor === "string" ? result.nextCursor : null,
    };
  }

  async start({ cwd = this.#defaultCwd, task, clientRequestId = null, permissionProfile = null, model = null, reasoningEffort = null }) {
    this.#assertOpen();
    if (typeof task !== "string" || !task.trim()) throw new Error("task must be a non-empty string");
    if (clientRequestId !== null && (typeof clientRequestId !== "string" || !clientRequestId.trim())) {
      throw new Error("clientRequestId must be a non-empty string when provided");
    }
    if (permissionProfile !== null && (typeof permissionProfile !== "string" || !permissionProfile.trim())) {
      throw new Error("permissionProfile must be a non-empty string when provided");
    }
    const requestedModel = normalizeModel(model);
    const requestedReasoningEffort = normalizeReasoningEffort(reasoningEffort);

    const effectiveCwd = path.resolve(cwd);
    const requestHash = hashRequest(effectiveCwd, task, requestedModel, requestedReasoningEffort);
    if (clientRequestId) {
      const prior = this.#clientRequestIds.get(clientRequestId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new Error(`clientRequestId was already used for a different agent start: ${clientRequestId}`);
        }
        const state = this.#agents.get(prior.agentRef);
        if (!state) return this.#unknown(prior.agentRef, "accepted start mapping is no longer available");
        return { ...this.#snapshot(state, 0), duplicate: true };
      }
    }

    let validatedReasoningModel = null;
    if (requestedReasoningEffort) {
      const validation = await this.#validateReasoningEffort({
        requestedModel,
        currentModel: null,
        requestedReasoningEffort,
      });
      validatedReasoningModel = validation.effectiveModel;
    }

    const agentRef = `agent_${randomUUID()}`;
    const state = {
      agentRef,
      cwd: effectiveCwd,
      threadId: null,
      currentTurnId: null,
      status: "starting",
      latestTurnStatus: null,
      finalResult: null,
      latestError: null,
      pendingApproval: null,
      pendingRequestHandle: null,
      approvalItems: new Map(),
      latestTokenUsage: null,
      resourceReceipt: null,
      resourceReceiptTurnId: null,
      resourceReceiptPromise: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnStartedAt: null,
      turnEndedAt: null,
      turnDurationMs: null,
      lastCompletedTurnId: null,
      permissionProfile,
      requestedModel,
      requestedReasoningEffort,
      resolvedModel: null,
      modelProvider: null,
      serviceTier: null,
      reasoningEffort: null,
      events: [],
    };
    this.#agents.set(agentRef, state);
    if (clientRequestId) this.#clientRequestIds.set(clientRequestId, { agentRef, requestHash });

    try {
      const threadParams = {
        cwd: effectiveCwd,
        ephemeral: false,
      };
      if (permissionProfile) threadParams.permissions = permissionProfile;
      if (requestedModel || validatedReasoningModel) threadParams.model = requestedModel ?? validatedReasoningModel;
      // Current App Server v2 does not accept reasoningEffort as a top-level
      // thread/start parameter. Bind the approved effort through the supported
      // per-thread config override so thread/start can resolve and echo the
      // effective effort before any metered turn is dispatched.
      if (requestedReasoningEffort) {
        threadParams.config = { model_reasoning_effort: requestedReasoningEffort };
      }
      const started = await this.#client.request("thread/start", threadParams);
      const threadId = started?.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("thread/start returned no formal thread id");
      if (permissionProfile) {
        const activeProfile = started?.activePermissionProfile?.id;
        if (activeProfile !== permissionProfile) {
          throw new Error(
            `thread/start authority mismatch: expected ${permissionProfile}, got ${String(activeProfile ?? "missing")}`
          );
        }
      }
      const expectedModel = requestedModel ?? validatedReasoningModel;
      const acceptedModel = typeof started?.model === "string" ? started.model : null;
      if (expectedModel && acceptedModel !== expectedModel) {
        throw new Error(
          `CODEX_AGENT_SELECTION_MISMATCH: prepared model "${expectedModel}" was not honored by thread/start (observed ${acceptedModel ?? "missing"}); no Codex turn was started`
        );
      }
      const acceptedReasoningEffort = typeof started?.reasoningEffort === "string" ? started.reasoningEffort : null;
      if (requestedReasoningEffort && acceptedReasoningEffort !== requestedReasoningEffort) {
        throw new Error(
          `CODEX_AGENT_SELECTION_MISMATCH: prepared reasoning effort "${requestedReasoningEffort}" was not honored by thread/start (observed ${acceptedReasoningEffort ?? "missing"}); no Codex turn was started`
        );
      }
      state.threadId = threadId;
      state.status = "idle";
      state.resolvedModel = acceptedModel ?? requestedModel;
      state.modelProvider = typeof started?.modelProvider === "string" ? started.modelProvider : null;
      state.serviceTier = typeof started?.serviceTier === "string" ? started.serviceTier : null;
      state.reasoningEffort = acceptedReasoningEffort;
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "thread/accepted", threadId, model: state.resolvedModel, at: Date.now() });
    } catch (error) {
      this.#agents.delete(agentRef);
      if (clientRequestId) this.#clientRequestIds.delete(clientRequestId);
      throw error;
    }

    try {
      state.turnStartedAt = Date.now();
      state.turnEndedAt = null;
      state.turnDurationMs = null;
      const turnStarted = await this.#client.request("turn/start", {
        threadId: state.threadId,
        clientUserMessageId: clientRequestId ?? agentRef,
        input: [{ type: "text", text: task }],
        // thread/start establishes the thread default; mirror the same explicit
        // request onto the first turn so turn/start cannot silently diverge.
        ...(requestedReasoningEffort ? { effort: requestedReasoningEffort } : {}),
      });
      const turn = turnStarted?.turn;
      if (typeof turn?.id !== "string" || !turn.id) throw new Error("turn/start returned no turn id");
      state.currentTurnId = turn.id;
      state.latestTurnStatus = turn.status ?? "inProgress";
      state.status = state.pendingApproval ? "awaitingApproval" : normalizeAgentStatus(state.latestTurnStatus);
      if (state.status === "unknown") state.status = "running";
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/accepted", turnId: turn.id, status: turn.status ?? null, at: Date.now() });
      return { ...this.#snapshot(state, 0), duplicate: false };
    } catch (error) {
      state.latestError = error instanceof Error ? error.message : String(error);
      if (state.pendingApproval) {
        if (!state.currentTurnId && state.pendingApproval.turnId) state.currentTurnId = state.pendingApproval.turnId;
        if (!state.latestTurnStatus) state.latestTurnStatus = "inProgress";
        state.status = "awaitingApproval";
      } else {
        state.status = "unknown";
      }
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/acceptance-unknown", text: state.latestError, at: Date.now() });
      return { ...this.#snapshot(state, 0), duplicate: false };
    }
  }

  async show({ agentRef, afterSeq = 0 }) {
    this.#assertOpen();
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const state = this.#agents.get(agentRef);
    if (!state) return this.#unknown(agentRef, "unknown agentRef");
    await this.#refreshFromOfficial(state);
    await this.#ensureResourceReceipt(state);
    return this.#snapshot(state, afterSeq);
  }

  async resolvePendingRequest({ agentRef, requestId, result }) {
    this.#assertOpen();
    const state = this.#agents.get(agentRef);
    if (!state) throw new Error(`unknown agentRef: ${agentRef}`);
    if (!state.pendingApproval || !state.pendingRequestHandle) {
      throw new Error(`agent has no pending server request: ${agentRef}`);
    }
    if (String(state.pendingApproval.requestId) !== String(requestId)) {
      throw new Error(`server request is unknown or stale for agent ${agentRef}: ${String(requestId)}`);
    }
    state.pendingRequestHandle.resolve(result);
    const resolvedId = state.pendingApproval.requestId;
    state.pendingApproval = null;
    state.pendingRequestHandle = null;
    state.status = normalizeAgentStatus(state.latestTurnStatus);
    if (state.status === "unknown") state.status = "running";
    state.updatedAt = Date.now();
    this.#appendEvent(state, { type: "server-request/resolved-local", requestId: resolvedId, at: Date.now() });
    return this.#snapshot(state, 0);
  }

  async rejectPendingRequest({ agentRef, requestId, error }) {
    this.#assertOpen();
    const state = this.#agents.get(agentRef);
    if (!state) throw new Error(`unknown agentRef: ${agentRef}`);
    if (!state.pendingApproval || !state.pendingRequestHandle) {
      throw new Error(`agent has no pending server request: ${agentRef}`);
    }
    if (String(state.pendingApproval.requestId) !== String(requestId)) {
      throw new Error(`server request is unknown or stale for agent ${agentRef}: ${String(requestId)}`);
    }
    state.pendingRequestHandle.reject(error);
    const rejectedId = state.pendingApproval.requestId;
    state.pendingApproval = null;
    state.pendingRequestHandle = null;
    state.status = normalizeAgentStatus(state.latestTurnStatus);
    if (state.status === "unknown") state.status = "running";
    state.updatedAt = Date.now();
    this.#appendEvent(state, { type: "server-request/rejected-local", requestId: rejectedId, at: Date.now() });
    return this.#snapshot(state, 0);
  }

  async resolveApproval({ agentRef, approvalRequestId, clientRequestId, decision }) {
    this.#assertOpen();
    if (!new Set(["approve", "reject"]).has(decision)) throw new Error("decision must be approve or reject");
    if (typeof approvalRequestId !== "string" || !approvalRequestId.trim()) {
      throw new Error("approvalRequestId must be a non-empty string");
    }
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
      throw new Error("clientRequestId must be a non-empty string");
    }
    const hash = controlRequestHash(decision, agentRef, approvalRequestId);
    const prior = this.#controlRequestIds.get(clientRequestId);
    if (prior) {
      if (prior.requestHash !== hash) {
        throw new Error(`clientRequestId was already used for a different agent control action: ${clientRequestId}`);
      }
      const priorState = this.#agents.get(prior.agentRef);
      if (!priorState) return { ...this.#unknown(prior.agentRef, "accepted control mapping is no longer available"), duplicate: true };
      return { ...this.#snapshot(priorState, 0), duplicate: true };
    }

    const state = this.#agents.get(agentRef);
    if (!state) return this.#unknown(agentRef, "unknown agentRef");
    if (!state.pendingApproval || !state.pendingRequestHandle) {
      throw new Error(`agent has no pending Codex approval: ${agentRef}`);
    }
    if (String(state.pendingApproval.requestId) !== approvalRequestId) {
      throw new Error(`approval request is unknown or stale for agent ${agentRef}: ${approvalRequestId}`);
    }

    const result = approvalResponseFor(state.pendingRequestHandle, decision);
    const snapshot = await this.resolvePendingRequest({ agentRef, requestId: approvalRequestId, result });
    this.#controlRequestIds.set(clientRequestId, { agentRef, requestHash: hash });
    return { ...snapshot, duplicate: false };
  }

  async cancel({ agentRef, clientRequestId, expectedTurnId = null }) {
    this.#assertOpen();
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
      throw new Error("clientRequestId must be a non-empty string");
    }
    const state = this.#agents.get(agentRef);
    if (!state) return this.#unknown(agentRef, "unknown agentRef");
    await this.#refreshFromOfficial(state);
    const targetTurnId = state.currentTurnId;
    if (expectedTurnId !== null && expectedTurnId !== targetTurnId) {
      throw new Error(`agent task turn changed: expected ${expectedTurnId}, current ${String(targetTurnId ?? "none")}`);
    }
    const hash = controlRequestHash("cancel", agentRef, targetTurnId);
    const prior = this.#controlRequestIds.get(clientRequestId);
    if (prior) {
      if (prior.requestHash !== hash) {
        throw new Error(`clientRequestId was already used for a different agent control action: ${clientRequestId}`);
      }
      await this.#refreshFromOfficial(state);
      return { ...this.#snapshot(state, 0), duplicate: true, controlAcceptance: prior.acceptance ?? "accepted" };
    }
    if (!targetTurnId || !state.threadId || !["running", "awaitingApproval", "unknown"].includes(state.status)) {
      throw new Error(`agent has no interruptible active turn: ${agentRef} (${state.status})`);
    }
    const earlierCancel = [...this.#controlRequestIds.entries()].find(([, entry]) =>
      entry?.action === "cancel" &&
      entry?.agentRef === agentRef &&
      entry?.targetId === targetTurnId &&
      entry?.acceptance !== "rejected"
    );
    if (earlierCancel) {
      throw new Error(`cancel was already dispatched for this turn under requestId ${earlierCancel[0]}; query agent_show or retry that exact requestId instead of replaying turn/interrupt`);
    }

    const record = { agentRef, requestHash: hash, action: "cancel", targetId: targetTurnId, acceptance: "dispatching" };
    this.#controlRequestIds.set(clientRequestId, record);
    this.#appendEvent(state, { type: "turn/interrupt-dispatched", turnId: targetTurnId, requestId: clientRequestId, at: Date.now() });
    try {
      await this.#client.request("turn/interrupt", { threadId: state.threadId, turnId: targetTurnId });
      record.acceptance = "accepted";
      state.latestTurnStatus = "interrupted";
      if (!state.pendingApproval) state.status = "interrupted";
      state.latestError = null;
      if (state.turnEndedAt === null) {
        state.turnEndedAt = Date.now();
        state.turnDurationMs = state.turnStartedAt === null ? null : Math.max(0, state.turnEndedAt - state.turnStartedAt);
      }
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/interrupt-accepted", turnId: targetTurnId, requestId: clientRequestId, at: Date.now() });
      await this.#ensureResourceReceipt(state);
      return { ...this.#snapshot(state, 0), duplicate: false, controlAcceptance: "accepted" };
    } catch (error) {
      record.acceptance = "unknown";
      state.latestError = `turn/interrupt acceptance unknown; do not replay: ${error instanceof Error ? error.message : String(error)}`;
      state.status = "unknown";
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/interrupt-acceptance-unknown", turnId: targetTurnId, requestId: clientRequestId, text: state.latestError, at: Date.now() });
      await this.#refreshFromOfficial(state);
      if (state.latestTurnStatus === "interrupted") {
        record.acceptance = "accepted";
        state.latestError = null;
      } else if (["completed", "failed"].includes(state.latestTurnStatus)) {
        record.acceptance = "accepted";
      } else {
        state.status = "unknown";
      }
      await this.#ensureResourceReceipt(state);
      return { ...this.#snapshot(state, 0), duplicate: false, controlAcceptance: record.acceptance };
    }
  }

  async send({ agentRef, message, clientRequestId = null, model = null, reasoningEffort = null }) {
    this.#assertOpen();
    if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
    if (clientRequestId !== null && (typeof clientRequestId !== "string" || !clientRequestId.trim())) {
      throw new Error("clientRequestId must be a non-empty string when provided");
    }
    const requestedModel = normalizeModel(model);
    const requestedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
    const sendHashBase = `${agentRef}\0${message}\0${requestedModel ?? ""}`;
    const sendHashMaterial = requestedReasoningEffort === null
      ? sendHashBase
      : `${sendHashBase}\0reasoningEffort=${requestedReasoningEffort}`;
    const requestHash = createHash("sha256").update(sendHashMaterial, "utf8").digest("hex");
    if (clientRequestId) {
      const prior = this.#sendRequestIds.get(clientRequestId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new Error(`clientRequestId was already used for a different agent send: ${clientRequestId}`);
        }
        const priorState = this.#agents.get(prior.agentRef);
        if (!priorState) return this.#unknown(prior.agentRef, "accepted send mapping is no longer available");
        return { ...this.#snapshot(priorState, 0), duplicate: true };
      }
    }

    const state = this.#agents.get(agentRef);
    if (!state) return this.#unknown(agentRef, "unknown agentRef");

    await this.#refreshFromOfficial(state);
    if (state.pendingApproval) throw new Error(`agent ${agentRef} has a pending Codex approval`);
    if (state.status !== "idle") throw new Error(`agent ${agentRef} is not idle: ${state.status}`);

    const resumed = await this.#client.request("thread/resume", { threadId: state.threadId });
    if (resumed?.thread?.canAcceptDirectInput === false) {
      throw new Error(`Codex thread cannot accept direct input: ${state.threadId}`);
    }
    if (typeof resumed?.model === "string") state.resolvedModel = resumed.model;
    if (typeof resumed?.modelProvider === "string") state.modelProvider = resumed.modelProvider;
    state.serviceTier = typeof resumed?.serviceTier === "string" ? resumed.serviceTier : state.serviceTier;
    state.reasoningEffort = typeof resumed?.reasoningEffort === "string" ? resumed.reasoningEffort : state.reasoningEffort;

    if (requestedReasoningEffort) {
      await this.#validateReasoningEffort({
        requestedModel,
        currentModel: typeof resumed?.model === "string" ? resumed.model : state.resolvedModel,
        requestedReasoningEffort,
      });
    }

    if (clientRequestId) this.#sendRequestIds.set(clientRequestId, { agentRef, requestHash });

    // The next turn becomes the current logical turn as soon as dispatch begins.
    // Clear the previous completed-turn projection so an uncertain turn/start
    // response cannot make show() keep reporting the prior turn as current.
    state.currentTurnId = null;
    state.latestTurnStatus = null;
    state.latestTokenUsage = null;
    state.resourceReceipt = null;
    state.resourceReceiptTurnId = null;
    state.resourceReceiptPromise = null;
    state.finalResult = null;
    state.latestError = null;
    state.status = "running";
    state.requestedModel = requestedModel;
    state.requestedReasoningEffort = requestedReasoningEffort;
    state.turnStartedAt = Date.now();
    state.turnEndedAt = null;
    state.turnDurationMs = null;
    state.updatedAt = Date.now();

    try {
      const turnStarted = await this.#client.request("turn/start", {
        threadId: state.threadId,
        clientUserMessageId: clientRequestId ?? `${agentRef}_${randomUUID()}`,
        input: [{ type: "text", text: message }],
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedReasoningEffort ? { effort: requestedReasoningEffort } : {}),
      });
      const turn = turnStarted?.turn;
      if (typeof turn?.id !== "string" || !turn.id) throw new Error("turn/start returned no turn id");
      state.currentTurnId = turn.id;
      state.latestTurnStatus = turn.status ?? "inProgress";
      state.status = state.pendingApproval ? "awaitingApproval" : normalizeAgentStatus(state.latestTurnStatus);
      if (state.status === "unknown") state.status = "running";
      state.finalResult = null;
      state.latestError = null;
      if (requestedModel) state.resolvedModel = null;
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/accepted", turnId: turn.id, status: turn.status ?? null, model: state.resolvedModel, at: Date.now() });
      return { ...this.#snapshot(state, 0), duplicate: false };
    } catch (error) {
      state.latestError = error instanceof Error ? error.message : String(error);
      if (state.pendingApproval) {
        if (!state.currentTurnId && state.pendingApproval.turnId) state.currentTurnId = state.pendingApproval.turnId;
        if (!state.latestTurnStatus) state.latestTurnStatus = "inProgress";
        state.status = "awaitingApproval";
      } else {
        state.status = "unknown";
      }
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/acceptance-unknown", text: state.latestError, at: Date.now() });
      return { ...this.#snapshot(state, 0), duplicate: false };
    }
  }

  async #currentModelCatalog() {
    const models = [];
    const seenCursors = new Set();
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.listModels({ cursor, limit: 200, includeHidden: true });
      models.push(...result.models);
      if (!result.nextCursor) return models;
      if (seenCursors.has(result.nextCursor)) throw new Error("Codex model catalog pagination repeated a cursor");
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("Codex model catalog exceeded the bounded pagination limit");
  }

  async #validateReasoningEffort({ requestedModel, currentModel, requestedReasoningEffort }) {
    let catalog;
    try {
      catalog = await this.#currentModelCatalog();
    } catch (error) {
      const modelLabel = requestedModel ?? currentModel ?? "<unresolved>";
      throw new Error(
        `reasoningEffort validation failed for model "${modelLabel}": requested effort "${requestedReasoningEffort}"; supported efforts unknown; current model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let effectiveModel = requestedModel ?? currentModel ?? null;
    if (!effectiveModel) {
      const defaults = catalog.filter((entry) => entry?.isDefault === true && modelIdentity(entry));
      if (defaults.length === 1) effectiveModel = modelIdentity(defaults[0]);
    }
    if (!effectiveModel) {
      throw new Error(
        `reasoningEffort validation failed for model "<unresolved>": requested effort "${requestedReasoningEffort}"; supported efforts unknown; current/default model could not be resolved from the current Codex model catalog`
      );
    }

    const entry = catalog.find((candidate) => candidate?.model === effectiveModel || candidate?.id === effectiveModel) ?? null;
    if (!entry) {
      throw new Error(
        `reasoningEffort validation failed for model "${effectiveModel}": requested effort "${requestedReasoningEffort}"; supported efforts unknown; model is not present in the current Codex model catalog`
      );
    }
    const supported = supportedReasoningEfforts(entry);
    if (!supported.includes(requestedReasoningEffort)) {
      throw new Error(
        `reasoningEffort validation failed for model "${effectiveModel}": requested effort "${requestedReasoningEffort}"; supported efforts: ${supported.length ? supported.join(", ") : "(none)"}`
      );
    }
    return { effectiveModel, supportedReasoningEfforts: supported };
  }

  async #refreshFromOfficial(state) {
    if (!state.threadId) return;
    try {
      const turns = await this.#client.request("thread/turns/list", {
        threadId: state.threadId,
        limit: 20,
      });
      const data = Array.isArray(turns?.data) ? turns.data : [];
      const turn = state.currentTurnId
        ? data.find((candidate) => candidate?.id === state.currentTurnId)
        : data[0];
      if (!turn) return;
      const currentTurnAlreadyTerminal = state.turnEndedAt !== null || TERMINAL_TURN_STATUSES.has(state.latestTurnStatus);
      const officialTurnIsTerminal = TERMINAL_TURN_STATUSES.has(turn.status);
      if (currentTurnAlreadyTerminal && !officialTurnIsTerminal) {
        const resumed = await this.#client.request("thread/resume", { threadId: state.threadId });
        if (typeof resumed?.model === "string") state.resolvedModel = resumed.model;
        if (typeof resumed?.modelProvider === "string") state.modelProvider = resumed.modelProvider;
        state.serviceTier = typeof resumed?.serviceTier === "string" ? resumed.serviceTier : state.serviceTier;
        state.reasoningEffort = typeof resumed?.reasoningEffort === "string" ? resumed.reasoningEffort : state.reasoningEffort;
        state.updatedAt = Date.now();
        this.#appendEvent(state, { type: "nonterminal-official-refresh-ignored", turnId: turn.id, status: turn.status ?? null, at: Date.now() });
        return;
      }
      state.currentTurnId = turn.id;
      state.latestTurnStatus = turn.status ?? state.latestTurnStatus;
      state.status = normalizeAgentStatus(turn.status);
      if (state.pendingApproval) state.status = "awaitingApproval";
      if (turn.status === "completed") {
        state.lastCompletedTurnId = turn.id;
        state.finalResult = lastAgentMessage(turn);
        state.latestError = null;
      } else if (turn.status === "failed") {
        state.latestError = turn?.error?.message ?? JSON.stringify(turn?.error ?? "turn failed");
      } else if (turn.status === "interrupted") {
        state.finalResult = lastAgentMessage(turn) ?? state.finalResult;
        state.latestError = null;
      }
      if (TERMINAL_TURN_STATUSES.has(turn.status) && state.turnEndedAt === null) {
        state.turnEndedAt = Date.now();
        state.turnDurationMs = state.turnStartedAt === null ? null : Math.max(0, state.turnEndedAt - state.turnStartedAt);
      }
      if (TERMINAL_TURN_STATUSES.has(turn.status)) {
        const resumed = await this.#client.request("thread/resume", { threadId: state.threadId });
        if (typeof resumed?.model === "string") state.resolvedModel = resumed.model;
        if (typeof resumed?.modelProvider === "string") state.modelProvider = resumed.modelProvider;
        state.serviceTier = typeof resumed?.serviceTier === "string" ? resumed.serviceTier : state.serviceTier;
        state.reasoningEffort = typeof resumed?.reasoningEffort === "string" ? resumed.reasoningEffort : state.reasoningEffort;
      }
      state.updatedAt = Date.now();
    } catch (error) {
      state.latestError = error instanceof Error ? error.message : String(error);
      if (state.status === "starting") state.status = "unknown";
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "official-refresh-error", text: state.latestError, at: Date.now() });
    }
  }

  #onNotification(message) {
    const threadId = notificationThreadId(message);
    const turnId = notificationTurnId(message);
    const requestId = notificationRequestId(message);
    const state = [...this.#agents.values()].find((candidate) =>
      (threadId && candidate.threadId === threadId) ||
      (turnId && candidate.currentTurnId === turnId) ||
      (requestId !== null && candidate.pendingApproval && String(candidate.pendingApproval.requestId) === String(requestId))
    );
    if (!state) return;

    const turn = notificationTurn(message);
    if (["turn/started", "turn/completed"].includes(message.method) && turnId && state.currentTurnId && turnId !== state.currentTurnId) {
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "stale-turn-notification-ignored", method: message.method, turnId, currentTurnId: state.currentTurnId, at: Date.now() });
      return;
    }
    if (turnId && !state.currentTurnId) state.currentTurnId = turnId;
    if (message.method === "thread/tokenUsage/updated" && message?.params?.tokenUsage) {
      state.latestTokenUsage = structuredClone(message.params.tokenUsage);
    }
    if (message.method === "item/started" && message?.params?.item?.id) {
      state.approvalItems.set(message.params.item.id, structuredClone(message.params.item));
      if (state.approvalItems.size > 32) {
        const oldest = state.approvalItems.keys().next().value;
        state.approvalItems.delete(oldest);
      }
    }
    if (message.method === "item/completed" && message?.params?.item?.id) {
      state.approvalItems.delete(message.params.item.id);
    }
    if (message.method === "serverRequest/resolved") {
      if (state.pendingApproval && String(state.pendingApproval.requestId) === String(requestId)) {
        state.pendingApproval = null;
        state.pendingRequestHandle = null;
        state.status = normalizeAgentStatus(state.latestTurnStatus);
        if (state.status === "unknown") state.status = "running";
      }
    } else if (message.method === "turn/started") {
      const currentTurnAlreadyTerminal = state.turnEndedAt !== null || TERMINAL_TURN_STATUSES.has(state.latestTurnStatus);
      if (!currentTurnAlreadyTerminal) {
        state.latestTurnStatus = turn?.status ?? "inProgress";
        state.status = state.pendingApproval ? "awaitingApproval" : "running";
        if (state.turnStartedAt === null) state.turnStartedAt = Date.now();
      }
    } else if (message.method === "turn/completed") {
      const status = turn?.status ?? "completed";
      state.latestTurnStatus = status;
      state.status = normalizeAgentStatus(status);
      if (status === "completed") {
        state.lastCompletedTurnId = turn?.id ?? state.currentTurnId;
        state.finalResult = lastAgentMessage(turn) ?? state.finalResult;
        state.latestError = null;
      } else if (status === "failed") {
        state.latestError = turn?.error?.message ?? JSON.stringify(turn?.error ?? "turn failed");
      } else if (status === "interrupted") {
        state.finalResult = lastAgentMessage(turn) ?? state.finalResult;
        state.latestError = null;
      }
      if (TERMINAL_TURN_STATUSES.has(status) && state.turnEndedAt === null) {
        state.turnEndedAt = Date.now();
        state.turnDurationMs = state.turnStartedAt === null ? null : Math.max(0, state.turnEndedAt - state.turnStartedAt);
      }
    } else if (message.method === "thread/status/changed") {
      const type = message?.params?.status?.type;
      const currentTurnTerminal = state.turnEndedAt !== null || TERMINAL_TURN_STATUSES.has(state.latestTurnStatus);
      if (type === "active" && !currentTurnTerminal) state.status = state.pendingApproval ? "awaitingApproval" : "running";
      if (type === "idle" && state.status === "running") state.status = "idle";
      if (type === "systemError" && !currentTurnTerminal) state.status = "failed";
    }
    state.updatedAt = Date.now();
    this.#appendEvent(state, compactNotification(message));
  }

  #onServerRequest(request) {
    const params = request?.params && typeof request.params === "object" ? request.params : {};
    const threadId = params.threadId ?? null;
    const turnId = params.turnId ?? null;
    const state = [...this.#agents.values()].find((candidate) =>
      (threadId && candidate.threadId === threadId) || (turnId && candidate.currentTurnId === turnId)
    );
    if (!state) {
      request.reject({
        code: -32602,
        message: `Agent server request could not be mapped to an active agent: ${request.method}`,
      });
      return;
    }
    if (turnId && !state.currentTurnId) state.currentTurnId = turnId;
    if (!state.latestTurnStatus) state.latestTurnStatus = "inProgress";
    if (state.pendingApproval) {
      request.reject({
        code: -32000,
        message: `Agent already has a pending server request: ${String(state.pendingApproval.requestId)}`,
      });
      return;
    }

    state.pendingApproval = approvalSummary(request, state.approvalItems.get(params.itemId ?? params.item?.id ?? null) ?? null);
    state.pendingRequestHandle = request;
    state.status = "awaitingApproval";
    state.updatedAt = Date.now();
    this.#appendEvent(state, {
      type: "server-request/pending",
      requestId: request.id,
      method: request.method,
      turnId: state.pendingApproval.turnId,
      at: state.pendingApproval.receivedAt,
    });
  }

  #appendEvent(state, event) {
    state.events.push({ seq: this.#nextEventSeq++, ...event });
    if (state.events.length > this.#maxEvents) state.events.splice(0, state.events.length - this.#maxEvents);
  }

  async #ensureResourceReceipt(state) {
    if (!state?.currentTurnId || !TERMINAL_TURN_STATUSES.has(state.latestTurnStatus)) return state?.resourceReceipt ?? null;
    if (state.resourceReceipt && state.resourceReceiptTurnId === state.currentTurnId) return state.resourceReceipt;
    if (state.resourceReceiptPromise) return await state.resourceReceiptPromise;

    const turnId = state.currentTurnId;
    state.resourceReceiptPromise = (async () => {
      let quotaSnapshot;
      try {
        quotaSnapshot = this.#resourceSnapshotProvider
          ? await this.#resourceSnapshotProvider({
              agentRef: state.agentRef,
              threadId: state.threadId,
              turnId,
              cwd: state.cwd,
            })
          : {
              status: "unavailable",
              observedAt: new Date().toISOString(),
              usage: { status: "unavailable", error: { name: "Unavailable", message: "resource telemetry provider is not configured" } },
              rateLimits: { status: "unavailable", error: { name: "Unavailable", message: "resource telemetry provider is not configured" } },
            };
      } catch (error) {
        const projected = {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        };
        quotaSnapshot = {
          status: "unavailable",
          observedAt: new Date().toISOString(),
          usage: { status: "unavailable", error: projected },
          rateLimits: { status: "unavailable", error: projected },
        };
      }
      const receipt = buildAgentResourceReceipt({
        turnId,
        turnStatus: state.latestTurnStatus,
        tokenUsage: state.latestTokenUsage,
        quotaSnapshot,
      });
      state.resourceReceipt = receipt;
      state.resourceReceiptTurnId = turnId;
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "resource-receipt/ready", turnId, at: Date.now() });
      return receipt;
    })();
    try {
      return await state.resourceReceiptPromise;
    } finally {
      state.resourceReceiptPromise = null;
    }
  }

  #snapshot(state, afterSeq) {
    const events = state.events.filter((event) => event.seq > afterSeq);
    const nextSeq = state.events.length ? state.events[state.events.length - 1].seq : afterSeq;
    return {
      agentRef: state.agentRef,
      threadId: state.threadId,
      turnId: state.currentTurnId,
      status: state.status,
      latestTurnStatus: state.latestTurnStatus,
      canSend: state.status === "idle" && !state.pendingApproval,
      pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null,
      finalResult: state.finalResult,
      resourceReceipt: state.resourceReceipt ? structuredClone(state.resourceReceipt) : null,
      latestError: state.latestError,
      lastCompletedTurnId: state.lastCompletedTurnId,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      timing: {
        startedAt: state.turnStartedAt,
        endedAt: state.turnEndedAt,
        durationMs: state.turnDurationMs,
      },
      execution: {
        requestedModel: state.requestedModel,
        ...(state.requestedReasoningEffort ? { requestedReasoningEffort: state.requestedReasoningEffort } : {}),
        resolvedModel: state.resolvedModel,
        modelProvider: state.modelProvider,
        serviceTier: state.serviceTier,
        reasoningEffort: state.reasoningEffort,
      },
      events,
      nextSeq,
      serverRequestMethods: this.#client.serverRequestMethods,
    };
  }

  #unknown(agentRef, message) {
    return {
      agentRef: typeof agentRef === "string" ? agentRef : null,
      threadId: null,
      turnId: null,
      status: "unknown",
      latestTurnStatus: null,
      canSend: false,
      pendingApproval: null,
      finalResult: null,
      resourceReceipt: null,
      latestError: message,
      lastCompletedTurnId: null,
      timing: { startedAt: null, endedAt: null, durationMs: null },
      execution: { requestedModel: null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
      events: [],
      nextSeq: 0,
      serverRequestMethods: this.#client.serverRequestMethods,
    };
  }

  #assertOpen() {
    if (!this.#opened || this.#closed || !this.#client.running) {
      throw new Error("CodexAgentExecutor is not open");
    }
  }
}
