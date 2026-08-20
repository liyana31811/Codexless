import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectQuotaSnapshot } from "./agent-resource.mjs";

/**
 * Canonical owner for Agent task, consent, card, index, and v1 persistence
 * state.  The public tool layer deliberately only projects records returned by
 * this object; it does not maintain a second task or consent store.
 */

export const TASK_STORE_VERSION = 1;
export const DEFAULT_TASK_STORE_TTL_MS = 14 * 24 * 60 * 60_000;
export const DEFAULT_TASK_STORE_MAX_ENTRIES = 2_000;
const CONSENT_TTL_MS = 10 * 60_000;

const CONSENT_MESSAGE =
  "This action starts metered Codex model work. The consentRef identifies this prepared task but does not authorize it. Render the Task Card and obtain an explicit server-side commit before dispatching Codex work.";

function requestHash(action, subjectRef, payload) {
  return createHash("sha256")
    .update(`${action}\0${subjectRef ?? ""}\0${JSON.stringify(payload)}`, "utf8")
    .digest("hex");
}

function taskPayloadHash(action, payload, agentRef = null) {
  const hasCallerModel = Object.hasOwn(payload ?? {}, "callerModel");
  const hasCallerEffort = Object.hasOwn(payload ?? {}, "callerReasoningEffort");
  const bound = {
    action,
    agentRef,
    prompt: action === "start" ? payload?.prompt ?? null : null,
    message: action === "send" ? payload?.message ?? null : null,
    cwd: action === "start" ? payload?.cwd ?? null : null,
    permissionProfile: action === "start" ? payload?.permissionProfile ?? null : null,
    model: hasCallerModel ? payload?.callerModel ?? null : payload?.model ?? null,
  };
  if (hasCallerEffort) bound.reasoningEffort = payload?.callerReasoningEffort ?? null;
  else if (!hasCallerModel && Object.hasOwn(payload ?? {}, "reasoningEffort")) bound.reasoningEffort = payload.reasoningEffort ?? null;
  return createHash("sha256").update(JSON.stringify(bound), "utf8").digest("hex");
}

function requestKey({ requestId, action, subjectRef = null }) {
  return `${action}\0${subjectRef ?? ""}\0${requestId}`;
}

export function portableShortTaskId(taskRef) {
  const digest = createHash("sha256").update(String(taskRef), "utf8").digest("hex").slice(0, 10).toUpperCase();
  return `C-${digest}`;
}

function summaryFor(action, payload) {
  const text = action === "start" ? payload?.prompt : payload?.message;
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
}

function titleFor(action, payload) {
  const text = action === "start" ? payload?.prompt : payload?.message;
  const firstLine = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Codex task";
  return firstLine.length > 72 ? firstLine.slice(0, 69) + "..." : firstLine;
}

function taskCardFor({ taskRef, requestId, action, payload, cwd = null, permissionProfile = null, quota = null }) {
  return {
    kind: "codex_task",
    taskRef,
    taskId: taskRef,
    requestId,
    action,
    title: titleFor(action, payload),
    summary: summaryFor(action, payload),
    requestedModel: Object.hasOwn(payload ?? {}, "callerModel")
      ? (typeof payload?.callerModel === "string" ? payload.callerModel : null)
      : (typeof payload?.model === "string" ? payload.model : null),
    ...(Object.hasOwn(payload ?? {}, "callerReasoningEffort")
      ? (typeof payload?.callerReasoningEffort === "string" ? { requestedReasoningEffort: payload.callerReasoningEffort } : {})
      : (typeof payload?.reasoningEffort === "string" ? { requestedReasoningEffort: payload.reasoningEffort } : {})),
    ...(payload?.modelSelection && typeof payload.modelSelection === "object" ? { modelSelection: structuredClone(payload.modelSelection) } : {}),
    cwd,
    permissionProfile,
    quota,
  };
}

function persistableSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const resultSummary = String(snapshot.resultSummary ?? snapshot.finalResult ?? snapshot.latestError ?? "")
    .replace(/\s+/g, " ").trim().slice(0, 800);
  return {
    taskRef: snapshot.taskRef ?? snapshot.taskId ?? snapshot.taskCard?.taskRef ?? null,
    taskId: snapshot.taskRef ?? snapshot.taskId ?? snapshot.taskCard?.taskRef ?? null,
    agentRef: snapshot.agentRef ?? null,
    turnId: snapshot.turnId ?? null,
    status: snapshot.status ?? "lost",
    canSend: false,
    pendingApproval: null,
    taskCard: snapshot.taskCard ? structuredClone(snapshot.taskCard) : null,
    meteredConsent: snapshot.meteredConsent ? structuredClone(snapshot.meteredConsent) : null,
    finalResult: resultSummary || null,
    resultSummary: resultSummary || null,
    resourceReceipt: snapshot.resourceReceipt ? structuredClone(snapshot.resourceReceipt) : null,
    timing: snapshot.timing ? structuredClone(snapshot.timing) : { startedAt: null, endedAt: null, durationMs: null },
    execution: snapshot.execution ? structuredClone(snapshot.execution) : { requestedModel: null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
    latestError: snapshot.latestError ? String(snapshot.latestError).replace(/\s+/g, " ").trim().slice(0, 800) : null,
    terminal: snapshot.terminal === true,
    terminalAt: Number.isFinite(snapshot.terminalAt) ? snapshot.terminalAt : null,
    events: [],
    nextSeq: 0,
  };
}

