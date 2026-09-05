import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
import { MeteredConsentGate } from "./metered-consent.mjs";
import { AGENT_TASK_CARD_URI, registerAgentTaskCardResource } from "./agent-card-ui.mjs";
import {
  bindCodexCallProfileSnapshot,
  DEFAULT_CODEX_CALL_PROFILE_INSTRUCTION,
  defaultCodexCallProfilePath,
  deleteCodexCallProfile,
  loadCodexCallProfile,
  saveCodexCallProfile,
  unconfiguredCodexCallInstruction,
} from "./codex-call-profile.mjs";

const EVENT_KEYS = new Set(["seq", "type", "at", "turnId", "status", "requestId"]);
const PENDING_APPROVAL_KEYS = new Set(["requestId", "method", "itemId", "receivedAt", "reason", "details"]);

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
  // Match the Rich Task Card duration vocabulary so Portable mirrors it
  // exactly (for example a 10080-minute quota window is shown as 7d).
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

const PORTABLE_RUNTIME_BODY_MAX_CHARS = 8_000;

function boundedPortableBody(value, fallback = "") {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  if (clean.length <= PORTABLE_RUNTIME_BODY_MAX_CHARS) return clean;
  const marker = ` … [truncated at ${PORTABLE_RUNTIME_BODY_MAX_CHARS} characters]`;
  return clean.slice(0, Math.max(1, PORTABLE_RUNTIME_BODY_MAX_CHARS - marker.length)) + marker;
}

function pathInside(base, candidate) {
  if (typeof base !== "string" || !base || typeof candidate !== "string" || !candidate) return false;
  try {
    const resolvedBase = path.resolve(base);
    const resolvedCandidate = path.resolve(resolvedBase, candidate);
    const lexicalRelative = path.relative(resolvedBase, resolvedCandidate);
    if (!(lexicalRelative === "" || (!lexicalRelative.startsWith("..") && !path.isAbsolute(lexicalRelative)))) return false;

    const realBase = realpathSync(resolvedBase);
    let existingAncestor = resolvedCandidate;
    while (!existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return false;
      existingAncestor = parent;
    }
    const realAncestor = realpathSync(existingAncestor);
    const realRelative = path.relative(realBase, realAncestor);
    return realRelative === "" || (!realRelative.startsWith("..") && !path.isAbsolute(realRelative));
  } catch {
    return false;
  }
}

function approvalValuePresent(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return true;
  return Boolean(value);
}

function sensitiveApprovalPath(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.config\/gh|credentials?|secrets?)(?:\/|$)/.test(normalized)
    || /(^|\/)\.env(?:\.|$)/.test(normalized)
    || /(?:^|\/)(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/.test(normalized);
}

function commandApprovalRiskReference(details, taskCard) {
  if (!details || typeof details.command !== "string" || !details.command.trim()) {
    return { risk: "unknown", reason: "command_details_unavailable", defaultRecommendation: "ask_user" };
  }
  if (approvalValuePresent(details.networkApprovalContext)) {
    return { risk: "high", reason: "network_access_requested", defaultRecommendation: "ask_user" };
  }
  if (approvalValuePresent(details.additionalPermissions)) {
    return { risk: "high", reason: "additional_permissions_requested", defaultRecommendation: "ask_user" };
  }
  if (details.cwd && !pathInside(taskCard?.cwd, details.cwd)) {
    return { risk: "high", reason: "command_outside_task_directory", defaultRecommendation: "ask_user" };
  }
  const command = details.command.trim();
  const lower = command.toLowerCase();
  if (/[|><;&]/.test(command)) {
    return { risk: "unknown", reason: "compound_or_redirected_command", defaultRecommendation: "ask_user" };
  }
  const dangerous = [
    /\b(?:rm|rmdir|del|erase|remove-item)\b/,
    /\b(?:format|diskpart|shutdown|reboot|restart-computer)\b/,
    /\b(?:taskkill|kill|stop-process)\b/,
    /\b(?:takeown|icacls|chmod|chown|set-acl)\b/,
    /\breg(?:\.exe)?\s+(?:add|delete|import)\b/,
    /\bsc(?:\.exe)?\s+(?:create|delete|stop|config)\b/,
    /\bgit\s+(?:push|clean|commit|merge|rebase|cherry-pick)\b/,
    /\bgit\s+reset\b.*--hard\b/,
    /\bgit\s+(?:checkout|restore)\b.*(?:--|\s\.)/,
    /\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|publish)\b/,
    /\b(?:pip|pip3)\s+install\b/,
    /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|ssh|scp|sftp|ftp)\b/,
    /\bgh\s+(?:pr|issue|release|repo)\b/,
  ];
  if (dangerous.some((pattern) => pattern.test(lower))) {
    return { risk: "high", reason: "command_has_external_or_destructive_side_effect", defaultRecommendation: "ask_user" };
  }
  if (/\bgit\s+(?:diff|grep)\b/.test(lower) && /\b--no-index\b/.test(lower)) {
    return { risk: "unknown", reason: "read_command_can_escape_repository", defaultRecommendation: "ask_user" };
  }
  const lowRisk = [
    /^(?:git\s+(?:status|diff|log|show|rev-parse|grep)\b)/,
    /^(?:git\s+branch\s+--show-current\b)/,
    /^(?:node(?:\.exe)?\s+--check\b)/,
    /^pwd\s*$/,
  ];
  if (lowRisk.some((pattern) => pattern.test(lower))) {
    return { risk: "low", reason: "bounded_read_or_static_check_command", defaultRecommendation: "delegate" };
  }
  return { risk: "unknown", reason: "command_not_proven_low_risk", defaultRecommendation: "ask_user" };
}

function fileChangeApprovalRiskReference(details, taskCard) {
  if (typeof details?.grantRoot === "string" && details.grantRoot.trim()) {
    return { risk: "high", reason: "file_change_requests_new_grant_root", defaultRecommendation: "ask_user" };
  }
  const changes = details?.changes;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 50) {
    return { risk: "unknown", reason: "file_change_details_unavailable_or_too_broad", defaultRecommendation: "ask_user" };
  }
  const allowedKinds = new Set(["add", "create", "update", "modify"]);
  for (const change of changes) {
    const changePath = typeof change?.path === "string" ? change.path : null;
    const kind = typeof change?.kind === "string" ? change.kind.toLowerCase() : "";
    if (!changePath || !pathInside(taskCard?.cwd, changePath)) {
      return { risk: "high", reason: "file_change_outside_task_directory", defaultRecommendation: "ask_user" };
    }
    if (sensitiveApprovalPath(changePath)) {
      return { risk: "high", reason: "file_change_targets_sensitive_path", defaultRecommendation: "ask_user" };
    }
    if (!allowedKinds.has(kind)) {
      return { risk: "high", reason: "file_change_is_destructive_or_structural", defaultRecommendation: "ask_user" };
    }
  }
  return { risk: "low", reason: "bounded_non_destructive_task_file_change", defaultRecommendation: "delegate" };
}

function approvalRiskReference(pendingApproval, taskCard) {
  if (!pendingApproval) return null;
  const kind = pendingApproval?.details?.kind ?? "unknown";
  if (kind === "permissions") {
    return { risk: "high", reason: "permission_expansion_requested", defaultRecommendation: "ask_user" };
  }
  if (kind === "command") return commandApprovalRiskReference(pendingApproval.details, taskCard);
  if (kind === "fileChange") return fileChangeApprovalRiskReference(pendingApproval.details, taskCard);
  return { risk: "unknown", reason: "approval_kind_not_classified", defaultRecommendation: "ask_user" };
}

const IN_TURN_I18N = Object.freeze({
  en: { title: "Codex needs an approval", blocked: "Codex approval blocked", taskId: "Task ID", action: "Requested action", scope: "Scope", why: "Why", risk: "Risk", reply: "Reply Yes to approve or No to reject.", genericWhy: "Codex requires this approval to continue the current task.", missing: "not enough human-readable detail was provided.", unsupported: "This approval type is not supported by the current Codexless approve/reject protocol. No action will be guessed or auto-approved." },
  zh: { title: "Codex 需要确认", blocked: "Codex 审批已阻塞", taskId: "任务 ID", action: "请求动作", scope: "范围", why: "原因", risk: "风险", reply: "请直接回复 Yes / No。", genericWhy: "Codex 需要这项确认才能继续当前任务。", missing: "当前没有足够的人类可读动作信息。", unsupported: "当前 Codexless approve/reject 协议不支持此审批类型；不会猜测或自动批准。" },
  ja: { title: "Codex の確認が必要です", blocked: "Codex 承認はブロックされています", taskId: "タスク ID", action: "要求された操作", scope: "範囲", why: "理由", risk: "リスク", reply: "Yes / No で返信してください。", genericWhy: "Codex が現在のタスクを続行するためにこの確認が必要です。", missing: "人が判断できる操作情報が不足しています。", unsupported: "現在の Codexless approve/reject プロトコルではこの承認種別を扱えません。推測や自動承認は行いません。" },
});

function inTurnStrings(locale) {
  const normalized = String(locale || "en").toLowerCase();
  if (normalized.startsWith("zh")) return IN_TURN_I18N.zh;
  if (normalized.startsWith("ja")) return IN_TURN_I18N.ja;
  return IN_TURN_I18N.en;
}

function inTurnApprovalPresentation(pendingApproval, riskReference, taskCard = null) {
  if (!pendingApproval) return null;
  const labels = inTurnStrings(taskCard?.presentationLocale ?? "en");
  const details = pendingApproval.details ?? {};
  const kind = details.kind ?? "unknown";
  const taskId = taskCard?.shortTaskId ?? taskCard?.taskId ?? taskCard?.taskRef ?? "unavailable";
  let action = null;
  let scope = "Current Codex task";
  if (kind === "command") {
    action = details.command ? `Run command: ${compactOneLine(details.command, 700)}` : "Run a command requested by Codex";
    if (details.cwd) scope = `Working directory: ${compactOneLine(details.cwd, 500)}`;
  } else if (kind === "fileChange") {
    const changes = Array.isArray(details.changes) ? details.changes : [];
    action = changes.length
      ? `Apply file changes: ${compactOneLine(changes.map((change) => `${change?.kind ?? "change"} ${change?.path ?? "unknown path"}`).join("; "), 700)}`
      : "Apply file changes requested by Codex";
    if (changes.length) scope = `Files: ${compactOneLine(changes.map((change) => change?.path ?? "unknown path").join("; "), 500)}`;
  } else if (kind === "permissions") {
    const permissions = compactOneLine(JSON.stringify(details.permissions ?? {}), 700);
    action = `Grant requested permissions: ${permissions}`;
    scope = `Requested permission subset: ${permissions}`;
  } else {
    action = details.humanText ? compactOneLine(details.humanText, 700) : null;
  }

  const why = typeof pendingApproval.reason === "string" && pendingApproval.reason.trim()
    ? compactOneLine(pendingApproval.reason, 700)
    : labels.genericWhy;
  const risk = riskReference?.risk ?? "unknown";
  const supported = new Set([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ]).has(pendingApproval.method);
  if (!action) {
    return {
      kind: "in_turn_approval",
      status: "blocked_unexplained",
      taskId,
      action: null,
      scope,
      why,
      risk,
      choices: [],
      approveSupported: false,
      rejectSupported: false,
      failClosed: true,
      text: `⚠️ **${labels.blocked}**\n${labels.taskId}: ${taskId}\n${labels.action}: ${labels.missing}\n${labels.scope}: ${scope}\n${labels.why}: ${why}\n${labels.risk}: ${risk}`,
    };
  }
  if (!supported) {
    return {
      kind: "in_turn_approval",
      status: "blocked_unsupported",
      taskId,
      action,
      scope,
      why,
      risk,
      choices: [],
      approveSupported: false,
      rejectSupported: false,
      failClosed: true,
      text: `⚠️ **${labels.blocked}**\n${labels.taskId}: ${taskId}\n${labels.action}: ${action}\n${labels.scope}: ${scope}\n${labels.why}: ${why}\n${labels.risk}: ${risk}\n${labels.unsupported}`,
    };
  }
  return {
    kind: "in_turn_approval",
    status: "decision_required",
    taskId,
    action,
    scope,
    why,
    risk,
    choices: ["Yes", "No"],
    approveSupported: true,
    rejectSupported: true,
    failClosed: false,
    text: `⚠️ **${labels.title}**\n${labels.taskId}: ${taskId}\n${labels.action}: ${action}\n${labels.scope}: ${scope}\n${labels.why}: ${why}\n${labels.risk}: ${risk}\n👉 **${labels.reply}**`,
  };
}

function portableShortTaskId(taskRef) {
  const digest = createHash("sha256").update(String(taskRef), "utf8").digest("hex").slice(0, 10).toUpperCase();
  return `C-${digest}`;
}

