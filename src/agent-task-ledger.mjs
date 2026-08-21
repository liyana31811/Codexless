import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectQuotaSnapshot, unavailableQuotaSnapshot } from "./agent-resource.mjs";
import { projectExecution } from "./codex-agent-executor.mjs";

export const TASK_STORE_VERSION = 1;
export const DEFAULT_TASK_STORE_TTL_MS = 14 * 24 * 60 * 60_000;
export const DEFAULT_TASK_STORE_MAX_ENTRIES = 2_000;
const CONSENT_TTL_MS = 10 * 60_000;

const CONSENT_MESSAGE =
  "This action starts metered Codex model work. The consentRef identifies this prepared task but does not authorize it. Render the Task Card and obtain an explicit server-side commit before dispatching Codex work.";

function digest(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function requestHash(action, subjectRef, payload) {
  const source = payload ?? {};
  const hasCallerModel = Object.hasOwn(source, "callerModel");
  const hasCallerEffort = Object.hasOwn(source, "callerReasoningEffort");
  const bound = {
    action,
    agentRef: subjectRef,
    prompt: action === "start" ? source.prompt ?? null : null,
    message: action === "send" ? source.message ?? null : null,
    cwd: action === "start" ? source.cwd ?? null : null,
    permissionProfile: action === "start" ? source.permissionProfile ?? null : null,
    model: (hasCallerModel ? source.callerModel : source.model) ?? null,
  };
  if (hasCallerEffort) bound.reasoningEffort = source.callerReasoningEffort ?? null;
  else if (!hasCallerModel && Object.hasOwn(source, "reasoningEffort")) bound.reasoningEffort = source.reasoningEffort ?? null;
  return digest(JSON.stringify(bound));
}

function requestKey({ requestId, action, subjectRef = null }) {
  return `${action}\0${subjectRef ?? ""}\0${requestId}`;
}

export function portableShortTaskId(taskRef) {
  return `C-${digest(String(taskRef)).slice(0, 10).toUpperCase()}`;
}

function taskCardFor({ taskRef, requestId, action, payload, cwd = null, permissionProfile = null, quota = null }) {
  const text = String((action === "start" ? payload?.prompt : payload?.message) ?? "");
  const clean = text.replace(/\s+/g, " ").trim();
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Codex task";
  const summary = clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
  const title = firstLine.length > 72 ? firstLine.slice(0, 69) + "..." : firstLine;
  const requestedModel = Object.hasOwn(payload ?? {}, "callerModel") ? payload.callerModel : payload?.model;
  const requestedEffort = Object.hasOwn(payload ?? {}, "callerReasoningEffort")
    ? payload.callerReasoningEffort
    : Object.hasOwn(payload ?? {}, "callerModel") ? undefined : payload?.reasoningEffort;
  return {
    kind: "codex_task",
    taskRef,
    taskId: taskRef,
    requestId,
    action,
    title,
    summary,
    requestedModel: typeof requestedModel === "string" ? requestedModel : null,
    ...(typeof requestedEffort === "string" ? { requestedReasoningEffort: requestedEffort } : {}),
    ...(payload?.modelSelection && typeof payload.modelSelection === "object" ? { modelSelection: structuredClone(payload.modelSelection) } : {}),
    cwd,
    permissionProfile,
    quota,
  };
}

function consentArgs(action, requestId) {
  if (action !== "start" && action !== "send") throw new Error("metered consent action must be start or send");
  if (typeof requestId !== "string" || !requestId.trim()) throw new Error("metered consent requestId must be a non-empty string");
}

function consentRequired(record, duplicate) {
  return {
    authorized: false,
    mode: "always",
    duplicate,
    consent: {
      status: "required",
      consentRef: record.consentRef,
      action: record.action,
      subjectRef: record.subjectRef,
      requestId: record.requestId,
      expiresAt: record.expiresAt,
      quota: record.quota,
      message: CONSENT_MESSAGE,
    },
  };
}

function existingConsent(consentRequests, key, hash, action, requestId) {
  const prior = consentRequests.get(key);
  if (!prior || prior instanceof Promise) return null;
  if (!prior.authorized && prior.expiresAt <= Date.now()) {
    consentRequests.delete(key);
    throw new Error(`consentRef is expired for this metered ${action} request; prepare the task again`);
  }
  if (prior.requestHash !== hash) throw new Error(`requestId was already used for a different metered ${action} request: ${requestId}`);
  return prior;
}

function hydratePersisted(entry) {
  const consent = {
    consentRef: entry.consentRef ?? null,
    requestId: entry.requestId ?? null,
    quota: entry.taskCard?.quota ?? null,
    status: entry.phase === "terminal" ? "approved" : entry.consentRef ? "required" : "approved",
  };
  return {
    taskRef: entry.taskRef,
    consent,
    action: entry.action,
    payload: null,
    payloadHash: entry.payloadHash ?? null,
    agentRef: entry.agentRef ?? null,
    authorized: entry.phase !== "pending",
    commitToken: null,
    turnId: entry.turnId ?? null,
    terminalSnapshot: entry.terminalSnapshot?.terminal === true ? structuredClone(entry.terminalSnapshot) : null,
    taskCard: entry.taskCard ?? null,
  };
}

function createPersistence({ filePath, ttlMs, maxEntries }) {
  if (!filePath) return null;
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000) throw new Error("agent task-state ttlMs must be at least 60000");
  if (!Number.isInteger(maxEntries) || maxEntries < 10 || maxEntries > 100_000) throw new Error("agent task-state maxEntries must be 10..100000");
  const resolvedPath = path.resolve(filePath);
  const records = new Map();
  let blockedError = null;
  if (existsSync(resolvedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
      if (parsed?.version !== TASK_STORE_VERSION || !Array.isArray(parsed.records)) {
        throw new Error(`unsupported task-state schema version ${String(parsed?.version ?? "missing")}`);
      }
      for (const entry of parsed.records) {
        if (!entry || typeof entry !== "object" || typeof entry.taskRef !== "string" || !entry.taskRef) continue;
        records.set(entry.taskRef, structuredClone(entry));
      }
    } catch (error) {
      blockedError = `agent task-state file is unreadable or corrupt: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  function assertAvailable() {
    if (blockedError) throw new Error(blockedError);
  }
  function trim(now = Date.now()) {
    for (const [key, entry] of records) {
      const updatedAt = Number.isFinite(entry?.updatedAt) ? entry.updatedAt : 0;
      if (!updatedAt || now - updatedAt > ttlMs) records.delete(key);
    }
    if (records.size <= maxEntries) return;
    const oldest = [...records.entries()].sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0));
    for (let index = 0; index < oldest.length - maxEntries; index += 1) records.delete(oldest[index][0]);
  }
  function flush() {
    trim();
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const temporary = `${resolvedPath}.tmp-${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify({ version: TASK_STORE_VERSION, records: [...records.values()] }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, resolvedPath);
  }
  return {
    assertAvailable,
    entries() {
      trim();
      return [...records.values()].map((entry) => structuredClone(entry));
    },
    put(record, phase = "pending", snapshot = null) {
      assertAvailable();
      if (!record || typeof record.taskRef !== "string" || !record.taskRef) throw new Error("persisted agent task entry requires taskRef");
      const ordered = {
        taskRef: record.taskRef,
        consentRef: record.consent?.consentRef ?? null,
        requestId: record.consent?.requestId ?? record.taskCard?.requestId ?? null,
        action: record.action ?? null,
        payloadHash: record.payloadHash ?? null,
        taskCard: record.taskCard ? structuredClone(record.taskCard) : null,
        subjectRef: record.agentRef ?? null,
        agentRef: record.agentRef ?? null,
        turnId: record.turnId ?? null,
        phase,
        terminalSnapshot: snapshot ? structuredClone(snapshot) : record.terminalSnapshot ? structuredClone(record.terminalSnapshot) : null,
        updatedAt: Date.now(),
      };
      records.set(ordered.taskRef, ordered);
      flush();
    },
  };
}

export function createAgentTaskLedger({
  mode = "off",
  quotaProvider = null,
  taskStateFile = null,
  taskStateTtlMs = DEFAULT_TASK_STORE_TTL_MS,
  taskStateMaxEntries = DEFAULT_TASK_STORE_MAX_ENTRIES,
} = {}) {
  if (mode !== "off" && mode !== "always") throw new Error("metered consent mode must be off or always");
  if (quotaProvider !== null && typeof quotaProvider !== "function") throw new Error("metered consent quotaProvider must be a function when provided");
  const persistence = createPersistence({ filePath: taskStateFile, ttlMs: taskStateTtlMs, maxEntries: taskStateMaxEntries });
  const records = new Map();
  const currentCard = new Map();
  const consentRequests = new Map();

  function dropRecord(taskRef) {
    records.delete(taskRef);
    for (const [agentRef, value] of currentCard) if (value === taskRef) currentCard.delete(agentRef);
  }

  function refreshIndexes() {
    if (!persistence) return;
    persistence.assertAvailable();
    const persistedRefs = new Set(persistence.entries().map((entry) => entry.taskRef));
    for (const taskRef of records.keys()) {
      if (!persistedRefs.has(taskRef)) dropRecord(taskRef);
    }
  }

  if (persistence) {
    for (const entry of persistence.entries()) records.set(entry.taskRef, hydratePersisted(entry));
  }

  function persist(record, phase = null, snapshot = null) {
    return !persistence || persistence.put(record, phase ?? (record.terminalSnapshot ? "terminal" : record.authorized ? "active" : "pending"), snapshot);
  }

  function findRecord({ requestId, action, subjectRef = null, payload = null }) {
    refreshIndexes();
    const record = [...records.values()].find((candidate) => {
      const subjectMatches = (candidate.agentRef ?? null) === (subjectRef ?? null) || action === "start" && subjectRef === null;
      return candidate.action === action && subjectMatches && (candidate.consent?.requestId ?? candidate.taskCard?.requestId) === requestId;
    }) ?? null;
    if (!record) return null;
    if (payload !== null && record.payloadHash && record.payloadHash !== requestHash(action, subjectRef, payload)) throw new Error(`requestId ${requestId} was already used for a different Codex task payload`);
    return record;
  }

  async function authorize({ action, requestId, subjectRef = null, payload }) {
    consentArgs(action, requestId);
    if (mode === "off") return { authorized: true, mode: "off", consentRef: null, duplicate: false };
    const key = requestKey({ requestId, action, subjectRef });
    const hash = requestHash(action, subjectRef, payload);
    const prior = existingConsent(consentRequests, key, hash, action, requestId);
    if (prior) {
      if (prior.authorized) return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: true };
      return consentRequired(prior, true);
    }
    const pending = consentRequests.get(key);
    if (pending) {
      const record = await pending;
      if (record.requestHash !== hash) throw new Error(`requestId was already used for a different metered ${action} request: ${requestId}`);
      return consentRequired(record, true);
    }
    const preparation = (async () => {
      let quotaSnapshot;
      try {
        quotaSnapshot = quotaProvider ? await quotaProvider() : unavailableQuotaSnapshot();
      } catch (error) {
        quotaSnapshot = unavailableQuotaSnapshot(error);
      }
      const record = {
        action,
        subjectRef,
        requestId,
        requestHash: hash,
        consentRef: `consent_${randomUUID()}`,
        quota: projectQuotaSnapshot(quotaSnapshot),
        expiresAt: Date.now() + CONSENT_TTL_MS,
        authorized: false,
      };
      return record;
    })();
    consentRequests.set(key, preparation);
    try {
      const record = await preparation;
      consentRequests.set(key, record);
      return consentRequired(record, false);
    } catch (error) {
      if (consentRequests.get(key) === preparation) consentRequests.delete(key);
      throw error;
    }
  }

  function approveConsent({ action, requestId, subjectRef = null, payload, consentRef }) {
    consentArgs(action, requestId);
    if (typeof consentRef !== "string" || !consentRef.trim()) throw new Error("metered consentRef must be a non-empty string");
    if (mode === "off") return { authorized: true, mode: "off", consentRef: null, duplicate: false };
    const key = requestKey({ requestId, action, subjectRef });
    const prior = existingConsent(consentRequests, key, requestHash(action, subjectRef, payload), action, requestId);
    if (!prior) throw new Error("consentRef is unknown or stale for this metered requestId");
    if (prior.consentRef !== consentRef) throw new Error(`consentRef does not match the pending metered ${action} request`);
    if (prior.authorized) return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: true };
    prior.authorized = true;
    return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: false };
  }

  function createTask({ consent = null, requestId = null, action, payload, cwd = null, permissionProfile = null, agentRef = null, authorized = false }) {
    const boundConsent = consent ?? { consentRef: null, requestId, quota: null };
    const boundRequestId = boundConsent.requestId ?? requestId;
    const existing = boundRequestId && action
      ? findRecord({ requestId: boundRequestId, action, subjectRef: agentRef, payload })
      : null;
    if (existing) return existing;
    const taskRef = `task_${randomUUID()}`;
    const record = {
      taskRef,
      consent: boundConsent,
      action,
      payload,
      payloadHash: requestHash(action, agentRef, payload),
      agentRef,
      authorized,
      commitToken: authorized ? null : `commit_${randomUUID()}`,
      turnId: null,
      terminalSnapshot: null,
      taskCard: taskCardFor({ taskRef, requestId: boundRequestId, action, payload, cwd, permissionProfile, quota: boundConsent.quota }),
    };
    records.set(record.taskRef, record);
    persist(record, "pending");
    return record;
  }

  function taskByRef(taskRef) {
    refreshIndexes();
    return taskRef ? records.get(taskRef) ?? null : null;
  }

  function taskByConsent(consentRef) {
    refreshIndexes();
    return [...records.values()].find((record) => record.consent?.consentRef === consentRef) ?? null;
  }

  function taskByPortable(taskId) {
    refreshIndexes();
    const matches = [...records.values()].filter((record) => portableShortTaskId(record.taskRef) === taskId);
    if (matches.length !== 1) throw new Error("unknown, stale, or ambiguous Portable Card task ID");
    const record = matches[0];
    if (!record.consent?.consentRef) throw new Error("Portable Card task ID is not bound to a prepared metered task");
    return record;
  }

  function taskForAgent(agentRef) {
    return taskByRef(currentCard.get(agentRef));
  }

  function bindAgent(record, agentRef, turnId = null) {
    if (!record) return;
    record.agentRef = agentRef ?? null;
    record.turnId = turnId ?? record.turnId ?? null;
    if (record.agentRef) currentCard.set(record.agentRef, record.taskRef);
  }

  function freeze(record, payload) {
    if (!record) throw new Error("Codex task record is required");
    if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
    const frozen = {
      ...structuredClone(payload),
      taskRef: record.taskRef,
      taskId: record.taskRef,
      taskCard: record.taskCard ? structuredClone(record.taskCard) : null,
      canSend: false,
      terminal: true,
      terminalAt: Date.now(),
    };
    frozen.resultSummary = String(frozen.finalResult ?? frozen.latestError ?? "DONE").replace(/\s+/g, " ").trim().slice(0, 600);
    record.terminalSnapshot = frozen;
    persist(record, "terminal", frozen);
    return structuredClone(frozen);
  }

  function markActive(record) {
    if (!record) throw new Error("Codex task record is required");
    persist(record, "active");
  }

  function recover(taskRef) {
    const record = taskByRef(taskRef);
    if (!record) return null;
    if (record.terminalSnapshot?.terminal === true) return structuredClone(record.terminalSnapshot);
    return freeze(record, terminalTaskPayload(record, "lost", null, {
      consentStatus: "unavailable",
      latestError: "Task control state was lost across Codexless restart. The original task will not be replayed.",
    }));
  }

  function terminalTaskPayload(record, status, error = null, { consentStatus = "approved", endedAt = Date.now(), latestError = null } = {}) {
    const lost = status === "lost";
    return {
      agentRef: record.agentRef,
      turnId: lost ? record.turnId : null,
      status,
      pendingApproval: null,
      finalResult: null,
      resourceReceipt: null,
      timing: { startedAt: null, endedAt, durationMs: lost ? null : 0 },
      execution: projectExecution({
        requestedModel: record.payload?.model ?? record.taskCard?.requestedModel,
        requestedReasoningEffort: record.payload?.reasoningEffort ?? record.taskCard?.requestedReasoningEffort,
      }),
      latestError: latestError ?? (lost
        ? "Task-specific terminal state was not observed before this agent advanced. The original task will not be replayed."
        : error instanceof Error ? error.message : String(error)),
      events: [], nextSeq: 0,
      meteredConsent: { status: consentStatus, quota: record.consent?.quota ?? record.taskCard?.quota ?? null },
    };
  }

  function decline(record) {
    if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
    if (record.authorized) throw new Error("prepared Codex task already started and cannot be declined as a pre-call task");
    return freeze(record, terminalTaskPayload(record, "rejected", null, { consentStatus: "rejected", endedAt: Date.now() }));
  }

  function commitTask(record, { action, requestId, subjectRef = null, payload, consentRef }) {
    if (!record) throw new Error("unknown or stale prepared metered consentRef");
    if (record.terminalSnapshot) return { record, duplicate: true };
    if (!record.consent?.consentRef) throw new Error("prepared Codex task is missing its metered consentRef");
    const approval = approveConsent({ action, requestId, subjectRef, payload, consentRef });
    if (!approval.authorized) throw new Error("prepared Codex task approval did not authorize dispatch");
    record.authorized = true;
    return { record, duplicate: approval.duplicate };
  }

  return {
    get mode() { return mode; },
    authorize,
    approveConsent,
    createTask,
    findRecord,
    taskByRef,
    taskByConsent,
    taskByPortable,
    taskForAgent,
    bindAgent,
    markActive,
    persist,
    freeze,
    recover,
    terminalTaskPayload,
    decline,
    commitTask,
  };
}
