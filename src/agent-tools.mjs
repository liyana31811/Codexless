import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
const AGENT_REF = z.string().min(1).max(512);
const APPROVAL_REQUEST_ID = z.string().min(1).max(512).describe("Exact pendingApproval.requestId from codex.agent_show/start/send.");
import { AGENT_TASK_CARD_URI, registerAgentTaskCardResource } from "./agent-card-ui.mjs";
import {
  createAgentTaskLedger,
  DEFAULT_TASK_STORE_MAX_ENTRIES,
  DEFAULT_TASK_STORE_TTL_MS,
  portableShortTaskId,
} from "./agent-task-ledger.mjs";
import { integerOrNull } from "./agent-resource.mjs";
import { collectModelCatalog, projectExecution, stringOrNull } from "./codex-agent-executor.mjs";

const EVENT_KEYS = new Set(["seq", "type", "at", "turnId", "status", "requestId"]);
const PENDING_APPROVAL_KEYS = new Set(["requestId", "method", "itemId", "receivedAt", "reason", "details"]);
const TERMINAL_STATUSES = new Set(["idle", "completed", "failed", "interrupted", "rejected", "lost"]);
const TERMINAL_LABELS = { failed: "FAILED", interrupted: "STOPPED", rejected: "REJECTED", lost: "UNCERTAIN" };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATING = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

function compactModelOption(entry) {
  const model = typeof entry?.model === "string" && entry.model ? entry.model : typeof entry?.id === "string" && entry.id ? entry.id : null;
  if (!model) return null;
  return {
    model,
    displayName: typeof entry?.displayName === "string" && entry.displayName ? entry.displayName : null,
    isDefault: entry?.isDefault === true,
    defaultReasoningEffort: typeof entry?.defaultReasoningEffort === "string" && entry.defaultReasoningEffort ? entry.defaultReasoningEffort : null,
    supportedReasoningEfforts: Array.isArray(entry?.supportedReasoningEfforts) ? entry.supportedReasoningEfforts.map((option) => typeof option === "string" ? option : typeof option?.reasoningEffort === "string" ? option.reasoningEffort : null).filter(Boolean) : [],
  };
}

function resolveReasoningSelection({ entry, requested = null, current = null, preserveCurrent = false } = {}) {
  const option = compactModelOption(entry);
  const model = option?.model ?? null;
  const supported = option?.supportedReasoningEfforts ?? [];
  let effort = typeof requested === "string" && requested.trim() ? requested.trim() : null;
  let source = effort ? "explicit" : null;
  if (!effort && preserveCurrent && model && current && supported.includes(current)) [effort, source] = [current, "current"];
  if (!effort && entry?.defaultReasoningEffort) [effort, source] = [entry.defaultReasoningEffort, "default"];
  if (source === "explicit" && !supported.includes(effort)) throw new Error(`reasoningEffort validation failed for model "${model}": requested effort "${effort}"; supported efforts: ${supported.length ? supported.join(", ") : "(none)"}`);
  if (source === "default" && supported.length && !supported.includes(effort)) throw new Error(`codex.model_list returned default reasoning effort "${effort}" outside the supported efforts for model "${model}"`);
  return { effort, source, supportedReasoningEfforts: supported };
}

function selectedPayload(payload, model, reasoningEffort, selection) {
  if (!selection) return payload;
  return {
    ...payload,
    callerModel: model ?? null,
    ...(reasoningEffort !== undefined ? { callerReasoningEffort: reasoningEffort } : {}),
    model: selection.selectedModel,
    ...(stringOrNull(selection.selectedReasoningEffort) !== null ? { reasoningEffort: selection.selectedReasoningEffort } : {}),
    modelSelection: selection,
  };
}