const PORTABLE_I18N = Object.freeze({
  en: {
    call: "Call Codex?", taskId: "Task ID", task: "Task", why: "Why Codex", model: "Model", reasoning: "Reasoning effort", status: "Status", changes: "Changes", verification: "Verification", remaining: "Remaining / blocker",
    requested: "requested", usage: "Turn usage", quota: "Codex quota", left: "left", reset: "reset", unavailable: "not provided", reply: "Please reply Yes or No.",
  },
  zh: {
    call: "调用 Codex？", taskId: "Task ID", task: "任务", why: "调用理由", model: "模型", reasoning: "推理强度", status: "状态", changes: "变更", verification: "验证", remaining: "剩余 / 阻塞",
    requested: "请求", usage: "本次用量", quota: "Codex 额度", left: "剩余", reset: "重置", unavailable: "当前未提供", reply: "请直接回复 Yes 或 No。",
  },
  ja: {
    call: "Codexを呼び出しますか？", taskId: "Task ID", task: "タスク", why: "Codexを使う理由", model: "モデル", reasoning: "推論強度", status: "状態", changes: "変更", verification: "検証", remaining: "残り / ブロッカー",
    requested: "指定", usage: "今回の使用量", quota: "Codex 利用枠", left: "残り", reset: "リセット", unavailable: "現在は提供なし", reply: "「Yes」または「No」と返信してください。",
  },
});

function agentModelIdentity(entry) {
  if (typeof entry?.model === "string" && entry.model) return entry.model;
  if (typeof entry?.id === "string" && entry.id) return entry.id;
  return null;
}

function portableModelOption(entry) {
  const model = agentModelIdentity(entry);
  if (!model) return null;
  const supportedReasoningEfforts = Array.isArray(entry?.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
        .map((option) => typeof option?.reasoningEffort === "string" ? option.reasoningEffort : null)
        .filter(Boolean)
    : [];
  return {
    model,
    displayName: typeof entry?.displayName === "string" && entry.displayName ? entry.displayName : null,
    isDefault: entry?.isDefault === true,
    defaultReasoningEffort: typeof entry?.defaultReasoningEffort === "string" && entry.defaultReasoningEffort ? entry.defaultReasoningEffort : null,
    supportedReasoningEfforts,
  };
}

function portableModelLabel(option) {
  if (!option) return null;
  return option.displayName && option.displayName !== option.model
    ? option.displayName
    : option.model;
}

function validPresentationLocale(value) {
  const locale = typeof value === "string" && value.trim() ? value.trim() : null;
  if (!locale) return null;
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale) ? locale : null;
}

function normalizePresentationLocale(value) {
  return validPresentationLocale(value) ?? "en";
}

function hostPresentationLocale(toolContext) {
  const meta = toolContext?._meta && typeof toolContext._meta === "object" ? toolContext._meta : null;
  return validPresentationLocale(meta?.["openai/locale"])
    ?? validPresentationLocale(meta?.["webplus/i18n"])
    ?? null;
}

function resolvePresentationLocale(explicitLocale, toolContext) {
  return validPresentationLocale(explicitLocale)
    ?? hostPresentationLocale(toolContext)
    ?? "en";
}

function presentationLocaleForPayload(payload) {
  return normalizePresentationLocale(payload?.taskCard?.presentationLocale ?? payload?.presentationLocale ?? "en");
}

function portableStrings(locale = "en") {
  const normalized = String(locale || "en").toLowerCase();
  if (normalized.startsWith("zh")) return PORTABLE_I18N.zh;
  if (normalized.startsWith("ja")) return PORTABLE_I18N.ja;
  return PORTABLE_I18N.en;
}

function portableResetText(unixSeconds, locale = "en") {
  if (!Number.isInteger(unixSeconds)) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return new Date(unixSeconds * 1000).toLocaleString();
  }
}

function portableQuotaText(window, index, locale = "en") {
  const strings = portableStrings(locale);
  const label = quotaWindowLabel(window, index);
  const remaining = Number.isInteger(window?.remainingPercent) ? `${window.remainingPercent}% ${strings.left}` : strings.unavailable;
  const reset = portableResetText(window?.resetsAt, locale);
  return `${label}：**${remaining}** · ${strings.reset} ${reset || strings.unavailable}`;
}

function portableQuotaGroup(label, quota, locale = "en") {
  const strings = portableStrings(locale);
  const windows = quotaWindows(quota);
  return [
    `**${label}**`,
    ...(windows.length ? windows.map((window, index) => portableQuotaText(window, index, locale)) : [strings.unavailable]),
  ];
}

const FIXED_CALL_APPROVAL_REQUIRED_FIELDS = Object.freeze([
  "task",
  "whyCodex",
  "model",
  "reasoningEffort",
  "quota",
  "taskId",
  "yesNo",
]);

function fixedCallApprovalDelivery(text) {
  const exactText = String(text ?? "");
  return {
    mode: "verbatim_text",
    mustPresentVerbatim: true,
    noProseBeforeOrAfter: true,
    allowSummary: false,
    allowRewrite: false,
    allowReorder: false,
    allowTranslation: false,
    textSha256: createHash("sha256").update(exactText, "utf8").digest("hex"),
    requiredFields: [...FIXED_CALL_APPROVAL_REQUIRED_FIELDS],
  };
}

