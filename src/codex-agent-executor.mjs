import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { buildAgentResourceReceipt, unavailableQuotaSnapshot } from "./agent-resource.mjs";

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const DEFAULT_MAX_EVENTS = 128;
const MAX_EVENT_TEXT_CHARS = 2_048;

function digest(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function hashRequest(cwd, task, model = null, reasoningEffort = null) {
  return digest(reasoningEffort === null ? `${cwd}\0${task}\0${model ?? ""}` : `${cwd}\0${task}\0${model ?? ""}\0reasoningEffort=${reasoningEffort}`);
}

function normalizeSelection(value, label, maxLength = null) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string when provided`);
  const normalized = value.trim();
  if (maxLength !== null && normalized.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters`);
  return normalized;
}

export function stringOrNull(value) { return typeof value === "string" ? value : null; }

function modelIdentity(entry) {
  return typeof entry?.model === "string" && entry.model
    ? entry.model
    : typeof entry?.id === "string" && entry.id
      ? entry.id
      : null;
}

function supportedReasoningEfforts(entry) {
  return Array.isArray(entry?.supportedReasoningEfforts) ? entry.supportedReasoningEfforts.map((value) => typeof value === "string" ? value : stringOrNull(value?.reasoningEffort)).filter(Boolean) : [];
}

function projectFields(value, fields) { return Object.fromEntries(fields.map((key) => [key, stringOrNull(value?.[key])])); }
function projectList(value, fields) { return Array.isArray(value) ? value.map((item) => projectFields(item, fields)) : []; }

function projectModel(entry) {
  const model = modelIdentity(entry);
  if (!model) return null;
  return {
    id: stringOrNull(entry.id),
    model: stringOrNull(entry.model),
    displayName: typeof entry?.displayName === "string" && entry.displayName ? entry.displayName : null,
    description: stringOrNull(entry.description),
    modelSpecialty: stringOrNull(entry.modelSpecialty),
    hidden: entry.hidden === true,
    isDefault: entry.isDefault === true,
    defaultReasoningEffort: typeof entry?.defaultReasoningEffort === "string" && entry.defaultReasoningEffort ? entry.defaultReasoningEffort : null,
    supportedReasoningEfforts: projectList(entry.supportedReasoningEfforts, ["reasoningEffort", "description"]),
    serviceTiers: projectList(entry.serviceTiers, ["id", "name", "description"]),
    defaultServiceTier: stringOrNull(entry.defaultServiceTier),
  };
}

const AGENT_STATUS = new Map([["inProgress", "running"], ["running", "running"], ["completed", "idle"], ["failed", "failed"], ["interrupted", "interrupted"]]);

function lastAgentMessage(turn) {
  return (Array.isArray(turn?.items) ? turn.items : []).findLast((item) => item?.type === "agentMessage" && typeof item.text === "string")?.text ?? null;
}

function notificationFields(message) {
  const params = message?.params ?? {};
  const turn = params.turn ?? null;
  return {
    threadId: params.threadId ?? params.thread?.id ?? null,
    turnId: params.turnId ?? turn?.id ?? null,
    requestId: params.requestId ?? null,
    turn,
  };
}

function requestKey(namespace, requestId) {
  return `${namespace}\0${requestId}`;
}

export function projectExecution(state = null) {
  return {
    requestedModel: state?.requestedModel ?? null,
    ...(state?.requestedReasoningEffort ? { requestedReasoningEffort: state.requestedReasoningEffort } : {}),
    resolvedModel: state?.resolvedModel ?? null,
    modelProvider: state?.modelProvider ?? null,
    serviceTier: state?.serviceTier ?? null,
    reasoningEffort: state?.reasoningEffort ?? null,
  };
}

export async function collectModelCatalog(listModels, {
  includeHidden = false,
  maxPages = 10,
  repeatedCursorMessage = "Codex model catalog pagination repeated a cursor",
  limitMessage = "Codex model catalog exceeded the bounded pagination limit",
} = {}) {
  const models = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listModels({ cursor, limit: 200, includeHidden });
    models.push(...(Array.isArray(result?.models) ? result.models : []));
    if (!result?.nextCursor) return models;
    if (seenCursors.has(result.nextCursor)) throw new Error(repeatedCursorMessage);
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(limitMessage);
}

