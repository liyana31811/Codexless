import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { codexlessPaths } from "./linux-identity.mjs";

export const RECENT_CALL_STORE_VERSION = 1;
export const DEFAULT_RECENT_CALL_TTL_MS = 15 * 60_000;
export const DEFAULT_RECENT_CALL_MAX_ENTRIES = 200;
export const DEFAULT_RECENT_CALL_QUERY_LIMIT = 50;
export const MAX_RECENT_CALL_QUERY_LIMIT = 100;

const RECEIPT_KEYS = Object.freeze([
  "receipt_id",
  "tool_name",
  "arrived_at",
  "handler_started_at",
  "result_returned_at",
  "result_class",
  "status",
  "error_stage",
  "error_class",
  "duration_ms",
]);
const RECEIPT_KEY_SET = new Set(RECEIPT_KEYS);
const STATUSES = new Set(["arrived", "handler_started", "returned", "handler_error"]);
const RESULT_CLASSES = new Set(["success", "tool_error"]);

export function defaultRecentCallStateFile(env = process.env) {
  return path.join(codexlessPaths({ env }).state, "recent-calls.json");
}

export function recentCallOptionsFromEnv(env = process.env, { readOnly = false } = {}) {
  return {
    filePath: envString(env, "CODEXLESS_RECENT_CALLS_STATE_FILE", defaultRecentCallStateFile(env)),
    ttlMs: envInteger(env, "CODEXLESS_RECENT_CALLS_TTL_MS", DEFAULT_RECENT_CALL_TTL_MS, { min: 10, max: 7 * 24 * 60 * 60_000 }),
    maxEntries: envInteger(env, "CODEXLESS_RECENT_CALLS_MAX_ENTRIES", DEFAULT_RECENT_CALL_MAX_ENTRIES, { min: 1, max: 10_000 }),
    queryLimit: envInteger(env, "CODEXLESS_RECENT_CALLS_QUERY_LIMIT", DEFAULT_RECENT_CALL_QUERY_LIMIT, { min: 1, max: MAX_RECENT_CALL_QUERY_LIMIT }),
    readOnly,
  };
}