function turnTotalTokens(payload) {
  const value = payload?.resourceReceipt?.tokenUsage?.turn?.totalTokens;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

const PORTABLE_PRESENTATION_I18N = Object.freeze({
  en: {
    result: "Result", error: "Error", duration: "Duration",
    before: "before", after: "after", completed: "COMPLETED", failed: "FAILED",
    stopped: "STOPPED", declined: "DECLINED", uncertain: "UNCERTAIN",
  },
  zh: {
    result: "结果", error: "错误", duration: "耗时",
    before: "调用前", after: "调用后观测", completed: "已完成", failed: "失败",
    stopped: "已停止", declined: "已拒绝", uncertain: "状态不确定",
  },
  ja: {
    result: "結果", error: "エラー", duration: "所要時間",
    before: "呼び出し前", after: "呼び出し後の観測", completed: "完了", failed: "失敗",
    stopped: "停止", declined: "拒否", uncertain: "状態不明",
  },
});

function portablePresentationStrings(locale = "en") {
  const normalized = String(locale || "en").toLowerCase();
  if (normalized.startsWith("zh")) return PORTABLE_PRESENTATION_I18N.zh;
  if (normalized.startsWith("ja")) return PORTABLE_PRESENTATION_I18N.ja;
  return PORTABLE_PRESENTATION_I18N.en;
}

function portableDurationText(durationMs, locale = "en") {
  const unavailable = portableStrings(locale).unavailable;
  if (!Number.isFinite(durationMs) || durationMs < 0) return unavailable;
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const wholeSeconds = Math.round(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const rest = wholeSeconds % 60;
  return rest ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${minutes}m`;
}

const BUSINESS_TERMINAL_STATUSES = new Set(["PASS", "PARTIAL", "BLOCKED", "FAILED", "CANCELLED"]);

function normalizeBusinessTerminalStatus(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return BUSINESS_TERMINAL_STATUSES.has(normalized) ? normalized : null;
}

function cleanTerminalEvidenceLine(value) {
  return String(value ?? "")
    .trim()
    .replace(/^[#>\s*-]+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function explicitBusinessStatusFromText(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const lines = value.split(/\r?\n/).map(cleanTerminalEvidenceLine).filter(Boolean);
  for (const line of lines) {
    const labeled = line.match(/^(?:business\s+status|status|状态|狀態|ステータス)\s*[:：]\s*(PASS|PARTIAL|BLOCKED|FAILED|CANCELLED)\b/i);
    if (labeled) return normalizeBusinessTerminalStatus(labeled[1]);
  }
  const first = lines[0] ?? "";
  const leading = first.match(/^(PASS|PARTIAL|BLOCKED|FAILED|CANCELLED)(?:\s*[:：\-—]|$)/i);
  return leading ? normalizeBusinessTerminalStatus(leading[1]) : null;
}

function compactTerminalEvidenceValue(value, max = 500) {
  if (typeof value === "string") return compactOneLine(value, max) || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value
      .map((item) => {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return compactOneLine(item, 180);
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const itemPath = typeof item.path === "string" ? item.path : typeof item.file === "string" ? item.file : null;
        const itemKind = typeof item.kind === "string" ? item.kind : typeof item.status === "string" ? item.status : null;
        const itemSummary = typeof item.summary === "string" ? item.summary : typeof item.text === "string" ? item.text : null;
        if (itemPath) return compactOneLine(`${itemKind ? `${itemKind} ` : ""}${itemPath}`, 180);
        if (itemSummary) return compactOneLine(itemSummary, 180);
        return null;
      })
      .filter(Boolean);
    return items.length ? compactOneLine(items.join("; "), max) : null;
  }
  if (value && typeof value === "object") {
    for (const key of ["summary", "text", "detail", "message"]) {
      if (typeof value[key] === "string" && value[key].trim()) return compactOneLine(value[key], max);
    }
    for (const key of ["files", "changes", "items", "tests", "blockers", "remaining"]) {
      const nested = compactTerminalEvidenceValue(value[key], max);
      if (nested) return nested;
    }
  }
  return null;
}

const TERMINAL_TEXT_FIELDS = Object.freeze({
  changes: /^(?:changes?|changed\s+files?|mutation(?:\s+summary)?|变更|變更|変更)\s*[:：]\s*(.+)$/i,
  verification: /^(?:verification|tests?|test\s+results?|acceptance(?:\s+evidence)?|验证|驗證|検証)\s*[:：]\s*(.+)$/i,
  remaining: /^(?:remaining(?:\s*\/\s*blocker)?|blockers?|next\s+steps?|剩余(?:\s*\/\s*阻塞)?|剩餘(?:\s*\/\s*阻塞)?|阻塞|残り(?:\s*\/\s*ブロッカー)?|ブロッカー)\s*[:：]\s*(.+)$/i,
  result: /^(?:result|summary|结果|結果)\s*[:：]\s*(.+)$/i,
});

function terminalTextField(value, field) {
  if (typeof value !== "string" || !value.trim()) return null;
  const pattern = TERMINAL_TEXT_FIELDS[field];
  if (!pattern) return null;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = cleanTerminalEvidenceLine(rawLine);
    const match = line.match(pattern);
    if (match?.[1]) return compactOneLine(match[1], 500) || null;
  }
  return null;
}

function structuredTerminalEvidence(payload) {
  const sources = [
    payload?.terminalEvidence,
    payload?.resultEvidence,
    payload?.resourceReceipt?.terminalEvidence,
    payload?.resourceReceipt?.resultEvidence,
  ].filter((source) => source && typeof source === "object" && !Array.isArray(source));

  const pick = (keys) => {
    for (const source of sources) {
      for (const key of keys) {
        const value = compactTerminalEvidenceValue(source?.[key]);
        if (value) return value;
      }
    }
    return null;
  };
  const status = sources
    .map((source) => normalizeBusinessTerminalStatus(source.businessStatus ?? source.resultStatus ?? source.outcome ?? source.status))
    .find(Boolean) ?? null;
  return {
    status,
    result: pick(["result", "resultSummary", "summary"]),
    changes: pick(["changes", "changeSummary", "mutation", "mutationSummary", "changedFiles", "filesChanged"]),
    verification: pick(["verification", "verificationSummary", "tests", "testSummary", "acceptanceEvidence"]),
    remaining: pick(["remaining", "remainingSummary", "blocker", "blockers", "nextSteps"]),
  };
}

function terminalEvidence(payload, status) {
  const structured = structuredTerminalEvidence(payload);
  const finalText = typeof payload?.finalResult === "string" ? payload.finalResult : null;
  const businessStatus = structured.status
    ?? explicitBusinessStatusFromText(finalText)
    ?? (status === "failed" ? "FAILED" : null)
    ?? (status === "interrupted" ? "CANCELLED" : null)
    ?? (status === "lost" ? "BLOCKED" : null);
  return {
    businessStatus,
    result: structured.result ?? terminalTextField(finalText, "result"),
    changes: structured.changes ?? terminalTextField(finalText, "changes"),
    verification: structured.verification ?? terminalTextField(finalText, "verification"),
    remaining: structured.remaining ?? terminalTextField(finalText, "remaining"),
  };
}

function terminalPresentation(businessStatus, locale = "en") {
  const p = portablePresentationStrings(locale);
  if (businessStatus === "PASS") return { icon: "✅", label: p.completed };
  if (businessStatus === "FAILED") return { icon: "❌", label: p.failed };
  if (businessStatus === "CANCELLED") return { icon: "⏹️", label: p.stopped };
  if (businessStatus === "PARTIAL" || businessStatus === "BLOCKED") return { icon: "⚠️", label: businessStatus };
  return { icon: "⚠️", label: p.uncertain };
}

function terminalDetail(payload, status, unavailable, evidence = terminalEvidence(payload, status)) {
  if (evidence?.result) return evidence.result;
  if (typeof payload?.portableTerminalDetail === "string" && payload.portableTerminalDetail) {
    return payload.portableTerminalDetail;
  }
  const raw = status === "failed" || status === "lost"
    ? payload?.latestError ?? payload?.finalResult
    : payload?.finalResult ?? payload?.latestError;
  return compactOneLine(raw ?? unavailable, 500) || unavailable;
}

function chatPresentation(payload) {
  if (payload?.suppressManualFallback === true) return null;
  const status = payload?.status ?? "unknown";
  // There is no text "running card" and no in-turn fallback card. Once Codex
  // is running, ordinary progress stays conversational; pending actions are
  // resolved by the caller after applying the Profile instruction. Text
  // fallback is reserved for the initial Call Codex decision and terminal receipt.
  if (status === "running" || status === "awaitingApproval") return null;
  const locale = presentationLocaleForPayload(payload);
  const strings = portableStrings(locale);
  const presentation = portablePresentationStrings(locale);
  const beforeQuota = payload?.meteredConsent?.quota ?? payload?.taskCard?.quota ?? null;
  const afterQuota = payload?.resourceReceipt?.accountQuota ?? null;
  const quota = beforeQuota ?? afterQuota;
  const windows = quotaWindows(quota);
  const portableQuotaLines = windows.length
    ? windows.map((window, index) => portableQuotaText(window, index, locale))
    : [strings.unavailable];
  const shortTaskId = payload?.shortTaskId ?? payload?.taskCard?.shortTaskId ?? null;
  const displayTaskId = shortTaskId ?? payload?.taskId ?? payload?.taskCard?.taskId ?? payload?.taskRef ?? null;
  const task = boundedPortableBody(payload?.portableTaskBody ?? payload?.taskCard?.summary ?? "Codex task", "Codex task");

  const selection = payload?.taskCard?.modelSelection && typeof payload.taskCard.modelSelection === "object"
    ? payload.taskCard.modelSelection
    : null;
  const selectedModelOption = selection?.models?.find((option) => option?.model === selection?.selectedModel) ?? null;
  const requestedModel = payload?.execution?.requestedModel ?? payload?.taskCard?.requestedModel ?? selection?.selectedModel ?? null;
  const resolvedModel = payload?.execution?.resolvedModel ?? null;
  const model = status === "consent_required" && selection?.selectedModel
    ? portableModelLabel(selectedModelOption ?? { model: selection.selectedModel, displayName: selection.selectedModelDisplayName ?? null })
    : resolvedModel
      ? `${compactOneLine(resolvedModel)}${requestedModel && requestedModel !== resolvedModel ? ` (${strings.requested} ${compactOneLine(requestedModel)})` : ""}`
      : requestedModel ? compactOneLine(requestedModel) : null;
  const requestedEffort = payload?.execution?.requestedReasoningEffort ?? payload?.taskCard?.requestedReasoningEffort ?? selection?.selectedReasoningEffort ?? null;
  const resolvedEffort = payload?.execution?.reasoningEffort ?? null;
  const effort = status === "consent_required"
    ? selection?.selectedReasoningEffort ?? requestedEffort ?? null
    : resolvedEffort
      ? `${compactOneLine(resolvedEffort)}${requestedEffort && requestedEffort !== resolvedEffort ? ` (${strings.requested} ${compactOneLine(requestedEffort)})` : ""}`
      : requestedEffort ? compactOneLine(requestedEffort) : null;
  const portableStatus = status === "consent_required"
    ? "AWAITING DECISION"
    : isTerminalStatus(status) ? terminalLabel(status) : String(status).toUpperCase();

  if (shortTaskId) {
    let lines;
    let choices = [];
    if (status === "consent_required") {
      choices = ["Yes", "No"];
      const why = typeof payload?.taskCard?.invocationRationale === "string" && payload.taskCard.invocationRationale
        ? compactOneLine(payload.taskCard.invocationRationale, 500)
        : strings.unavailable;
      lines = [
        `⚠️ **${strings.call}**`,
        `${strings.task}：${task}`,
        `${strings.why}：${why}`,
        `${strings.model}：${model ?? strings.unavailable}`,
        `${strings.reasoning}：${effort ?? strings.unavailable}`,
        `**${strings.quota}**`,
        ...portableQuotaLines,
        `${strings.taskId}：${displayTaskId ?? strings.unavailable}`,
        `👉 **${strings.reply}**`,
      ];
    } else if (isTerminalStatus(status)) {
      const evidence = terminalEvidence(payload, status);
      const businessStatus = evidence.businessStatus ?? strings.unavailable;
      const terminal = terminalPresentation(businessStatus, locale);
      const detail = terminalDetail(payload, status, strings.unavailable, evidence);
      const turnTokens = turnTotalTokens(payload);
      const terminalResolvedModel = typeof payload?.execution?.resolvedModel === "string" && payload.execution.resolvedModel
        ? compactOneLine(payload.execution.resolvedModel)
        : strings.unavailable;
      const terminalEffort = typeof payload?.execution?.reasoningEffort === "string" && payload.execution.reasoningEffort
        ? compactOneLine(payload.execution.reasoningEffort)
        : strings.unavailable;
      const detailLabel = businessStatus === "FAILED" ? presentation.error : presentation.result;
      lines = [
        `${terminal.icon} **Codex · Result**`,
        `${strings.task}：${task}`,
        `${strings.status}：${businessStatus}`,
        `${strings.model} / ${strings.reasoning}：${terminalResolvedModel} / ${terminalEffort}`,
        `${presentation.duration}：${portableDurationText(payload?.timing?.durationMs, locale)}`,
        `${detailLabel}：${detail}`,
        `${strings.changes}：${evidence.changes ?? strings.unavailable}`,
        `${strings.verification}：${evidence.verification ?? strings.unavailable}`,
        `${strings.remaining}：${evidence.remaining ?? ((businessStatus === "BLOCKED" || businessStatus === "FAILED") ? detail : strings.unavailable)}`,
        `${strings.usage}：${turnTokens !== null ? `${turnTokens.toLocaleString()} tokens` : strings.unavailable}`,
        ...portableQuotaGroup(`${strings.quota} · ${presentation.before}`, beforeQuota, locale),
        ...portableQuotaGroup(`${strings.quota} · ${presentation.after}`, afterQuota, locale),
        `${strings.taskId}：${displayTaskId ?? strings.unavailable}`,
      ];
    } else {
      lines = [`**Codex · ${portableStatus}**`, `${strings.task}：${task}`];
      if (model) lines.push(`${strings.model}：${model}`);
      if (effort) lines.push(`${strings.reasoning}：${effort}`);
      if (beforeQuota) lines.push("", ...portableQuotaGroup(strings.quota, beforeQuota, locale));
    }
    const text = lines.join("\n");
    return {
      kind: status === "consent_required" ? "call_approval" : "codex_result",
      mustPresentToUser: status === "consent_required" || isTerminalStatus(status),
      blocking: status === "consent_required",
      taskId: shortTaskId,
      status: portableStatus,
      task,
      choices,
      quota: {
        windows,
        before: { windows: quotaWindows(beforeQuota) },
        after: { windows: quotaWindows(afterQuota) },
      },
      ...(selection ? { modelSelection: structuredClone(selection) } : {}),
      ...(status === "consent_required" ? {
        delivery: fixedCallApprovalDelivery(text),
        binding: {
          exactTaskId: shortTaskId,
          approveTool: "codex.agent_commit",
          declineTool: "codex.agent_decline",
          singleConsume: true,
        },
        rebind: {
          mode: "natural_language_reprepare",
          requiresNewRequestId: true,
          instruction: "If the user changes model or reasoning effort before approval, do not commit this task. Prepare the same logical task again with the requested selection and a fresh requestId, present the new confirmation, and bind Yes only to the newly presented taskId.",
        },
      } : {}),
      lines,
      text,
    };
  }

  if (status === "consent_required") {
    const lines = [
      `⚠️ **${strings.call}**`,
      "",
      `${strings.taskId}：${displayTaskId ?? strings.unavailable}`,
      `${strings.task}：${task}`,
      `${strings.model}：${model ?? strings.unavailable}`,
      `${strings.reasoning}：${effort ?? strings.unavailable}`,
      "",
      ...portableQuotaGroup(strings.quota, beforeQuota, locale),
      "",
      `👉 **${strings.reply}**`,
    ];
    const text = lines.join("\n");
    return {
      kind: "confirm_metered",
      mustPresentToUser: true,
      taskId: displayTaskId,
      choices: ["Yes", "No"],
      summary: task,
      quota: { windows },
      delivery: fixedCallApprovalDelivery(text),
      binding: {
        exactTaskId: displayTaskId,
        approveTool: "codex.agent_commit",
        declineTool: "codex.agent_decline",
        singleConsume: true,
      },
      rebind: {
        mode: "natural_language_reprepare",
        requiresNewRequestId: true,
        instruction: "If task, model, reasoning effort, cwd, or other bound call meaning changes before approval, prepare a fresh task with a fresh requestId and present its new Task ID before accepting Yes.",
      },
      lines,
      text,
    };
  }

  if (isTerminalStatus(status)) {
    const evidence = terminalEvidence(payload, status);
    const businessStatus = evidence.businessStatus ?? strings.unavailable;
    const terminal = terminalPresentation(businessStatus, locale);
    const detail = terminalDetail(payload, status, strings.unavailable, evidence);
    const turnTokens = turnTotalTokens(payload);
    const terminalResolvedModel = typeof payload?.execution?.resolvedModel === "string" && payload.execution.resolvedModel
      ? compactOneLine(payload.execution.resolvedModel)
      : strings.unavailable;
    const terminalEffort = typeof payload?.execution?.reasoningEffort === "string" && payload.execution.reasoningEffort
      ? compactOneLine(payload.execution.reasoningEffort)
      : strings.unavailable;
    const detailLabel = businessStatus === "FAILED" ? presentation.error : presentation.result;
    const beforeLines = quotaWindows(beforeQuota);
    const afterLines = quotaWindows(afterQuota);
    const lines = [
      `${terminal.icon} **Codex · Result**`,
      `${strings.task}：${task}`,
      `${strings.status}：${businessStatus}`,
      `${strings.model} / ${strings.reasoning}：${terminalResolvedModel} / ${terminalEffort}`,
      `${presentation.duration}：${portableDurationText(payload?.timing?.durationMs, locale)}`,
      `${detailLabel}：${detail}`,
      `${strings.changes}：${evidence.changes ?? strings.unavailable}`,
      `${strings.verification}：${evidence.verification ?? strings.unavailable}`,
      `${strings.remaining}：${evidence.remaining ?? ((businessStatus === "BLOCKED" || businessStatus === "FAILED") ? detail : strings.unavailable)}`,
      `${strings.usage}：${turnTokens !== null ? `${turnTokens.toLocaleString()} tokens` : strings.unavailable}`,
      ...portableQuotaGroup(`${strings.quota} · ${presentation.before}`, beforeQuota, locale),
      ...portableQuotaGroup(`${strings.quota} · ${presentation.after}`, afterQuota, locale),
      `${strings.taskId}：${displayTaskId ?? strings.unavailable}`,
    ];
    return {
      kind: "completion",
      mustPresentToUser: true,
      status: terminalLabel(status).toLowerCase(),
      task,
      result: detail,
      quota: { windows, before: { windows: beforeLines }, after: { windows: afterLines } },
      lines,
      text: lines.join("\n"),
    };
  }

  return null;
}

function publicAgentSnapshot(snapshot, taskCard = null, { suppressManualFallback = false, portableTaskBody = null } = {}) {
  const pendingApproval = publicPendingApproval(snapshot?.pendingApproval);
  const riskReference = pendingApproval ? approvalRiskReference(pendingApproval, taskCard) : null;
  const taskRef = taskCard?.taskRef ?? snapshot?.taskRef ?? null;
  const shortTaskId = taskCard?.shortTaskId ?? snapshot?.shortTaskId ?? null;
  const taskId = taskCard?.taskId ?? shortTaskId ?? snapshot?.taskId ?? taskRef ?? null;
  const publicStatus = snapshot?.status === "idle" ? "completed" : snapshot?.status ?? "unknown";
  const payload = {
    taskRef,
    taskId,
    shortTaskId,
    agentRef: snapshot?.agentRef ?? null,
    turnId: snapshot?.turnId ?? null,
    status: publicStatus,
    canSend: snapshot?.canSend === true,
    pendingApproval,
    finalResult: snapshot?.finalResult ?? null,
    resourceReceipt: snapshot?.resourceReceipt ?? null,
    timing: snapshot?.timing ?? { startedAt: null, endedAt: null, durationMs: null },
    execution: snapshot?.execution ?? { requestedModel: null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
    latestError: snapshot?.latestError ?? null,
    events: Array.isArray(snapshot?.events) ? snapshot.events.map(publicEvent).filter(Boolean) : [],
    nextSeq: Number.isInteger(snapshot?.nextSeq) ? snapshot.nextSeq : 0,
  };
  if (taskCard) payload.taskCard = taskCard;
  const projectedTerminalEvidence = structuredTerminalEvidence(snapshot);
  if (projectedTerminalEvidence.status || projectedTerminalEvidence.result || projectedTerminalEvidence.changes || projectedTerminalEvidence.verification || projectedTerminalEvidence.remaining) {
    payload.terminalEvidence = projectedTerminalEvidence;
  }
  if (typeof portableTaskBody === "string" && portableTaskBody) payload.portableTaskBody = portableTaskBody;
  if (isTerminalStatus(publicStatus)) {
    const rawTerminalDetail = publicStatus === "failed" || publicStatus === "lost"
      ? payload.latestError ?? payload.finalResult
      : payload.finalResult ?? payload.latestError;
    if (rawTerminalDetail !== null && rawTerminalDetail !== undefined) {
      payload.portableTerminalDetail = boundedPortableBody(rawTerminalDetail);
    }
  }
  const supervision = supervisionFor(publicStatus, payload.agentRef, pendingApproval);
  payload.supervisionRequired = supervision.supervisionRequired;
  payload.nextAction = supervision.nextAction;
  if (riskReference) payload.approvalRiskReference = riskReference;
  if (pendingApproval) payload.approvalPresentation = inTurnApprovalPresentation(pendingApproval, riskReference, taskCard);
  if (typeof snapshot?.duplicate === "boolean") payload.duplicate = snapshot.duplicate;
  if (typeof snapshot?.controlAcceptance === "string") payload.controlAcceptance = snapshot.controlAcceptance;
  if (suppressManualFallback) payload.suppressManualFallback = true;
  const presentation = suppressManualFallback ? null : chatPresentation(payload);
  if (presentation) payload.chatPresentation = presentation;
  delete payload.portableTaskBody;
  delete payload.portableTerminalDetail;
  return payload;
}

function consentRequiredSnapshot({ agentRef = null, consent, taskCard = null, portableTaskBody = null }) {
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
    supervisionRequired: false,
    nextAction: { kind: "await_call_approval" },
  };
  if (typeof portableTaskBody === "string" && portableTaskBody) payload.portableTaskBody = portableTaskBody;
  payload.chatPresentation = chatPresentation(payload);
  delete payload.portableTaskBody;
  return payload;
}

const TASK_STORE_VERSION = 1;
const DEFAULT_TASK_STORE_TTL_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_TASK_STORE_MAX_ENTRIES = 2_000;

function createTaskPersistence({ filePath = null, ttlMs = DEFAULT_TASK_STORE_TTL_MS, maxEntries = DEFAULT_TASK_STORE_MAX_ENTRIES } = {}) {
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
        if (!entry || typeof entry !== "object" || typeof entry.taskRef !== "string") continue;
        records.set(entry.taskRef, entry);
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
    const tmp = `${resolvedPath}.tmp-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify({ version: TASK_STORE_VERSION, records: [...records.values()] }), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, resolvedPath);
  }

  trim();
  return {
    filePath: resolvedPath,
    get(taskRef) {
      assertAvailable();
      trim();
      const entry = records.get(taskRef);
      return entry ? structuredClone(entry) : null;
    },
    findByRequest({ requestId, action, agentRef = null }) {
      assertAvailable();
      trim();
      let found = null;
      for (const entry of records.values()) {
        if (entry?.requestId !== requestId || entry?.action !== action) continue;
        if ((entry?.subjectRef ?? null) !== agentRef) continue;
        if (!found || (entry.updatedAt ?? 0) > (found.updatedAt ?? 0)) found = entry;
      }
      return found ? structuredClone(found) : null;
    },
    put(entry) {
      assertAvailable();
      if (!entry || typeof entry.taskRef !== "string" || !entry.taskRef) throw new Error("persisted agent task entry requires taskRef");
      records.set(entry.taskRef, { ...structuredClone(entry), updatedAt: Date.now() });
      flush();
    },
  };
}