function controlInputSchema(kind) {
  const requestId = z.string().min(1).max(512).describe(`Stable caller-generated idempotency key for this logical ${kind}.`);
  if (kind === "cancel") return z.object({
    agentRef: AGENT_REF,
    expectedTurnId: z.string().min(1).max(512).optional().describe("Optional task-bound turn id. When supplied, cancel fails closed if the agent has advanced to another turn."),
    requestId,
  }).strict();
  return z.object({ agentRef: AGENT_REF, approvalRequestId: APPROVAL_REQUEST_ID, requestId }).strict();
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
        limitKey: stringOrNull(limit?.key),
        limitName: stringOrNull(limit?.limitName),
        kind: stringOrNull(window?.kind),
        remainingPercent: integerOrNull(window?.remainingPercent),
        resetsAt: integerOrNull(window?.resetsAt),
        windowDurationMins: integerOrNull(window?.windowDurationMins),
      });
    }
  }
  return windows;
}

function compactOneLine(value, max = 320) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, Math.max(1, max - 3)) + "..." : clean;
}

function quotaWindowText(window, index, locale = null) {
  const mins = window?.windowDurationMins;
  const duration = !Number.isInteger(mins) || mins <= 0 ? null
    : mins % 1_440 === 0 ? `${mins / 1_440}d`
      : mins % 60 === 0 ? `${mins / 60}h`
        : `${mins}m`;
  const rawName = window?.limitName;
  const namedLimit = rawName && rawName.toLowerCase() !== "codex"
    ? rawName
    : (window?.limitKey && window.limitKey !== "codex" ? window.limitKey : null);
  const label = namedLimit && duration ? `${namedLimit} · ${duration}` : namedLimit || duration || window?.kind || `window ${index + 1}`;
  if (!locale) {
    const remaining = Number.isInteger(window?.remainingPercent) ? `${window.remainingPercent}% left` : "remaining unknown";
    const reset = Number.isInteger(window?.resetsAt) ? ` · reset ${new Date(window.resetsAt * 1000).toISOString()}` : "";
    return `${label}: ${remaining}${reset}`;
  }
  const strings = portableStrings(locale);
  const remaining = Number.isInteger(window?.remainingPercent) ? `${window.remainingPercent}% ${strings.left}` : strings.unavailable;
  let reset = "";
  if (Number.isInteger(window?.resetsAt)) {
    try {
      reset = new Intl.DateTimeFormat(locale || undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(window.resetsAt * 1000));
    } catch {
      reset = new Date(window.resetsAt * 1000).toLocaleString();
    }
  }
  return `${label}：${remaining} · ${strings.reset} ${reset || strings.unavailable}`;
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

function portableQuotaGroup(label, quota, locale = portableLocale()) {
  const strings = portableStrings(locale);
  const windows = quotaWindows(quota);
  return [label, ...(windows.length ? windows.map((window, index) => quotaWindowText(window, index, locale)) : [strings.unavailable])];
}

function portableTaskCard({ taskId, status, task, choices, lines, windows, beforeQuota, afterQuota, selection, consent = false }) {
  const card = {
    kind: "portable_card", portable: true, taskId, status, task, choices,
    requiresTaskCard: false, nextAction: "codex.agent_card_render",
    quota: beforeQuota === null && afterQuota === null ? { windows } : { windows, before: { windows: quotaWindows(beforeQuota) }, after: { windows: quotaWindows(afterQuota) } },
    lines, text: lines.join("\n"),
  };
  if (selection) card.modelSelection = structuredClone(selection);
  if (consent) {
    card.rebind = {
      mode: "natural_language_reprepare", requiresNewRequestId: true,
      instruction: "If the user changes model or reasoning effort before approval, do not commit this task. Prepare the same logical task again with the requested selection and a fresh requestId, present the new confirmation, and bind Yes only to the newly presented taskId.",
    };
    card.decision = { approveTool: "codex.agent_commit", declineTool: "codex.agent_decline", taskId };
  }
  return card;
}

function manualFallback(payload) {
  const status = payload?.status ?? "unknown";
  const locale = portableLocale();
  const strings = portableStrings(locale);
  const beforeQuota = payload?.meteredConsent?.quota ?? payload?.taskCard?.quota ?? null;
  const afterQuota = payload?.resourceReceipt?.accountQuota ?? null;
  const windows = quotaWindows(beforeQuota ?? afterQuota);
  const taskRef = payload?.taskRef ?? payload?.taskId ?? payload?.taskCard?.taskRef ?? null;
  const task = compactOneLine(payload?.taskCard?.summary ?? "Codex task");
  const selection = payload?.taskCard?.modelSelection && typeof payload.taskCard.modelSelection === "object" ? payload.taskCard.modelSelection : null;
  const selectedModelOption = selection?.models?.find((option) => option?.model === selection?.selectedModel) ?? null;
  const requestedModel = payload?.execution?.requestedModel ?? payload?.taskCard?.requestedModel ?? selection?.selectedModel ?? null;
  const resolvedModel = payload?.execution?.resolvedModel ?? null;
  const requestedEffort = payload?.execution?.requestedReasoningEffort ?? payload?.taskCard?.requestedReasoningEffort ?? selection?.selectedReasoningEffort ?? null;
  const resolvedEffort = payload?.execution?.reasoningEffort ?? null;
  const approvalText = payload?.pendingApproval ? compactOneLine(payload.pendingApproval.reason ?? payload.pendingApproval.details?.reason ?? payload.pendingApproval.details?.command ?? payload.pendingApproval.details?.path ?? payload.pendingApproval.details?.changes?.[0]?.path ?? payload.pendingApproval.method ?? "Approval required") : "Approval required";

  if (status === "consent_required") {
    if (!taskRef) return null;
    const taskId = portableShortTaskId(taskRef);
    const model = selection?.selectedModel
      ? ((selectedModelOption?.displayName && selectedModelOption.displayName !== selectedModelOption.model) ? selectedModelOption.displayName : selectedModelOption?.model) ?? selection.selectedModelDisplayName ?? selection.selectedModel
      : requestedModel ? compactOneLine(requestedModel) : null;
    const effort = selection?.selectedReasoningEffort ?? requestedEffort;
    const lines = [strings.call, "", `${strings.task}：${task}`];
    lines.push(`${strings.model}：${model ?? strings.unavailable}`, `${strings.reasoning}：${effort ?? strings.unavailable}`, "", ...portableQuotaGroup(strings.quota, beforeQuota, locale), "", strings.reply);
    return portableTaskCard({ taskId, status: "AWAITING DECISION", task, choices: ["Yes", "No"], lines, windows, beforeQuota, afterQuota, selection, consent: true });
  }

  if (taskRef) {
    const taskId = portableShortTaskId(taskRef);
    const model = resolvedModel ?? requestedModel ?? null;
    const effort = resolvedEffort ?? requestedEffort ?? null;
    const portableStatus = status === "awaitingApproval" ? "CODEX APPROVAL REQUIRED" : status === "running" ? "RUNNING" : TERMINAL_STATUSES.has(status) ? TERMINAL_LABELS[status] ?? "DONE" : String(status).toUpperCase();
    const lines = [`Codex · ${portableStatus}`, `${strings.task}：${task}`];
    if (model) lines.push(`${strings.model}：${model}`);
    if (effort) lines.push(`${strings.reasoning}：${effort}`);
    if (status === "awaitingApproval" && payload?.pendingApproval) lines.push(`Pending Codex approval: ${approvalText}`);
    if (TERMINAL_STATUSES.has(status)) {
      const detail = compactOneLine(payload?.finalResult ?? payload?.latestError ?? "", 500);
      const turnTokens = payload?.resourceReceipt?.tokenUsage?.turn?.totalTokens ?? null;
      if (detail) lines.push(`Result: ${detail}`);
      lines.push(Number.isInteger(turnTokens) ? `Usage: ${turnTokens.toLocaleString("en-US")} tokens this turn` : "Usage: tokens unavailable");
      if (beforeQuota) lines.push("", ...portableQuotaGroup(`${strings.quota} · before`, beforeQuota, locale));
      if (afterQuota) lines.push("", ...portableQuotaGroup(`${strings.quota} · after`, afterQuota, locale));
      if (!beforeQuota && !afterQuota) lines.push("", strings.quota, strings.unavailable);
    } else if (beforeQuota) lines.push("", ...portableQuotaGroup(strings.quota, beforeQuota, locale));
    return portableTaskCard({ taskId, status: portableStatus, task, choices: [], lines, windows, beforeQuota, afterQuota, selection });
  }

  return null;
}

function publicAgentSnapshot(snapshot, taskCard = null, extra = null) {
  const payload = {
    agentRef: snapshot?.agentRef ?? null,
    turnId: snapshot?.turnId ?? null,
    status: snapshot?.status ?? "unknown",
    canSend: snapshot?.canSend === true,
    pendingApproval: publicPendingApproval(snapshot?.pendingApproval),
    finalResult: snapshot?.finalResult ?? null,
    resourceReceipt: snapshot?.resourceReceipt ?? null,
    timing: snapshot?.timing ?? { startedAt: null, endedAt: null, durationMs: null },
    execution: snapshot?.execution ?? projectExecution(),
    latestError: snapshot?.latestError ?? null,
    events: Array.isArray(snapshot?.events) ? snapshot.events.map((event) => !event || typeof event !== "object" ? null : Object.fromEntries(Object.entries(event).filter(([key]) => EVENT_KEYS.has(key)))).filter(Boolean) : [],
    nextSeq: integerOrNull(snapshot?.nextSeq) ?? 0,
  };
  if (taskCard) payload.taskCard = taskCard;
  if (extra) Object.assign(payload, extra);
  if (typeof snapshot?.duplicate === "boolean") payload.duplicate = snapshot.duplicate;
  if (typeof snapshot?.controlAcceptance === "string") payload.controlAcceptance = snapshot.controlAcceptance;
  const fallback = manualFallback(payload);
  if (fallback) payload.manualFallback = fallback;
  return payload;
}

function pendingTaskSnapshot({ record, resolvedExecution = null }) {
  return publicAgentSnapshot({
    agentRef: record.agentRef,
    status: "consent_required",
    timing: { startedAt: null, endedAt: null, durationMs: null },
    execution: projectExecution({
      requestedModel: stringOrNull(record.payload?.model),
      requestedReasoningEffort: stringOrNull(record.payload?.reasoningEffort),
      ...resolvedExecution,
    }),
  }, record.taskCard, {
    meteredConsent: record.consent,
    taskRef: record.taskRef,
    taskId: record.taskRef,
  });
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
  const meteredConsent = Object.freeze({ get mode() { return ledger.mode; } });
  return { ledger, meteredConsent };
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
  const inFlightDispatches = new Map();
  registerAgentTaskCardResource(server);

  async function fullModelCatalog() {
    const raw = await collectModelCatalog((params) => agentExecutor.listModels(params), {
      maxPages: 20,
      repeatedCursorMessage: "codex.model_list returned a repeated cursor while preparing the Codex confirmation",
      limitMessage: "codex.model_list exceeded the bounded pagination limit while preparing the Codex confirmation",
    });
    return raw.map(compactModelOption).filter((option, index, all) => option && all.findIndex((entry) => entry?.model === option.model) === index);
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
    const selection = resolveReasoningSelection({
      entry,
      requested: requestedReasoningEffort,
      current: currentReasoningEffort,
      preserveCurrent: current === entry.model,
    });
    const { effort, supportedReasoningEfforts: supported } = selection;
    return {
      source: "codex.model_list",
      selectedModel: entry.model,
      selectedModelDisplayName: entry.displayName,
      modelSelectionSource: requested ? "explicit" : current === entry.model ? "current" : "default",
      selectedReasoningEffort: effort,
      reasoningEffortSelectionSource: selection.source ?? "unavailable",
      supportedReasoningEfforts: supported,
      models,
    };
  }

  async function prepareTask({ action, requestId, payload, lookupPayload = payload, cwd = null, permissionProfile = null, agentRef = null, resolvedExecution = null }) {
    const existing = ledger.findRecord({ requestId, action, subjectRef: agentRef, payload: lookupPayload });
    const prior = existing ? (!existing.payload && !existing.terminalSnapshot ? ledger.recover(existing.taskRef) : await preparedCardState(existing)) : null;
    if (prior) return { ...prior, duplicate: true };
    const consent = await ledger.authorize({ action, requestId, subjectRef: agentRef, payload });
    if (!consent.authorized) {
      const record = ledger.createTask({ consent: consent.consent, action, payload, cwd, permissionProfile, agentRef, authorized: false });
      if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
      return pendingTaskSnapshot({ record, resolvedExecution });
    }
    return dispatchPrepared(ledger.createTask({ action, payload, cwd, permissionProfile, agentRef, requestId, authorized: true }));
  }

  async function resolveApprovalDecision(agentRef, approvalRequestId, requestId, decision) {
    const snapshot = await agentExecutor.resolveApproval({ agentRef, approvalRequestId, clientRequestId: requestId, decision });
    return publicAgentSnapshot(snapshot, ledger.taskForAgent(snapshot?.agentRef)?.taskCard ?? null);
  }

  function publicTaskSnapshot(record, snapshot) {
    return {
      ...publicAgentSnapshot(snapshot, record.taskCard),
      taskRef: record.taskRef,
      taskId: record.taskRef,
      meteredConsent: { status: "approved", quota: record.consent?.quota ?? record.taskCard?.quota ?? null },
    };
  }

  async function preparedCardState(record) {
    if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
    if (!record.payload) return ledger.recover(record.taskRef);
    if (!record.authorized) return pendingTaskSnapshot({ record });
    if (!record.agentRef) throw new Error("prepared Codex task is authorized but its agentRef is not available yet");
    const snapshot = await agentExecutor.show({ agentRef: record.agentRef, afterSeq: 0 });
    if (record.turnId && snapshot.turnId !== record.turnId) return ledger.freeze(record, ledger.terminalTaskPayload(record, "lost"));
    record.turnId ||= snapshot.turnId ?? null;
    const payload = publicTaskSnapshot(record, snapshot);
    return TERMINAL_STATUSES.has(payload.status) ? ledger.freeze(record, payload) : payload;
  }

  async function dispatchPrepared(record, commit = false) {
    const prior = inFlightDispatches.get(record?.taskRef);
    if (prior) {
      const result = await prior;
      return { ...structuredClone(result), duplicate: true };
    }
    const operation = (async () => {
      const startAction = record.action === "start";
      let current = null;
      if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
      if (commit && record.authorized && record.consent?.consentRef) return { ...(await preparedCardState(record)), duplicate: true };
      if (startAction) {
        const currentAuthority = await authorityExecutor.resolveAuthority({ cwd: record.taskCard.cwd, access: "inherit" });
        if (currentAuthority.effectiveCwd !== record.taskCard.cwd || currentAuthority.permissionProfile !== record.taskCard.permissionProfile) throw new Error("prepared Codex task authority changed; prepare and approve a new task card");
      } else {
        current = await agentExecutor.show({ agentRef: record.agentRef, afterSeq: 0 });
        if (record.payload?.parentTurnId && (current.turnId !== record.payload.parentTurnId || current.status !== "idle" || current.canSend !== true)) throw new Error("prepared Codex follow-up is stale because the agent advanced; prepare a new task card for the current turn");
      }
      if (commit) {
        const approval = ledger.commitTask(record, {
          action: record.action,
          requestId: record.consent.requestId,
          subjectRef: startAction ? null : record.agentRef,
          payload: record.payload,
          consentRef: record.consent.consentRef,
        });
        if (approval.duplicate && record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
      }
      if (!record.authorized) throw new Error("Codex task is still pending user approval; dispatch is blocked until the prepared task is explicitly committed");
      ledger.persist(record, "active");
      if (!startAction && TERMINAL_STATUSES.has(current?.status)) {
        const prior = ledger.taskForAgent(record.agentRef);
        if (prior && !prior.terminalSnapshot) {
          if (!prior.turnId) prior.turnId = current.turnId ?? null;
          if (prior.turnId === current.turnId) ledger.freeze(prior, publicTaskSnapshot(prior, current));
        }
      }
      let snapshot;
      try {
        const dispatch = {
          clientRequestId: record.consent.requestId,
          model: record.payload.model ?? null,
          reasoningEffort: record.payload.reasoningEffort ?? null,
          ...(startAction
            ? { cwd: record.taskCard.cwd, task: record.payload.prompt, permissionProfile: record.taskCard.permissionProfile }
            : { agentRef: record.agentRef, message: record.payload.message }),
        };
        snapshot = await agentExecutor[startAction ? "start" : "send"](dispatch);
      } catch (error) {
        return ledger.freeze(record, ledger.terminalTaskPayload(record, "failed", error));
      }
      if (startAction && snapshot?.agentRef) ledger.bindAgent(record, snapshot.agentRef, snapshot.turnId ?? null);
      if (!startAction) ledger.bindAgent(record, record.agentRef, snapshot.turnId ?? null);
      const payload = publicTaskSnapshot(record, snapshot);
      if (TERMINAL_STATUSES.has(payload.status)) return ledger.freeze(record, payload);
      ledger.persist(record, "active", payload);
      return payload;
    })();
    inFlightDispatches.set(record.taskRef, operation);
    return operation.finally(() => {
      if (inFlightDispatches.get(record.taskRef) === operation) inFlightDispatches.delete(record.taskRef);
    });
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
      annotations: READ_ONLY,
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
      annotations: MUTATING,
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
      if (consentRef) throw new Error("consentRef cannot authorize a Codex start through the public agent_start tool; render/approve the prepared Task Card instead");
      const preparedSelection = meteredConsent.mode === "always"
        ? await resolvePreparedModelSelection({ requestedModel: model ?? null, requestedReasoningEffort: reasoningEffort ?? null })
        : null;
      const payload = selectedPayload(callerPayload, model, reasoningEffort, preparedSelection);
      return prepareTask({
        action: "start",
        requestId,
        payload,
        lookupPayload: callerPayload,
        cwd: authority.effectiveCwd,
        permissionProfile: authority.permissionProfile,
      });
    })
  );

  server.registerTool(
    "codex.agent_card_render",
    {
      title: "Render Prepared Codex Task Card",
      description:
        "Read-only render step for a prepared metered Codex start/send. Call this only after codex.agent_start or codex.agent_send returns consent_required. It does not start or continue Codex work; it re-reads the server-bound prepared record. Rich-UI Hosts can mount the Codex Task Card from outputTemplate; Hosts that cannot render that UI still receive the same confirmation as a framed Portable Card in ordinary MCP text content. Rich Card buttons use the card capability path; Portable Card Yes/No decisions bind the exact prepared task through codex.agent_commit / codex.agent_decline.",
      inputSchema: z.object({ consentRef: z.string().min(1).max(512) }).strict(),
      annotations: READ_ONLY,
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
      annotations: READ_ONLY,
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
        agentRef: AGENT_REF,
        afterSeq: z.number().int().min(0).optional(),
      }).strict(),
      annotations: READ_ONLY,
    },
    async ({ agentRef, afterSeq }) => structured(async () => {
      const snapshot = await agentExecutor.show({ agentRef, afterSeq: afterSeq ?? 0 });
      return publicAgentSnapshot(snapshot, ledger.taskForAgent(agentRef)?.taskCard ?? null);
    })
  );

  server.registerTool(
    "codex.agent_send",
    {
      title: "Continue Codex Agent",
      description:
        `Experimental Preview. Prepare one exact Codexless-owned Codex agent follow-up by opaque agentRef. The caller must deliberately choose the target agentRef; Codexless has no implicit "most recent agent" routing. Local metered consent mode is ${meteredConsent.mode}; when set to always, every unapproved logical send returns consent_required and quota context without starting a turn. requestId is a caller-stable idempotency key and MUST be reused if the same send is retried after an uncertain response. A returned consentRef identifies the prepared follow-up but is never proof of approval: replaying it through this public tool cannot start Codex work. Approval normally occurs through the Rich Task Card; when the Host cannot render that UI, codex.agent_card_render returns a Portable Card and an explicit user Yes/No may be bound to that exact prepared follow-up through codex.agent_commit / codex.agent_decline. model is optional and may override the model for this turn and subsequent turns. reasoningEffort is an optional per-turn override validated against the current codex.model_list entry for the effective model. Active turns, stale parent turns, and pending approvals fail visibly; Codexless never auto-replays an accepted or uncertain send.`,
      inputSchema: z.object({
        agentRef: AGENT_REF,
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
      annotations: MUTATING,
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
      if (consentRef) throw new Error("consentRef cannot authorize a Codex follow-up through the public agent_send tool; render/approve the prepared Task Card instead");
      if (meteredConsent.mode === "off") {
        const parentCard = ledger.taskForAgent(agentRef)?.taskCard ?? null;
        return prepareTask({
          action: "send",
          requestId,
          payload: { ...requestPayload, parentTurnId: null, permissionProfile: parentCard?.permissionProfile ?? null },
          lookupPayload: requestPayload,
          cwd: parentCard?.cwd ?? null,
          permissionProfile: parentCard?.permissionProfile ?? null,
          agentRef,
        });
      }
      const current = await agentExecutor.show({ agentRef, afterSeq: 0 });
      if (current.status !== "idle" || current.canSend !== true || !current.turnId) {
        throw new Error(`agent ${agentRef} is not ready for a follow-up: ${current.status}`);
      }
      const parentCard = ledger.taskForAgent(agentRef)?.taskCard ?? null;
      const preparedSelection = await resolvePreparedModelSelection({
        requestedModel: model ?? null,
        requestedReasoningEffort: reasoningEffort ?? null,
        currentModel: current.execution?.resolvedModel ?? null,
        currentReasoningEffort: current.execution?.reasoningEffort ?? null,
      });
      const payload = selectedPayload({
        message,
        parentTurnId: current.turnId,
        permissionProfile: parentCard?.permissionProfile ?? null,
      }, model, reasoningEffort, preparedSelection);
      return prepareTask({
        action: "send",
        requestId,
        payload,
        lookupPayload: requestPayload,
        cwd: parentCard?.cwd ?? null,
        permissionProfile: parentCard?.permissionProfile ?? null,
        agentRef,
        resolvedExecution: current.execution,
      });
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
      annotations: { ...MUTATING, destructiveHint: false, openWorldHint: false },
    },
    async ({ consentRef, taskId }) => structured(async () => {
      const portableMode = typeof taskId === "string";
      if (portableMode === (typeof consentRef === "string")) {
        throw new Error("provide exactly one of consentRef (Rich Card) or taskId (Portable Card)");
      }
      const record = portableMode ? ledger.taskByPortable(taskId) : ledger.taskByConsent(consentRef);
      if (!record) throw new Error("unknown or stale prepared metered Codex task");
      return ledger.decline(record);
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
      annotations: MUTATING,
    },
    async ({ consentRef, commitToken, taskId }) => structured(async () => {
      const portableMode = typeof taskId === "string";
      if (portableMode) {
        if (consentRef || commitToken) throw new Error("Portable Card commit accepts only taskId");
        return dispatchPrepared(ledger.taskByPortable(taskId), true);
      }
      if (!consentRef || !commitToken) {
        throw new Error("Rich Task Card commit requires both consentRef and commitToken");
      }
      const record = ledger.taskByConsent(consentRef);
      if (!record) throw new Error("unknown or stale prepared metered consentRef");
      if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
      if (!record.commitToken || commitToken !== record.commitToken) {
        throw new Error("Codex Task Card commit capability is missing or does not match this prepared task");
      }
      return dispatchPrepared(record, true);
    })
  );

  server.registerTool(
    "codex.agent_approve",
    {
      title: "Approve Pending Codex Agent Action",
      description:
        "Experimental Preview. Resolve exactly the currently pending Codex approval identified by approvalRequestId using the narrow one-turn approval response defined by Codex. Call only after the user explicitly approves that exact pending request. requestId is a caller-stable idempotency key and must be reused for retries of the same logical approval. Codexless never grants permissions beyond the permission subset requested by Codex.",
      inputSchema: controlInputSchema("approval"),
      annotations: MUTATING,
    },
    async ({ agentRef, approvalRequestId, requestId }) => structured(() => resolveApprovalDecision(agentRef, approvalRequestId, requestId, "approve"))
  );

  server.registerTool(
    "codex.agent_reject",
    {
      title: "Reject Pending Codex Agent Action",
      description:
        "Experimental Preview. Reject exactly the currently pending Codex approval identified by approvalRequestId without widening permissions. Command/file approvals use Codex's decline response; permission requests grant an empty permission subset for the current turn. requestId is a caller-stable idempotency key and must be reused for retries of the same logical rejection.",
      inputSchema: controlInputSchema("rejection"),
      annotations: MUTATING,
    },
    async ({ agentRef, approvalRequestId, requestId }) => structured(() => resolveApprovalDecision(agentRef, approvalRequestId, requestId, "reject"))
  );

  server.registerTool(
    "codex.agent_cancel",
    {
      title: "Cancel Active Codex Agent Turn",
      description:
        "Experimental Preview. Interrupt the currently active formal Codex turn through official turn/interrupt. This does not delete the thread or replay work. requestId is a caller-stable idempotency key and must be reused for retries of the same logical cancel.",
      inputSchema: controlInputSchema("cancel"),
      annotations: MUTATING,
    },
    async ({ agentRef, expectedTurnId, requestId }) => structured(async () => {
      const snapshot = await agentExecutor.cancel({ agentRef, expectedTurnId: expectedTurnId ?? null, clientRequestId: requestId });
      return publicAgentSnapshot(snapshot, ledger.taskForAgent(snapshot?.agentRef)?.taskCard ?? null);
    })
  );
}

function wireResponse(payload, { text = null, meta = null } = {}) {
  return {
    content: [{ type: "text", text: typeof text === "string" && text ? text : JSON.stringify(payload) }],
    structuredContent: payload,
    ...(meta ? { _meta: meta } : {}),
    isError: false,
  };
}

async function structured(task, { card = false, extraMeta = null, contentProjector = null } = {}) {
  try {
    const payload = await task();
    const projectedMeta = typeof extraMeta === "function" ? await extraMeta(payload) : extraMeta;
    const projectedText = typeof contentProjector === "function" ? await contentProjector(payload) : contentProjector;
    return wireResponse(payload, card ? {
      text: projectedText,
      meta: { toolwireAgentState: payload, ...(projectedMeta && typeof projectedMeta === "object" ? projectedMeta : {}) },
    } : {});
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    const response = wireResponse(payload, card ? { meta: { toolwireAgentState: payload } } : {});
    response.isError = true;
    return response;
  }
}

const structuredCard = (task, extraMeta = null, contentProjector = null) => structured(task, { card: true, extraMeta, contentProjector });
