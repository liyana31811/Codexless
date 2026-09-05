const CHATGPT_HOST = "chatgpt.com";
const ROUTE_KEYS = new Set(["resolved_model_slug", "requested_model_experience"]);
const MAX_BODY_CHARS = 2_000_000;
const MAX_ASSISTANT_CLAIM_CHARS = 500;
const POST_STREAM_GRACE_MS = 10_000;
const NETWORK_METHODS = Object.freeze([
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Network.webSocketFrameReceived",
]);

export class BrowserModelRouteProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserModelRouteProbeError";
    this.code = code;
  }
}

export function assertChatGptProbeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_URL_INVALID", "probe tab URL must be a valid https URL");
  }
  if (url.protocol !== "https:" || url.hostname !== CHATGPT_HOST) {
    throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_HOST_DENIED", "model route probing is restricted to https://chatgpt.com");
  }
  return url;
}

export function extractChatGptModelRouteFields(body) {
  if (typeof body !== "string") return emptyRouteFields();
  if (body.length > MAX_BODY_CHARS) {
    throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_BODY_TOO_LARGE", "conversation response exceeded the probe parse limit");
  }
  const found = emptyRouteSets();
  collectRouteFieldsFromTransportText(body, found);
  return routeFieldsFromSets(found);
}

export function extractChatGptAssistantClaim(body) {
  if (typeof body !== "string") return { text: null, truncated: false };
  if (body.length > MAX_BODY_CHARS) {
    throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_BODY_TOO_LARGE", "conversation response exceeded the probe parse limit");
  }
  const claims = [];
  collectAssistantClaimsFromTransportText(body, claims);
  return claims.at(-1) ?? { text: null, truncated: false };
}

export async function resolveChatGptTabCdpCapability({ tab, documentation = null }) {
  if (documentation && typeof documentation.get === "function") {
    await documentation.get("confirmations");
    await documentation.get("capabilities/tab/cdp");
  }
  const capabilities = tab?.capabilities;
  if (!capabilities || typeof capabilities.get !== "function") {
    throw new BrowserModelRouteProbeError(
      "BROWSER_MODEL_ROUTE_CDP_UNAVAILABLE",
      "the claimed tab does not expose the Browser capability registry"
    );
  }
  const cdp = await capabilities.get("cdp");
  if (!cdp || typeof cdp.send !== "function" || typeof cdp.readEvents !== "function") {
    throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_CDP_UNAVAILABLE", "the claimed tab does not advertise the CDP capability");
  }
  return cdp;
}

export function browserModelRouteRuntimeParserSource() {
  return [
    `const ROUTE_KEYS = new Set(["resolved_model_slug", "requested_model_experience"]);`,
    `const MAX_BODY_CHARS = ${MAX_BODY_CHARS};`,
    `const MAX_ASSISTANT_CLAIM_CHARS = ${MAX_ASSISTANT_CLAIM_CHARS};`,
    collectRouteFieldsFromTransportText.toString(),
    collectAssistantClaimsFromTransportText.toString(),
    collectAssistantClaims.toString(),
    assistantContentText.toString(),
    addAssistantClaim.toString(),
    collectLooseTransportScalar.toString(),
    collectWhitelistedFields.toString(),
    addServerSteModelSlug.toString(),
    addScalar.toString(),
    parseJson.toString(),
    emptyRouteSets.toString(),
    routeFieldsFromSets.toString(),
    firstOrNull.toString(),
  ].join("\n");
}