export function createAgentPreviewState({
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  taskStateFile = null,
  taskStateTtlMs = DEFAULT_TASK_STORE_TTL_MS,
  taskStateMaxEntries = DEFAULT_TASK_STORE_MAX_ENTRIES,
} = {}) {
  return {
    meteredConsent: new MeteredConsentGate({ mode: meteredConsentMode, quotaProvider: meteredQuotaProvider }),
    preparedMetered: new Map(),
    agentCards: new Map(),
    taskRecords: new Map(),
    taskPersistence: createTaskPersistence({ filePath: taskStateFile, ttlMs: taskStateTtlMs, maxEntries: taskStateMaxEntries }),
  };
}

function isTerminalStatus(status) {
  return new Set(["idle", "completed", "failed", "interrupted", "rejected", "lost"]).has(status);
}

function terminalLabel(status) {
  if (status === "failed") return "FAILED";
  if (status === "interrupted") return "STOPPED";
  if (status === "rejected") return "REJECTED";
  if (status === "lost") return "UNCERTAIN";
  return "DONE";
}

function supervisionFor(status, agentRef, pendingApproval = null) {
  if (status === "running") {
    return {
      supervisionRequired: true,
      nextAction: { kind: "recheck_agent", tool: "codex.agent_show", agentRef: agentRef ?? null },
    };
  }
  if (status === "awaitingApproval" || pendingApproval) {
    return {
      supervisionRequired: true,
      nextAction: {
        kind: "resolve_pending_approval",
        agentRef: agentRef ?? null,
        approvalRequestId: pendingApproval?.requestId ?? null,
      },
    };
  }
  if (isTerminalStatus(status)) {
    const kind = status === "lost"
      ? "resolve_uncertain_terminal"
      : status === "completed" || status === "idle"
        ? "verify_and_integrate"
        : "review_terminal_failure";
    return { supervisionRequired: false, nextAction: { kind } };
  }
  return {
    supervisionRequired: false,
    nextAction: { kind: "inspect_agent_state", agentRef: agentRef ?? null },
  };
}

