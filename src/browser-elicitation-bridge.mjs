import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRequestStateCodec, inputRequired } = require("@modelcontextprotocol/server");

export const BROWSER_ELICITATION_INPUT_KEY = "browser_elicitation";
const CODEX_MCP_ELICITATION_METHOD = "mcpServer/elicitation/request";
const BROWSER_MCP_SERVER = "node_repl";
const DEFAULT_CONTINUATION_TTL_MS = 55_000;
const REQUEST_STATE_VERSION = 1;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deferred() {
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
  };
}

function stableJSON(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Browser tool input must be JSON-serializable");
  return encoded;
}

function inputHashFor(input) {
  return createHash("sha256").update(stableJSON(input), "utf8").digest("hex");
}

function assertBoundedString(value, name, maxChars = 20_000) {
  if (typeof value !== "string" || !value || value.length > maxChars) {
    throw new Error(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function projectElicitationRequest(request) {
  if (!isPlainObject(request)) {
    throw new Error("App Server Browser elicitation request must be an object");
  }
  if (request.mode === "form") {
    const message = assertBoundedString(request.message, "elicitation message");
    if (!isPlainObject(request.requestedSchema)) {
      throw new Error("form elicitation requires requestedSchema");
    }
    return inputRequired.elicit({
      message,
      requestedSchema: structuredClone(request.requestedSchema),
      ...(isPlainObject(request._meta) ? { _meta: structuredClone(request._meta) } : {}),
    });
  }
  if (request.mode === "url") {
    return inputRequired.elicitUrl({
      message: assertBoundedString(request.message, "elicitation message"),
      url: assertBoundedString(request.url, "elicitation url", 16_384),
      ...(isPlainObject(request._meta) ? { _meta: structuredClone(request._meta) } : {}),
    });
  }
  if (request.mode === "openai/form") {
    throw new Error(
      "openai/form Browser elicitation is not negotiated by this Workbench client; " +
      "mcpServerOpenaiFormElicitation is intentionally not declared"
    );
  }
  throw new Error(`unsupported App Server Browser elicitation mode: ${String(request.mode)}`);
}

function projectElicitationResponse(value) {
  if (!isPlainObject(value)) {
    throw new BrowserElicitationBridgeError(
      "BROWSER_ELICITATION_RESPONSE_INVALID",
      "Browser elicitation resume requires one elicitation response."
    );
  }
  if (!["accept", "decline", "cancel"].includes(value.action)) {
    throw new BrowserElicitationBridgeError(
      "BROWSER_ELICITATION_RESPONSE_INVALID",
      "Browser elicitation response action must be accept, decline, or cancel."
    );
  }
  const response = { action: value.action };
  if (value.content !== undefined) {
    if (!isPlainObject(value.content)) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_RESPONSE_INVALID",
        "Browser elicitation response content must be an object."
      );
    }
    response.content = structuredClone(value.content);
  }
  if (value._meta !== undefined) {
    if (!isPlainObject(value._meta)) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_RESPONSE_INVALID",
        "Browser elicitation response _meta must be an object."
      );
    }
    response._meta = structuredClone(value._meta);
  }
  return response;
}

function assertDecodedRequestState(value) {
  if (
    !isPlainObject(value) ||
    value.v !== REQUEST_STATE_VERSION ||
    typeof value.runtimeId !== "string" ||
    typeof value.operationId !== "string" ||
    typeof value.toolName !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.inputHash ?? "") ||
    !Number.isInteger(value.round) ||
    value.round < 1
  ) {
    throw new Error("invalid Browser requestState payload");
  }
  return value;
}

export class BrowserElicitationBridgeError extends Error {
  constructor(code, message, nextActions = []) {
    super(message);
    this.name = "BrowserElicitationBridgeError";
    this.code = code;
    this.nextActions = nextActions;
  }
}

export class BrowserElicitationBridge {
  #active = null;
  #operations = new Map();
  #continuationTtlMs;
  #codec;
  #runtimeId;
  #retireTaintedOperation;
  #closed = false;

