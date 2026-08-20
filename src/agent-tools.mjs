import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
import { AGENT_TASK_CARD_URI, registerAgentTaskCardResource } from "./agent-card-ui.mjs";
import {
  createAgentTaskLedger,
  DEFAULT_TASK_STORE_MAX_ENTRIES,
  DEFAULT_TASK_STORE_TTL_MS,
  portableShortTaskId as ledgerPortableShortTaskId,
} from "./agent-task-ledger.mjs";

const EVENT_KEYS = new Set(["seq", "type", "at", "turnId", "status", "requestId"]);
const PENDING_APPROVAL_KEYS = new Set(["requestId", "method", "itemId", "receivedAt", "reason", "details"]);
const TERMINAL_STATUSES = new Set(["idle", "completed", "failed", "interrupted", "rejected", "lost"]);

function publicEvent(event) {
  if (!event || typeof event !== "object") return null;
  return Object.fromEntries(Object.entries(event).filter(([key]) => EVENT_KEYS.has(key)));
}

function publicPendingApproval(pendingApproval) {
  if (!pendingApproval || typeof pendingApproval !== "object") return null;
  const projected = Object.fromEntries(Object.entries(pendingApproval).filter(([key]) => PENDING_APPROVAL_KEYS.has(key)));
  if (projected.requestId !== undefined && projected.requestId !== null) projected.requestId = String(projected.requestId);
  return projected;
}

function quotaWindows(quota) {
  const limits = quota?.rateLimits?.limits ?? [];
  const windows = [];
  for (const limit of limits) {
    for (const window of Array.isArray(limit?.windows) ? limit.windows : []) {
      windows.push({
        limitKey: typeof limit?.key === "string" ? limit.key : null,
        limitName: typeof limit?.limitName === "string" ? limit.limitName : null,
        kind: typeof window?.kind === "string" ? window.kind : null,
        remainingPercent: Number.isInteger(window?.remainingPercent) ? window.remainingPercent : null,
        resetsAt: Number.isInteger(window?.resetsAt) ? window.resetsAt : null,
        windowDurationMins: Number.isInteger(window?.windowDurationMins) ? window.windowDurationMins : null,
      });
    }
  }
  return windows;
}