export function registerAgentPreviewTools(server, {
  agentExecutor,
  modelCatalogProvider = null,
  authorityExecutor,
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  agentPreviewState = null,
  agentPortableCard = false,
  legacyAgentCardInternals = false,
  agentReasoningEffort = false,
  codexCallProfile = false,
  codexCallProfileFile = null,
  formalAgentBlock = null,
}) {
  if (!agentExecutor || !authorityExecutor) {
    throw new Error("Agent preview requires both agentExecutor and authorityExecutor");
  }
  if (formalAgentBlock !== null && (typeof formalAgentBlock !== "object" || Array.isArray(formalAgentBlock))) {
    throw new Error("formalAgentBlock must be null or an object");
  }
  const catalogProvider = modelCatalogProvider ?? agentExecutor;
  const state = agentPreviewState ?? createAgentPreviewState({ meteredConsentMode, meteredQuotaProvider });
  const { meteredConsent, preparedMetered, agentCards, taskRecords, taskPersistence } = state;
  if (legacyAgentCardInternals) registerAgentTaskCardResource(server);
  const callProfilePath = codexCallProfile
    ? path.resolve(codexCallProfileFile || defaultCodexCallProfilePath())
    : null;

  function readCallProfile() {
    return codexCallProfile
      ? loadCodexCallProfile({ filePath: callProfilePath })
      : {
          status: "disabled",
          valid: false,
          effective: { requireCallApproval: true },
          instruction: "",
          legacy: false,
        };
  }

  function callProfileSnapshot(profile) {
    return codexCallProfile ? bindCodexCallProfileSnapshot(profile) : null;
  }

  function assertFormalAgentAvailable() {
    if (!formalAgentBlock) return;
    const error = new Error(
      typeof formalAgentBlock.message === "string" && formalAgentBlock.message.trim()
        ? formalAgentBlock.message.trim()
        : "Formal Codex Agent work is unavailable in this runtime configuration."
    );
    error.code = typeof formalAgentBlock.code === "string" && formalAgentBlock.code.trim()
      ? formalAgentBlock.code.trim()
      : "FORMAL_CODEX_AGENT_UNAVAILABLE";
    if (Array.isArray(formalAgentBlock.nextActions)) error.nextActions = [...formalAgentBlock.nextActions];
    throw error;
  }

  function isAmbiguousInheritedAuthority(error) {
    return /activePermissionProfile is null and config\/read provides no explicit default_permissions provenance/.test(
      error instanceof Error ? error.message : String(error)
    );
  }

  async function resolveFormalAgentStartAuthority(cwd) {
    try {
      return await authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
    } catch (error) {
      if (!isAmbiguousInheritedAuthority(error)) throw error;
      return authorityExecutor.resolveAuthority({ cwd, access: "readOnly" });
    }
  }

  function summaryFor(action, payload) {
    const text = action === "start" ? payload.prompt : payload.message;
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    return clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
  }

  function titleFor(action, payload) {
    const text = action === "start" ? payload.prompt : payload.message;
    const firstLine = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Codex task";
    return firstLine.length > 72 ? firstLine.slice(0, 69) + "..." : firstLine;
  }

  async function fullModelCatalog() {
    const models = [];
    let cursor = null;
    const seenCursors = new Set();
    for (let page = 0; page < 20; page += 1) {
      const result = await catalogProvider.listModels({ cursor, limit: 200, includeHidden: false });
      for (const entry of Array.isArray(result?.models) ? result.models : []) {
        const option = portableModelOption(entry);
        if (option && !models.some((item) => item.model === option.model)) models.push(option);
      }
      const next = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!next) break;
      if (seenCursors.has(next)) throw new Error("codex.model_list returned a repeated cursor while preparing the Codex confirmation");
      seenCursors.add(next);
      cursor = next;
    }
    if (!models.length) throw new Error("codex.model_list returned no selectable models for the Codex confirmation");
    return models;
  }

  async function resolvePreparedModelSelection({ requestedModel = null, requestedReasoningEffort = null, currentModel = null, currentReasoningEffort = null } = {}) {
    const models = await fullModelCatalog();
    const requested = typeof requestedModel === "string" && requestedModel.trim() ? requestedModel.trim() : null;
    const current = typeof currentModel === "string" && currentModel.trim() ? currentModel.trim() : null;
    const entry = requested
      ? models.find((item) => item.model === requested)
      : current
        ? models.find((item) => item.model === current) ?? models.find((item) => item.isDefault)
        : models.find((item) => item.isDefault);
    if (!entry) {
      const wanted = requested ?? current ?? "<default>";
      throw new Error(`codex.model_list could not resolve the selected model ${wanted}`);
    }
    const supported = [...entry.supportedReasoningEfforts];
    let effort = typeof requestedReasoningEffort === "string" && requestedReasoningEffort.trim()
      ? requestedReasoningEffort.trim()
      : null;
    let effortSource = effort ? "explicit" : null;
    if (effort && !supported.includes(effort)) {
      throw new Error(
        `reasoningEffort validation failed for model "${entry.model}": requested effort "${effort}"; supported efforts: ${supported.length ? supported.join(", ") : "(none)"}`
      );
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

  function publicCallProfile(profile) {
    const snapshot = callProfileSnapshot(profile);
    if (!snapshot) return null;
    return {
      ...snapshot,
      ...(profile?.status === "invalid" && typeof profile?.error === "string" ? { error: profile.error } : {}),
    };
  }

  function profileInstructionState(profile) {
    const publicProfile = publicCallProfile(profile);
    const instruction = unconfiguredCodexCallInstruction();
    if (profile?.status === "invalid") {
      const lines = [
        `Codex Call Profile is invalid: ${profile.error || "unknown Profile error"}.`,
        "Until it is repaired, Codexless requires Call Codex approval and does not treat the broken Profile text as a durable instruction.",
        "Choose one: repair/create the long-term Profile, customize it, or skip setup for this task only and save nothing.",
        "A Profile instruction can guide calling, model/reasoning selection, and in-turn approval habits, but it never expands Codex authority.",
      ];
      return {
        status: "profile_required",
        terminal: false,
        canSend: false,
        callProfile: publicProfile,
        callProfileInstruction: instruction,
        manualFallback: {
          kind: "codex_call_profile",
          mustPresentToUser: true,
          text: lines.join("\n"),
          lines,
          choices: ["create_profile", "customize_profile", "skip_once"],
          primaryChoice: "create_profile",
        },
      };
    }

    const locale = "en";
    const normalized = String(locale || "en").toLowerCase();
    const copy = normalized.startsWith("zh")
      ? {
          title: "设置 Codex Profile",
          summary: "推荐默认已经准备好。保存后我会按这套 Profile 使用 Codex；需要时你随时可以再修改。",
          permissionLabel: "调用前许可",
          permissionValue: "需要（推荐）。每次真正调用 Codex 前先问你；可在自定义里改成跳过。",
          save: "保存推荐设置",
          customize: "也可以选择“自定义 Profile”查看并修改详细规则。",
          skip: "如果这次先不设置，下次准备调用 Codex 时还会再提醒。",
        }
      : normalized.startsWith("ja")
        ? {
            title: "Codex Profile を設定",
            summary: "おすすめの標準設定はすでに用意されています。保存後はこの Profile に沿って Codex を使い、必要ならいつでも変更できます。",
            permissionLabel: "呼び出し前の許可",
            permissionValue: "必要（推奨）。Codex を実際に呼び出す前に毎回確認します。カスタマイズでスキップに変更できます。",
            save: "おすすめ設定を保存",
            customize: "「Profile をカスタマイズ」を選ぶと、詳細ルールを確認・変更できます。",
            skip: "今回は設定しない場合、次に Codex を呼び出す前にもう一度お知らせします。",
          }
        : {
            title: "Set up Codex Profile",
            summary: "Recommended defaults are ready. Save them to use Codex with this Profile; you can change it later at any time.",
            permissionLabel: "Approval before calling Codex",
            permissionValue: "Required (recommended). You will be asked before each real Codex call; Customize can change this to skip approval.",
            save: "Save recommended settings",
            customize: "Choose “Customize Profile” to review or change the detailed rules.",
            skip: "If you skip setup this time, you will be reminded again before the next Codex call.",
          };
    const separator = normalized.startsWith("en") ? ":" : "：";
    const lines = [
      `**${copy.title}**`,
      "",
      copy.summary,
      "",
      `- **${copy.permissionLabel}${separator}** ${copy.permissionValue}`,
      "",
      `👉 **${copy.save}**`,
      copy.customize,
      "",
      copy.skip,
    ];
    return {
      status: "profile_required",
      terminal: false,
      canSend: false,
      callProfile: publicProfile,
      callProfileInstruction: instruction,
      manualFallback: {
        kind: "codex_call_profile",
        mustPresentToUser: true,
        text: lines.join("\n"),
        lines,
        choices: ["create_profile", "customize_profile", "skip_once"],
        primaryChoice: "create_profile",
      },
    };
  }

  async function authorizeForProfile({ action, requestId, subjectRef = null, payload, requireCallApproval = true }) {
    const first = await meteredConsent.authorize({ action, requestId, subjectRef, payload, consentRef: null });
    if (first.authorized || requireCallApproval !== false) return first;
    const consentRef = first?.consent?.consentRef;
    if (!consentRef) throw new Error("Codex Call Profile auto-commit could not bind a metered consent record");
    const approved = await meteredConsent.authorize({ action, requestId, subjectRef, payload, consentRef });
    return { ...approved, consent: first.consent, autoCommittedByProfile: true };
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
      invocationRationale: action === "start" ? payload?.invocationRationale ?? null : null,
      presentationLocale: payload?.presentationLocale ?? null,
      callProfile: payload?.callProfile ?? null,
    };
    // Prepared confirmations bind resolved defaults for execution but keep
    // caller intent as the requestId idempotency key. This lets an omitted
    // default remain stable across retries while an explicit user change still
    // requires a fresh requestId / prepared confirmation.
    if (hasCallerEffort) bound.reasoningEffort = payload?.callerReasoningEffort ?? null;
    else if (!hasCallerModel && Object.hasOwn(payload ?? {}, "reasoningEffort")) bound.reasoningEffort = payload.reasoningEffort ?? null;
    return createHash("sha256").update(JSON.stringify(bound), "utf8").digest("hex");
  }

  function callerIntentHash(action, payload, agentRef = null) {
    const bound = {
      action,
      agentRef,
      prompt: action === "start" ? payload?.prompt ?? null : null,
      message: action === "send" ? payload?.message ?? null : null,
      cwd: action === "start" ? payload?.callerCwd ?? null : null,
      model: payload?.callerModel ?? null,
      reasoningEffort: payload?.callerReasoningEffort ?? null,
      invocationRationale: action === "start" ? payload?.callerInvocationRationale ?? null : null,
      presentationLocale: payload?.presentationLocale ?? null,
    };
    return createHash("sha256").update(JSON.stringify(bound), "utf8").digest("hex");
  }

  function taskCardFor({ taskRef, shortTaskId = null, requestId, action, payload, cwd = null, permissionProfile = null, quota = null }) {
    const card = {
      kind: "codex_task",
      taskRef,
      taskId: shortTaskId ?? taskRef,
      requestId,
      action,
      title: titleFor(action, payload),
      summary: summaryFor(action, payload),
      requestedModel: Object.hasOwn(payload ?? {}, "callerModel")
        ? (typeof payload?.callerModel === "string" ? payload.callerModel : null)
        : (typeof payload?.model === "string" ? payload.model : null),
      ...(typeof payload?.reasoningEffort === "string" ? { requestedReasoningEffort: payload.reasoningEffort } : {}),
      ...(payload?.modelSelection && typeof payload.modelSelection === "object" ? { modelSelection: structuredClone(payload.modelSelection) } : {}),
      ...(typeof payload?.invocationRationale === "string" ? { invocationRationale: payload.invocationRationale } : {}),
      presentationLocale: normalizePresentationLocale(payload?.presentationLocale ?? "en"),
      cwd,
      permissionProfile,
      quota,
      ...(payload?.callProfile ? { callProfile: structuredClone(payload.callProfile) } : {}),
    };
    if (shortTaskId) card.shortTaskId = shortTaskId;
    return card;
  }

  function newTaskIdentity() {
    while (true) {
      const taskRef = `task_${randomUUID()}`;
      const shortTaskId = agentPortableCard ? portableShortTaskId(taskRef) : null;
      if (!shortTaskId || ![...taskRecords.values()].some((record) => record.shortTaskId === shortTaskId)) return { taskRef, shortTaskId };
    }
  }

  function persistableSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const resultSummary = compactOneLine(snapshot.resultSummary ?? snapshot.finalResult ?? snapshot.latestError ?? "", 800);
    return {
      taskRef: snapshot.taskRef ?? snapshot.taskId ?? snapshot.taskCard?.taskRef ?? null,
      taskId: snapshot.taskId ?? snapshot.shortTaskId ?? snapshot.taskCard?.taskId ?? snapshot.taskRef ?? snapshot.taskCard?.taskRef ?? null,
      shortTaskId: snapshot.shortTaskId ?? snapshot.taskCard?.shortTaskId ?? null,
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
      ...(snapshot.terminalEvidence ? { terminalEvidence: structuredClone(snapshot.terminalEvidence) } : {}),
      timing: snapshot.timing ? structuredClone(snapshot.timing) : { startedAt: null, endedAt: null, durationMs: null },
      execution: snapshot.execution ? structuredClone(snapshot.execution) : { requestedModel: null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
      latestError: snapshot.latestError ? compactOneLine(snapshot.latestError, 800) : null,
      terminal: snapshot.terminal === true,
      terminalAt: Number.isFinite(snapshot.terminalAt) ? snapshot.terminalAt : null,
      suppressManualFallback: snapshot.suppressManualFallback === true,
      events: [],
      nextSeq: 0,
    };
  }

  function persistRecord(record, snapshot = null, phase = null) {
    if (!taskPersistence || !record?.taskRef) return true;
    try {
      taskPersistence.put({
        taskRef: record.taskRef,
        shortTaskId: record.shortTaskId ?? null,
        consentRef: record.consent?.consentRef ?? null,
        requestId: record.consent?.requestId ?? record.taskCard?.requestId ?? null,
        action: record.action,
        payloadHash: record.payloadHash ?? null,
        callerIntentHash: record.callerIntentHash ?? null,
        toolError: record.toolError ?? null,
        suppressTerminalFallback: record.suppressTerminalFallback === true,
        taskCard: structuredClone(record.taskCard),
        subjectRef: record.subjectRef ?? null,
        agentRef: record.agentRef ?? null,
        turnId: record.turnId ?? null,
        phase: phase ?? (record.terminalSnapshot ? "terminal" : record.authorized ? "active" : "pending"),
        terminalSnapshot: snapshot ? persistableSnapshot(snapshot) : record.terminalSnapshot ? persistableSnapshot(record.terminalSnapshot) : null,
      });
      record.persistenceWarning = null;
      return true;
    } catch (error) {
      record.persistenceWarning = `Prepared-task persistence unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  function recoveredTaskState(taskRef) {
    if (!taskPersistence || typeof taskRef !== "string" || !taskRef) return null;
    const persisted = taskPersistence.get(taskRef);
    if (!persisted) return null;
    if (persisted.toolError) throw new Error(persisted.toolError);
    if (persisted.terminalSnapshot) {
      const terminal = structuredClone(persisted.terminalSnapshot);
      if (terminal.suppressManualFallback !== true && !terminal.chatPresentation) {
        const presentation = chatPresentation(terminal);
        if (presentation) terminal.chatPresentation = presentation;
      }
      return terminal;
    }
    const now = Date.now();
    const lost = {
      taskRef,
      taskId: persisted.shortTaskId ?? taskRef,
      shortTaskId: persisted.shortTaskId ?? persisted.taskCard?.shortTaskId ?? null,
      agentRef: persisted.agentRef ?? null,
      turnId: persisted.turnId ?? null,
      status: "lost",
      canSend: false,
      pendingApproval: null,
      taskCard: persisted.taskCard ? structuredClone(persisted.taskCard) : null,
      meteredConsent: { status: "unavailable", quota: persisted.taskCard?.quota ?? null },
      finalResult: null,
      resourceReceipt: null,
      timing: { startedAt: null, endedAt: now, durationMs: null },
      execution: {
        requestedModel: persisted.taskCard?.requestedModel ?? null,
        ...(typeof persisted.taskCard?.requestedReasoningEffort === "string" ? { requestedReasoningEffort: persisted.taskCard.requestedReasoningEffort } : {}),
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      },
      latestError: "Task control state was lost across Codexless restart. The original task will not be replayed.",
      ...(persisted.suppressTerminalFallback === true ? { suppressManualFallback: true } : {}),
      terminal: true,
      terminalAt: now,
      resultSummary: "Task control state was lost across Codexless restart. The original task will not be replayed.",
      events: [],
      nextSeq: 0,
    };
    if (lost.suppressManualFallback !== true) {
      const presentation = chatPresentation(lost);
      if (presentation) lost.chatPresentation = presentation;
    }
    try {
      taskPersistence.put({ ...persisted, phase: "terminal", terminalSnapshot: persistableSnapshot(lost) });
    } catch {
      // Recovery remains fail-closed even when the local history file cannot be refreshed.
    }
    return lost;
  }

  async function existingRequestByCallerIntent({ requestId, action, payload, agentRef = null }) {
    const expectedHash = callerIntentHash(action, payload, agentRef);
    let liveRecord = null;
    for (const record of taskRecords.values()) {
      if (record?.action !== action) continue;
      if ((record?.subjectRef ?? null) !== agentRef) continue;
      const recordRequestId = record?.consent?.requestId ?? record?.taskCard?.requestId ?? null;
      if (recordRequestId !== requestId) continue;
      liveRecord = record;
      break;
    }
    if (liveRecord?.callerIntentHash) {
      if (liveRecord.callerIntentHash !== expectedHash) {
        throw new Error(`requestId ${requestId} was already used for a different Codex caller intent`);
      }
      if (liveRecord.toolError) throw new Error(liveRecord.toolError);
      return preparedCardState(liveRecord);
    }
    if (!taskPersistence) return null;
    const persisted = taskPersistence.findByRequest({ requestId, action, agentRef });
    if (!persisted || !persisted.callerIntentHash) return null;
    if (persisted.callerIntentHash !== expectedHash) {
      throw new Error(`requestId ${requestId} was already used for a different Codex caller intent`);
    }
    if (persisted.toolError) throw new Error(persisted.toolError);
    const live = taskRecords.get(persisted.taskRef);
    if (live) return preparedCardState(live);
    return recoveredTaskState(persisted.taskRef);
  }

  async function existingRequestState({ requestId, action, payload, agentRef = null }) {
    if (!taskPersistence) return null;
    const persisted = taskPersistence.findByRequest({ requestId, action, agentRef });
    if (!persisted) return null;
    const payloadHash = taskPayloadHash(action, payload, agentRef);
    if (persisted.payloadHash && persisted.payloadHash !== payloadHash) {
      throw new Error(`requestId ${requestId} was already used for a different Codex task payload`);
    }
    const live = taskRecords.get(persisted.taskRef);
    if (live) return preparedCardState(live);
    return recoveredTaskState(persisted.taskRef);
  }

  function rememberPrepared({ consent, action, payload, cwd = null, permissionProfile = null, agentRef = null }) {
    const existing = preparedMetered.get(consent.consentRef);
    if (existing) return existing;
    const { taskRef, shortTaskId } = newTaskIdentity();
    const record = {
      taskRef,
      taskId: shortTaskId ?? taskRef,
      shortTaskId,
      consent,
      action,
      payload,
      payloadHash: taskPayloadHash(action, payload, agentRef),
      callerIntentHash: callerIntentHash(action, payload, agentRef),
      cwd,
      permissionProfile,
      subjectRef: agentRef,
      agentRef,
      authorized: false,
      turnId: null,
      terminalSnapshot: null,
      toolError: null,
      declinedAt: null,
      portableTaskBody: boundedPortableBody(action === "start" ? payload?.prompt : payload?.message),
      taskCard: taskCardFor({ taskRef, shortTaskId, requestId: consent.requestId, action, payload, cwd, permissionProfile, quota: consent.quota }),
    };
    preparedMetered.set(consent.consentRef, record);
    taskRecords.set(taskRef, record);
    persistRecord(record, null, "pending");
    return record;
  }

  function directRecord({ action, payload, cwd = null, permissionProfile = null, agentRef = null, requestId }) {
    const { taskRef, shortTaskId } = newTaskIdentity();
    const consent = { consentRef: null, requestId, quota: null };
    const record = {
      taskRef,
      taskId: shortTaskId ?? taskRef,
      shortTaskId,
      consent,
      action,
      payload,
      payloadHash: taskPayloadHash(action, payload, agentRef),
      callerIntentHash: callerIntentHash(action, payload, agentRef),
      cwd,
      permissionProfile,
      subjectRef: agentRef,
      agentRef,
      authorized: false,
      turnId: null,
      terminalSnapshot: null,
      toolError: null,
      declinedAt: null,
      portableTaskBody: boundedPortableBody(action === "start" ? payload?.prompt : payload?.message),
      taskCard: taskCardFor({ taskRef, shortTaskId, requestId, action, payload, cwd, permissionProfile, quota: null }),
    };
    taskRecords.set(taskRef, record);
    persistRecord(record, null, "pending");
    return record;
  }

  function cardForAgent(agentRef) {
    return agentRef ? agentCards.get(agentRef) ?? null : null;
  }

  function freezeRecord(record, payload) {
    if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
    const frozen = {
      ...structuredClone(payload),
      taskRef: record.taskRef,
      taskId: record.shortTaskId ?? record.taskRef,
      shortTaskId: record.shortTaskId ?? null,
      taskCard: structuredClone(record.taskCard),
      canSend: false,
      terminal: true,
      terminalAt: Date.now(),
    };
    const suppressTerminalFallback = record.suppressTerminalFallback === true || frozen.suppressManualFallback === true;
    if (suppressTerminalFallback) {
      frozen.suppressManualFallback = true;
      delete frozen.manualFallback;
      delete frozen.chatPresentation;
    } else if (!frozen.chatPresentation) {
      const presentation = chatPresentation(frozen);
      if (presentation) frozen.chatPresentation = presentation;
    }
    frozen.resultSummary = compactOneLine(frozen.finalResult ?? frozen.latestError ?? terminalLabel(frozen.status), 600);
    record.terminalSnapshot = frozen;
    persistRecord(record, frozen, "terminal");
    return structuredClone(frozen);
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
        requestedModel: typeof record.payload?.model === "string" ? record.payload.model : null,
        ...(typeof record.payload?.reasoningEffort === "string" ? { requestedReasoningEffort: record.payload.reasoningEffort } : {}),
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      },
      latestError: "Task-specific terminal state was not observed before this agent advanced. The original task will not be replayed.",
      events: [],
      nextSeq: 0,
      meteredConsent: { status: "approved", quota: record.consent.quota },
    });
  }

  async function freezeCurrentTaskForAgent(agentRef) {
    if (!agentRef) return;
    const snapshot = await agentExecutor.show({ agentRef, afterSeq: 0 });
    if (!isTerminalStatus(snapshot?.status)) return;
    for (const record of taskRecords.values()) {
      if (record.agentRef !== agentRef || record.terminalSnapshot) continue;
      if (!record.turnId && cardForAgent(agentRef)?.taskRef === record.taskRef) record.turnId = snapshot.turnId ?? null;
      if (!record.turnId || snapshot.turnId !== record.turnId) continue;
      freezeRecord(record, {
        ...publicAgentSnapshot(snapshot, record.taskCard, { portableTaskBody: record.portableTaskBody }),
        taskRef: record.taskRef,
        taskId: record.shortTaskId ?? record.taskRef,
        shortTaskId: record.shortTaskId ?? null,
        meteredConsent: { status: "approved", quota: record.consent.quota },
      });
    }
  }

  async function preparedCardState(record) {
    if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
    if (record.toolError) throw new Error(record.toolError);
    if (!record.authorized) {
      const pending = consentRequiredSnapshot({ agentRef: record.agentRef, consent: record.consent, taskCard: record.taskCard, portableTaskBody: record.portableTaskBody });
      pending.taskRef = record.taskRef;
      pending.taskId = record.shortTaskId ?? record.taskRef;
      pending.shortTaskId = record.shortTaskId ?? null;
      pending.turnId = null;
      pending.timing = { startedAt: null, endedAt: null, durationMs: null };
      pending.execution = {
        requestedModel: typeof record.payload?.model === "string" ? record.payload.model : null,
        ...(typeof record.payload?.reasoningEffort === "string" ? { requestedReasoningEffort: record.payload.reasoningEffort } : {}),
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      };
      return pending;
    }
    if (!record.agentRef) throw new Error("prepared Codex task is authorized but its agentRef is not available yet");
    const snapshot = await agentExecutor.show({ agentRef: record.agentRef, afterSeq: 0 });
    if (!record.turnId && snapshot.turnId) record.turnId = snapshot.turnId;
    if (record.turnId && snapshot.turnId !== record.turnId) return lostRecord(record);
    const payload = {
      ...publicAgentSnapshot(snapshot, record.taskCard, { portableTaskBody: record.portableTaskBody }),
      taskRef: record.taskRef,
      taskId: record.shortTaskId ?? record.taskRef,
      shortTaskId: record.shortTaskId ?? null,
      meteredConsent: { status: "approved", quota: record.consent.quota },
    };
    if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
    return payload;
  }

  function preparedRecordByTaskId(taskId) {
    const matches = [...taskRecords.values()].filter((record) => record.taskId === taskId || record.shortTaskId === taskId);
    if (matches.length !== 1) throw new Error("unknown, stale, or ambiguous prepared Codex task ID");
    const record = matches[0];
    if (!record.consent?.consentRef) throw new Error("prepared Codex task ID is not bound to a pending metered decision");
    return record;
  }

  function declinePrepared(record) {
    if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
    if (record.authorized) throw new Error("prepared Codex task already started and cannot be declined as a pre-call task");
    record.declinedAt = Date.now();
    record.suppressTerminalFallback = true;
    return freezeRecord(record, {
      agentRef: record.agentRef,
      turnId: null,
      status: "rejected",
      suppressManualFallback: true,
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
      meteredConsent: { status: "rejected", quota: record.consent.quota },
    });
  }

  async function dispatchPrepared(record) {
    assertFormalAgentAvailable();
    if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
    if (record.declinedAt) return structuredClone(record.terminalSnapshot ?? lostRecord(record));
    if (record.toolError) throw new Error(record.toolError);
    if (record.authorized) return { ...(await preparedCardState(record)), duplicate: true };
    if (taskPersistence && !persistRecord(record, null, "pending")) {
      throw new Error("Codex task was not started because durable prepared-task state could not be recorded safely");
    }
    if (record.action === "start") {
      const currentAuthority = await resolveFormalAgentStartAuthority(record.cwd);
      if (currentAuthority.effectiveCwd !== record.cwd || currentAuthority.permissionProfile !== record.permissionProfile) {
        throw new Error("prepared Codex task authority changed; prepare and approve a new task");
      }
    } else if (record.payload?.parentTurnId) {
      const current = await agentExecutor.show({ agentRef: record.agentRef, afterSeq: 0 });
      if (current.turnId !== record.payload.parentTurnId || current.status !== "idle" || current.canSend !== true) {
        throw new Error("prepared Codex follow-up is stale because the agent advanced; prepare a new task for the current turn");
      }
    }
    const consent = await meteredConsent.authorize({
      action: record.action,
      requestId: record.consent.requestId,
      subjectRef: record.action === "send" ? record.agentRef : null,
      payload: record.payload,
      consentRef: record.consent.consentRef,
    });
    if (!consent.authorized) throw new Error("metered consent was not authorized for the prepared task");
    record.authorized = true;

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
        record.toolError = error instanceof Error ? error.message : String(error);
        persistRecord(record, null, "error");
        throw error;
      }
      if (snapshot?.agentRef) {
        record.agentRef = snapshot.agentRef;
        record.turnId = snapshot.turnId ?? null;
        agentCards.set(snapshot.agentRef, record.taskCard);
      }
      const payload = {
        ...publicAgentSnapshot(snapshot, record.taskCard, { portableTaskBody: record.portableTaskBody }),
        taskRef: record.taskRef,
        taskId: record.shortTaskId ?? record.taskRef,
        shortTaskId: record.shortTaskId ?? null,
        meteredConsent: { status: "approved", quota: record.consent.quota },
      };
      if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
      persistRecord(record, payload, "active");
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
      record.toolError = error instanceof Error ? error.message : String(error);
      persistRecord(record, null, "error");
      throw error;
    }
    record.turnId = snapshot.turnId ?? null;
    if (record.agentRef) agentCards.set(record.agentRef, record.taskCard);
    const payload = {
      ...publicAgentSnapshot(snapshot, record.taskCard, { portableTaskBody: record.portableTaskBody }),
      taskRef: record.taskRef,
      taskId: record.shortTaskId ?? record.taskRef,
      shortTaskId: record.shortTaskId ?? null,
      meteredConsent: { status: "approved", quota: record.consent.quota },
    };
    if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
    persistRecord(record, payload, "active");
    return payload;
  }


  if (codexCallProfile) {
    server.registerTool(
      "codex.call_profile",
      {
        title: "Codex Call Profile",
        description:
          "Read or explicitly update the user-local Codex Call Profile. The Profile body is a recurring natural-language instruction for the calling AI: it may describe when Codex should be used, how large Codex work units should be, how running Codex sessions should be supervised, how waiting time should be used, model/reasoning selection rules (including multiple tiers or AI judgment), in-turn approval habits at any user-chosen granularity, and how Codex results should be verified and integrated. Codexless does not reduce those instructions to product enums and does not pretend to enforce the AI's semantic judgment. The recommended default instruction is background working policy: do not enumerate or explain its detailed principles to the user unless the user asks about them or chooses Customize Profile. The only hard Profile field is requireCallApproval: unless it is false, every real Codex call must pass the Call Codex consent stage and return the fixed compact Chat approval text. show is read-only. save/delete are durable preference mutations and may be called only after explicit user intent; when the user says things like 'don't ask me about this kind next time' or 'always ask me before this kind', suggest updating the Profile and persist only after confirmation. The saved Profile lives outside the install/package tree and product updates/reinstalls must preserve it; only an explicit Profile mutation or removal may replace or delete it. Updating a configured Profile requires the fresh expectedProfileRevision + expectedProfileHash so another window cannot be overwritten silently. The Profile never expands Codex permissions, sandbox, trusted roots, network, Browser/MCP authority, or any requested permission subset.",
        inputSchema: z.object({
          action: z.enum(["show", "save", "delete"]),
          requireCallApproval: z.boolean().optional()
            .describe("Hard call-stage switch. true = every real Codex call requires Call Codex Card/text approval; false = skip only that call-stage approval."),
          instruction: z.string().max(40_000).optional()
            .describe("Long-term user-authored natural-language instruction for calling rules, task sizing, supervision/follow-through, waiting-time habits, model/reasoning strategy, in-turn approvals, and result verification/integration."),
          expectedProfileRevision: z.number().int().min(1).optional()
            .describe("Required when updating an existing configured Profile; copy the exact revision from a fresh show."),
          expectedProfileHash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional()
            .describe("Required when updating an existing configured Profile; copy the exact SHA-256 hash from a fresh show."),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ action, requireCallApproval, instruction, expectedProfileRevision, expectedProfileHash }) => structured(async () => {
        if (action === "show") {
          if (requireCallApproval !== undefined || instruction !== undefined || expectedProfileRevision !== undefined || expectedProfileHash !== undefined) {
            throw new Error("codex.call_profile show accepts no settings");
          }
          const profile = readCallProfile();
          return {
            ...publicCallProfile(profile),
            ...(profile.status === "configured" ? {} : { setupInstruction: unconfiguredCodexCallInstruction() }),
          };
        }
        if (action === "delete") {
          if (requireCallApproval !== undefined || instruction !== undefined || expectedProfileRevision !== undefined || expectedProfileHash !== undefined) {
            throw new Error("codex.call_profile delete accepts no settings");
          }
          const profile = deleteCodexCallProfile({ filePath: callProfilePath });
          return { ...publicCallProfile(profile), setupInstruction: unconfiguredCodexCallInstruction() };
        }

        const currentProfile = readCallProfile();
        if (currentProfile.status === "configured") {
          if (!Number.isInteger(expectedProfileRevision) || typeof expectedProfileHash !== "string") {
            throw new Error("codex.call_profile save must include expectedProfileRevision and expectedProfileHash from a fresh show when updating an existing Profile");
          }
          if (requireCallApproval === undefined && instruction === undefined) {
            throw new Error("codex.call_profile save requires at least one Profile setting to change when updating an existing Profile");
          }
        }
        const selectedRequireCallApproval = requireCallApproval !== undefined
          ? requireCallApproval
          : currentProfile.status === "configured" && currentProfile.effective?.requireCallApproval === false
            ? false
            : true;
        const selectedInstruction = instruction !== undefined
          ? instruction
          : currentProfile.status === "configured" && typeof currentProfile.instruction === "string"
            ? currentProfile.instruction
            : DEFAULT_CODEX_CALL_PROFILE_INSTRUCTION;
        const profile = saveCodexCallProfile({
          filePath: callProfilePath,
          requireCallApproval: selectedRequireCallApproval,
          instruction: selectedInstruction,
          expectedProfileRevision: currentProfile.status === "configured" ? expectedProfileRevision : expectedProfileRevision ?? null,
          expectedProfileHash: currentProfile.status === "configured" ? expectedProfileHash : expectedProfileHash ?? null,
        });
        return publicCallProfile(profile);
      })
    );
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
    async ({ cursor, limit, includeHidden }) => structured(async () => catalogProvider.listModels({
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
        `Experimental Preview. Start one formal Codex agent thread/turn under Codexless's locally resolved authority. Before calling, read and apply the current Codex Call Profile to task sizing, model/reasoning choice, supervision, and in-turn approval habits. invocationRationale records why this task needs Codex. requireCallApproval is the only hard call-stage switch: only an explicit false from a valid configured Profile may skip Call Approval; true, missing, unreadable, invalid, field-missing, or unknown Profile state fails closed. When approval is required, this tool prepares one exact server-bound task and returns consent_required plus fixed compact chatPresentation text with an exact Task ID. The next user-visible assistant response MUST equal the returned content[0].text / chatPresentation.text verbatim, with no prose before or after, no summary, rewrite, reordering, translation, or field omission; do not reconstruct it from structuredContent. Then map the user's literal Yes / No only to codex.agent_commit or codex.agent_decline with that exact taskId. Do not retry agent_start as an approval action. Pass presentationLocale from the current Chat/Host when available; service-machine locale is not user-language authority. When requireCallApproval is false, Codex starts immediately. RUNNING is authoritative but has no mechanical presentation: keep responsibility for the work unit, supervise it according to the bound Profile, and use waiting time for non-conflicting work. requestId is a caller-stable idempotency key and MUST be reused only for retries of the same logical start.${agentReasoningEffort ? " reasoningEffort is validated against the current effective model catalog; no global effort enum is hard-coded." : ""} If the returned state is awaitingApproval, apply explicit current-task user instructions first, otherwise the valid bound Profile, and use the recommended default only when the Profile is missing. If user confirmation is actually required, present the returned conspicuous ordinary-text decision with exact Task ID/action/scope/reason/risk and literal Yes / No. Durable user corrections should prompt an offer to update the Profile, never a silent write. The caller cannot choose or widen Codex permission profile, sandbox, roots, network authority, or other authority ceilings.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(200_000),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key. Reuse this exact value for retries of the same logical start."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional execution-directory context. Codexless resolves authority locally for this cwd; cwd is not a permission selector."),
        presentationLocale: z.string().min(2).max(64).optional()
          .describe("Optional current Chat/Host locale (for example zh-CN, ja-JP, en-US) used only for the fixed approval/result text. It is bound to the prepared task and never changes Codex authority."),
        model: z.string().min(1).max(512).optional()
          .describe("Optional exact model id from codex.model_list. Omit to use Codex's current default model routing."),
        ...(agentReasoningEffort ? {
          reasoningEffort: z.string().min(1).max(128).optional()
            .describe("Optional reasoning effort string supported by the effective model's current codex.model_list entry. Runtime validation is per-model; no global effort enum is hard-coded."),
        } : {}),
        ...(codexCallProfile ? {
          invocationRationale: z.string().min(1).max(4_000)
            .describe("Free-form current-task reason why the caller decided Codex should be used after applying the Profile instruction. Shown as Why Codex; this is not a routing enum."),
          profileDecision: z.enum(["skip_once"]).optional()
            .describe("Legacy compatibility input from the earlier Profile-setup interstitial. It never bypasses Call Codex approval; missing, invalid, unreadable, or otherwise unknown Profile state remains fail-closed."),
        } : {}),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Preparing Codex task…",
        "openai/toolInvocation/invoked": "Codex task ready.",
      },
    },
    async ({ prompt, requestId, cwd, presentationLocale, model, reasoningEffort, invocationRationale, profileDecision }, toolContext) => structuredCard(async () => {
      assertFormalAgentAvailable();
      const resolvedPresentationLocale = resolvePresentationLocale(presentationLocale, toolContext);

      const startCallerIntent = {
        prompt,
        callerCwd: cwd ?? null,
        presentationLocale: resolvedPresentationLocale,
        callerModel: model ?? null,
        callerReasoningEffort: agentReasoningEffort ? reasoningEffort ?? null : null,
        ...(codexCallProfile ? {
          callerInvocationRationale: invocationRationale ?? null,
        } : {}),
      };
      const priorByCallerIntent = await existingRequestByCallerIntent({
        requestId,
        action: "start",
        payload: startCallerIntent,
        agentRef: null,
      });
      if (priorByCallerIntent) return { ...priorByCallerIntent, duplicate: true };

      const loadedProfile = readCallProfile();
      const activeProfile = loadedProfile.status === "configured"
        ? loadedProfile
        : {
            ...loadedProfile,
            effective: { requireCallApproval: true },
            instruction: loadedProfile.status === "missing" ? DEFAULT_CODEX_CALL_PROFILE_INSTRUCTION.trim() : "",
            legacy: false,
          };
      const boundInvocationRationale = codexCallProfile
        ? invocationRationale.trim()
        : null;
      const boundProfile = callProfileSnapshot(activeProfile);

      const authority = await resolveFormalAgentStartAuthority(cwd ?? null);
      const callerPayload = {
        prompt,
        callerCwd: cwd ?? null,
        cwd: authority.effectiveCwd,
        presentationLocale: resolvedPresentationLocale,
        callerModel: model ?? null,
        model: model ?? null,
        callerReasoningEffort: agentReasoningEffort ? reasoningEffort ?? null : null,
        permissionProfile: authority.permissionProfile,
        ...(codexCallProfile ? {
          callerInvocationRationale: invocationRationale ?? null,
          invocationRationale: boundInvocationRationale,
        } : {}),
        ...(agentReasoningEffort && reasoningEffort !== undefined
          ? { reasoningEffort }
          : {}),
        ...(boundProfile ? { callProfile: boundProfile } : {}),
      };

      const prior = await existingRequestState({ requestId, action: "start", payload: callerPayload, agentRef: null });
      if (prior) return { ...prior, duplicate: true };

      let preparedSelection = null;
      if (agentPortableCard && meteredConsent.mode === "always") {
        try {
          preparedSelection = await resolvePreparedModelSelection({
            requestedModel: model ?? null,
            requestedReasoningEffort: agentReasoningEffort ? reasoningEffort ?? null : null,
          });
        } catch (error) {
          throw new Error(
            `Codex model/reasoning selection is not currently valid: ${error instanceof Error ? error.message : String(error)}. ` +
            "Re-read codex.model_list and apply the current Profile instruction again; do not silently substitute a user-named choice unless the Profile allows it."
          );
        }
      }

      const payload = preparedSelection ? {
        ...callerPayload,
        model: preparedSelection.selectedModel,
        ...(agentReasoningEffort && typeof preparedSelection.selectedReasoningEffort === "string"
          ? { reasoningEffort: preparedSelection.selectedReasoningEffort }
          : {}),
        modelSelection: preparedSelection,
      } : callerPayload;

      const consent = await authorizeForProfile({
        action: "start",
        requestId,
        payload,
        requireCallApproval: boundProfile?.effective?.requireCallApproval !== false,
      });

      if (!consent.authorized) {
        const record = rememberPrepared({
          consent: consent.consent,
          action: "start",
          payload,
          cwd: authority.effectiveCwd,
          permissionProfile: authority.permissionProfile,
        });
        if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
        const pending = consentRequiredSnapshot({ consent: consent.consent, taskCard: record.taskCard, portableTaskBody: record.portableTaskBody });
        pending.taskRef = record.taskRef;
        pending.taskId = record.shortTaskId ?? record.taskRef;
        pending.shortTaskId = record.shortTaskId ?? null;
        pending.turnId = null;
        pending.callProfile = boundProfile;
        pending.timing = { startedAt: null, endedAt: null, durationMs: null };
        pending.execution = {
          requestedModel: payload.model ?? null,
          ...(agentReasoningEffort && typeof payload.reasoningEffort === "string"
            ? { requestedReasoningEffort: payload.reasoningEffort }
          : {}),
          resolvedModel: null,
          modelProvider: null,
          serviceTier: null,
          reasoningEffort: null,
        };
        return pending;
      }

      if (consent.autoCommittedByProfile && consent.consent) {
        const record = rememberPrepared({
          consent: consent.consent,
          action: "start",
          payload,
          cwd: authority.effectiveCwd,
          permissionProfile: authority.permissionProfile,
        });
        return dispatchPrepared(record);
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

  if (legacyAgentCardInternals) {
    server.registerTool(
    "codex.agent_card_render",
    {
      title: "Render Codex Task Card",
      description:
        "Internal historical renderer retained only for bounded diagnostics. It reads one exact server-bound task state and never participates in the normal approval/result correctness path or dispatch authority.",
      inputSchema: z.object({
        taskRef: z.string().min(1).max(512).optional(),
        consentRef: z.string().min(1).max(512).optional(),
      }).strict(),
      outputSchema: z.object({
        taskRef: z.string().nullable().optional(),
        taskId: z.string().nullable().optional(),
        agentRef: z.string().nullable().optional(),
        turnId: z.string().nullable().optional(),
        status: z.string().optional(),
        canSend: z.boolean().optional(),
        pendingApproval: z.unknown().nullable().optional(),
        meteredConsent: z.unknown().nullable().optional(),
        taskCard: z.unknown().nullable().optional(),
        finalResult: z.unknown().nullable().optional(),
        resourceReceipt: z.unknown().nullable().optional(),
        renderDelivery: z.object({
          renderDataReady: z.boolean(),
          userVisibleRender: z.literal("unconfirmed_by_codexless"),
          confirmationAuthority: z.literal("host"),
          portableFallbackRequiredUnlessHostConfirmed: z.boolean(),
        }).optional(),
        timing: z.unknown().optional(),
        execution: z.unknown().optional(),
        latestError: z.string().nullable().optional(),
        events: z.array(z.unknown()).optional(),
        nextSeq: z.number().int().optional(),
        manualFallback: z.unknown().nullable().optional(),
        chatPresentation: z.unknown().nullable().optional(),
        duplicate: z.boolean().optional(),
        controlAcceptance: z.string().optional(),
        terminal: z.boolean().optional(),
        terminalAt: z.number().optional(),
        resultSummary: z.string().nullable().optional(),
        error: z.string().optional(),
      }).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        ui: { resourceUri: AGENT_TASK_CARD_URI, visibility: ["app"] },
        "openai/outputTemplate": AGENT_TASK_CARD_URI,
        "openai/toolInvocation/invoking": "Opening Codex task…",
        "openai/toolInvocation/invoked": "Codex task ready.",
      },
    },
    async ({ taskRef, consentRef }) => structuredCard(async () => {
      if ((taskRef ? 1 : 0) + (consentRef ? 1 : 0) !== 1) {
        throw new Error("exactly one of taskRef or consentRef is required");
      }
      const renderDelivery = {
        renderDataReady: true,
        userVisibleRender: "unconfirmed_by_codexless",
        confirmationAuthority: "host",
        portableFallbackRequiredUnlessHostConfirmed: false,
      };
      if (taskRef) {
        const live = taskRecords.get(taskRef);
        if (live) return { ...(await preparedCardState(live)), renderDelivery };
        const recovered = recoveredTaskState(taskRef);
        if (recovered) return { ...recovered, renderDelivery };
        throw new Error("unknown or stale Codex taskRef");
      }
      const record = preparedMetered.get(consentRef);
      if (!record) throw new Error("unknown or stale prepared metered consentRef");
      return { ...(await preparedCardState(record)), renderDelivery };
    })
  );

  server.registerTool(
    "codex.agent_card_state",
    {
      title: "Read Codex Task Card State",
      description:
        "Internal historical read-only task-state endpoint retained only for bounded diagnostics. Persisted terminal snapshots survive restarts; persisted non-terminal tasks recover as LOST/uncertain and are never replayed.",
      inputSchema: z.object({
        taskRef: z.string().min(1).max(512).optional(),
        consentRef: z.string().min(1).max(512).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ taskRef, consentRef }) => structured(async () => {
      if (!taskRef && !consentRef) throw new Error("taskRef or consentRef is required");
      if (taskRef) {
        const live = taskRecords.get(taskRef);
        if (live) return preparedCardState(live);
        const recovered = recoveredTaskState(taskRef);
        if (recovered) return recovered;
      }
      if (consentRef) {
        const legacy = preparedMetered.get(consentRef);
        if (legacy) return preparedCardState(legacy);
      }
      throw new Error("unknown or stale Codex task card reference");
    })
  );

  }

  server.registerTool(
    "codex.agent_show",
    {
      title: "Show Codex Agent",
      description:
        "Experimental Preview. Read the bounded operational state of one Codexless-owned Codex agent by opaque agentRef. Returns status, sendability, minimal pending-approval summary, a conservative approvalRiskReference, final result, and a bounded event tail; it does not duplicate the Codex transcript. approvalRiskReference is internal default guidance for the common 'handle routine low-risk actions for me' instruction, not a server-side decision and not an override of a more specific user-authored Profile rule. The caller must apply the in-turn priority rule to each pending action: explicit current-task user instruction first, otherwise the valid bound Profile, and the recommended default only when the Profile is missing. If the user expresses a durable preference such as 'don't ask me about this kind next time' or 'always ask me before this kind', offer to update the Profile and persist only after explicit confirmation.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        afterSeq: z.number().int().min(0).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ agentRef, afterSeq }) => structured(async () => {
      const snapshot = await agentExecutor.show({ agentRef, afterSeq: afterSeq ?? 0 });
      const card = cardForAgent(agentRef);
      const record = card?.taskRef ? taskRecords.get(card.taskRef) ?? null : null;
      const suppress = isTerminalStatus(snapshot?.status)
        && (record?.suppressTerminalFallback === true || record?.terminalSnapshot?.suppressManualFallback === true)
        && (!record?.turnId || !snapshot?.turnId || record.turnId === snapshot.turnId);
      return publicAgentSnapshot(snapshot, card, {
        suppressManualFallback: suppress,
        portableTaskBody: record?.portableTaskBody ?? null,
      });
    })
  );

  server.registerTool(
    "codex.agent_send",
    {
      title: "Continue Codex Agent",
      description:
        `Experimental Preview. Continue one exact Codexless-owned agent by opaque agentRef. The start-bound Codex Call Profile snapshot remains attached to the thread so its hard requireCallApproval setting and user instruction stay stable for this running task. Apply that instruction again before each follow-up. model/reasoning are explicit per-call choices; if omitted, keep the current thread selection. Unless the bound Profile explicitly sets requireCallApproval=false, each logical follow-up prepares one exact server-bound task and returns consent_required plus fixed compact chatPresentation text with an exact Task ID. The next user-visible assistant response MUST equal the returned content[0].text / chatPresentation.text verbatim, with no prose before or after, no summary, rewrite, reordering, translation, or field omission; do not reconstruct it from structuredContent. Then map literal Yes / No only to codex.agent_commit or codex.agent_decline with that exact taskId. Do not retry agent_send as an approval action. Pass presentationLocale from the current Chat/Host when available. If Call Approval is skipped, the follow-up starts immediately. RUNNING has no mechanical presentation. requestId is caller-stable and MUST be reused only for retries of the same logical send.${agentReasoningEffort ? " reasoningEffort is validated against the current effective model catalog." : ""} If an in-turn action becomes pending, apply explicit current-task instructions first, otherwise the valid bound Profile, and the recommended default only when the Profile is missing. If user confirmation is required, present the returned conspicuous ordinary-text decision with exact Task ID/action/scope/reason/risk and literal Yes / No. Active turns, stale parent turns, and pre-existing pending approvals fail visibly; Codexless never auto-replays an accepted or uncertain send.`,
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        message: z.string().min(1).max(200_000),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key. Reuse this exact value for retries of the same logical send."),
        presentationLocale: z.string().min(2).max(64).optional()
          .describe("Optional current Chat/Host locale used only for the fixed approval/result text. It is bound to this prepared follow-up and never changes Codex authority."),
        model: z.string().min(1).max(512).optional()
          .describe("Optional exact model id from codex.model_list. Omit to keep the current Codex thread model."),
        ...(agentReasoningEffort ? {
          reasoningEffort: z.string().min(1).max(128).optional()
            .describe("Optional per-turn reasoning effort supported by the effective model's current codex.model_list entry. Runtime validation is per-model; no global effort enum is hard-coded."),
        } : {}),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Preparing Codex follow-up…",
        "openai/toolInvocation/invoked": "Codex follow-up ready.",
      },
    },
    async ({ agentRef, message, requestId, presentationLocale, model, reasoningEffort }, toolContext) => structuredCard(async () => {
      assertFormalAgentAvailable();
      const resolvedPresentationLocale = resolvePresentationLocale(presentationLocale, toolContext);
      const sendCallerIntent = {
        message,
        presentationLocale: resolvedPresentationLocale,
        callerModel: model ?? null,
        callerReasoningEffort: agentReasoningEffort ? reasoningEffort ?? null : null,
      };

      const priorByCallerIntent = await existingRequestByCallerIntent({
        requestId,
        action: "send",
        payload: sendCallerIntent,
        agentRef,
      });
      if (priorByCallerIntent) return { ...priorByCallerIntent, duplicate: true };

      const parentCard = cardForAgent(agentRef);
      const boundProfile = codexCallProfile && parentCard?.callProfile
        ? structuredClone(parentCard.callProfile)
        : null;
      const current = await agentExecutor.show({ agentRef, afterSeq: 0 });
      if (current.status !== "idle" || current.canSend !== true || !current.turnId) {
        throw new Error(`agent ${agentRef} is not ready for a follow-up: ${current.status}`);
      }

      const requestedModel = model ?? null;
      const requestedEffort = agentReasoningEffort ? reasoningEffort ?? null : null;

      let preparedSelection = null;
      if (agentPortableCard && meteredConsent.mode === "always") {
        try {
          preparedSelection = await resolvePreparedModelSelection({
            requestedModel,
            requestedReasoningEffort: requestedEffort,
            currentModel: current.execution?.resolvedModel ?? null,
            currentReasoningEffort: current.execution?.reasoningEffort ?? null,
          });
        } catch (error) {
          throw new Error(
            `Codex follow-up model/reasoning selection is not currently valid: ${error instanceof Error ? error.message : String(error)}. ` +
            "Re-read the current catalog and apply the bound Profile instruction again; do not silently substitute a user-named choice unless that instruction allows it."
          );
        }
      }

      const payload = {
        message,
        presentationLocale: resolvedPresentationLocale,
        callerModel: model ?? null,
        callerReasoningEffort: agentReasoningEffort ? reasoningEffort ?? null : null,
        model: preparedSelection?.selectedModel ?? requestedModel ?? null,
        ...(preparedSelection ? { modelSelection: preparedSelection } : {}),
        ...(agentReasoningEffort && (preparedSelection?.selectedReasoningEffort ?? requestedEffort) !== null && (preparedSelection?.selectedReasoningEffort ?? requestedEffort) !== undefined
          ? { reasoningEffort: preparedSelection?.selectedReasoningEffort ?? requestedEffort }
          : {}),
        parentTurnId: current.turnId,
        permissionProfile: parentCard?.permissionProfile ?? null,
        ...(boundProfile ? { callProfile: boundProfile } : {}),
      };

      const prior = await existingRequestState({ requestId, action: "send", payload, agentRef });
      if (prior) return { ...prior, duplicate: true };

      if (meteredConsent.mode === "off") {
        return dispatchPrepared(directRecord({
          action: "send",
          payload,
          cwd: parentCard?.cwd ?? null,
          permissionProfile: parentCard?.permissionProfile ?? null,
          agentRef,
          requestId,
        }));
      }

      const consent = await authorizeForProfile({
        action: "send",
        requestId,
        subjectRef: agentRef,
        payload,
        requireCallApproval: boundProfile?.effective?.requireCallApproval !== false,
      });
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
        const pending = consentRequiredSnapshot({ agentRef, consent: consent.consent, taskCard: record.taskCard, portableTaskBody: record.portableTaskBody });
        pending.taskRef = record.taskRef;
        pending.taskId = record.shortTaskId ?? record.taskRef;
        pending.shortTaskId = record.shortTaskId ?? null;
        pending.turnId = null;
        pending.callProfile = boundProfile;
        pending.timing = { startedAt: null, endedAt: null, durationMs: null };
        pending.execution = {
          requestedModel: payload.model ?? null,
          ...(agentReasoningEffort && typeof payload.reasoningEffort === "string" ? { requestedReasoningEffort: payload.reasoningEffort } : {}),
          resolvedModel: current.execution?.resolvedModel ?? null,
          modelProvider: current.execution?.modelProvider ?? null,
          serviceTier: current.execution?.serviceTier ?? null,
          reasoningEffort: current.execution?.reasoningEffort ?? null,
        };
        return pending;
      }

      if (consent.autoCommittedByProfile && consent.consent) {
        const record = rememberPrepared({
          consent: consent.consent,
          action: "send",
          payload,
          cwd: parentCard?.cwd ?? null,
          permissionProfile: parentCard?.permissionProfile ?? null,
          agentRef,
        });
        return dispatchPrepared(record);
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
      title: "Decline Prepared Codex Task",
      description:
        "Decline exactly one prepared Call Approval by the exact Task ID shown in the fixed approval text. The Task ID resolves only to the existing server-bound prepared record; no prompt/message, cwd, model, reasoningEffort, subject, or authority fields can be replaced here. Decline never starts Codex work, seals this prepared approval terminally, and an exact duplicate or later stale Yes cannot revive it. A changed task requires a fresh requestId and a newly prepared Task ID.",
      inputSchema: z.object({
        taskId: z.string().min(1).max(512)
          .describe("Exact Task ID from the currently presented fixed Call Approval text."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskId }) => structuredCard(async () => declinePrepared(preparedRecordByTaskId(taskId)))
  );

  server.registerTool(
    "codex.agent_commit",
    {
      title: "Approve Prepared Codex Task",
      description:
        "Approve exactly one prepared Call Approval by the exact Task ID shown in the fixed approval text. Codexless resolves the existing server-bound record and dispatches only its already bound action, requestId, prompt/message, cwd, model, reasoningEffort, subject, and permission profile; this tool accepts no replacements or authority overrides. Exact duplicate commits return the same task state and never create a second logical start/send. Unknown, stale, consumed, or ambiguous Task IDs fail closed.",
      inputSchema: z.object({
        taskId: z.string().min(1).max(512)
          .describe("Exact Task ID from the currently presented fixed Call Approval text."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => structuredCard(async () => dispatchPrepared(preparedRecordByTaskId(taskId)))
  );

  server.registerTool(
    "codex.agent_approve",
    {
      title: "Approve Pending Codex Agent Action",
      description:
        "Experimental Preview. Resolve exactly the currently pending Codex approval identified by approvalRequestId using Codex's narrow one-turn approval response. Call only after either (a) the user explicitly approves this exact action, or (b) the caller has applied the bound natural-language Codex Call Profile to this exact action and reasonably concluded that the user's rule permits approval without another prompt. approvalRiskReference from agent_show is conservative default guidance only; specific user-authored rules may be stricter or more permissive within the existing Codex authority ceiling. Unknown or ambiguous Profile meaning should come back to the user. Current-task explicit user instructions take priority over the Profile for this in-turn decision, while never bypassing the hard Call Codex gate. If asking the user, use the returned visually separate ordinary-text confirmation with exact Task ID, action, scope, reason, risk, and literal Yes / No. requestId is caller-stable and must be reused for retries of the same logical approval. Codexless never grants permissions beyond the exact subset requested by Codex and this tool cannot widen authority.",
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
      assertFormalAgentAvailable();
      const snapshot = await agentExecutor.resolveApproval({
        agentRef,
        approvalRequestId,
        clientRequestId: requestId,
        decision: "approve",
      });
      const card = cardForAgent(snapshot?.agentRef ?? agentRef);
      const record = card?.taskRef ? taskRecords.get(card.taskRef) ?? null : null;
      return publicAgentSnapshot(snapshot, card, { portableTaskBody: record?.portableTaskBody ?? null });
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
      assertFormalAgentAvailable();
      const snapshot = await agentExecutor.resolveApproval({
        agentRef,
        approvalRequestId,
        clientRequestId: requestId,
        decision: "reject",
      });
      const card = cardForAgent(snapshot?.agentRef ?? agentRef);
      const record = card?.taskRef ? taskRecords.get(card.taskRef) ?? null : null;
      const payload = publicAgentSnapshot(snapshot, card, { portableTaskBody: record?.portableTaskBody ?? null });
      if (record && isTerminalStatus(payload.status) && (!record.turnId || !payload.turnId || record.turnId === payload.turnId)) {
        return freezeRecord(record, payload);
      }
      return payload;
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
      assertFormalAgentAvailable();
      const snapshot = await agentExecutor.cancel({ agentRef, expectedTurnId: expectedTurnId ?? null, clientRequestId: requestId });
      const card = cardForAgent(snapshot?.agentRef ?? agentRef);
      const record = card?.taskRef ? taskRecords.get(card.taskRef) ?? null : null;
      const payload = publicAgentSnapshot(snapshot, card, { portableTaskBody: record?.portableTaskBody ?? null });
      if (record && isTerminalStatus(payload.status) && (!record.turnId || !payload.turnId || record.turnId === payload.turnId)) {
        return freezeRecord(record, payload);
      }
      return payload;
    })
  );

}

function modelVisibleAgentPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const visible = structuredClone(payload);
  delete visible.taskRef;
  delete visible.shortTaskId;
  delete visible.cardRender;
  delete visible.manualFallback;
  delete visible.suppressManualFallback;
  delete visible.taskCard;
  if (visible.meteredConsent && typeof visible.meteredConsent === "object") {
    visible.meteredConsent = {
      status: visible.meteredConsent.status ?? null,
      expiresAt: Number.isFinite(visible.meteredConsent.expiresAt) ? visible.meteredConsent.expiresAt : null,
      quota: visible.meteredConsent.quota ?? null,
    };
  }
  return visible;
}

function agentContentText(payload) {
  if (payload?.approvalPresentation?.kind === "in_turn_approval" && typeof payload.approvalPresentation.text === "string") {
    return payload.approvalPresentation.text;
  }
  const presentation = payload?.chatPresentation;
  if (presentation && typeof presentation.text === "string" && presentation.text && presentation.mustPresentToUser === true) {
    return presentation.text;
  }
  return JSON.stringify(modelVisibleAgentPayload(payload));
}

async function structuredCard(task) {
  try {
    const payload = await task();
    const visiblePayload = modelVisibleAgentPayload(payload);
    return {
      content: [{ type: "text", text: agentContentText(visiblePayload) }],
      structuredContent: visiblePayload,
      _meta: { toolwireAgentState: payload },
      isError: false,
    };
  } catch (error) {
    const payload = {
      error: error instanceof Error ? error.message : String(error),
      ...(typeof error?.code === "string" && error.code ? { errorCode: error.code } : {}),
      ...(Array.isArray(error?.nextActions) ? { nextActions: [...error.nextActions] } : {}),
    };
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
    const visiblePayload = modelVisibleAgentPayload(payload);
    return {
      content: [{ type: "text", text: agentContentText(visiblePayload) }],
      structuredContent: visiblePayload,
      isError: false,
    };
  } catch (error) {
    const payload = {
      error: error instanceof Error ? error.message : String(error),
      ...(typeof error?.code === "string" && error.code ? { errorCode: error.code } : {}),
      ...(Array.isArray(error?.nextActions) ? { nextActions: [...error.nextActions] } : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