export function createRecentCallDiagnostics({
  filePath = defaultRecentCallStateFile(),
  ttlMs = DEFAULT_RECENT_CALL_TTL_MS,
  maxEntries = DEFAULT_RECENT_CALL_MAX_ENTRIES,
  queryLimit = DEFAULT_RECENT_CALL_QUERY_LIMIT,
  readOnly = false,
  now = () => Date.now(),
  idFactory = () => `receipt_${randomUUID()}`,
} = {}) {
  validateBounds({ ttlMs, maxEntries, queryLimit });
  const resolvedPath = filePath ? path.resolve(filePath) : null;
  const records = new Map();
  let persistence = resolvedPath
    ? { status: "ok", schema_version: RECENT_CALL_STORE_VERSION, error_class: null }
    : { status: "disabled", schema_version: RECENT_CALL_STORE_VERSION, error_class: null };
  let persistenceBlocked = false;

  if (resolvedPath && existsSync(resolvedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
      if (parsed?.version !== RECENT_CALL_STORE_VERSION) {
        persistence = {
          status: "unsupported_schema",
          schema_version: RECENT_CALL_STORE_VERSION,
          stored_schema_version: Number.isInteger(parsed?.version) ? parsed.version : null,
          error_class: "UnsupportedSchema",
        };
        persistenceBlocked = true;
      } else if (!Array.isArray(parsed.receipts)) {
        throw new Error("receipt store must contain a receipts array");
      } else {
        for (const raw of parsed.receipts) {
          const receipt = validateStoredReceipt(raw);
          records.set(receipt.receipt_id, receipt);
        }
      }
    } catch (error) {
      if (!persistenceBlocked) {
        persistence = {
          status: "corrupt",
          schema_version: RECENT_CALL_STORE_VERSION,
          error_class: safeErrorClass(error),
        };
        persistenceBlocked = true;
      }
    }
  }

  const initialSize = records.size;
  trim();
  if (!readOnly && !persistenceBlocked && resolvedPath && initialSize !== records.size) flush();

  function trim() {
    const cutoff = now() - ttlMs;
    for (const [receiptId, receipt] of records) {
      const arrivedMs = Date.parse(receipt.arrived_at);
      if (!Number.isFinite(arrivedMs) || arrivedMs < cutoff) records.delete(receiptId);
    }
    if (records.size <= maxEntries) return;
    const oldest = [...records.values()].sort((a, b) => Date.parse(a.arrived_at) - Date.parse(b.arrived_at));
    for (let index = 0; index < oldest.length - maxEntries; index += 1) records.delete(oldest[index].receipt_id);
  }

  function flush() {
    if (!resolvedPath || readOnly || persistenceBlocked) return false;
    trim();
    let tmp = null;
    try {
      mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
      tmp = `${resolvedPath}.tmp-${randomUUID()}`;
      const payload = JSON.stringify({ version: RECENT_CALL_STORE_VERSION, receipts: [...records.values()] });
      writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, resolvedPath);
      persistence = { status: "ok", schema_version: RECENT_CALL_STORE_VERSION, error_class: null };
      return true;
    } catch (error) {
      persistence = {
        status: "write_failed",
        schema_version: RECENT_CALL_STORE_VERSION,
        error_class: safeErrorClass(error),
      };
      return false;
    } finally {
      if (tmp) {
        try { rmSync(tmp, { force: true }); } catch {}
      }
    }
  }

  function put(receipt) {
    records.set(receipt.receipt_id, validateStoredReceipt(receipt));
    trim();
    flush();
  }

  function arrive(toolName) {
    if (typeof toolName !== "string" || !toolName) throw new Error("recent-call toolName must be a non-empty string");
    const timestamp = isoNow(now);
    const receipt = {
      receipt_id: idFactory(),
      tool_name: toolName,
      arrived_at: timestamp,
      handler_started_at: null,
      result_returned_at: null,
      result_class: null,
      status: "arrived",
      error_stage: null,
      error_class: null,
      duration_ms: null,
    };
    put(receipt);
    return receipt.receipt_id;
  }

  function handlerStarted(receiptId) {
    const receipt = records.get(receiptId);
    if (!receipt) return false;
    const next = { ...receipt, handler_started_at: isoNow(now), status: "handler_started" };
    put(next);
    return true;
  }

  function returned(receiptId, { isError = false } = {}) {
    const receipt = records.get(receiptId);
    if (!receipt) return false;
    const returnedMs = now();
    const startedMs = Date.parse(receipt.handler_started_at ?? receipt.arrived_at);
    const next = {
      ...receipt,
      result_returned_at: new Date(returnedMs).toISOString(),
      result_class: isError ? "tool_error" : "success",
      status: "returned",
      error_stage: null,
      error_class: null,
      duration_ms: Number.isFinite(startedMs) ? Math.max(0, returnedMs - startedMs) : null,
    };
    put(next);
    return true;
  }

  function handlerError(receiptId, error) {
    const receipt = records.get(receiptId);
    if (!receipt) return false;
    const returnedMs = now();
    const startedMs = Date.parse(receipt.handler_started_at ?? receipt.arrived_at);
    const next = {
      ...receipt,
      result_returned_at: null,
      result_class: null,
      status: "handler_error",
      error_stage: "handler",
      error_class: safeErrorClass(error),
      duration_ms: Number.isFinite(startedMs) ? Math.max(0, returnedMs - startedMs) : null,
    };
    put(next);
    return true;
  }

  function wrapHandler(toolName, handler) {
    if (typeof handler !== "function") throw new Error(`recent-call handler for ${toolName} must be a function`);
    return async function recentCallWrappedHandler(...args) {
      const receiptId = arrive(toolName);
      handlerStarted(receiptId);
      try {
        const result = await handler.apply(this, args);
        returned(receiptId, { isError: result?.isError === true });
        return result;
      } catch (error) {
        handlerError(receiptId, error);
        throw error;
      }
    };
  }

  function query({ receiptId = null, toolName = null, status = null, since = null, limit = queryLimit } = {}) {
    trim();
    const boundedLimit = normalizeQueryLimit(limit, queryLimit);
    const sinceMs = normalizeSince(since);
    let rows = [...records.values()]
      .filter((receipt) => !receiptId || receipt.receipt_id === receiptId)
      .filter((receipt) => !toolName || receipt.tool_name === toolName)
      .filter((receipt) => !status || receipt.status === status)
      .filter((receipt) => sinceMs === null || Date.parse(receipt.arrived_at) >= sinceMs)
      .sort((a, b) => Date.parse(b.arrived_at) - Date.parse(a.arrived_at));
    const matchedBeforeLimit = rows.length;
    rows = rows.slice(0, boundedLimit).map(cloneReceipt);
    const incompleteCount = rows.filter((receipt) => receipt.status === "arrived" || receipt.status === "handler_started").length;
    const persistenceSnapshot = persistenceHealth();
    const noMatch = classifyNoMatch(persistenceSnapshot.status);
    return {
      bounded: true,
      ttl_ms: ttlMs,
      capacity: maxEntries,
      limit: boundedLimit,
      matched_before_limit: matchedBeforeLimit,
      count: rows.length,
      incomplete_count: incompleteCount,
      evidence: rows.length ? "server_arrival_receipts_found" : noMatch.evidence,
      no_match_meaning: rows.length ? null : noMatch.meaning,
      persistence: persistenceSnapshot,
      receipts: rows,
    };
  }

  function persistenceHealth() {
    return {
      ...structuredClone(persistence),
      enabled: Boolean(resolvedPath),
      read_only: Boolean(readOnly),
    };
  }

  return {
    stateFile: resolvedPath,
    ttlMs,
    maxEntries,
    queryLimit,
    arrive,
    handlerStarted,
    returned,
    handlerError,
    wrapHandler,
    query,
    persistenceHealth,
  };
}