function approvalResponseFor(handle, decision) {
  const params = handle?.params && typeof handle.params === "object" ? handle.params : {};
  if (handle?.method === "item/commandExecution/requestApproval" || handle?.method === "item/fileChange/requestApproval") {
    const wanted = decision === "approve" ? "accept" : "decline";
    if (handle.method === "item/commandExecution/requestApproval" && Array.isArray(params.availableDecisions) && !params.availableDecisions.some((entry) => entry === wanted)) {
      throw new Error(`Codex approval does not offer ${wanted} for this command request`);
    }
    return { decision: wanted };
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
  return { kind: "unknown" };
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
  const { turnId } = notificationFields(message);
  if (turnId) event.turnId = turnId;
  const text = message.method === "item/agentMessage/delta" ? message?.params?.delta
    : message.method === "item/mcpToolCall/progress" ? message?.params?.message : null;
  if (typeof text === "string") event.text = text.slice(-MAX_EVENT_TEXT_CHARS);
  if (message.method === "thread/tokenUsage/updated" && message?.params?.tokenUsage) {
    event.tokenUsage = message.params.tokenUsage;
  }
  return event;
}

export class CodexAgentExecutor {
  #client;
  #defaultCwd;
  #agents = new Map();
  #requestIndex = new Map();
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
            args: [...configOverrides.flatMap((value) => ["-c", value]), "app-server", "--stdio"],
            options: { cwd: this.#defaultCwd },
          }),
          requestTimeoutMs,
          initializeCapabilities: { experimentalApi: true },
          serverRequestHandler,
          clientInfo: {
            name: "codexless_agent",
            title: "Codexless Agent",
            version: "0.1.0",
          },
        });
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
    this.#requestIndex.clear();
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
      models: Array.isArray(result?.data) ? result.data.map(projectModel).filter(Boolean) : [],
      nextCursor: stringOrNull(result?.nextCursor),
    };
  }

  async start({ cwd = this.#defaultCwd, task, clientRequestId = null, permissionProfile = null, model = null, reasoningEffort = null }) {
    this.#assertOpen();
    if (typeof task !== "string" || !task.trim()) throw new Error("task must be a non-empty string");
    if (clientRequestId !== null && (typeof clientRequestId !== "string" || !clientRequestId.trim())) throw new Error("clientRequestId must be a non-empty string when provided");
    if (permissionProfile !== null && (typeof permissionProfile !== "string" || !permissionProfile.trim())) {
      throw new Error("permissionProfile must be a non-empty string when provided");
    }
    const requestedModel = normalizeSelection(model, "model");
    const requestedReasoningEffort = normalizeSelection(reasoningEffort, "reasoningEffort", 128);

    const effectiveCwd = path.resolve(cwd);
    const requestHash = hashRequest(effectiveCwd, task, requestedModel, requestedReasoningEffort);
    const duplicate = this.#duplicateRequest("start", clientRequestId, requestHash, "accepted start mapping is no longer available");
    if (duplicate) return duplicate;

    const validatedReasoningModel = requestedReasoningEffort
      ? (await this.#validateReasoningEffort({ requestedModel, currentModel: null, requestedReasoningEffort })).effectiveModel
      : null;

    const agentRef = `agent_${randomUUID()}`;
    const state = {
      agentRef,
      cwd: effectiveCwd,
      approvalItems: new Map(),
      events: [],
    };
    this.#agents.set(agentRef, state);
    if (clientRequestId) this.#requestIndex.set(requestKey("start", clientRequestId), { agentRef, requestHash });

    try {
      const threadParams = { cwd: effectiveCwd, ephemeral: false };
      if (permissionProfile) threadParams.permissions = permissionProfile;
      if (requestedModel || validatedReasoningModel) threadParams.model = requestedModel ?? validatedReasoningModel;
      if (requestedReasoningEffort) threadParams.config = { model_reasoning_effort: requestedReasoningEffort };
      const started = await this.#client.request("thread/start", threadParams);
      const threadId = started?.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("thread/start returned no formal thread id");
      if (permissionProfile) {
        const activeProfile = started?.activePermissionProfile?.id;
        if (activeProfile !== permissionProfile) throw new Error(`thread/start authority mismatch: expected ${permissionProfile}, got ${String(activeProfile ?? "missing")}`);
      }
      const expectedModel = requestedModel ?? validatedReasoningModel;
      const acceptedModel = stringOrNull(started?.model);
      if (expectedModel && acceptedModel !== expectedModel) {
        throw new Error(`CODEX_AGENT_SELECTION_MISMATCH: prepared model "${expectedModel}" was not honored by thread/start (observed ${acceptedModel ?? "missing"}); no Codex turn was started`);
      }
      const acceptedReasoningEffort = stringOrNull(started?.reasoningEffort);
      if (requestedReasoningEffort && acceptedReasoningEffort !== requestedReasoningEffort) {
        throw new Error(`CODEX_AGENT_SELECTION_MISMATCH: prepared reasoning effort "${requestedReasoningEffort}" was not honored by thread/start (observed ${acceptedReasoningEffort ?? "missing"}); no Codex turn was started`);
      }
      state.threadId = threadId;
      state.status = "idle";
      this.#applyMetadata(state, { ...started, model: acceptedModel ?? requestedModel, reasoningEffort: acceptedReasoningEffort });
      this.#appendEvent(state, { type: "thread/accepted", threadId, model: state.resolvedModel, at: Date.now() });
    } catch (error) {
      this.#agents.delete(agentRef);
      if (clientRequestId) this.#requestIndex.delete(requestKey("start", clientRequestId));
      throw error;
    }

    return this.#startTurn(state, {
      text: task,
      clientUserMessageId: clientRequestId ?? agentRef,
      reasoningEffort: requestedReasoningEffort,
    });
  }

  async show({ agentRef, afterSeq = 0 }) {
    this.#assertOpen();
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const state = this.#agents.get(agentRef);
    if (!state) return this.#snapshot(null, 0, { agentRef, message: "unknown agentRef" });
    await this.#refreshFromOfficial(state);
    await this.#ensureResourceReceipt(state);
    return this.#snapshot(state, afterSeq);
  }

  async #startTurn(state, { text, clientUserMessageId, model = null, reasoningEffort = null }) {
    state.currentTurnId = null;
    state.latestTurnStatus = null;
    state.latestTokenUsage = null;
    state.resourceReceipt = null;
    state.finalResult = null;
    state.latestError = null;
    state.status = "running";
    state.requestedModel = model;
    state.requestedReasoningEffort = reasoningEffort;
    state.turnStartedAt = Date.now();
    state.turnEndedAt = null;
    try {
      const response = await this.#client.request("turn/start", {
        threadId: state.threadId,
        clientUserMessageId,
        input: [{ type: "text", text }],
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      });
      const turn = response?.turn;
      if (typeof turn?.id !== "string" || !turn.id) throw new Error("turn/start returned no turn id");
      this.#applyTurnObservation(state, { turnId: turn.id, status: turn.status ?? "inProgress", turn });
      this.#appendEvent(state, {
        type: "turn/accepted",
        turnId: turn.id,
        status: turn.status ?? null,
        ...(model ? { model: state.resolvedModel } : {}),
        at: Date.now(),
      });
    } catch (error) {
      state.latestError = error instanceof Error ? error.message : String(error);
      if (state.pendingApproval) {
        state.currentTurnId ||= state.pendingApproval.turnId ?? null;
        state.latestTurnStatus ||= "inProgress";
      }
      state.status = state.pendingApproval ? "awaitingApproval" : "unknown";
      this.#appendEvent(state, { type: "turn/acceptance-unknown", text: state.latestError, at: Date.now() });
    }
    return { ...this.#snapshot(state, 0), duplicate: false };
  }

  #duplicateRequest(namespace, requestId, requestHash, missingMessage) {
    if (!requestId) return null;
    const prior = this.#requestIndex.get(requestKey(namespace, requestId));
    if (!prior) return null;
    if (prior.requestHash !== requestHash) throw new Error(`clientRequestId was already used for a different agent ${namespace}: ${requestId}`);
    const state = this.#agents.get(prior.agentRef);
    return state ? { ...this.#snapshot(state, 0), duplicate: true } : this.#snapshot(null, 0, { agentRef: prior.agentRef, message: missingMessage });
  }

  async resolveApproval({ agentRef, approvalRequestId, clientRequestId, decision }) {
    this.#assertOpen();
    if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
    if (typeof approvalRequestId !== "string" || !approvalRequestId.trim()) throw new Error("approvalRequestId must be a non-empty string");
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) throw new Error("clientRequestId must be a non-empty string");
    const hash = digest(`${decision}\0${agentRef}\0${approvalRequestId}`);
    const prior = this.#requestIndex.get(requestKey("control", clientRequestId));
    if (prior) {
      if (prior.requestHash !== hash) throw new Error(`clientRequestId was already used for a different agent control action: ${clientRequestId}`);
      const priorState = this.#agents.get(prior.agentRef);
      if (!priorState) return { ...this.#snapshot(null, 0, { agentRef: prior.agentRef, message: "accepted control mapping is no longer available" }), duplicate: true };
      return { ...this.#snapshot(priorState, 0), duplicate: true };
    }

    const state = this.#agents.get(agentRef);
    if (!state) return this.#snapshot(null, 0, { agentRef, message: "unknown agentRef" });
    if (!state.pendingApproval || !state.pendingRequestHandle) throw new Error(`agent has no pending Codex approval: ${agentRef}`);
    if (String(state.pendingApproval.requestId) !== approvalRequestId) throw new Error(`approval request is unknown or stale for agent ${agentRef}: ${approvalRequestId}`);

    const result = approvalResponseFor(state.pendingRequestHandle, decision);
    state.pendingRequestHandle.resolve(result);
    const resolvedId = state.pendingApproval.requestId;
    this.#clearPending(state);
    this.#appendEvent(state, { type: "server-request/resolved-local", requestId: resolvedId, at: Date.now() });
    this.#requestIndex.set(requestKey("control", clientRequestId), { agentRef, requestHash: hash, action: decision, targetId: approvalRequestId, acceptance: "accepted" });
    return { ...this.#snapshot(state, 0), duplicate: false };
  }

  async cancel({ agentRef, clientRequestId, expectedTurnId = null }) {
    this.#assertOpen();
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) throw new Error("clientRequestId must be a non-empty string");
    const state = this.#agents.get(agentRef);
    if (!state) return this.#snapshot(null, 0, { agentRef, message: "unknown agentRef" });
    await this.#refreshFromOfficial(state);
    const targetTurnId = state.currentTurnId;
    if (expectedTurnId !== null && expectedTurnId !== targetTurnId) throw new Error(`agent task turn changed: expected ${expectedTurnId}, current ${String(targetTurnId ?? "none")}`);
    const hash = digest(`cancel\0${agentRef}\0${targetTurnId ?? ""}`);
    const prior = this.#requestIndex.get(requestKey("control", clientRequestId));
    if (prior) {
      if (prior.requestHash !== hash) throw new Error(`clientRequestId was already used for a different agent control action: ${clientRequestId}`);
      await this.#refreshFromOfficial(state);
      return { ...this.#snapshot(state, 0), duplicate: true, controlAcceptance: prior.acceptance ?? "accepted" };
    }
    if (!targetTurnId || !state.threadId || !["running", "awaitingApproval", "unknown"].includes(state.status)) throw new Error(`agent has no interruptible active turn: ${agentRef} (${state.status})`);
    const earlierCancel = [...this.#requestIndex.entries()].find(([, entry]) =>
      entry?.action === "cancel" && entry?.agentRef === agentRef && entry?.targetId === targetTurnId && entry?.acceptance !== "rejected"
    );
    if (earlierCancel) throw new Error(`cancel was already dispatched for this turn under requestId ${earlierCancel[0]}; query agent_show or retry that exact requestId instead of replaying turn/interrupt`);

    const record = { agentRef, requestHash: hash, action: "cancel", targetId: targetTurnId, acceptance: "dispatching" };
    this.#requestIndex.set(requestKey("control", clientRequestId), record);
    this.#appendEvent(state, { type: "turn/interrupt-dispatched", turnId: targetTurnId, requestId: clientRequestId, at: Date.now() });
    try {
      await this.#client.request("turn/interrupt", { threadId: state.threadId, turnId: targetTurnId });
      record.acceptance = "accepted";
      this.#applyTurnObservation(state, { source: "turn/interrupt", turnId: targetTurnId, status: "interrupted" });
      this.#appendEvent(state, { type: "turn/interrupt-accepted", turnId: targetTurnId, requestId: clientRequestId, at: Date.now() });
    } catch (error) {
      record.acceptance = "unknown";
      state.latestError = `turn/interrupt acceptance unknown; do not replay: ${error instanceof Error ? error.message : String(error)}`;
      state.status = "unknown";
      this.#appendEvent(state, { type: "turn/interrupt-acceptance-unknown", turnId: targetTurnId, requestId: clientRequestId, text: state.latestError, at: Date.now() });
      await this.#refreshFromOfficial(state);
      if (["interrupted", "completed", "failed"].includes(state.latestTurnStatus)) {
        record.acceptance = "accepted";
        if (state.latestTurnStatus === "interrupted") state.latestError = null;
      } else state.status = "unknown";
    }
    await this.#ensureResourceReceipt(state);
    return { ...this.#snapshot(state, 0), duplicate: false, controlAcceptance: record.acceptance };
  }

  async send({ agentRef, message, clientRequestId = null, model = null, reasoningEffort = null }) {
    this.#assertOpen();
    if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
    if (clientRequestId !== null && (typeof clientRequestId !== "string" || !clientRequestId.trim())) throw new Error("clientRequestId must be a non-empty string when provided");
    const requestedModel = normalizeSelection(model, "model");
    const requestedReasoningEffort = normalizeSelection(reasoningEffort, "reasoningEffort", 128);
    const requestHash = hashRequest(agentRef, message, requestedModel, requestedReasoningEffort);
    const duplicate = this.#duplicateRequest("send", clientRequestId, requestHash, "accepted send mapping is no longer available");
    if (duplicate) return duplicate;

    const state = this.#agents.get(agentRef);
    if (!state) return this.#snapshot(null, 0, { agentRef, message: "unknown agentRef" });
    await this.#refreshFromOfficial(state);
    if (state.pendingApproval) throw new Error(`agent ${agentRef} has a pending Codex approval`);
    if (state.status !== "idle") throw new Error(`agent ${agentRef} is not idle: ${state.status}`);

    const resumed = await this.#client.request("thread/resume", { threadId: state.threadId });
    if (resumed?.thread?.canAcceptDirectInput === false) throw new Error(`Codex thread cannot accept direct input: ${state.threadId}`);
    this.#applyMetadata(state, resumed);

    if (requestedReasoningEffort) await this.#validateReasoningEffort({
      requestedModel,
      currentModel: stringOrNull(resumed?.model) ?? state.resolvedModel,
      requestedReasoningEffort,
    });

    if (clientRequestId) this.#requestIndex.set(requestKey("send", clientRequestId), { agentRef, requestHash });
    return this.#startTurn(state, {
      text: message,
      clientUserMessageId: clientRequestId ?? `${agentRef}_${randomUUID()}`,
      model: requestedModel,
      reasoningEffort: requestedReasoningEffort,
    });
  }

  async #validateReasoningEffort({ requestedModel, currentModel, requestedReasoningEffort }) {
    let catalog;
    try {
      catalog = await collectModelCatalog((params) => this.listModels(params), { includeHidden: true });
    } catch (error) {
      const modelLabel = requestedModel ?? currentModel ?? "<unresolved>";
      throw new Error(`reasoningEffort validation failed for model "${modelLabel}": requested effort "${requestedReasoningEffort}"; supported efforts unknown; current model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const defaults = catalog.filter((entry) => entry?.isDefault === true && modelIdentity(entry));
    const effectiveModel = requestedModel ?? currentModel ?? (defaults.length === 1 ? modelIdentity(defaults[0]) : null);
    if (!effectiveModel) {
      throw new Error(`reasoningEffort validation failed for model "<unresolved>": requested effort "${requestedReasoningEffort}"; supported efforts unknown; current/default model could not be resolved from the current Codex model catalog`);
    }

    const entry = catalog.find((candidate) => candidate?.model === effectiveModel || candidate?.id === effectiveModel) ?? null;
    if (!entry) {
      throw new Error(`reasoningEffort validation failed for model "${effectiveModel}": requested effort "${requestedReasoningEffort}"; supported efforts unknown; model is not present in the current Codex model catalog`);
    }
    const supported = supportedReasoningEfforts(entry);
    if (!supported.includes(requestedReasoningEffort)) throw new Error(`reasoningEffort validation failed for model "${effectiveModel}": requested effort "${requestedReasoningEffort}"; supported efforts: ${supported.length ? supported.join(", ") : "(none)"}`);
    return { effectiveModel, supportedReasoningEfforts: supported };
  }

  #applyTurnObservation(state, observation) {
    const turnId = observation.turnId ?? observation.turn?.id ?? null;
    if (turnId && state.currentTurnId && turnId !== state.currentTurnId) {
      this.#appendEvent(state, {
        type: "stale-turn-notification-ignored",
        method: observation.method ?? observation.source ?? "observation",
        turnId,
        currentTurnId: state.currentTurnId,
        at: Date.now(),
      });
      return;
    }
    if (turnId && !state.currentTurnId) state.currentTurnId = turnId;
    if (TERMINAL_TURN_STATUSES.has(state.latestTurnStatus)) return;
    if (observation.statusType) {
      const next = observation.statusType === "active" ? (state.pendingApproval ? "awaitingApproval" : "running") : observation.statusType === "idle" && state.status === "running" ? "idle" : observation.statusType === "systemError" ? "failed" : null;
      state.status = next ?? state.status;
      return;
    }
    const status = observation.status ?? observation.turn?.status ?? null;
    if (!status) return;
    state.latestTurnStatus = status;
    state.status = state.pendingApproval ? "awaitingApproval" : AGENT_STATUS.get(status) ?? "running";
    if (status === "completed" || status === "interrupted") {
      state.finalResult = lastAgentMessage(observation.turn) ?? state.finalResult;
      state.latestError = null;
    } else if (status === "failed") {
      state.latestError = observation.turn?.error?.message ?? JSON.stringify(observation.turn?.error ?? "turn failed");
    }
    if (TERMINAL_TURN_STATUSES.has(status)) state.turnEndedAt ??= Date.now();
  }

  #applyMetadata(state, response) {
    if (typeof response?.model === "string") state.resolvedModel = response.model;
    if (typeof response?.modelProvider === "string") state.modelProvider = response.modelProvider;
    state.serviceTier = stringOrNull(response?.serviceTier) ?? state.serviceTier;
    state.reasoningEffort = stringOrNull(response?.reasoningEffort) ?? state.reasoningEffort;
  }

  #clearPending(state) {
    state.pendingApproval = state.pendingRequestHandle = null;
    state.status = AGENT_STATUS.get(state.latestTurnStatus) ?? "running";
  }

  async #refreshFromOfficial(state) {
    try {
      const turns = await this.#client.request("thread/turns/list", { threadId: state.threadId, limit: 20 });
      const data = Array.isArray(turns?.data) ? turns.data : [];
      const turn = state.currentTurnId ? data.find((candidate) => candidate?.id === state.currentTurnId) : data[0];
      if (!turn) return;
      const officialTurnIsTerminal = TERMINAL_TURN_STATUSES.has(turn.status);
      if (TERMINAL_TURN_STATUSES.has(state.latestTurnStatus) && !officialTurnIsTerminal) {
        this.#applyMetadata(state, await this.#client.request("thread/resume", { threadId: state.threadId }));
        this.#appendEvent(state, { type: "nonterminal-official-refresh-ignored", turnId: turn.id, status: turn.status ?? null, at: Date.now() });
        return;
      }
      this.#applyTurnObservation(state, { source: "refresh", turnId: turn.id, status: turn.status, turn });
      if (officialTurnIsTerminal) this.#applyMetadata(state, await this.#client.request("thread/resume", { threadId: state.threadId }));
    } catch (error) {
      state.latestError = error instanceof Error ? error.message : String(error);
      this.#appendEvent(state, { type: "official-refresh-error", text: state.latestError, at: Date.now() });
    }
  }

  #findAgent({ threadId = null, turnId = null, requestId = null } = {}) {
    return [...this.#agents.values()].find((candidate) =>
      (threadId && candidate.threadId === threadId) ||
      (turnId && candidate.currentTurnId === turnId) ||
      (requestId !== null && candidate.pendingApproval && String(candidate.pendingApproval.requestId) === String(requestId))
    ) ?? null;
  }

  #onNotification(message) {
    const { threadId, turnId, requestId, turn } = notificationFields(message);
    const state = this.#findAgent({ threadId, turnId, requestId });
    if (!state) return;

    if (["turn/started", "turn/completed"].includes(message.method) && turnId && state.currentTurnId && turnId !== state.currentTurnId) {
      this.#applyTurnObservation(state, { source: message.method, method: message.method, turnId });
      return;
    }
    if (turnId && !state.currentTurnId) state.currentTurnId = turnId;
    if (message.method === "thread/tokenUsage/updated" && message?.params?.tokenUsage) state.latestTokenUsage = structuredClone(message.params.tokenUsage);
    if (message.method === "item/started" && message?.params?.item?.id) {
      state.approvalItems.set(message.params.item.id, structuredClone(message.params.item));
      if (state.approvalItems.size > 32) state.approvalItems.delete(state.approvalItems.keys().next().value);
    }
    if (message.method === "item/completed" && message?.params?.item?.id) state.approvalItems.delete(message.params.item.id);
    if (message.method === "serverRequest/resolved") {
      if (state.pendingApproval && String(state.pendingApproval.requestId) === String(requestId)) {
        this.#clearPending(state);
      }
    } else if (message.method === "turn/started" || message.method === "turn/completed") {
      this.#applyTurnObservation(state, {
        source: message.method,
        method: message.method,
        turnId,
        status: turn?.status ?? (message.method === "turn/completed" ? "completed" : "inProgress"),
        turn,
      });
    } else if (message.method === "thread/status/changed") {
      this.#applyTurnObservation(state, { statusType: message?.params?.status?.type });
    }
    this.#appendEvent(state, compactNotification(message));
  }

  #onServerRequest(request) {
    const { threadId, turnId } = notificationFields(request);
    const params = request?.params ?? {};
    const state = this.#findAgent({ threadId, turnId });
    if (!state) {
      request.reject({ code: -32602, message: `Agent server request could not be mapped to an active agent: ${request.method}` });
      return;
    }
    if (turnId && !state.currentTurnId) state.currentTurnId = turnId;
    if (!state.latestTurnStatus) state.latestTurnStatus = "inProgress";
    if (state.pendingApproval) {
      request.reject({ code: -32000, message: `Agent already has a pending server request: ${String(state.pendingApproval.requestId)}` });
      return;
    }

    state.pendingApproval = approvalSummary(request, state.approvalItems.get(params.itemId ?? params.item?.id ?? null) ?? null);
    state.pendingRequestHandle = request;
    state.status = "awaitingApproval";
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
    if (!state?.currentTurnId || !TERMINAL_TURN_STATUSES.has(state.latestTurnStatus) || state.resourceReceipt?.turnId === state.currentTurnId) return state?.resourceReceipt ?? null;
    if (state.resourceReceiptPromise) return await state.resourceReceiptPromise;

    const turnId = state.currentTurnId;
    state.resourceReceiptPromise = (async () => {
      let quotaSnapshot;
      try {
        quotaSnapshot = this.#resourceSnapshotProvider
          ? await this.#resourceSnapshotProvider({ agentRef: state.agentRef, threadId: state.threadId, turnId, cwd: state.cwd })
          : unavailableQuotaSnapshot(null, true);
      } catch (error) {
        quotaSnapshot = unavailableQuotaSnapshot(error, true);
      }
      const receipt = buildAgentResourceReceipt({
        turnId,
        turnStatus: state.latestTurnStatus,
        tokenUsage: state.latestTokenUsage,
        quotaSnapshot,
      });
      state.resourceReceipt = receipt;
      this.#appendEvent(state, { type: "resource-receipt/ready", turnId, at: Date.now() });
      return receipt;
    })();
    try { return await state.resourceReceiptPromise; }
    finally { state.resourceReceiptPromise = null; }
  }

  #snapshot(state, afterSeq, missing = null) {
    const events = state ? state.events.filter((event) => event.seq > afterSeq) : [];
    const nextSeq = state?.events?.length ? state.events[state.events.length - 1].seq : afterSeq;
    return {
      agentRef: typeof (state?.agentRef ?? missing?.agentRef) === "string" ? (state?.agentRef ?? missing.agentRef) : null,
      turnId: state?.currentTurnId ?? null,
      status: state?.status ?? "unknown",
      canSend: state ? state.status === "idle" && !state.pendingApproval : false,
      pendingApproval: state?.pendingApproval ? { ...state.pendingApproval } : null,
      finalResult: state?.finalResult ?? null,
      resourceReceipt: state?.resourceReceipt ? structuredClone(state.resourceReceipt) : null,
      latestError: missing?.message ?? state?.latestError ?? null,
      timing: { startedAt: state?.turnStartedAt ?? null, endedAt: state?.turnEndedAt ?? null, durationMs: state?.turnStartedAt !== null && state?.turnEndedAt !== null ? Math.max(0, state.turnEndedAt - state.turnStartedAt) : null },
      execution: projectExecution(state),
      events,
      nextSeq,
    };
  }

  #assertOpen() {
    if (!this.#opened || this.#closed || !this.#client.running) throw new Error("CodexAgentExecutor is not open");
  }
}