export async function probeChatGptModelRoute({ tabUrl, cdp, trigger, timeoutMs = 45_000 }) {
  const initialUrl = assertChatGptProbeUrl(tabUrl);
  if (!cdp || typeof cdp.send !== "function" || typeof cdp.readEvents !== "function") {
    throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_CDP_UNAVAILABLE", "the claimed tab does not advertise the CDP capability");
  }
  if (typeof trigger !== "function") {
    throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_TRIGGER_REQUIRED", "a bounded conversation trigger is required");
  }

  await cdp.send("Network.enable", {});
  const baseline = await cdp.readEvents({ methods: NETWORK_METHODS, limit: 1, timeoutMs: 1 });
  let cursor = Number(baseline?.cursor) || 0;
  const enabledAt = Date.now();
  await trigger();

  const requestMethods = new Map();
  const found = emptyRouteSets();
  let response = null;
  let loadingFinished = false;
  let loadingFinishedAt = null;
  const deadline = enabledAt + timeoutMs;

  while (Date.now() < deadline) {
    const batch = await cdp.readEvents({
      afterSequence: cursor,
      methods: NETWORK_METHODS,
      timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
      limit: 200,
    });
    cursor = Math.max(cursor, Number(batch?.cursor) || 0);
    for (const event of batch?.events ?? []) {
      const requestId = event.params?.requestId;
      if (event.method === "Network.requestWillBeSent" && requestId) {
        const request = event.params?.request;
        requestMethods.set(requestId, { method: request?.method ?? null, url: request?.url ?? null });
        continue;
      }
      if (event.method === "Network.responseReceived" && requestId) {
        const request = requestMethods.get(requestId);
        if (request?.method === "POST" && isConversationGenerationResponse(event.params?.response?.url)) {
          response = {
            requestId,
            status: event.params?.response?.status ?? null,
            mimeType: event.params?.response?.mimeType ?? null,
            url: new URL(event.params.response.url),
          };
        }
        continue;
      }
      if (event.method === "Network.webSocketFrameReceived") {
        collectRouteFieldsFromTransportText(event.params?.response?.payloadData, found);
        continue;
      }
      if (response?.requestId && requestId === response.requestId) {
        if (event.method === "Network.loadingFailed") {
          throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_STREAM_FAILED", "the matched conversation response failed before completion");
        }
        if (event.method === "Network.loadingFinished") {
          loadingFinished = true;
          loadingFinishedAt = Date.now();
        }
      }
    }

    if (response?.requestId && loadingFinished && hasAllRouteSets(found)) break;
    if (response?.requestId && loadingFinishedAt !== null && Date.now() - loadingFinishedAt >= POST_STREAM_GRACE_MS) break;
  }

  if (!response?.requestId) {
    throw new BrowserModelRouteProbeError(
      "BROWSER_MODEL_ROUTE_RESPONSE_NOT_OBSERVED",
      "no chatgpt.com conversation generation response was observed after Network.enable"
    );
  }
  if (!loadingFinished) {
    throw new BrowserModelRouteProbeError("BROWSER_MODEL_ROUTE_STREAM_INCOMPLETE", "the conversation stream did not finish before the probe timeout");
  }

  const bodyResult = await cdp.send("Network.getResponseBody", { requestId: response.requestId });
  const body = bodyResult?.base64Encoded
    ? Buffer.from(String(bodyResult.body ?? ""), "base64").toString("utf8")
    : String(bodyResult?.body ?? "");
  collectRouteFieldsFromTransportText(body, found);
  const fields = routeFieldsFromSets(found);
  const assistantClaim = extractChatGptAssistantClaim(body);

  return {
    status: hasRouteField(fields) ? "ok" : "route_fields_not_found",
    origin: initialUrl.origin,
    response: {
      origin: response.url.origin,
      pathname: response.url.pathname,
      status: response.status,
      mimeType: response.mimeType,
      streamedBodyAvailableAfterLoadingFinished: true,
    },
    assistantClaim,
    fields,
    cdp: {
      enabledBeforeTrigger: true,
      baselineCapturedBeforeTrigger: true,
      methods: ["Network.enable", "Network.getResponseBody"],
      events: [...NETWORK_METHODS],
      routeFieldTransports: ["conversation_response_body", "websocket_frame_received"],
    },
  };
}

function isConversationGenerationResponse(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === CHATGPT_HOST
      && url.pathname.endsWith("/conversation")
      && !url.pathname.endsWith("/conversation/prepare")
      && !url.pathname.endsWith("/conversation/init");
  } catch {
    return false;
  }
}

function collectAssistantClaimsFromTransportText(value, claims) {
  if (typeof value !== "string" || !value || value.length > MAX_BODY_CHARS) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJson(trimmed, false);
    if (parsed !== null) collectAssistantClaims(parsed, claims, 0);
  } else {
    for (const line of value.split(String.fromCharCode(10))) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const parsed = parseJson(data, false);
      if (parsed !== null) collectAssistantClaims(parsed, claims, 0);
    }
  }
}

function collectAssistantClaims(value, claims, depth) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 1 && trimmed.length <= MAX_BODY_CHARS && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      const nested = parseJson(trimmed, false);
      if (nested !== null) collectAssistantClaims(nested, claims, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectAssistantClaims(item, claims, depth + 1);
    return;
  }
  if (value?.message && typeof value.message === "object" && value.message?.content && typeof value.message.content === "object") {
    addAssistantClaim(claims, assistantContentText(value.message.content));
  }
  if (value?.author?.role === "assistant" && value?.content && typeof value.content === "object") {
    addAssistantClaim(claims, assistantContentText(value.content));
  }
  for (const child of Object.values(value)) collectAssistantClaims(child, claims, depth + 1);
}

function assistantContentText(content) {
  const pieces = [];
  if (Array.isArray(content?.parts)) {
    for (const part of content.parts) {
      if (typeof part === "string") pieces.push(part);
      else if (part && typeof part === "object" && typeof part.text === "string") pieces.push(part.text);
    }
  }
  if (pieces.length === 0 && typeof content?.text === "string") pieces.push(content.text);
  return pieces.join("\n").trim();
}