function clone(value) {
  return value === undefined ? value : structuredClone(value);
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

function validateMode(mode) {
  if (mode !== "off" && mode !== "always") throw new Error("metered consent mode must be off or always");
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
    taskId: entry.taskRef,
    consent,
    action: entry.action,
    payload: null,
    payloadHash: entry.payloadHash ?? null,
    cwd: entry.taskCard?.cwd ?? null,
    permissionProfile: entry.taskCard?.permissionProfile ?? null,
    subjectRef: entry.subjectRef ?? null,
    agentRef: entry.agentRef ?? null,
    authorized: entry.phase !== "pending",
    commitToken: null,
    turnId: entry.turnId ?? null,
    terminalSnapshot: entry.terminalSnapshot?.terminal === true ? structuredClone(entry.terminalSnapshot) : null,
    declinedAt: entry.phase === "terminal" && entry.terminalSnapshot?.status === "rejected" ? entry.updatedAt ?? null : null,
    taskCard: entry.taskCard ? structuredClone(entry.taskCard) : null,
    persistenceWarning: null,
    persisted: true,
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
    assertAvailable();
    trim();
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const temporary = `${resolvedPath}.tmp-${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify({ version: TASK_STORE_VERSION, records: [...records.values()] }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, resolvedPath);
  }
  trim();
  return {
    filePath: resolvedPath,
    assertAvailable,
    get(taskRef) {
      assertAvailable();
      trim();
      return records.has(taskRef) ? structuredClone(records.get(taskRef)) : null;
    },
    entries() {
      trim();
      return [...records.values()].map((entry) => structuredClone(entry));
    },
    put(entry) {
      assertAvailable();
      if (!entry || typeof entry.taskRef !== "string" || !entry.taskRef) throw new Error("persisted agent task entry requires taskRef");
      // Object insertion order is a v1 wire/persistence contract.
      const ordered = {
        taskRef: entry.taskRef,
        consentRef: entry.consentRef ?? null,
        requestId: entry.requestId ?? null,
        action: entry.action ?? null,
        payloadHash: entry.payloadHash ?? null,
        taskCard: entry.taskCard ? structuredClone(entry.taskCard) : null,
        subjectRef: entry.subjectRef ?? null,
        agentRef: entry.agentRef ?? null,
        turnId: entry.turnId ?? null,
        phase: entry.phase ?? "pending",
        terminalSnapshot: entry.terminalSnapshot ? structuredClone(entry.terminalSnapshot) : null,
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
  validateMode(mode);
  if (quotaProvider !== null && typeof quotaProvider !== "function") throw new Error("metered consent quotaProvider must be a function when provided");
  const persistence = createPersistence({ filePath: taskStateFile, ttlMs: taskStateTtlMs, maxEntries: taskStateMaxEntries });
  const records = new Map();
  const requestIndex = new Map();
  const consentIndex = new Map();
  const portableIndex = new Map();
  const agentTaskIndex = new Map();
  const currentCard = new Map();
  const consentRequests = new Map();
  // Public handlers await authority/model work before reaching the ledger.
  // Share one in-flight preparation so identical concurrent calls cannot
  // mint separate consent identities or commit capabilities.
  const pendingAuthorizations = new Map();

  function indexRecord(record) {
    if (!record?.taskRef) return;
    records.set(record.taskRef, record);
    const requestId = record.consent?.requestId ?? record.taskCard?.requestId;
    const subjectRef = record.subjectRef ?? null;
    if (requestId && record.action) requestIndex.set(requestKey({ requestId, action: record.action, subjectRef }), record.taskRef);
    const consentRef = record.consent?.consentRef;
    if (consentRef) consentIndex.set(consentRef, record.taskRef);
    const portable = portableShortTaskId(record.taskRef);
    if (!portableIndex.has(portable)) portableIndex.set(portable, new Set());
    portableIndex.get(portable).add(record.taskRef);
    if (record.agentRef) {
      if (!agentTaskIndex.has(record.agentRef)) agentTaskIndex.set(record.agentRef, new Set());
      agentTaskIndex.get(record.agentRef).add(record.taskRef);
    }
  }

  function dropRecord(taskRef) {
    if (!taskRef) return;
    const record = records.get(taskRef);
    records.delete(taskRef);
    for (const [key, value] of requestIndex) if (value === taskRef) requestIndex.delete(key);
    for (const [key, value] of consentIndex) if (value === taskRef) consentIndex.delete(key);
    const portable = portableShortTaskId(taskRef);
    const portableRefs = portableIndex.get(portable);
    portableRefs?.delete(taskRef);
    if (portableRefs?.size === 0) portableIndex.delete(portable);
    if (record?.agentRef) {
      const agentRefs = agentTaskIndex.get(record.agentRef);
      agentRefs?.delete(taskRef);
      if (agentRefs?.size === 0) agentTaskIndex.delete(record.agentRef);
    }
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
    for (const entry of persistence.entries()) indexRecord(hydratePersisted(entry));
  }

  function persist(record, phase = null, snapshot = null) {
    if (!persistence) return true;
    persistence.put({
      taskRef: record.taskRef,
      consentRef: record.consent?.consentRef ?? null,
      requestId: record.consent?.requestId ?? record.taskCard?.requestId ?? null,
      action: record.action,
      payloadHash: record.payloadHash ?? null,
      taskCard: record.taskCard ? structuredClone(record.taskCard) : null,
      subjectRef: record.subjectRef ?? null,
      agentRef: record.agentRef ?? null,
      turnId: record.turnId ?? null,
      phase: phase ?? (record.terminalSnapshot ? "terminal" : record.authorized ? "active" : "pending"),
      // The terminal projection is already bounded by the public snapshot
      // reducer. Persist that exact projection rather than rebuilding a
      // smaller shape: a terminal replay after restart must be byte/field
      // identical to the first terminal result (including event sequence and
      // optional metadata).
      terminalSnapshot: snapshot ? structuredClone(snapshot) : record.terminalSnapshot ? structuredClone(record.terminalSnapshot) : null,
    });
    record.persistenceWarning = null;
    return true;
  }

  function findRecord({ requestId, action, subjectRef = null, payload = null }) {
    refreshIndexes();
    const taskRef = requestIndex.get(requestKey({ requestId, action, subjectRef }));
    if (!taskRef) return null;
    const record = records.get(taskRef);
    if (!record) return null;
    if (payload !== null) {
      const hash = taskPayloadHash(action, payload, subjectRef);
      if (record.payloadHash && record.payloadHash !== hash) throw new Error(`requestId ${requestId} was already used for a different Codex task payload`);
    }
    return record;
  }

  async function authorize({ action, requestId, subjectRef = null, payload }) {
    if (action !== "start" && action !== "send") throw new Error("metered consent action must be start or send");
    if (typeof requestId !== "string" || !requestId.trim()) throw new Error("metered consent requestId must be a non-empty string");
    if (mode === "off") return { authorized: true, mode: "off", consentRef: null, duplicate: false };
    const key = requestKey({ requestId, action, subjectRef });
    const hash = requestHash(action, subjectRef, payload);
    const prior = consentRequests.get(key);
    if (prior && !prior.authorized && prior.expiresAt <= Date.now()) {
      consentRequests.delete(key);
      throw new Error(`consentRef is expired for this metered ${action} request; prepare the task again`);
    }
    if (prior) {
      if (prior.requestHash !== hash) throw new Error(`requestId was already used for a different metered ${action} request: ${requestId}`);
      if (prior.authorized) return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: true };
      return consentRequired(prior, true);
    }
    const pending = pendingAuthorizations.get(key);
    if (pending) {
      const record = await pending;
      if (record.requestHash !== hash) throw new Error(`requestId was already used for a different metered ${action} request: ${requestId}`);
      return consentRequired(record, true);
    }
    const preparation = (async () => {
      let quotaSnapshot;
      try {
        quotaSnapshot = quotaProvider
          ? await quotaProvider()
          : { status: "unavailable", observedAt: new Date().toISOString(), usage: { status: "unavailable" }, rateLimits: { status: "unavailable" } };
      } catch (error) {
        const projected = { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
        quotaSnapshot = {
          status: "unavailable",
          observedAt: new Date().toISOString(),
          usage: { status: "unavailable", error: projected },
          rateLimits: { status: "unavailable", error: projected },
        };
      }
      const record = {
        action,
        subjectRef,
        requestId,
        requestHash: hash,
        consentRef: `consent_${randomUUID()}`,
        quota: projectQuotaSnapshot(quotaSnapshot),
        createdAt: Date.now(),
        expiresAt: Date.now() + CONSENT_TTL_MS,
        authorized: false,
        authorizedAt: null,
      };
      consentRequests.set(key, record);
      return record;
    })();
    pendingAuthorizations.set(key, preparation);
    try {
      const record = await preparation;
      return consentRequired(record, false);
    } finally {
      if (pendingAuthorizations.get(key) === preparation) pendingAuthorizations.delete(key);
    }
  }

  function approveConsent({ action, requestId, subjectRef = null, payload, consentRef }) {
    if (action !== "start" && action !== "send") throw new Error("metered consent action must be start or send");
    if (typeof requestId !== "string" || !requestId.trim()) throw new Error("metered consent requestId must be a non-empty string");
    if (typeof consentRef !== "string" || !consentRef.trim()) throw new Error("metered consentRef must be a non-empty string");
    if (mode === "off") return { authorized: true, mode: "off", consentRef: null, duplicate: false };
    const key = requestKey({ requestId, action, subjectRef });
    const prior = consentRequests.get(key);
    if (!prior) throw new Error("consentRef is unknown or stale for this metered requestId");
    if (!prior.authorized && prior.expiresAt <= Date.now()) {
      consentRequests.delete(key);
      throw new Error(`consentRef is expired for this metered ${action} request; prepare the task again`);
    }
    if (prior.requestHash !== requestHash(action, subjectRef, payload)) throw new Error(`requestId was already used for a different metered ${action} request: ${requestId}`);
    if (prior.consentRef !== consentRef) throw new Error(`consentRef does not match the pending metered ${action} request`);
    if (prior.authorized) return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: true };
    prior.authorized = true;
    prior.authorizedAt = Date.now();
    return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: false };
  }

  function createTask({ consent = null, requestId = null, action, payload, cwd = null, permissionProfile = null, agentRef = null, authorized = false }) {
    refreshIndexes();
    const boundConsent = consent ?? { consentRef: null, requestId, quota: null };
    const boundRequestId = boundConsent.requestId ?? requestId;
    const subjectRef = agentRef ?? null;
    const existingTaskRef = boundRequestId && action
      ? requestIndex.get(requestKey({ requestId: boundRequestId, action, subjectRef }))
      : null;
    if (existingTaskRef) {
      const existing = records.get(existingTaskRef);
      const hash = taskPayloadHash(action, payload, subjectRef);
      if (existing?.payloadHash && existing.payloadHash !== hash) {
        throw new Error(`requestId ${boundRequestId} was already used for a different Codex task payload`);
      }
      return existing;
    }
    const taskRef = `task_${randomUUID()}`;
    const record = {
      taskRef,
      taskId: taskRef,
      consent: boundConsent,
      action,
      payload,
      payloadHash: taskPayloadHash(action, payload, agentRef),
      cwd,
      permissionProfile,
      subjectRef: agentRef,
      agentRef,
      authorized,
      commitToken: authorized ? null : `commit_${randomUUID()}`,
      turnId: null,
      terminalSnapshot: null,
      declinedAt: null,
      taskCard: taskCardFor({ taskRef, requestId: boundRequestId, action, payload, cwd, permissionProfile, quota: boundConsent.quota }),
      persistenceWarning: null,
    };
    indexRecord(record);
    persist(record, "pending");
    return record;
  }

  function taskByRef(taskRef) {
    refreshIndexes();
    return typeof taskRef === "string" && taskRef ? records.get(taskRef) ?? null : null;
  }

  function taskByConsent(consentRef) {
    refreshIndexes();
    const taskRef = consentIndex.get(consentRef);
    return taskRef ? records.get(taskRef) ?? null : null;
  }

  function taskByPortable(taskId) {
    refreshIndexes();
    const refs = portableIndex.get(taskId);
    if (!refs || refs.size !== 1) throw new Error("unknown, stale, or ambiguous Portable Card task ID");
    const record = records.get([...refs][0]);
    if (!record?.consent?.consentRef) throw new Error("Portable Card task ID is not bound to a prepared metered task");
    return record;
  }

  function taskForAgent(agentRef) {
    refreshIndexes();
    const taskRef = currentCard.get(agentRef);
    return taskRef ? records.get(taskRef) ?? null : null;
  }

  function bindAgent(record, agentRef, turnId = null) {
    if (!record) return;
    if (record.agentRef && agentTaskIndex.has(record.agentRef)) agentTaskIndex.get(record.agentRef).delete(record.taskRef);
    record.agentRef = agentRef ?? null;
    record.subjectRef = agentRef ?? record.subjectRef ?? null;
    record.turnId = turnId ?? record.turnId ?? null;
    indexRecord(record);
    if (record.agentRef) currentCard.set(record.agentRef, record.taskRef);
  }

  function markActive(record) {
    if (!record) throw new Error("Codex task record is required");
    persist(record, "active");
  }

  function freeze(record, payload) {
    if (!record) throw new Error("Codex task record is required");
    if (record.terminalSnapshot) return clone(record.terminalSnapshot);
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
    return clone(frozen);
  }

  function recover(taskRef) {
    const record = taskByRef(taskRef);
    if (!record) return null;
    if (record.terminalSnapshot?.terminal === true) return clone(record.terminalSnapshot);
    const now = Date.now();
    const lost = {
      taskRef,
      taskId: taskRef,
      agentRef: record.agentRef ?? null,
      turnId: record.turnId ?? null,
      status: "lost",
      canSend: false,
      pendingApproval: null,
      taskCard: record.taskCard ? structuredClone(record.taskCard) : null,
      meteredConsent: { status: "unavailable", quota: record.taskCard?.quota ?? null },
      finalResult: null,
      resourceReceipt: null,
      timing: { startedAt: null, endedAt: now, durationMs: null },
      execution: {
        requestedModel: record.taskCard?.requestedModel ?? null,
        ...(typeof record.taskCard?.requestedReasoningEffort === "string" ? { requestedReasoningEffort: record.taskCard.requestedReasoningEffort } : {}),
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      },
      latestError: "Task control state was lost across Codexless restart. The original task will not be replayed.",
      terminal: true,
      terminalAt: now,
      resultSummary: "Task control state was lost across Codexless restart. The original task will not be replayed.",
      events: [],
      nextSeq: 0,
    };
    const first = clone(lost);
    persist(record, "terminal", lost);
    // Recovery returns the natural LOST projection once; later reads replay
    // the exact persisted terminal snapshot byte-for-byte.
    record.terminalSnapshot = structuredClone(lost);
    return first;
  }

  function decline(record) {
    if (record.terminalSnapshot) return clone(record.terminalSnapshot);
    if (record.authorized) throw new Error("prepared Codex task already started and cannot be declined as a pre-call task");
    record.declinedAt = Date.now();
    return freeze(record, {
      agentRef: record.agentRef,
      turnId: null,
      status: "rejected",
      pendingApproval: null,
      finalResult: null,
      resourceReceipt: null,
      timing: { startedAt: null, endedAt: record.declinedAt, durationMs: 0 },
      execution: {
        requestedModel: record.payload?.model ?? null,
        ...(typeof record.payload?.reasoningEffort === "string" ? { requestedReasoningEffort: record.payload.reasoningEffort } : {}),
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      },
      latestError: null,
      events: [],
      nextSeq: 0,
      meteredConsent: { status: "rejected", quota: record.consent?.quota ?? null },
    });
  }

  function commitTask(record, { action, requestId, subjectRef = null, payload, consentRef }) {
    if (!record) throw new Error("unknown or stale prepared metered consentRef");
    if (record.terminalSnapshot) return { record, duplicate: true };
    if (record.declinedAt) return { record, duplicate: true };
    const boundConsent = record.consent?.consentRef;
    if (!boundConsent) throw new Error("prepared Codex task is missing its metered consentRef");
    const approval = approveConsent({ action, requestId, subjectRef, payload, consentRef });
    if (!approval.authorized) throw new Error("prepared Codex task approval did not authorize dispatch");
    record.authorized = true;
    return { record, duplicate: approval.duplicate };
  }

  return {
    get mode() { return mode; },
    get persistence() { return persistence; },
    assertAvailable() { persistence?.assertAvailable(); },
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
    decline,
    commitTask,
    portableShortTaskId,
    taskPayloadHash,
    persistableSnapshot,
    records: () => {
      refreshIndexes();
      return [...records.values()];
    },
  };
}
