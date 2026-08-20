export function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

export function unavailableQuotaSnapshot(error = null, includeDefaultError = false) {
  const projected = error
    ? { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) }
    : includeDefaultError ? { name: "Unavailable", message: "resource telemetry provider is not configured" } : null;
  return {
    status: "unavailable",
    observedAt: new Date().toISOString(),
    usage: { status: "unavailable", ...(projected ? { error: projected } : {}) },
    rateLimits: { status: "unavailable", ...(projected ? { error: projected } : {}) },
  };
}

function stringFields(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, typeof value?.[field] === "string" ? value[field] : null]));
}

function normalizeBreakdown(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    inputTokens: integerOrNull(value.inputTokens),
    cachedInputTokens: integerOrNull(value.cachedInputTokens),
    cacheWriteInputTokens: integerOrNull(value.cacheWriteInputTokens),
    outputTokens: integerOrNull(value.outputTokens),
    reasoningOutputTokens: integerOrNull(value.reasoningOutputTokens),
    totalTokens: integerOrNull(value.totalTokens),
  };
}

export function normalizeThreadTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    turn: normalizeBreakdown(value.last),
    threadTotal: normalizeBreakdown(value.total),
    modelContextWindow: integerOrNull(value.modelContextWindow),
  };
}

function projectError(error) {
  if (!error || typeof error !== "object") return null;
  return {
    name: typeof error.name === "string" ? error.name : null,
    message: typeof error.message === "string" ? error.message : String(error),
    rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null,
    rpcMessage: typeof error.rpcMessage === "string" ? error.rpcMessage : null,
  };
}

function projectLimit(limit) {
  const windows = Array.isArray(limit?.windows) ? limit.windows : [];
  return {
    ...stringFields(limit, ["key", "limitId", "limitName", "planType", "rateLimitReachedType"]),
    spendControlReached: typeof limit?.spendControlReached === "boolean" ? limit.spendControlReached : null,
    windows: windows.map((window) => ({
      kind: typeof window?.kind === "string" ? window.kind : null,
      usedPercent: Number.isInteger(window?.usedPercent) ? window.usedPercent : null,
      remainingPercent: Number.isInteger(window?.usedPercent) ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null,
      resetsAt: Number.isInteger(window?.resetsAt) ? window.resetsAt : null,
      windowDurationMins: Number.isInteger(window?.windowDurationMins) ? window.windowDurationMins : null,
    })),
  };
}

export function projectQuotaSnapshot(snapshot) {
  const rateLimits = snapshot?.rateLimits;
  const normalizedLimits = rateLimits?.status === "ok" && Array.isArray(rateLimits?.value?.limits)
    ? rateLimits.value.limits.map(projectLimit)
    : [];
  return {
    status: typeof snapshot?.status === "string" ? snapshot.status : "unavailable",
    observedAt: typeof snapshot?.observedAt === "string" ? snapshot.observedAt : null,
    rateLimits: {
      status: typeof rateLimits?.status === "string" ? rateLimits.status : "unavailable",
      limits: normalizedLimits,
      error: rateLimits?.status === "unavailable" ? projectError(rateLimits.error) : null,
    },
    usageTelemetry: {
      status: typeof snapshot?.usage?.status === "string" ? snapshot.usage.status : "unavailable",
      error: snapshot?.usage?.status === "unavailable" ? projectError(snapshot.usage.error) : null,
    },
  };
}

export function buildAgentResourceReceipt({ turnId, turnStatus, tokenUsage, quotaSnapshot, observedAt = new Date().toISOString() } = {}) {
  return {
    turnId: typeof turnId === "string" ? turnId : null,
    turnStatus: typeof turnStatus === "string" ? turnStatus : null,
    observedAt,
    tokenUsage: normalizeThreadTokenUsage(tokenUsage),
    accountQuota: projectQuotaSnapshot(quotaSnapshot),
    attribution: {
      taskTokenUsage: "Codex turn/thread telemetry for this formal Agent thread when available.",
      accountQuota: "Observed account waterline only; concurrent Codex/agentic work may also affect it.",
    },
  };
}