function addAssistantClaim(claims, value) {
  if (typeof value !== "string") return;
  const text = value.trim();
  if (!text) return;
  claims.push({
    text: text.length > MAX_ASSISTANT_CLAIM_CHARS ? text.slice(0, MAX_ASSISTANT_CLAIM_CHARS) : text,
    truncated: text.length > MAX_ASSISTANT_CLAIM_CHARS,
  });
}

function collectRouteFieldsFromTransportText(value, found) {
  if (typeof value !== "string" || !value || value.length > MAX_BODY_CHARS) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJson(trimmed, false);
    if (parsed !== null) collectWhitelistedFields(parsed, found, 0);
  } else {
    for (const line of value.split(String.fromCharCode(10))) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const parsed = parseJson(data, false);
      if (parsed !== null) collectWhitelistedFields(parsed, found, 0);
    }
  }
  collectLooseTransportScalar(value, "resolved_model_slug", found.resolved_model_slug);
  collectLooseTransportScalar(value, "requested_model_experience", found.requested_model_experience);
  const serverIndex = value.indexOf("server_ste_metadata");
  if (serverIndex >= 0) {
    collectLooseTransportScalar(value.slice(serverIndex, serverIndex + 4096), "model_slug", found.serverSteModelSlug);
  }
}

function collectLooseTransportScalar(value, key, set) {
  let fromIndex = 0;
  while (fromIndex < value.length) {
    const keyIndex = value.indexOf(key, fromIndex);
    if (keyIndex < 0) return;
    const colonIndex = value.indexOf(":", keyIndex + key.length);
    if (colonIndex < 0 || colonIndex - (keyIndex + key.length) > 64) {
      fromIndex = keyIndex + key.length;
      continue;
    }
    let cursor = colonIndex + 1;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor);
      if (![9, 10, 13, 32, 34, 39, 92].includes(code)) break;
      cursor += 1;
    }
    const start = cursor;
    while (cursor < value.length && /[A-Za-z0-9_.:-]/u.test(value[cursor]) && cursor - start <= 256) cursor += 1;
    if (cursor > start && cursor - start <= 256) addScalar(set, value.slice(start, cursor));
    fromIndex = keyIndex + key.length;
  }
}

function collectWhitelistedFields(value, found, depth) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.length > 1
      && trimmed.length <= MAX_BODY_CHARS
      && (trimmed.startsWith("{") || trimmed.startsWith("["))
    ) {
      const nested = parseJson(trimmed, false);
      if (nested !== null) collectWhitelistedFields(nested, found, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectWhitelistedFields(item, found, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (ROUTE_KEYS.has(key)) addScalar(found[key], child);
    if (key === "server_ste_metadata") addServerSteModelSlug(found.serverSteModelSlug, child);
    collectWhitelistedFields(child, found, depth + 1);
  }
}

function addServerSteModelSlug(set, value) {
  if (value && typeof value === "object") {
    addScalar(set, value.model_slug);
    return;
  }
  if (typeof value !== "string") return;
  const parsed = parseJson(value.trim(), false);
  if (parsed && typeof parsed === "object") addScalar(set, parsed.model_slug);
}

function addScalar(set, value) {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) set.add(value);
}

function parseJson(value, strict = true) {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (!strict) return null;
    throw new BrowserModelRouteProbeError(
      "BROWSER_MODEL_ROUTE_BODY_INVALID",
      `conversation response was not valid JSON/SSE JSON: ${error.message}`
    );
  }
}

function emptyRouteSets() {
  return {
    resolved_model_slug: new Set(),
    serverSteModelSlug: new Set(),
    requested_model_experience: new Set(),
  };
}

function routeFieldsFromSets(found) {
  return {
    resolved_model_slug: firstOrNull(found.resolved_model_slug),
    server_ste_metadata: { model_slug: firstOrNull(found.serverSteModelSlug) },
    requested_model_experience: firstOrNull(found.requested_model_experience),
    observedValues: {
      resolved_model_slug: [...found.resolved_model_slug],
      server_ste_metadata_model_slug: [...found.serverSteModelSlug],
      requested_model_experience: [...found.requested_model_experience],
    },
  };
}

function emptyRouteFields() {
  return {
    resolved_model_slug: null,
    server_ste_metadata: { model_slug: null },
    requested_model_experience: null,
    observedValues: {
      resolved_model_slug: [],
      server_ste_metadata_model_slug: [],
      requested_model_experience: [],
    },
  };
}

function hasAllRouteSets(found) {
  return found.resolved_model_slug.size > 0
    && found.serverSteModelSlug.size > 0
    && found.requested_model_experience.size > 0;
}

function firstOrNull(set) {
  return set.values().next().value ?? null;
}

function hasRouteField(fields) {
  return Boolean(fields.resolved_model_slug || fields.server_ste_metadata.model_slug || fields.requested_model_experience);
}