function quotaWindowDurationLabel(window) {
  const mins = window?.windowDurationMins;
  if (!Number.isInteger(mins) || mins <= 0) return null;
  if (mins % 1_440 === 0) return `${mins / 1_440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function quotaWindowLabel(window, index) {
  const duration = quotaWindowDurationLabel(window);
  const rawName = window?.limitName;
  const namedLimit = rawName && rawName.toLowerCase() !== "codex"
    ? rawName
    : (window?.limitKey && window.limitKey !== "codex" ? window.limitKey : null);
  if (namedLimit && duration) return `${namedLimit} · ${duration}`;
  return namedLimit || duration || window?.kind || `window ${index + 1}`;
}

function compactOneLine(value, max = 320) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, Math.max(1, max - 3)) + "..." : clean;
}

function approvalOneLine(pendingApproval) {
  if (!pendingApproval) return "Approval required";
  return compactOneLine(
    pendingApproval.reason
      ?? pendingApproval.details?.reason
      ?? pendingApproval.details?.command
      ?? pendingApproval.details?.path
      ?? pendingApproval.details?.changes?.[0]?.path
      ?? pendingApproval.method
      ?? "Approval required"
  );
}

function quotaFallbackText(window, index) {
  const label = quotaWindowLabel(window, index);
  const remaining = Number.isInteger(window?.remainingPercent) ? `${window.remainingPercent}% left` : "remaining unknown";
  const reset = Number.isInteger(window?.resetsAt) ? ` · reset ${new Date(window.resetsAt * 1000).toISOString()}` : "";
  return `${label}: ${remaining}${reset}`;
}

function portableShortTaskId(taskRef) {
  return ledgerPortableShortTaskId(taskRef);
}

function portableLocale() {
  const envLocale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  if (envLocale) return envLocale.split(".")[0].replace(/_/g, "-");
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en";
  } catch {
    return "en";
  }
}

function portableStrings(locale = portableLocale()) {
  const value = String(locale || "en").toLowerCase();
  if (value.startsWith("zh")) {
    return {
      call: "调用 Codex？", task: "任务", model: "模型", reasoning: "推理强度",
      quota: "Codex 额度", left: "剩余", reset: "重置", unavailable: "当前未提供", reply: "请回复「Yes」或「No」。",
    };
  }
  if (value.startsWith("ja")) {
    return {
      call: "Codexを呼び出しますか？", task: "タスク", model: "モデル", reasoning: "推論強度",
      quota: "Codex 利用枠", left: "残り", reset: "リセット", unavailable: "現在は提供なし", reply: "「Yes」または「No」と返信してください。",
    };
  }
  return {
    call: "Call Codex?", task: "Task", model: "Model", reasoning: "Reasoning effort",
    quota: "Codex quota", left: "left", reset: "reset", unavailable: "not provided", reply: "Please reply \"Yes\" or \"No\".",
  };
}

function agentModelIdentity(entry) {
  if (typeof entry?.model === "string" && entry.model) return entry.model;
  if (typeof entry?.id === "string" && entry.id) return entry.id;
  return null;
}

function portableModelOption(entry) {
  const model = agentModelIdentity(entry);
  if (!model) return null;
  return {
    model,
    displayName: typeof entry?.displayName === "string" && entry.displayName ? entry.displayName : null,
    isDefault: entry?.isDefault === true,
    defaultReasoningEffort: typeof entry?.defaultReasoningEffort === "string" && entry.defaultReasoningEffort ? entry.defaultReasoningEffort : null,
    supportedReasoningEfforts: Array.isArray(entry?.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.map((option) => typeof option?.reasoningEffort === "string" ? option.reasoningEffort : null).filter(Boolean)
      : [],
  };
}

function portableModelLabel(option) {
  if (!option) return null;
  return option.displayName && option.displayName !== option.model
    ? option.displayName
    : option.model;
}

function portableResetText(unixSeconds, locale = portableLocale()) {
  if (!Number.isInteger(unixSeconds)) return "";
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return new Date(unixSeconds * 1000).toLocaleString();
  }
}

function portableQuotaText(window, index, locale = portableLocale()) {
  const strings = portableStrings(locale);
  const label = quotaWindowLabel(window, index);
  const remaining = Number.isInteger(window?.remainingPercent) ? `${window.remainingPercent}% ${strings.left}` : strings.unavailable;
  const reset = portableResetText(window?.resetsAt, locale);
  return `${label}：${remaining} · ${strings.reset} ${reset || strings.unavailable}`;
}

function portableQuotaGroup(label, quota, locale = portableLocale()) {
  const strings = portableStrings(locale);
  const windows = quotaWindows(quota);
  return [label, ...(windows.length ? windows.map((window, index) => portableQuotaText(window, index, locale)) : [strings.unavailable])];
}

function manualFallback(payload) {
  const status = payload?.status ?? "unknown";
  const locale = portableLocale();
  const strings = portableStrings(locale);
  const beforeQuota = payload?.meteredConsent?.quota ?? payload?.taskCard?.quota ?? null;
  const afterQuota = payload?.resourceReceipt?.accountQuota ?? null;
  const quota = beforeQuota ?? afterQuota;
  const windows = quotaWindows(quota);
  const quotaLines = windows.length ? windows.map((window, index) => quotaFallbackText(window, index)) : ["Codex quota: unavailable"];
  const taskRef = payload?.taskRef ?? payload?.taskId ?? payload?.taskCard?.taskRef ?? null;

  if (taskRef) {
    const taskId = portableShortTaskId(taskRef);
    const task = compactOneLine(payload?.taskCard?.summary ?? "Codex task");
    const selection = payload?.taskCard?.modelSelection && typeof payload.taskCard.modelSelection === "object" ? payload.taskCard.modelSelection : null;
    const selectedModelOption = selection?.models?.find((option) => option?.model === selection?.selectedModel) ?? null;
    const requestedModel = payload?.execution?.requestedModel ?? payload?.taskCard?.requestedModel ?? selection?.selectedModel ?? null;
    const resolvedModel = payload?.execution?.resolvedModel ?? null;
    const model = status === "consent_required" && selection?.selectedModel
      ? portableModelLabel(selectedModelOption ?? { model: selection.selectedModel, displayName: selection.selectedModelDisplayName ?? null })
      : resolvedModel ?? requestedModel ?? null;
    const requestedEffort = payload?.execution?.requestedReasoningEffort ?? payload?.taskCard?.requestedReasoningEffort ?? selection?.selectedReasoningEffort ?? null;
    const resolvedEffort = payload?.execution?.reasoningEffort ?? null;
    const effort = status === "consent_required" ? selection?.selectedReasoningEffort ?? requestedEffort ?? null : resolvedEffort ?? requestedEffort ?? null;
    const portableStatus = status === "consent_required" ? "AWAITING DECISION" : status === "awaitingApproval" ? "CODEX APPROVAL REQUIRED" : status === "running" ? "RUNNING" : isTerminalStatus(status) ? terminalLabel(status) : String(status).toUpperCase();
    let lines;
    if (status === "consent_required") {
      lines = [
        strings.call, "",
        `${strings.task}：${task}`,
        `${strings.model}：${model ?? strings.unavailable}`,
        `${strings.reasoning}：${effort ?? strings.unavailable}`,
        "",
        ...portableQuotaGroup(strings.quota, beforeQuota, locale), "",
        strings.reply,
      ];
    } else {
      lines = [`Codex · ${portableStatus}`, `${strings.task}：${task}`];
      if (model) lines.push(`${strings.model}：${model}`);
      if (effort) lines.push(`${strings.reasoning}：${effort}`);
      if (status === "awaitingApproval" && payload?.pendingApproval) lines.push(`Pending Codex approval: ${approvalOneLine(payload.pendingApproval)}`);
      if (isTerminalStatus(status)) {
        const detail = compactOneLine(payload?.finalResult ?? payload?.latestError ?? "", 500);
        const turnTokens = payload?.resourceReceipt?.tokenUsage?.turn?.totalTokens ?? null;
        if (detail) lines.push(`Result: ${detail}`);
        lines.push(Number.isInteger(turnTokens) ? `Usage: ${turnTokens.toLocaleString("en-US")} tokens this turn` : "Usage: tokens unavailable");
        if (beforeQuota) lines.push("", ...portableQuotaGroup(`${strings.quota} · before`, beforeQuota, locale));
        if (afterQuota) lines.push("", ...portableQuotaGroup(`${strings.quota} · after`, afterQuota, locale));
        if (!beforeQuota && !afterQuota) lines.push("", strings.quota, strings.unavailable);
      } else if (beforeQuota) lines.push("", ...portableQuotaGroup(strings.quota, beforeQuota, locale));
    }
    return {
      kind: "portable_card",
      portable: true,
      taskId,
      status: portableStatus,
      task,
      choices: status === "consent_required" ? ["Yes", "No"] : [],
      requiresTaskCard: false,
      nextAction: "codex.agent_card_render",
      quota: { windows, before: { windows: quotaWindows(beforeQuota) }, after: { windows: quotaWindows(afterQuota) } },
      ...(selection ? { modelSelection: structuredClone(selection) } : {}),
      ...(status === "consent_required" ? {
        rebind: {
          mode: "natural_language_reprepare",
          requiresNewRequestId: true,
          instruction: "If the user changes model or reasoning effort before approval, do not commit this task. Prepare the same logical task again with the requested selection and a fresh requestId, present the new confirmation, and bind Yes only to the newly presented taskId.",
        },
        decision: { approveTool: "codex.agent_commit", declineTool: "codex.agent_decline", taskId },
      } : {}),
      lines,
      text: lines.join("\n"),
    };
  }

  if (status === "consent_required") {
    const locale = portableLocale();
    const strings = portableStrings(locale);
    const summary = compactOneLine(payload?.taskCard?.summary ?? "Codex task");
    const requestedModel = payload?.execution?.requestedModel ?? payload?.taskCard?.requestedModel ?? null;
    const model = requestedModel ? compactOneLine(requestedModel) : null;
    const requestedEffort = payload?.execution?.requestedReasoningEffort ?? payload?.taskCard?.requestedReasoningEffort ?? null;
    const effort = requestedEffort ? compactOneLine(requestedEffort) : null;
    const taskRef = payload?.taskRef ?? payload?.taskId ?? payload?.taskCard?.taskRef ?? null;
    const taskId = taskRef ? portableShortTaskId(taskRef) : null;
    const portableQuotaLines = windows.length
      ? windows.map((window, index) => portableQuotaText(window, index, locale))
      : [strings.unavailable];
    const body = [strings.call, "", `${strings.task}：${summary}`];
    if (model) body.push(`${strings.model}：${model}`);
    if (effort) body.push(`${strings.reasoning}：${effort}`);
    body.push("", strings.quota, ...portableQuotaLines, "", strings.reply);
    const lines = body;
    return {
      kind: "portable_card",
      choices: ["Yes", "No"],
      summary,
      taskId,
      quota: { windows },
      requiresTaskCard: false,
      nextAction: "codex.agent_card_render",
      decision: taskId ? {
        approveTool: "codex.agent_commit",
        declineTool: "codex.agent_decline",
        taskId,
      } : null,
      lines,
      text: lines.join("\n"),
    };
  }

  if (status === "awaitingApproval" && payload?.pendingApproval) {
    const summary = approvalOneLine(payload.pendingApproval);
    return {
      kind: "confirm_approval",
      choices: ["Yes", "No"],
      summary,
      quota: { windows },
      lines: ["Codex approval", `Request: ${summary}`, ...quotaLines, "Yes / No"],
    };
  }

  const terminal = isTerminalStatus(status);
  if (terminal) {
    const label = terminalLabel(status);
    const task = compactOneLine(payload?.taskCard?.summary ?? "Codex task");
    const detail = label === "DONE" ? null : compactOneLine(payload?.latestError ?? payload?.finalResult ?? label, 240);
    const turnTokens = payload?.resourceReceipt?.tokenUsage?.turn?.totalTokens ?? null;
    const tokenLine = Number.isInteger(turnTokens) ? `This turn: ${turnTokens.toLocaleString("en-US")} tokens` : "This turn: tokens unavailable";
    const lines = [`Codex · ${label}`, `Task: ${task}`];
    if (detail) lines.push(`Detail: ${detail}`);
    lines.push(tokenLine, "Codex quota", ...quotaLines);
    return {
      kind: "completion",
      status: label.toLowerCase(),
      task,
      result: detail,
      turnTokens: Number.isInteger(turnTokens) ? turnTokens : null,
      quota: { windows },
      lines,
    };
  }

  return null;
}

function publicAgentSnapshot(snapshot, taskCard = null) {
  const payload = {
    agentRef: snapshot?.agentRef ?? null,
    turnId: snapshot?.turnId ?? null,
    status: snapshot?.status ?? "unknown",
    canSend: snapshot?.canSend === true,
    pendingApproval: publicPendingApproval(snapshot?.pendingApproval),
    finalResult: snapshot?.finalResult ?? null,
    resourceReceipt: snapshot?.resourceReceipt ?? null,
    timing: snapshot?.timing ?? { startedAt: null, endedAt: null, durationMs: null },
    execution: snapshot?.execution ?? { requestedModel: null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
    latestError: snapshot?.latestError ?? null,
    events: Array.isArray(snapshot?.events) ? snapshot.events.map(publicEvent).filter(Boolean) : [],
    nextSeq: Number.isInteger(snapshot?.nextSeq) ? snapshot.nextSeq : 0,
  };
  if (taskCard) payload.taskCard = taskCard;
  if (typeof snapshot?.duplicate === "boolean") payload.duplicate = snapshot.duplicate;
  if (typeof snapshot?.controlAcceptance === "string") payload.controlAcceptance = snapshot.controlAcceptance;
  const fallback = manualFallback(payload);
  if (fallback) payload.manualFallback = fallback;
  return payload;
}

function consentRequiredSnapshot({ agentRef = null, consent, taskCard = null }) {
  const payload = {
    agentRef,
    status: "consent_required",
    canSend: false,
    pendingApproval: null,
    meteredConsent: consent,
    taskCard,
    finalResult: null,
    resourceReceipt: null,
    latestError: null,
    events: [],
    nextSeq: 0,
  };
  payload.manualFallback = manualFallback(payload);
  return payload;
}

function pendingTaskSnapshot({ record, resolvedExecution = null }) {
  const pending = consentRequiredSnapshot({
    agentRef: record.agentRef,
    consent: record.consent,
    taskCard: record.taskCard,
  });
  pending.taskRef = record.taskRef;
  pending.taskId = record.taskRef;
  pending.turnId = null;
  pending.timing = { startedAt: null, endedAt: null, durationMs: null };
  pending.execution = {
    requestedModel: typeof record.payload?.model === "string" ? record.payload.model : null,
    ...(typeof record.payload?.reasoningEffort === "string" ? { requestedReasoningEffort: record.payload.reasoningEffort } : {}),
    resolvedModel: resolvedExecution?.resolvedModel ?? null,
    modelProvider: resolvedExecution?.modelProvider ?? null,
    serviceTier: resolvedExecution?.serviceTier ?? null,
    reasoningEffort: resolvedExecution?.reasoningEffort ?? null,
  };
  pending.manualFallback = manualFallback(pending);
  return pending;
}

export function createAgentPreviewState({
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  taskStateFile = null,
  taskStateTtlMs = DEFAULT_TASK_STORE_TTL_MS,
  taskStateMaxEntries = DEFAULT_TASK_STORE_MAX_ENTRIES,
} = {}) {
  const ledger = createAgentTaskLedger({
    mode: meteredConsentMode,
    quotaProvider: meteredQuotaProvider,
    taskStateFile,
    taskStateTtlMs,
    taskStateMaxEntries,
  });
  // A read-only mode view keeps description interpolation compatible while
  // leaving the ledger as the sole mutable owner of Agent state.
  const meteredConsent = Object.freeze({ get mode() { return ledger.mode; } });
  return { ledger, meteredConsent };
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function terminalLabel(status) {
  if (status === "failed") return "FAILED";
  if (status === "interrupted") return "STOPPED";
  if (status === "rejected") return "REJECTED";
  if (status === "lost") return "UNCERTAIN";
  return "DONE";
}

export function registerAgentPreviewTools(server, {
  agentExecutor,
  authorityExecutor,
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  agentPreviewState = null,
}) {
  if (!agentExecutor || !authorityExecutor) {
    throw new Error("Agent preview requires both agentExecutor and authorityExecutor");
  }
  const state = agentPreviewState ?? createAgentPreviewState({ meteredConsentMode, meteredQuotaProvider });
  const ledger = state.ledger;
  if (!ledger) throw new Error("Agent preview requires canonical task ledger state");
  const meteredConsent = state.meteredConsent;
  registerAgentTaskCardResource(server);

  async function fullModelCatalog() {
    const models = [];
    let cursor = null;
    const seenCursors = new Set();
    for (let page = 0; page < 20; page += 1) {
      const result = await agentExecutor.listModels({ cursor, limit: 200, includeHidden: false });
      for (const entry of Array.isArray(result?.models) ? result.models : []) {
        const option = portableModelOption(entry);
        if (option && !models.some((item) => item.model === option.model)) models.push(option);
      }
      if (!result?.nextCursor) return models;
      if (seenCursors.has(result.nextCursor)) throw new Error("codex.model_list returned a repeated cursor while preparing the Codex confirmation");
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("codex.model_list exceeded the bounded pagination limit while preparing the Codex confirmation");
  }

  async function resolvePreparedModelSelection({ requestedModel = null, requestedReasoningEffort = null, currentModel = null, currentReasoningEffort = null } = {}) {
    const models = await fullModelCatalog();
    if (!models.length) throw new Error("codex.model_list returned no selectable models for the Codex confirmation");
    const requested = typeof requestedModel === "string" && requestedModel.trim() ? requestedModel.trim() : null;
    const current = typeof currentModel === "string" && currentModel.trim() ? currentModel.trim() : null;
    const entry = requested
      ? models.find((item) => item.model === requested)
      : current
        ? models.find((item) => item.model === current) ?? models.find((item) => item.isDefault)
        : models.find((item) => item.isDefault);
    if (!entry) throw new Error(`codex.model_list could not resolve the selected model ${requested ?? current ?? "<default>"}`);
    const supported = [...entry.supportedReasoningEfforts];
    let effort = typeof requestedReasoningEffort === "string" && requestedReasoningEffort.trim() ? requestedReasoningEffort.trim() : null;
    let effortSource = effort ? "explicit" : null;
    if (effort && !supported.includes(effort)) {
      throw new Error(`reasoningEffort validation failed for model "${entry.model}": requested effort "${effort}"; supported efforts: ${supported.length ? supported.join(", ") : "(none)"}`);
    }
    if (!effort && !requested && current === entry.model && typeof currentReasoningEffort === "string" && supported.includes(currentReasoningEffort)) {
      effort = currentReasoningEffort;
      effortSource = "current";
    }
    if (!effort && entry.defaultReasoningEffort) {
      if (supported.length && !supported.includes(entry.defaultReasoningEffort)) {
        throw new Error(`codex.model_list returned default reasoning effort "${entry.defaultReasoningEffort}" outside the supported efforts for model "${entry.model}"`);
      }
      effort = entry.defaultReasoningEffort;
      effortSource = "default";
    }
    return {
      source: "codex.model_list",
      selectedModel: entry.model,
      selectedModelDisplayName: entry.displayName,
      modelSelectionSource: requested ? "explicit" : current === entry.model ? "current" : "default",
      selectedReasoningEffort: effort,
      reasoningEffortSelectionSource: effortSource ?? "unavailable",
      supportedReasoningEfforts: supported,
      models,
    };
  }

  async function existingRequestState({ requestId, action, payload, agentRef = null }) {
    const record = ledger.findRecord({ requestId, action, subjectRef: agentRef, payload });
    if (!record) return null;
    if (!record.payload && !record.terminalSnapshot) return ledger.recover(record.taskRef);
    return preparedCardState(record);
  }

  function rememberPrepared({ consent, action, payload, cwd = null, permissionProfile = null, agentRef = null }) {
    const existing = ledger.taskByConsent(consent.consentRef);
    if (existing) return existing;
    return ledger.createTask({ consent, action, payload, cwd, permissionProfile, agentRef, authorized: false });
  }

  function directRecord({ action, payload, cwd = null, permissionProfile = null, agentRef = null, requestId }) {
    return ledger.createTask({ action, payload, cwd, permissionProfile, agentRef, requestId, authorized: true });
  }

  function cardForAgent(agentRef) {
    return ledger.taskForAgent(agentRef)?.taskCard ?? null;
  }

  function publicTaskSnapshot(record, snapshot) {
    return {
      ...publicAgentSnapshot(snapshot, record.taskCard),
      taskRef: record.taskRef,
      taskId: record.taskRef,
      meteredConsent: { status: "approved", quota: record.consent?.quota ?? record.taskCard?.quota ?? null },
    };
  }

  function failedDispatchSnapshot(record, error) {
    return {
      agentRef: record.agentRef,
      turnId: null,
      status: "failed",
      pendingApproval: null,
      finalResult: null,
      resourceReceipt: null,
      timing: { startedAt: null, endedAt: Date.now(), durationMs: 0 },
      execution: {
        requestedModel: record.payload?.model ?? record.taskCard?.requestedModel ?? null,
        ...(typeof record.payload?.reasoningEffort === "string" ? { requestedReasoningEffort: record.payload.reasoningEffort } : {}),
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      },
      latestError: error instanceof Error ? error.message : String(error),
      events: [], nextSeq: 0,
      meteredConsent: { status: "approved", quota: record.consent?.quota ?? record.taskCard?.quota ?? null },
    };
  }

  function freezeRecord(record, payload) {
    return ledger.freeze(record, payload);
  }

  function lostRecord(record) {
    return freezeRecord(record, {
      agentRef: record.agentRef,
      turnId: record.turnId,
      status: "lost",
      pendingApproval: null,
      finalResult: null,
      resourceReceipt: null,
      timing: { startedAt: null, endedAt: Date.now(), durationMs: null },
      execution: {
        requestedModel: typeof record.payload?.model === "string" ? record.payload.model : record.taskCard?.requestedModel ?? null,
        ...(typeof record.payload?.reasoningEffort === "string" ? { requestedReasoningEffort: record.payload.reasoningEffort } : typeof record.taskCard?.requestedReasoningEffort === "string" ? { requestedReasoningEffort: record.taskCard.requestedReasoningEffort } : {}),
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      },
      latestError: "Task-specific terminal state was not observed before this agent advanced. The original task will not be replayed.",
      events: [],
      nextSeq: 0,
      meteredConsent: { status: "approved", quota: record.consent?.quota ?? record.taskCard?.quota ?? null },
    });
  }

  async function freezeCurrentTaskForAgent(agentRef) {
    if (!agentRef) return;
    const snapshot = await agentExecutor.show({ agentRef, afterSeq: 0 });
    if (!isTerminalStatus(snapshot?.status)) return;
    for (const record of ledger.records()) {
      if (record.agentRef !== agentRef || record.terminalSnapshot) continue;
      if (!record.turnId && cardForAgent(agentRef)?.taskRef === record.taskRef) record.turnId = snapshot.turnId ?? null;
      if (!record.turnId || snapshot.turnId !== record.turnId) continue;
      freezeRecord(record, publicTaskSnapshot(record, snapshot));
    }
  }

  async function preparedCardState(record) {
    if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
    if (!record.payload && record.persisted) return ledger.recover(record.taskRef);
    if (!record.authorized) return pendingTaskSnapshot({ record });
    if (!record.agentRef) throw new Error("prepared Codex task is authorized but its agentRef is not available yet");
    const snapshot = await agentExecutor.show({ agentRef: record.agentRef, afterSeq: 0 });
    if (!record.turnId && snapshot.turnId) record.turnId = snapshot.turnId;
    if (record.turnId && snapshot.turnId !== record.turnId) return lostRecord(record);
    const payload = publicTaskSnapshot(record, snapshot);
    if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
    return payload;
  }

  function preparedRecordByPortableTaskId(taskId) {
    return ledger.taskByPortable(taskId);
  }

  function declinePrepared(record) {
    return ledger.decline(record);
  }

  function approvePrepared(record) {
    if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
    if (record.declinedAt) return { ...structuredClone(record.terminalSnapshot ?? lostRecord(record)), duplicate: true };
    const approval = ledger.commitTask(record, {
      action: record.action,
      requestId: record.consent.requestId,
      subjectRef: record.action === "send" ? record.agentRef : null,
      payload: record.payload,
      consentRef: record.consent.consentRef,
    });
    if (approval.duplicate && record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
    return dispatchPrepared(record);
  }

  async function dispatchPrepared(record) {
    if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
    if (record.declinedAt) return structuredClone(record.terminalSnapshot ?? lostRecord(record));
    if (record.action === "start") {
      const currentAuthority = await authorityExecutor.resolveAuthority({ cwd: record.cwd, access: "inherit" });
      if (currentAuthority.effectiveCwd !== record.cwd || currentAuthority.permissionProfile !== record.permissionProfile) {
        throw new Error("prepared Codex task authority changed; prepare and approve a new task card");
      }
    } else if (record.payload?.parentTurnId) {
      const current = await agentExecutor.show({ agentRef: record.agentRef, afterSeq: 0 });
      if (current.turnId !== record.payload.parentTurnId || current.status !== "idle" || current.canSend !== true) {
        throw new Error("prepared Codex follow-up is stale because the agent advanced; prepare a new task card for the current turn");
      }
    }
    if (!record.authorized) {
      throw new Error("Codex task is still pending user approval; dispatch is blocked until the prepared task is explicitly committed");
    }
    // The durable active marker is the last local boundary before a remote call.
    ledger.markActive(record);

    if (record.action === "start") {
      let snapshot;
      try {
        snapshot = await agentExecutor.start({
          cwd: record.cwd,
          task: record.payload.prompt,
          clientRequestId: record.consent.requestId,
          permissionProfile: record.permissionProfile,
          model: record.payload.model ?? null,
          reasoningEffort: record.payload.reasoningEffort ?? null,
        });
      } catch (error) {
        return freezeRecord(record, failedDispatchSnapshot(record, error));
      }
      if (snapshot?.agentRef) ledger.bindAgent(record, snapshot.agentRef, snapshot.turnId ?? null);
      const payload = publicTaskSnapshot(record, snapshot);
      if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
      ledger.persist(record, "active", payload);
      return payload;
    }

    await freezeCurrentTaskForAgent(record.agentRef);
    let snapshot;
    try {
      snapshot = await agentExecutor.send({
        agentRef: record.agentRef,
        message: record.payload.message,
        clientRequestId: record.consent.requestId,
        model: record.payload.model ?? null,
        reasoningEffort: record.payload.reasoningEffort ?? null,
      });
    } catch (error) {
      return freezeRecord(record, failedDispatchSnapshot(record, error));
    }
    record.turnId = snapshot.turnId ?? null;
    if (record.agentRef) ledger.bindAgent(record, record.agentRef, record.turnId);
    const payload = publicTaskSnapshot(record, snapshot);
    if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
    ledger.persist(record, "active", payload);
    return payload;
  }

  server.registerTool(
    "codex.model_list",
    {
      title: "List Codex Models",
      description:
        "Model-free read of the current Codex App Server model catalog. Use it when a user explicitly cares which model to run. The catalog reports current model ids/capabilities/defaults but does not provide price data, so Codexless must not infer cheapest from names alone.",
      inputSchema: z.object({
        cursor: z.string().min(1).max(2048).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        includeHidden: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cursor, limit, includeHidden }) => structured(async () => agentExecutor.listModels({
      cursor: cursor ?? null,
      limit: limit ?? null,
      includeHidden: includeHidden === true,
    }))
  );

  server.registerTool(
    "codex.agent_start",
    {
      title: "Start Codex Agent",
      description:
        `Experimental Preview. Prepare one formal Codex agent thread/turn under Codexless's locally resolved Codex authority. Local metered consent mode is ${meteredConsent.mode}; when set to always, every unapproved logical start returns consent_required and quota context without starting a turn. requestId is a caller-stable idempotency key and MUST be reused if the same start is retried after an uncertain response. A returned consentRef identifies the prepared task but is never proof of approval: replaying it through this public tool cannot start Codex work. Approval normally occurs through the Rich Task Card; when the Host cannot render that UI, codex.agent_card_render returns a Portable Card and an explicit user Yes/No may be bound to that exact prepared task through codex.agent_commit / codex.agent_decline. model is optional; omit it to preserve Codex's current default routing. reasoningEffort is also optional and is validated against the current codex.model_list entry for the effective model rather than a hard-coded global enum. The caller cannot choose permission profile, sandbox, approval policy, roots, or network authority.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(200_000),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key. Reuse this exact value for retries of the same logical start."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional execution-directory context. Codexless resolves authority locally for this cwd; cwd is not a permission selector."),
        model: z.string().min(1).max(512).optional()
          .describe("Optional exact model id from codex.model_list. Omit to use Codex's current default model routing."),
        reasoningEffort: z.string().min(1).max(128).optional()
          .describe("Optional reasoning effort supported by the effective model's current codex.model_list entry. Runtime validation is per-model; no global effort enum is hard-coded."),
        consentRef: z.string().min(1).max(512).optional()
          .describe("Legacy compatibility field. It identifies an already prepared task only; supplying or replaying it never authorizes metered Codex work. Approval must occur through the server-side Task Card commit path."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Preparing Codex task…",
        "openai/toolInvocation/invoked": "Codex task ready.",
      },
    },
    async ({ prompt, requestId, cwd, model, reasoningEffort, consentRef }) => structuredCard(async () => {
      const authority = await authorityExecutor.resolveAuthority({ cwd: cwd ?? null, access: "inherit" });
      const callerPayload = {
        prompt,
        cwd: authority.effectiveCwd,
        model: model ?? null,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        permissionProfile: authority.permissionProfile,
      };
      const prior = await existingRequestState({ requestId, action: "start", payload: callerPayload, agentRef: null });
      if (prior) return { ...prior, duplicate: true };
      if (consentRef) throw new Error("consentRef cannot authorize a Codex start through the public agent_start tool; render/approve the prepared Task Card instead");
      const preparedSelection = meteredConsent.mode === "always"
        ? await resolvePreparedModelSelection({ requestedModel: model ?? null, requestedReasoningEffort: reasoningEffort ?? null })
        : null;
      const payload = preparedSelection ? {
        ...callerPayload,
        callerModel: model ?? null,
        ...(reasoningEffort !== undefined ? { callerReasoningEffort: reasoningEffort } : {}),
        model: preparedSelection.selectedModel,
        ...(typeof preparedSelection.selectedReasoningEffort === "string" ? { reasoningEffort: preparedSelection.selectedReasoningEffort } : {}),
        modelSelection: preparedSelection,
      } : callerPayload;
      const consent = await ledger.authorize({ action: "start", requestId, payload });
      if (!consent.authorized) {
        const record = rememberPrepared({
          consent: consent.consent,
          action: "start",
          payload,
          cwd: authority.effectiveCwd,
          permissionProfile: authority.permissionProfile,
        });
        if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
        return pendingTaskSnapshot({ record });
      }
      const record = directRecord({
        action: "start",
        payload,
        cwd: authority.effectiveCwd,
        permissionProfile: authority.permissionProfile,
        requestId,
      });
      return dispatchPrepared(record);
    })
  );

  server.registerTool(
    "codex.agent_card_render",
    {
      title: "Render Prepared Codex Task Card",
      description:
        "Read-only render step for a prepared metered Codex start/send. Call this only after codex.agent_start or codex.agent_send returns consent_required. It does not start or continue Codex work; it re-reads the server-bound prepared record. Rich-UI Hosts can mount the Codex Task Card from outputTemplate; Hosts that cannot render that UI still receive the same confirmation as a framed Portable Card in ordinary MCP text content. Rich Card buttons use the card capability path; Portable Card Yes/No decisions bind the exact prepared task through codex.agent_commit / codex.agent_decline.",
      inputSchema: z.object({ consentRef: z.string().min(1).max(512) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        ui: { resourceUri: AGENT_TASK_CARD_URI },
        "openai/outputTemplate": AGENT_TASK_CARD_URI,
        "openai/toolInvocation/invoking": "Opening Codex confirmation…",
        "openai/toolInvocation/invoked": "Codex confirmation ready.",
      },
    },
    async ({ consentRef }) => structuredCard(
      async () => {
        const record = ledger.taskByConsent(consentRef);
        if (!record) throw new Error("unknown or stale prepared metered consentRef");
        return preparedCardState(record);
      },
      () => {
        const record = ledger.taskByConsent(consentRef);
        return record?.commitToken ? { codexlessCommitToken: record.commitToken } : {};
      },
      (payload) => payload?.manualFallback?.text ?? null
    )
  );

  server.registerTool(
    "codex.agent_card_state",
    {
      title: "Read Codex Task Card State",
      description:
        "App-only read-only state endpoint for one already mounted Codex Task Card. New cards use opaque taskRef so state remains task-specific even without a metered consentRef; consentRef remains a legacy in-runtime fallback. Persisted terminal snapshots survive Codexless restarts. Persisted non-terminal tasks recover as LOST/uncertain and are never replayed.",
      inputSchema: z.object({
        taskRef: z.string().min(1).max(512).optional(),
        consentRef: z.string().min(1).max(512).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ taskRef, consentRef }) => structuredCard(
      async () => {
        if (!taskRef && !consentRef) throw new Error("taskRef or consentRef is required");
        if (taskRef) {
          const live = ledger.taskByRef(taskRef);
          if (live) return preparedCardState(live);
          const recovered = ledger.recover(taskRef);
          if (recovered) return recovered;
        }
        if (consentRef) {
          const legacy = ledger.taskByConsent(consentRef);
          if (legacy) return preparedCardState(legacy);
        }
        throw new Error("unknown or stale Codex task card reference");
      },
      () => {
        const live = taskRef ? ledger.taskByRef(taskRef) : consentRef ? ledger.taskByConsent(consentRef) : null;
        return live?.commitToken ? { codexlessCommitToken: live.commitToken } : {};
      }
    )
  );

  server.registerTool(
    "codex.agent_show",
    {
      title: "Show Codex Agent",
      description:
        "Experimental Preview. Read the bounded operational state of one Codexless-owned Codex agent by opaque agentRef. Returns status, sendability, minimal pending-approval summary, final result, and a bounded event tail; it does not duplicate the Codex transcript.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        afterSeq: z.number().int().min(0).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ agentRef, afterSeq }) => structured(async () => {
      const snapshot = await agentExecutor.show({ agentRef, afterSeq: afterSeq ?? 0 });
      return publicAgentSnapshot(snapshot, cardForAgent(agentRef));
    })
  );

  server.registerTool(
    "codex.agent_send",
    {
      title: "Continue Codex Agent",
      description:
        `Experimental Preview. Prepare one exact Codexless-owned Codex agent follow-up by opaque agentRef. The caller must deliberately choose the target agentRef; Codexless has no implicit "most recent agent" routing. Local metered consent mode is ${meteredConsent.mode}; when set to always, every unapproved logical send returns consent_required and quota context without starting a turn. requestId is a caller-stable idempotency key and MUST be reused if the same send is retried after an uncertain response. A returned consentRef identifies the prepared follow-up but is never proof of approval: replaying it through this public tool cannot start Codex work. Approval normally occurs through the Rich Task Card; when the Host cannot render that UI, codex.agent_card_render returns a Portable Card and an explicit user Yes/No may be bound to that exact prepared follow-up through codex.agent_commit / codex.agent_decline. model is optional and may override the model for this turn and subsequent turns. reasoningEffort is an optional per-turn override validated against the current codex.model_list entry for the effective model. Active turns, stale parent turns, and pending approvals fail visibly; Codexless never auto-replays an accepted or uncertain send.`,
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        message: z.string().min(1).max(200_000),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key. Reuse this exact value for retries of the same logical send."),
        model: z.string().min(1).max(512).optional()
          .describe("Optional exact model id from codex.model_list. Omit to keep the current Codex thread model."),
        reasoningEffort: z.string().min(1).max(128).optional()
          .describe("Optional per-turn reasoning effort supported by the effective model's current codex.model_list entry. Runtime validation is per-model; no global effort enum is hard-coded."),
        consentRef: z.string().min(1).max(512).optional()
          .describe("Legacy compatibility field. It identifies an already prepared follow-up only; supplying or replaying it never authorizes metered Codex work. Approval must occur through the server-side Task Card commit path."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Preparing Codex follow-up…",
        "openai/toolInvocation/invoked": "Codex follow-up ready.",
      },
    },
    async ({ agentRef, message, requestId, model, reasoningEffort, consentRef }) => structuredCard(async () => {
      const requestPayload = {
        message,
        model: model ?? null,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      };
      const prior = await existingRequestState({
        requestId,
        action: "send",
        payload: requestPayload,
        agentRef,
      });
      if (prior) return { ...prior, duplicate: true };
      if (consentRef) throw new Error("consentRef cannot authorize a Codex follow-up through the public agent_send tool; render/approve the prepared Task Card instead");
      if (meteredConsent.mode === "off") {
        const parentCard = cardForAgent(agentRef);
        return dispatchPrepared(directRecord({
          action: "send",
          payload: { ...requestPayload, parentTurnId: null, permissionProfile: parentCard?.permissionProfile ?? null },
          cwd: parentCard?.cwd ?? null,
          permissionProfile: parentCard?.permissionProfile ?? null,
          agentRef,
          requestId,
        }));
      }
      const current = await agentExecutor.show({ agentRef, afterSeq: 0 });
      if (current.status !== "idle" || current.canSend !== true || !current.turnId) {
        throw new Error(`agent ${agentRef} is not ready for a follow-up: ${current.status}`);
      }
      const parentCard = cardForAgent(agentRef);
      const preparedSelection = await resolvePreparedModelSelection({
        requestedModel: model ?? null,
        requestedReasoningEffort: reasoningEffort ?? null,
        currentModel: current.execution?.resolvedModel ?? null,
        currentReasoningEffort: current.execution?.reasoningEffort ?? null,
      });
      const payload = {
        message,
        callerModel: model ?? null,
        ...(reasoningEffort !== undefined ? { callerReasoningEffort: reasoningEffort } : {}),
        model: preparedSelection.selectedModel,
        ...(typeof preparedSelection.selectedReasoningEffort === "string" ? { reasoningEffort: preparedSelection.selectedReasoningEffort } : {}),
        modelSelection: preparedSelection,
        parentTurnId: current.turnId,
        permissionProfile: parentCard?.permissionProfile ?? null,
      };
      const consent = await ledger.authorize({ action: "send", requestId, subjectRef: agentRef, payload });
      if (!consent.authorized) {
        const record = rememberPrepared({
          consent: consent.consent,
          action: "send",
          payload,
          cwd: parentCard?.cwd ?? null,
          permissionProfile: parentCard?.permissionProfile ?? null,
          agentRef,
        });
        if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
        return pendingTaskSnapshot({ record, resolvedExecution: current.execution });
      }
      const record = directRecord({
        action: "send",
        payload,
        cwd: parentCard?.cwd ?? null,
        permissionProfile: parentCard?.permissionProfile ?? null,
        agentRef,
        requestId,
      });
      return dispatchPrepared(record);
    })
  );

  server.registerTool(
    "codex.agent_decline",
    {
      title: "Decline Prepared Metered Codex Task",
      description:
        "Decline exactly one prepared Codex task without starting Codex work. Rich Task Card callers use the opaque consentRef. Portable Card callers use only the exact short taskId carried in structured content, and should call this only after the user explicitly replies No to that displayed Portable Card. After decline the prepared task is terminal and cannot be revived by a cached commit.",
      inputSchema: z.object({
        consentRef: z.string().min(1).max(512).optional(),
        taskId: z.string().regex(/^C-[A-F0-9]{10}$/).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ consentRef, taskId }) => structured(async () => {
      const portableMode = typeof taskId === "string";
      if (portableMode === (typeof consentRef === "string")) {
        throw new Error("provide exactly one of consentRef (Rich Card) or taskId (Portable Card)");
      }
      const record = portableMode ? preparedRecordByPortableTaskId(taskId) : ledger.taskByConsent(consentRef);
      if (!record) throw new Error("unknown or stale prepared metered Codex task");
      return declinePrepared(record);
    })
  );

  server.registerTool(
    "codex.agent_commit",
    {
      title: "Commit Prepared Metered Codex Task",
      description:
        "Commit exactly one previously prepared metered Codex start/send. Rich Task Card callers must supply both consentRef and the separate card-only commitToken. Portable Card callers supply only the exact short taskId carried in structured content, and should call this only after the user explicitly replies Yes to that displayed Portable Card. In either mode Codexless retrieves the bound requestId, prompt/message, cwd, model, subject and authority from server memory; callers cannot replace them at commit time. Repeated exact commits never create a second logical turn.",
      inputSchema: z.object({
        consentRef: z.string().min(1).max(512).optional(),
        commitToken: z.string().min(1).max(512).optional()
          .describe("Rich-Task-Card-only capability token delivered outside model-visible structured content. It must match the exact prepared task."),
        taskId: z.string().regex(/^C-[A-F0-9]{10}$/).optional()
          .describe("Exact short task ID from the Portable Card structured content. Use only after an explicit user Yes for that displayed task."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ consentRef, commitToken, taskId }) => structured(async () => {
      const portableMode = typeof taskId === "string";
      if (portableMode) {
        if (consentRef || commitToken) throw new Error("Portable Card commit accepts only taskId");
        return approvePrepared(preparedRecordByPortableTaskId(taskId));
      }
      if (!consentRef || !commitToken) {
        throw new Error("Rich Task Card commit requires both consentRef and commitToken");
      }
      const record = ledger.taskByConsent(consentRef);
      if (!record) throw new Error("unknown or stale prepared metered consentRef");
      if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
      if (record.declinedAt) return { ...structuredClone(record.terminalSnapshot ?? lostRecord(record)), duplicate: true };
      if (!record.commitToken || commitToken !== record.commitToken) {
        throw new Error("Codex Task Card commit capability is missing or does not match this prepared task");
      }
      return approvePrepared(record);
    })
  );

  server.registerTool(
    "codex.agent_approve",
    {
      title: "Approve Pending Codex Agent Action",
      description:
        "Experimental Preview. Resolve exactly the currently pending Codex approval identified by approvalRequestId using the narrow one-turn approval response defined by Codex. Call only after the user explicitly approves that exact pending request. requestId is a caller-stable idempotency key and must be reused for retries of the same logical approval. Codexless never grants permissions beyond the permission subset requested by Codex.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        approvalRequestId: z.string().min(1).max(512)
          .describe("Exact pendingApproval.requestId from codex.agent_show/start/send."),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key for this logical approval."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ agentRef, approvalRequestId, requestId }) => structured(async () => {
      const snapshot = await agentExecutor.resolveApproval({
        agentRef,
        approvalRequestId,
        clientRequestId: requestId,
        decision: "approve",
      });
      return publicAgentSnapshot(snapshot, cardForAgent(snapshot?.agentRef));
    })
  );

  server.registerTool(
    "codex.agent_reject",
    {
      title: "Reject Pending Codex Agent Action",
      description:
        "Experimental Preview. Reject exactly the currently pending Codex approval identified by approvalRequestId without widening permissions. Command/file approvals use Codex's decline response; permission requests grant an empty permission subset for the current turn. requestId is a caller-stable idempotency key and must be reused for retries of the same logical rejection.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        approvalRequestId: z.string().min(1).max(512)
          .describe("Exact pendingApproval.requestId from codex.agent_show/start/send."),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key for this logical rejection."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ agentRef, approvalRequestId, requestId }) => structured(async () => {
      const snapshot = await agentExecutor.resolveApproval({
        agentRef,
        approvalRequestId,
        clientRequestId: requestId,
        decision: "reject",
      });
      return publicAgentSnapshot(snapshot, cardForAgent(snapshot?.agentRef));
    })
  );

  server.registerTool(
    "codex.agent_cancel",
    {
      title: "Cancel Active Codex Agent Turn",
      description:
        "Experimental Preview. Interrupt the currently active formal Codex turn through official turn/interrupt. This does not delete the thread or replay work. requestId is a caller-stable idempotency key and must be reused for retries of the same logical cancel.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        expectedTurnId: z.string().min(1).max(512).optional()
          .describe("Optional task-bound turn id. When supplied, cancel fails closed if the agent has advanced to another turn."),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key for this logical cancel."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ agentRef, expectedTurnId, requestId }) => structured(async () => {
      const snapshot = await agentExecutor.cancel({ agentRef, expectedTurnId: expectedTurnId ?? null, clientRequestId: requestId });
      return publicAgentSnapshot(snapshot, cardForAgent(snapshot?.agentRef));
    })
  );
}

async function structuredCard(task, extraMeta = null, contentProjector = null) {
  try {
    const payload = await task();
    const projectedMeta = typeof extraMeta === "function" ? await extraMeta(payload) : extraMeta;
    const projectedText = typeof contentProjector === "function" ? await contentProjector(payload) : contentProjector;
    return {
      content: [{ type: "text", text: typeof projectedText === "string" && projectedText ? projectedText : JSON.stringify(payload) }],
      structuredContent: payload,
      _meta: { toolwireAgentState: payload, ...(projectedMeta && typeof projectedMeta === "object" ? projectedMeta : {}) },
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      _meta: { toolwireAgentState: payload },
      isError: true,
    };
  }
}

async function structured(task) {
  try {
    const payload = await task();
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
