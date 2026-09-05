export const AGENT_TASK_CARD_URI = "ui://toolwire/codex-task-card-v13.html";
export const AGENT_TASK_CARD_LEGACY_URIS = Object.freeze([
  "ui://toolwire/codex-task-card-v12.html",
  "ui://toolwire/codex-task-card-v11.html",
]);

export function registerAgentTaskCardResource(server) {
  const resources = [
    { name: "toolwire-codex-task-card", uri: AGENT_TASK_CARD_URI },
    ...AGENT_TASK_CARD_LEGACY_URIS.map((uri, index) => ({ name: `toolwire-codex-task-card-legacy-${index + 1}`, uri })),
  ];
  for (const resource of resources) {
    server.registerResource(resource.name, resource.uri, {}, async () => ({
      contents: [{
        uri: resource.uri,
        mimeType: "text/html;profile=mcp-app",
        text: AGENT_TASK_CARD_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    }));
  }
}

const AGENT_TASK_CARD_HTML = String.raw`
<style>
  #actions button {
    appearance:none;
    -webkit-appearance:none;
    font-family:inherit;
    background:rgba(127,127,127,.10);
    color:inherit !important;
    border:1px solid rgba(127,127,127,.38);
    box-shadow:none;
  }
  #yes, #no {
    flex:1;
    min-width:0;
    min-height:44px;
    padding:8px 12px;
    border-radius:9px;
    font-size:15px;
    font-weight:650;
  }
  #stop {
    flex:1;
    min-height:46px;
    padding:9px 14px;
    border-radius:10px;
    font-size:15px;
    font-weight:650;
  }
  #refresh {
    min-width:50px;
    min-height:46px;
    border-radius:10px;
    font-size:19px;
  }
  #actions button:active { background:rgba(127,127,127,.18); }
  #actions button:disabled { opacity:.48; cursor:wait; }
  @media (min-width:640px) {
    #actions { justify-content:flex-end; gap:8px; }
    #yes, #no { flex:0 0 96px; min-height:38px; padding:7px 12px; font-size:14px; }
    #stop { flex:0 0 112px; min-height:42px; padding:8px 14px; }
    #refresh { min-width:44px; min-height:42px; }
  }
</style>
<div id="card" style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;padding:14px;line-height:1.35">
  <div id="status" style="font-size:19px;font-weight:750">Codex</div>
  <div id="task" style="margin-top:9px;font-size:14px;line-height:1.45"></div>
  <div id="meta" style="display:none;margin-top:6px;font-size:12.5px;line-height:1.4;opacity:.72"></div>

  <div id="quotaBox" style="margin-top:13px;padding-top:11px;border-top:1px solid rgba(128,128,128,.28)">
    <div id="quotaTitle" style="font-size:13px;font-weight:700">Codex quota</div>
    <div id="quotaRows" style="margin-top:6px;display:grid;gap:5px;font-size:13px"></div>
  </div>

  <div id="result" style="display:none;margin-top:10px;font-size:14px;line-height:1.45;white-space:pre-wrap"></div>
  <div id="usage" style="display:none;margin-top:7px;font-size:13px;opacity:.75"></div>

  <div id="actions" style="display:flex;gap:10px;margin-top:12px;width:100%">
    <button id="yes" type="button" style="display:none">Yes</button>
    <button id="no" type="button" style="display:none">No</button>
    <button id="stop" type="button" style="display:none">Stop</button>
    <button id="refresh" type="button" aria-label="Refresh" style="display:none">↻</button>
  </div>
  <div id="error" style="display:none;margin-top:8px;font-size:12px"></div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status"), taskEl = $("task"), metaEl = $("meta"), quotaTitleEl = $("quotaTitle"), quotaRowsEl = $("quotaRows"), resultEl = $("result"), usageEl = $("usage"), errorEl = $("error");
  const yesBtn = $("yes"), noBtn = $("no"), stopBtn = $("stop"), refreshBtn = $("refresh");
  const pending = new Map();
  const stableIds = new Map();
  let seq = 1;
  let state = null;
  let pollTimer = null;
  let clockTimer = null;
  let declinedLocally = false;
  let hydratedConsentRef = null;
  let hydratedTaskRef = null;
  let hydrateInFlight = false;
  let locale = (window.openai && window.openai.locale) || navigator.language || "en";

  const I18N = {
    en: { call: "Call Codex?", taskId: "Task ID", task: "Task", why: "Why Codex", quota: "Codex quota", before: "Before call", after: "After observed", unavailable: "not provided", left: "left", reset: "reset", approve: "Codex approval", request: "Request", starting: "Starting Codex…", submitting: "Submitting…", running: "Codex running", done: "Codex completed", failed: "Codex failed", stopped: "Codex stopped", uncertain: "Codex state uncertain", result: "Result", usage: "Usage", turn: "This turn", tokens: "tokens", stop: "Stop", rejected: "Declined", model: "Model", reasoning: "Reasoning effort", requested: "requested", elapsed: "Elapsed", duration: "Duration", ended: "Ended" },
    zh: { call: "调用 Codex？", taskId: "Task ID", task: "任务", why: "调用理由", quota: "Codex 额度", before: "调用前", after: "调用后观测", unavailable: "当前未提供", left: "剩余", reset: "重置", approve: "Codex 请求审批", request: "请求", starting: "正在启动 Codex…", submitting: "正在提交…", running: "Codex 运行中", done: "Codex 施工完成", failed: "Codex 执行失败", stopped: "Codex 已停止", uncertain: "Codex 状态不确定", result: "结果", usage: "用量", turn: "本次", tokens: "tokens", stop: "停止", rejected: "已拒绝", model: "模型", reasoning: "推理强度", requested: "请求", elapsed: "已运行", duration: "耗时", ended: "结束" },
    ja: { call: "Codexを呼び出しますか？", taskId: "Task ID", task: "タスク", why: "Codexを使う理由", quota: "Codex 利用枠", before: "呼び出し前", after: "呼び出し後の観測", unavailable: "現在は提供なし", left: "残り", reset: "リセット", approve: "Codex 承認リクエスト", request: "内容", starting: "Codexを起動しています…", submitting: "送信しています…", running: "Codex 実行中", done: "Codex 完了", failed: "Codex 失敗", stopped: "Codex 停止", uncertain: "Codex 状態不明", result: "結果", usage: "使用量", turn: "今回", tokens: "tokens", stop: "停止", rejected: "拒否済み", model: "モデル", reasoning: "推論強度", requested: "指定", elapsed: "実行時間", duration: "所要時間", ended: "終了" }
  };

  function langKey() {
    const v = String(locale || "en").toLowerCase();
    if (v.startsWith("zh")) return "zh";
    if (v.startsWith("ja")) return "ja";
    return "en";
  }
  function t(key) { return I18N[langKey()][key] || I18N.en[key] || key; }

  function request(method, params) {
    const id = seq++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    return new Promise((resolve, reject) => pending.set(id, { resolve: resolve, reject: reject }));
  }

  function stableRequestId(key) {
    if (!stableIds.has(key)) {
      const random = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
      stableIds.set(key, "toolwire-card-" + random);
    }
    return stableIds.get(key);
  }

  function quotaWindows(quota) {
    const limits = quota && quota.rateLimits && quota.rateLimits.limits || [];
    const windows = [];
    for (const limit of limits) {
      for (const w of (limit && limit.windows) || []) {
        windows.push({
          ...w,
          __limitKey: limit && typeof limit.key === "string" ? limit.key : null,
          __limitName: limit && typeof limit.limitName === "string" ? limit.limitName : null,
        });
      }
    }
    return windows;
  }

  function quotaWindowLabel(window, index) {
    const mins = window && window.windowDurationMins;
    let duration = null;
    if (Number.isInteger(mins) && mins > 0) {
      if (mins % 1440 === 0) duration = String(mins / 1440) + "d";
      else if (mins % 60 === 0) duration = String(mins / 60) + "h";
      else duration = String(mins) + "m";
    }
    const rawName = window && window.__limitName;
    const named = rawName && String(rawName).toLowerCase() !== "codex"
      ? rawName
      : (window && window.__limitKey && window.__limitKey !== "codex" ? window.__limitKey : null);
    if (named && duration) return named + " · " + duration;
    return named || duration || (window && window.kind) || ("window " + String(index + 1));
  }

  function resetText(unixSeconds) {
    if (!Number.isInteger(unixSeconds)) return "";
    try {
      return new Intl.DateTimeFormat(locale || undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(unixSeconds * 1000));
    } catch {
      return new Date(unixSeconds * 1000).toLocaleString();
    }
  }

  function clockText(value) {
    if (value === null || value === undefined) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(locale || undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
    } catch {
      return date.toLocaleTimeString();
    }
  }

  function durationText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return h + "h " + m + "m " + s + "s";
    if (m) return m + "m " + s + "s";
    return s + "s";
  }

  function quotaObservedLabel(label, quota) {
    const observed = quota && quota.observedAt ? clockText(quota.observedAt) : "";
    return observed ? label + " · " + observed : label;
  }

  function renderMeta() {
    clearInterval(clockTimer);
    clockTimer = null;
    if (!state) { metaEl.style.display = "none"; return; }
    const execution = state.execution || {};
    const timing = state.timing || {};
    const lines = [];
    const visibleTaskId = state.shortTaskId || (state.taskCard && state.taskCard.shortTaskId) || state.taskId || (state.taskCard && state.taskCard.taskId) || state.taskRef || null;
    if (visibleTaskId) lines.push(t("taskId") + "：" + String(visibleTaskId));
    const invocationRationale = state.taskCard && typeof state.taskCard.invocationRationale === "string"
      ? state.taskCard.invocationRationale
      : null;
    if (invocationRationale) lines.push(t("why") + "：" + invocationRationale);
    if (execution.resolvedModel) {
      const requestedModel = execution.requestedModel && execution.requestedModel !== execution.resolvedModel
        ? " (" + t("requested") + " " + execution.requestedModel + ")"
        : "";
      lines.push(t("model") + "：" + execution.resolvedModel + requestedModel);
    } else if (execution.requestedModel) {
      lines.push(t("model") + "：" + execution.requestedModel + " (" + t("requested") + ")");
    }
    const requestedEffort = execution.requestedReasoningEffort || (state.taskCard && state.taskCard.requestedReasoningEffort) || null;
    if (execution.reasoningEffort) {
      lines.push(t("reasoning") + "：" + execution.reasoningEffort + (requestedEffort ? " (" + t("requested") + " " + requestedEffort + ")" : ""));
    } else if (requestedEffort) {
      lines.push(t("reasoning") + "：" + requestedEffort + " (" + t("requested") + ")");
    }
    const terminal = isTerminalState(state);
    if (terminal && Number.isFinite(timing.durationMs)) {
      lines.push(t("duration") + "：" + durationText(timing.durationMs));
    } else if (!terminal && Number.isFinite(timing.startedAt)) {
      lines.push(t("elapsed") + "：" + durationText(Date.now() - timing.startedAt));
    }
    if (terminal && Number.isFinite(timing.endedAt)) {
      lines.push(t("ended") + "：" + clockText(timing.endedAt));
    }
    metaEl.textContent = lines.join(" · ");
    metaEl.style.display = lines.length ? "block" : "none";
    if (!terminal && Number.isFinite(timing.startedAt)) {
      clockTimer = setInterval(() => {
        if (state) renderMeta();
      }, 1000);
    }
  }

  function quotaLine(window, index) {
    const label = quotaWindowLabel(window, index);
    const remaining = Number.isInteger(window && window.remainingPercent) ? String(window.remainingPercent) + "% " + t("left") : t("unavailable");
    const reset = resetText(window && window.resetsAt);
    return label + "：" + remaining + (reset ? " · " + reset + " " + t("reset") : "");
  }

  function appendQuotaGroup(label, windows) {
    if (label) {
      const heading = document.createElement("div");
      heading.textContent = label;
      heading.style.fontWeight = "650";
      heading.style.opacity = ".72";
      heading.style.marginTop = quotaRowsEl.childElementCount ? "4px" : "0";
      quotaRowsEl.appendChild(heading);
    }
    if (!windows.length) {
      const row = document.createElement("div");
      row.textContent = t("unavailable");
      row.style.opacity = ".58";
      quotaRowsEl.appendChild(row);
      return;
    }
    windows.forEach((window, index) => {
      const row = document.createElement("div");
      row.textContent = quotaLine(window, index);
      quotaRowsEl.appendChild(row);
    });
  }

  function renderQuota(s) {
    const beforeQuota = (s && s.meteredConsent && s.meteredConsent.quota)
      || (s && s.taskCard && s.taskCard.quota)
      || null;
    const afterQuota = (s && s.resourceReceipt && s.resourceReceipt.accountQuota) || null;
    const before = quotaWindows(beforeQuota);
    const after = quotaWindows(afterQuota);
    quotaTitleEl.textContent = t("quota");
    quotaRowsEl.replaceChildren();
    if (afterQuota) {
      appendQuotaGroup(beforeQuota ? quotaObservedLabel(t("before"), beforeQuota) : null, before);
      appendQuotaGroup(quotaObservedLabel(t("after"), afterQuota), after);
      return;
    }
    appendQuotaGroup(beforeQuota ? quotaObservedLabel(t("before"), beforeQuota) : null, before);
  }

  function pickPayload(raw) {
    if (!raw || typeof raw !== "object") return null;
    // Host metadata envelopes may have their own status field. Always unwrap
    // canonical MCP result containers before deciding this is Codexless state.
    if (raw.structuredContent && typeof raw.structuredContent === "object") {
      const nested = pickPayload(raw.structuredContent);
      if (nested) return nested;
    }
    if (raw._meta && raw._meta.toolwireAgentState && typeof raw._meta.toolwireAgentState === "object") {
      const nested = pickPayload(raw._meta.toolwireAgentState);
      if (nested) return nested;
    }
    if (raw.mcp_tool_result && typeof raw.mcp_tool_result === "object") {
      const nested = pickPayload(raw.mcp_tool_result);
      if (nested) return nested;
    }
    if (raw.call_tool_result && typeof raw.call_tool_result === "object") {
      const nested = pickPayload(raw.call_tool_result);
      if (nested) return nested;
    }
    if (raw.toolOutput && typeof raw.toolOutput === "object") {
      const nested = pickPayload(raw.toolOutput);
      if (nested) return nested;
    }
    if (raw.toolResponseMetadata && typeof raw.toolResponseMetadata === "object") {
      const nested = pickPayload(raw.toolResponseMetadata);
      if (nested) return nested;
    }
    const toolwireStatus = new Set(["consent_required", "running", "awaitingApproval", "idle", "completed", "failed", "interrupted", "rejected", "lost"]);
    if (raw.taskCard || raw.meteredConsent || raw.resourceReceipt || raw.agentRef !== undefined || toolwireStatus.has(raw.status)) return raw;
    return null;
  }

  function hostPayload() {
    if (!window.openai) return null;
    return pickPayload(window.openai.toolOutput) || pickPayload(window.openai.toolResponseMetadata) || pickPayload(window.openai);
  }

  function hasOwn(object, key) {
    return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
  }

  function isTerminalState(value) {
    const current = value && typeof value === "object" ? value : {};
    if (current.terminal === true) return true;
    if (["completed", "failed", "interrupted", "rejected", "lost"].includes(current.status)) return true;
    return current.status === "idle" && (current.finalResult !== null && current.finalResult !== undefined || Boolean(current.resourceReceipt));
  }

  function mergeTaskState(previous, incoming) {
    const next = incoming && typeof incoming === "object" ? incoming : {};
    const prev = previous && typeof previous === "object" ? previous : {};
    if (isTerminalState(prev)) return prev;
    const prevTaskId = prev.taskId || (prev.taskCard && prev.taskCard.taskId) || null;
    const nextTaskId = next.taskId || (next.taskCard && next.taskCard.taskId) || null;
    if (prevTaskId && nextTaskId && prevTaskId !== nextTaskId) return prev;
    const prevRequestId = prev.meteredConsent && prev.meteredConsent.requestId;
    const nextRequestId = next.meteredConsent && next.meteredConsent.requestId;
    const prevAgentRef = prev.agentRef || null;
    const nextAgentRef = next.agentRef || null;
    const reset = Boolean(
      !prevTaskId && !nextTaskId && (
        (prevRequestId && nextRequestId && prevRequestId !== nextRequestId)
        || (prevAgentRef && nextAgentRef && prevAgentRef !== nextAgentRef)
      )
    );
    const base = reset ? {} : prev;
    const merged = { ...base, ...next };

    if (!hasOwn(next, "taskCard") || !next.taskCard) merged.taskCard = base.taskCard || null;
    if (!hasOwn(next, "resourceReceipt") || !next.resourceReceipt) merged.resourceReceipt = base.resourceReceipt || null;
    if (!hasOwn(next, "agentRef") || !next.agentRef) merged.agentRef = base.agentRef || next.agentRef || null;

    if (next.meteredConsent || base.meteredConsent) {
      merged.meteredConsent = { ...(base.meteredConsent || {}), ...(next.meteredConsent || {}) };
      if (!(next.meteredConsent && next.meteredConsent.quota)) {
        merged.meteredConsent.quota = (base.meteredConsent && base.meteredConsent.quota)
          || (base.taskCard && base.taskCard.quota)
          || (next.taskCard && next.taskCard.quota)
          || null;
      }
    }

    if (base.agentRef && next.status === "consent_required" && !nextAgentRef) {
      merged.status = base.status || next.status;
    }
    return merged;
  }

  function render(next) {
    state = mergeTaskState(state, next);
    declinedLocally = false;
    errorEl.style.display = "none";
    resultEl.style.display = "none";
    usageEl.style.display = "none";
    yesBtn.style.display = noBtn.style.display = stopBtn.style.display = refreshBtn.style.display = "none";
    renderQuota(state);
    renderMeta();

    const rawStatus = state.status || "unknown";
    const terminal = isTerminalState(state);
    const status = rawStatus === "idle" && terminal ? "completed" : rawStatus;
    const title = (state.taskCard && state.taskCard.title) || (state.taskCard && state.taskCard.summary) || "";
    taskEl.textContent = title ? t("task") + "：" + title : "";

    if (status === "consent_required") {
      statusEl.textContent = t("call");
      yesBtn.style.display = noBtn.style.display = "inline-block";
    } else if (status === "awaitingApproval" && state.pendingApproval) {
      statusEl.textContent = t("running");
      stopBtn.textContent = t("stop");
      stopBtn.style.display = refreshBtn.style.display = "inline-block";
    } else if (status === "running") {
      statusEl.textContent = t("running");
      stopBtn.textContent = t("stop");
      stopBtn.style.display = refreshBtn.style.display = "inline-block";
    } else if (status === "completed" || status === "idle") {
      statusEl.textContent = t("done");
      const result = state.resultSummary || state.finalResult;
      if (result) {
        resultEl.textContent = t("result") + "：" + String(result);
        resultEl.style.display = "block";
      }
    } else if (status === "interrupted") {
      statusEl.textContent = t("stopped");
      if (state.resultSummary) {
        resultEl.textContent = t("result") + "：" + String(state.resultSummary);
        resultEl.style.display = "block";
      }
    } else if (status === "failed") {
      statusEl.textContent = t("failed");
      const result = state.resultSummary || state.latestError;
      if (result) {
        resultEl.textContent = t("result") + "：" + String(result);
        resultEl.style.display = "block";
      }
    } else if (status === "rejected") {
      statusEl.textContent = t("rejected");
    } else if (status === "lost") {
      statusEl.textContent = t("uncertain");
      if (state.resultSummary || state.latestError) {
        resultEl.textContent = t("result") + "：" + String(state.resultSummary || state.latestError);
        resultEl.style.display = "block";
      }
    } else {
      statusEl.textContent = "Codex";
      if (state.agentRef && !terminal) refreshBtn.style.display = "inline-block";
    }
    if (terminal) {
      const cumulativeTokens = state && state.resourceReceipt && state.resourceReceipt.tokenUsage && state.resourceReceipt.tokenUsage.threadTotal && state.resourceReceipt.tokenUsage.threadTotal.totalTokens;
      if (Number.isInteger(cumulativeTokens) && cumulativeTokens >= 0) {
        usageEl.textContent = t("usage") + "：" + Number(cumulativeTokens).toLocaleString() + " " + t("tokens");
        usageEl.style.display = "block";
      }
    }
    schedulePoll();
  }

  async function tool(name, args) {
    errorEl.style.display = "none";
    const result = window.openai && typeof window.openai.callTool === "function"
      ? await window.openai.callTool(name, args)
      : await request("tools/call", { name: name, arguments: args });
    if (result && result.isError) throw new Error((result.content && result.content[0] && result.content[0].text) || "Tool call failed");
    const next = result && result.structuredContent;
    if (next) render(next);
    return next;
  }

  function consentRefFromInput(input) {
    if (!input || typeof input !== "object") return null;
    if (typeof input.consentRef === "string" && input.consentRef) return input.consentRef;
    if (input.arguments && typeof input.arguments === "object") return consentRefFromInput(input.arguments);
    if (input.toolInput && typeof input.toolInput === "object") return consentRefFromInput(input.toolInput);
    return null;
  }

  async function hydrateFromTaskRef(taskRef) {
    if (!taskRef || isTerminalState(state) || hydrateInFlight || hydratedTaskRef === taskRef) return;
    hydrateInFlight = true;
    try {
      const next = await tool("codex.agent_card_state", { taskRef: taskRef });
      if (next) hydratedTaskRef = taskRef;
    } catch (error) {
      if (!isTerminalState(state)) showError(error);
    } finally {
      hydrateInFlight = false;
    }
  }

  async function hydrateFromToolInput(input) {
    const currentHost = hostPayload();
    if (isTerminalState(currentHost)) {
      if (!isTerminalState(state)) render(currentHost);
      return;
    }
    if (isTerminalState(state)) return;
    if (state && state.taskRef) return hydrateFromTaskRef(state.taskRef);
    const consentRef = consentRefFromInput(input);
    if (!consentRef || hydrateInFlight || hydratedConsentRef === consentRef) return;
    hydrateInFlight = true;
    try {
      const next = await tool("codex.agent_card_state", { consentRef: consentRef });
      if (next) hydratedConsentRef = consentRef;
    } catch (error) {
      if (!isTerminalState(state)) showError(error);
    } finally {
      hydrateInFlight = false;
    }
  }

  function showError(error) {
    errorEl.textContent = (error && error.message) || String(error);
    errorEl.style.display = "block";
  }

  yesBtn.onclick = async () => {
    if (yesBtn.disabled || noBtn.disabled) return;
    const decisionTaskId = state && (state.taskId || state.shortTaskId);
    if (!(state && state.status === "consent_required" && decisionTaskId)) return;
    yesBtn.disabled = noBtn.disabled = true;
    try {
      statusEl.textContent = t("starting");
      await tool("codex.agent_commit", { taskId: decisionTaskId });
    } catch (e) {
      render(state);
      showError(e);
    } finally {
      yesBtn.disabled = noBtn.disabled = false;
    }
  };

  noBtn.onclick = async () => {
    if (yesBtn.disabled || noBtn.disabled) return;
    const decisionTaskId = state && (state.taskId || state.shortTaskId);
    if (!(state && state.status === "consent_required" && decisionTaskId)) return;
    yesBtn.disabled = noBtn.disabled = true;
    try {
      await tool("codex.agent_decline", { taskId: decisionTaskId });
    } catch (e) { showError(e); }
    finally { yesBtn.disabled = noBtn.disabled = false; }
  };

  stopBtn.onclick = async () => {
    if (!state || !state.agentRef) return;
    stopBtn.disabled = true;
    try { await tool("codex.agent_cancel", { agentRef: state.agentRef, expectedTurnId: state.turnId || undefined, requestId: stableRequestId("cancel:" + state.agentRef + ":" + String(state.turnId || "none")) }); }
    catch (e) { showError(e); }
    finally { stopBtn.disabled = false; }
  };

  refreshBtn.onclick = async () => {
    if (!state || isTerminalState(state) || !state.agentRef) return;
    refreshBtn.disabled = true;
    try {
      if (state.taskRef) await tool("codex.agent_card_state", { taskRef: state.taskRef });
      else if (hydratedConsentRef) await tool("codex.agent_card_state", { consentRef: hydratedConsentRef });
      else await tool("codex.agent_show", { agentRef: state.agentRef });
    }
    catch (e) { if (!isTerminalState(state)) showError(e); }
    finally { refreshBtn.disabled = false; }
  };

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (declinedLocally || !state || isTerminalState(state) || !state.agentRef || !["running", "awaitingApproval"].includes(state.status)) return;
    pollTimer = setTimeout(async () => {
      try {
        if (state.taskRef) await tool("codex.agent_card_state", { taskRef: state.taskRef });
        else if (hydratedConsentRef) await tool("codex.agent_card_state", { consentRef: hydratedConsentRef });
        else await tool("codex.agent_show", { agentRef: state.agentRef });
      } catch (e) { if (!isTerminalState(state)) showError(e); }
    }, 2500);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-input" && msg.params) hydrateFromToolInput(msg.params.arguments || msg.params);
    if (msg.method === "ui/notifications/tool-result" && msg.params && msg.params.structuredContent) render(msg.params.structuredContent);
    if (/host-context|context-changed/i.test(String(msg.method || ""))) {
      const params = msg.params || {};
      const context = params.context || {};
      const candidate = params.locale || params.language || params.userLocale || context.locale || context.language;
      if (typeof candidate === "string" && candidate) { locale = candidate; if (state) render(state); }
    }
  }, { passive: true });

  window.addEventListener("openai:set_globals", (event) => {
    const globals = event && event.detail && event.detail.globals || {};
    if (globals.toolInput) hydrateFromToolInput(globals.toolInput);
    if (globals.toolOutput) {
      const next = pickPayload(globals.toolOutput);
      if (next) {
        render(next);
        if (!isTerminalState(state) && next.taskRef) hydrateFromTaskRef(next.taskRef);
      }
    }
    if (typeof globals.locale === "string" && globals.locale) { locale = globals.locale; if (state) render(state); }
  }, { passive: true });

  const initial = hostPayload();
  if (initial) {
    render(initial);
    if (!isTerminalState(state)) {
      if (initial.taskRef) hydrateFromTaskRef(initial.taskRef);
      else hydrateFromToolInput(window.openai && window.openai.toolInput);
    }
  } else {
    hydrateFromToolInput(window.openai && window.openai.toolInput);
  }
  let hostPollAttempts = 0;
  const hostPoll = window.setInterval(() => {
    hostPollAttempts += 1;
    if (window.openai && typeof window.openai.locale === "string" && window.openai.locale) locale = window.openai.locale;
    const current = hostPayload();
    if (current) {
      render(current);
      if (!isTerminalState(state)) {
        if (current.taskRef) hydrateFromTaskRef(current.taskRef);
        else if (window.openai && window.openai.toolInput) hydrateFromToolInput(window.openai.toolInput);
      }
    } else if (window.openai && window.openai.toolInput) {
      hydrateFromToolInput(window.openai.toolInput);
    }
    if (current || hostPollAttempts >= 40) window.clearInterval(hostPoll);
  }, 250);
})();
</script>
`.trim();