export function installRecentCallToolInstrumentation(server, diagnostics) {
  if (!server || typeof server.registerTool !== "function") throw new Error("recent-call instrumentation requires an MCP server");
  if (!diagnostics || typeof diagnostics.wrapHandler !== "function") throw new Error("recent-call instrumentation requires diagnostics");
  const original = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => original(name, config, diagnostics.wrapHandler(name, handler));
  return server;
}

export function safeErrorClass(error) {
  if (error && typeof error === "object") {
    const name = safeClassToken(error.name) || safeClassToken(error.constructor?.name);
    const code = safeClassToken(error.code);
    if (name && code) return `${name}:${code}`.slice(0, 160);
    if (name) return name;
    if (code) return code;
  }
  return "Error";
}

function validateStoredReceipt(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid receipt record");
  for (const key of Object.keys(raw)) {
    if (!RECEIPT_KEY_SET.has(key)) throw new Error(`unsupported receipt field ${key}`);
  }
  for (const key of RECEIPT_KEYS) {
    if (!Object.hasOwn(raw, key)) throw new Error(`missing receipt field ${key}`);
  }
  if (typeof raw.receipt_id !== "string" || !raw.receipt_id || raw.receipt_id.length > 256) throw new Error("invalid receipt_id");
  if (typeof raw.tool_name !== "string" || !raw.tool_name || raw.tool_name.length > 512) throw new Error("invalid tool_name");
  if (!isIsoDate(raw.arrived_at)) throw new Error("invalid arrived_at");
  if (raw.handler_started_at !== null && !isIsoDate(raw.handler_started_at)) throw new Error("invalid handler_started_at");
  if (raw.result_returned_at !== null && !isIsoDate(raw.result_returned_at)) throw new Error("invalid result_returned_at");
  if (raw.result_class !== null && !RESULT_CLASSES.has(raw.result_class)) throw new Error("invalid result_class");
  if (!STATUSES.has(raw.status)) throw new Error("invalid status");
  if (raw.error_stage !== null && raw.error_stage !== "handler") throw new Error("invalid error_stage");
  if (raw.error_class !== null && (typeof raw.error_class !== "string" || raw.error_class.length > 160)) throw new Error("invalid error_class");
  if (raw.duration_ms !== null && (!Number.isFinite(raw.duration_ms) || raw.duration_ms < 0)) throw new Error("invalid duration_ms");
  if ((raw.status === "arrived" || raw.status === "handler_started") && raw.result_returned_at !== null) throw new Error("incomplete receipt cannot be terminal");
  return cloneReceipt(raw);
}

function cloneReceipt(receipt) {
  return Object.fromEntries(RECEIPT_KEYS.map((key) => [key, receipt[key]]));
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function classifyNoMatch(persistenceStatus) {
  if (persistenceStatus === "corrupt" || persistenceStatus === "unsupported_schema") {
    return {
      evidence: "durable_evidence_unavailable",
      meaning: "Durable recent-call evidence is unavailable because the local store is corrupt or uses an unsupported schema. No conclusion about prior Host delivery can be drawn from the missing durable history.",
    };
  }
  if (persistenceStatus === "write_failed") {
    return {
      evidence: "durable_evidence_degraded",
      meaning: "No matching server-arrival receipt was found in the retained evidence, and durable persistence has failed for part of the window. This does not prove the Host did not send the call.",
    };
  }
  return {
    evidence: "no_server_arrival_found_in_bounded_evidence",
    meaning: "No matching server-arrival receipt was found in the bounded local evidence. This does not prove the Host did not send the call.",
  };
}

function normalizeSince(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error("since must be an ISO timestamp or epoch milliseconds");
  return parsed;
}

function normalizeQueryLimit(value, fallback) {
  const numeric = value === null || value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_RECENT_CALL_QUERY_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_RECENT_CALL_QUERY_LIMIT}`);
  }
  return numeric;
}

function validateBounds({ ttlMs, maxEntries, queryLimit }) {
  if (!Number.isInteger(ttlMs) || ttlMs < 10 || ttlMs > 7 * 24 * 60 * 60_000) throw new Error("recent-call ttlMs is out of bounds");
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) throw new Error("recent-call maxEntries is out of bounds");
  if (!Number.isInteger(queryLimit) || queryLimit < 1 || queryLimit > MAX_RECENT_CALL_QUERY_LIMIT) throw new Error("recent-call queryLimit is out of bounds");
}

function envString(env, name, fallback) {
  const value = env?.[name];
  return typeof value === "string" && value.length ? value : fallback;
}

function envInteger(env, name, fallback, { min, max }) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function safeClassToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80);
  return token || null;
}