  constructor({
    continuationTtlMs = DEFAULT_CONTINUATION_TTL_MS,
    requestStateKey = randomBytes(32),
    runtimeId = `browser_runtime_${randomUUID()}`,
    retireTaintedOperation = null,
  } = {}) {
    if (!Number.isInteger(continuationTtlMs) || continuationTtlMs < 1_000) {
      throw new Error("continuationTtlMs must be an integer at least 1000");
    }
    if (typeof runtimeId !== "string" || !runtimeId) throw new Error("runtimeId must be a non-empty string");
    if (retireTaintedOperation !== null && typeof retireTaintedOperation !== "function") {
      throw new Error("retireTaintedOperation must be null or a function");
    }
    this.#continuationTtlMs = continuationTtlMs;
    this.#runtimeId = runtimeId;
    this.#retireTaintedOperation = retireTaintedOperation;
    this.#codec = createRequestStateCodec({
      key: requestStateKey,
      ttlSeconds: Math.max(1, Math.ceil(continuationTtlMs / 1000)),
    });
  }

  async verifyRequestState(state, ctx) {
    const decoded = assertDecodedRequestState(await this.#codec.verify(state, ctx));
    if (decoded.runtimeId !== this.#runtimeId) throw new Error("Browser requestState belongs to a retired runtime");
    return decoded;
  }

  handleServerRequest(request) {
    if (request?.method !== CODEX_MCP_ELICITATION_METHOD) {
      request.reject?.({
        code: -32601,
        message: `Server-initiated request not supported by Codex Toolbox Bridge: ${String(request?.method ?? "unknown")}`,
      });
      return;
    }

    const params = isPlainObject(request.params) ? request.params : null;
    const serverName = params?.serverName ?? params?.server_name;
    if (!params || serverName !== BROWSER_MCP_SERVER) {
      request.reject?.({
        code: -32602,
        message: `Browser elicitation is supported only for ${BROWSER_MCP_SERVER}; got ${String(serverName ?? "missing")}`,
      });
      return;
    }

    let projected;
    try {
      // Current App Server versions flatten the elicitation body into params and
      // use camelCase. Keep the nested request shape for older Codex releases.
      projected = projectElicitationRequest(isPlainObject(params.request) ? params.request : params);
    } catch (error) {
      request.reject?.({
        code: -32602,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const operation = this.#active;
    if (!operation || this.#closed) {
      request.reject?.({
        code: -32000,
        message: "Browser elicitation arrived outside an active Browser tool call.",
      });
      return;
    }
    if (operation.expired) {
      request.reject?.({
        code: -32000,
        message: "Browser tool call is already expired and cannot accept another elicitation.",
      });
      return;
    }
    if (operation.pending) {
      request.reject?.({
        code: -32000,
        message: "Browser tool call already has a pending elicitation.",
      });
      return;
    }

    const pending = {
      handle: request,
      inputRequest: projected,
      round: operation.nextRound++,
      stateIssued: false,
      expiresAt: null,
      timer: null,
    };
    operation.pending = pending;
    operation.event.resolve("user_input");
  }

  async run({ toolName, input, mcpReq = null, task }) {
    if (typeof toolName !== "string" || !toolName || typeof task !== "function") {
      throw new Error("BrowserElicitationBridge.run requires toolName and task");
    }
    if (this.#closed) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_EXPIRED",
        "Browser permission runtime is closed."
      );
    }

    const inputHash = inputHashFor(input);
    const stateAccessor = mcpReq?.requestState;
    if (stateAccessor !== undefined && typeof stateAccessor !== "function") {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_REQUEST_STATE_INVALID",
        "Browser continuation requestState accessor is invalid."
      );
    }
    let requestState = stateAccessor?.();
    if (typeof requestState === "string") {
      try {
        requestState = await this.verifyRequestState(requestState, { mcpReq });
      } catch {
        throw new BrowserElicitationBridgeError(
          "BROWSER_ELICITATION_REQUEST_STATE_INVALID",
          "Browser continuation requestState is invalid or expired."
        );
      }
    } else if (requestState !== undefined) {
      try {
        requestState = assertDecodedRequestState(requestState);
      } catch {
        throw new BrowserElicitationBridgeError(
          "BROWSER_ELICITATION_REQUEST_STATE_INVALID",
          "Browser continuation requestState is invalid or expired."
        );
      }
    }

    if (requestState !== undefined) {
      return this.#resume({
        requestState,
        toolName,
        inputHash,
        inputResponses: mcpReq?.inputResponses,
      });
    }
    if (mcpReq?.inputResponses && Object.keys(mcpReq.inputResponses).length > 0) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_REQUEST_STATE_INVALID",
        "Browser continuation inputResponses require a verified requestState."
      );
    }
    if (this.#active) {
      if (this.#active.tainted) {
        const recovery = this.#active.recovery;
        throw new BrowserElicitationBridgeError(
          "BROWSER_OPERATION_TAINTED",
          recovery?.status === "failed"
            ? "The expired Browser operation could not be retired safely, so Browser remains fail-closed."
            : "The expired Browser operation is being retired with its isolated App Server before another Browser call can start.",
          recovery?.status === "failed"
            ? ["Restart the private Codexless household runtime to retire the old Browser App Server. Do not retry the Browser side effect until restart completes and current page state has been read."]
            : ["Wait for Browser runtime recovery to complete, then call codex.browser_status before preparing a fresh action. Do not replay an uncertain side effect automatically."]
        );
      }
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_PENDING",
        "Another Browser tool call is still active or waiting for user input.",
        ["Resolve, dismiss, or let the pending Browser permission request expire before starting another Browser action."]
      );
    }

    const operation = {
      id: `browser_operation_${randomUUID()}`,
      toolName,
      inputHash,
      event: deferred(),
      pending: null,
      outcome: null,
      nextRound: 1,
      consumedRounds: new Set(),
      expired: false,
      tainted: false,
      recovery: null,
    };
    this.#active = operation;
    this.#operations.set(operation.id, operation);

    Promise.resolve().then(task).then(
      (value) => {
        operation.outcome = { kind: "complete", value };
        operation.event.resolve("task_complete");
        if (operation.expired) this.#release(operation);
      },
      (error) => {
        operation.outcome = { kind: "error", error };
        operation.event.resolve("task_complete");
        if (operation.expired) this.#release(operation);
      }
    );
    return this.#waitOperation(operation);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const operation = this.#active;
    if (!operation) return;
    operation.expired = true;
    const pending = operation.pending;
    if (pending) {
      this.#clearPendingTimer(pending);
      operation.consumedRounds.add(pending.round);
      operation.pending = null;
      if (!pending.handle.settled) {
        try {
          pending.handle.resolve({ action: "cancel" });
        } catch {}
      }
    }
    operation.event.resolve("closed");
    if (operation.outcome) this.#release(operation);
  }

  async #resume({ requestState, toolName, inputHash, inputResponses }) {
    if (requestState.runtimeId !== this.#runtimeId) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_EXPIRED",
        "Browser permission request belongs to a retired Browser runtime.",
        ["Retry the Browser action so the current runtime can issue a fresh permission request."]
      );
    }
    const operation = this.#operations.get(requestState.operationId);
    if (!operation || operation.expired) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_EXPIRED",
        "Browser permission request expired or the Browser runtime restarted.",
        ["Retry the Browser action so the current Chrome runtime can issue a fresh permission request."]
      );
    }
    if (
      requestState.toolName !== toolName ||
      requestState.inputHash !== inputHash ||
      operation.toolName !== toolName ||
      operation.inputHash !== inputHash
    ) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_STALE",
        "Browser permission continuation does not match this exact tool and input.",
        ["Resume the exact Browser tool call that produced the permission request."]
      );
    }
    if (operation.consumedRounds.has(requestState.round)) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_STALE",
        "Browser permission continuation was already consumed."
      );
    }

    const pending = operation.pending;
    if (!pending || !pending.stateIssued || pending.round !== requestState.round) {
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_STALE",
        "Browser permission continuation no longer matches the pending App Server request."
      );
    }
    if (Date.now() >= pending.expiresAt) {
      this.#expirePending(operation, pending);
      throw new BrowserElicitationBridgeError(
        "BROWSER_ELICITATION_EXPIRED",
        "Browser permission request expired before user input arrived."
      );
    }

    operation.consumedRounds.add(pending.round);
    let response;
    try {
      response = projectElicitationResponse(
        isPlainObject(inputResponses) ? inputResponses[BROWSER_ELICITATION_INPUT_KEY] : undefined
      );
    } catch (error) {
      this.#expirePending(operation, pending);
      throw error;
    }

    this.#clearPendingTimer(pending);
    operation.pending = null;
    operation.event = deferred();
    if (!pending.handle.settled) pending.handle.resolve(response);
    return this.#waitOperation(operation);
  }

  async #waitOperation(operation) {
    while (true) {
      if (operation.outcome) return this.#consumeOutcome(operation);
      if (operation.expired) {
        throw new BrowserElicitationBridgeError(
          "BROWSER_ELICITATION_EXPIRED",
          "Browser permission request expired before the Browser task completed."
        );
      }
      const pending = operation.pending;
      if (pending && !pending.stateIssued) {
        const payload = {
          v: REQUEST_STATE_VERSION,
          runtimeId: this.#runtimeId,
          operationId: operation.id,
          toolName: operation.toolName,
          inputHash: operation.inputHash,
          round: pending.round,
        };
        const requestState = await this.#codec.mint(payload);
        pending.stateIssued = true;
        pending.expiresAt = Date.now() + this.#continuationTtlMs;
        this.#armPendingTimer(operation, pending);
        return inputRequired({
          inputRequests: {
            [BROWSER_ELICITATION_INPUT_KEY]: structuredClone(pending.inputRequest),
          },
          requestState,
        });
      }
      const event = operation.event;
      await event.promise;
      if (operation.event === event) operation.event = deferred();
    }
  }

  #consumeOutcome(operation) {
    const outcome = operation.outcome;
    this.#release(operation);
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  }

  #armPendingTimer(operation, pending) {
    this.#clearPendingTimer(pending);
    pending.timer = setTimeout(() => {
      if (operation.pending !== pending || operation.expired) return;
      this.#expirePending(operation, pending);
    }, this.#continuationTtlMs);
    pending.timer.unref?.();
  }

  #expirePending(operation, pending) {
    this.#clearPendingTimer(pending);
    if (operation.pending !== pending) return;
    operation.consumedRounds.add(pending.round);
    operation.pending = null;
    operation.expired = true;
    operation.tainted = !operation.outcome;
    if (!pending.handle.settled) {
      try {
        pending.handle.resolve({ action: "cancel" });
      } catch {}
    }
    operation.event.resolve("expired");
    if (operation.outcome) {
      this.#release(operation);
      return;
    }
    this.#retireExpiredOperation(operation);
  }

  #retireExpiredOperation(operation) {
    if (!operation.tainted || operation.recovery) return;
    if (!this.#retireTaintedOperation) {
      operation.recovery = { status: "manual_restart_required", error: null };
      return;
    }
    operation.recovery = { status: "running", error: null };
    Promise.resolve()
      .then(() => this.#retireTaintedOperation({
        operationId: operation.id,
        toolName: operation.toolName,
        reason: "elicitation_ttl_expired",
      }))
      .then(
        () => {
          if (operation.recovery?.status !== "running") return;
          operation.recovery = { status: "complete", error: null };
          this.#release(operation);
          operation.event.resolve("retired");
        },
        (error) => {
          if (operation.recovery?.status !== "running") return;
          operation.recovery = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
          operation.event.resolve("retire_failed");
        }
      );
  }

  #clearPendingTimer(pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
  }

  #release(operation) {
    const pending = operation.pending;
    if (pending) this.#clearPendingTimer(pending);
    this.#operations.delete(operation.id);
    if (this.#active === operation) this.#active = null;
  }
}
