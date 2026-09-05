import { createHash, randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_REFS = 512;
const ALLOWED_ACTIONS = new Set(["click", "double_click"]);

function requiredString(value, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(code);
  return normalized;
}

function boundedDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const output = {};
  for (const key of ["tag", "role", "name", "text", "href", "type"]) {
    if (typeof value[key] !== "string") continue;
    const normalized = value[key].replace(/\s+/g, " ").trim();
    if (normalized) output[key] = normalized.slice(0, 2048);
  }
  return Object.freeze(output);
}

function renderedAttr(line, name) {
  const match = line.match(new RegExp(`\\b${name}=(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

export function browserElementNodesFromVisibleDom(snapshot, { maxNodes = 256 } = {}) {
  if (typeof snapshot !== "string") throw new Error("BROWSER_ELEMENT_VISIBLE_DOM_INVALID");
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 2_000) throw new Error("BROWSER_ELEMENT_MAX_NODES_INVALID");
  const nodes = [];
  for (const rawLine of snapshot.split(/\r?\n/)) {
    const nodeMatch = rawLine.match(/\bnode_id=(?:\"([^\"]+)\"|'([^']+)'|([^\s>]+))/i);
    if (!nodeMatch) continue;
    const rawNodeId = (nodeMatch[1] ?? nodeMatch[2] ?? nodeMatch[3] ?? "").trim();
    if (!rawNodeId) continue;
    const tag = rawLine.match(/<([A-Za-z][\w:-]*)\b/)?.[1]?.toLowerCase() ?? "";
    const role = renderedAttr(rawLine, "role");
    const name = renderedAttr(rawLine, "aria-label") || renderedAttr(rawLine, "name") || renderedAttr(rawLine, "title");
    const href = renderedAttr(rawLine, "href");
    const type = renderedAttr(rawLine, "type");
    const text = rawLine
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const canonical = rawLine
      .replace(/\bnode_id=(?:\"[^\"]+\"|'[^']+'|[^\s>]+)/i, "node_id=<server-bound>")
      .replace(/\s+/g, " ")
      .trim();
    const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
    nodes.push({
      rawNodeId,
      fingerprint,
      descriptor: { tag, role, name, text, href, type },
    });
    if (nodes.length >= maxNodes) break;
  }
  return nodes;
}

function normalizeNode(node) {
  const rawNodeId = requiredString(node?.rawNodeId, "BROWSER_ELEMENT_NODE_ID_REQUIRED");
  const fingerprint = requiredString(node?.fingerprint, "BROWSER_ELEMENT_FINGERPRINT_REQUIRED");
  return { rawNodeId, fingerprint, descriptor: boundedDescriptor(node?.descriptor) };
}

export class BrowserElementRefRegistry {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxRefs = DEFAULT_MAX_REFS, clock = () => Date.now() } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 10 * 60_000) throw new Error("BROWSER_ELEMENT_TTL_INVALID");
    if (!Number.isInteger(maxRefs) || maxRefs < 1 || maxRefs > 10_000) throw new Error("BROWSER_ELEMENT_CAPACITY_INVALID");
    if (typeof clock !== "function") throw new Error("BROWSER_ELEMENT_CLOCK_INVALID");
    this.ttlMs = ttlMs;
    this.maxRefs = maxRefs;
    this.clock = clock;
    this.refs = new Map();
  }

  clear() {
    this.refs.clear();
  }

  invalidateTab(tabRef) {
    for (const [ref, record] of this.refs) {
      if (record.tabRef === tabRef) this.refs.delete(ref);
    }
  }

  observe({ tabRef, family, providerTabId, url, workbenchGeneration, nodes }) {
    const normalizedTabRef = requiredString(tabRef, "BROWSER_TAB_REF_REQUIRED");
    const normalizedFamily = requiredString(family, "BROWSER_FAMILY_REQUIRED");
    const normalizedProviderTabId = requiredString(providerTabId, "BROWSER_PROVIDER_TAB_ID_REQUIRED");
    const normalizedUrl = requiredString(url, "BROWSER_ELEMENT_URL_REQUIRED");
    if (!Number.isInteger(workbenchGeneration) || workbenchGeneration < 0) throw new Error("BROWSER_ELEMENT_GENERATION_INVALID");
    if (!Array.isArray(nodes)) throw new Error("BROWSER_ELEMENT_NODES_INVALID");

    this.#cleanupExpired();
    this.invalidateTab(normalizedTabRef);
    const seenNodeIds = new Set();
    const observedAt = this.clock();
    const expiresAt = observedAt + this.ttlMs;
    const elements = [];
    for (const raw of nodes) {
      const node = normalizeNode(raw);
      if (seenNodeIds.has(node.rawNodeId)) throw new Error("BROWSER_ELEMENT_NODE_ID_DUPLICATE");
      seenNodeIds.add(node.rawNodeId);
      const elementRef = `browser_element_${randomUUID()}`;
      const record = Object.freeze({
        elementRef,
        tabRef: normalizedTabRef,
        family: normalizedFamily,
        providerTabId: normalizedProviderTabId,
        url: normalizedUrl,
        workbenchGeneration,
        rawNodeId: node.rawNodeId,
        fingerprint: node.fingerprint,
        descriptor: node.descriptor,
        observedAt,
        expiresAt,
      });
      this.refs.set(elementRef, record);
      elements.push(Object.freeze({ elementRef, descriptor: node.descriptor }));
    }
    this.#trim();
    return Object.freeze({ observedAt, expiresAt, elements: Object.freeze(elements) });
  }

  revalidate({ elementRef, tabRef, family, providerTabId, url, workbenchGeneration, nodes }) {
    const record = this.#get(elementRef);
    if (
      record.tabRef !== tabRef
      || record.family !== family
      || record.providerTabId !== providerTabId
      || record.url !== url
      || record.workbenchGeneration !== workbenchGeneration
    ) {
      throw new Error("BROWSER_ELEMENT_TARGET_CHANGED");
    }
    if (!Array.isArray(nodes)) throw new Error("BROWSER_ELEMENT_NODES_INVALID");
    const current = nodes.map(normalizeNode).find((node) => node.rawNodeId === record.rawNodeId);
    if (!current) throw new Error("BROWSER_ELEMENT_STALE");
    if (current.fingerprint !== record.fingerprint) throw new Error("BROWSER_ELEMENT_TARGET_CHANGED");
    return Object.freeze({
      elementRef: record.elementRef,
      rawNodeId: record.rawNodeId,
      fingerprint: record.fingerprint,
      descriptor: record.descriptor,
    });
  }

  bindAction({ elementRef, action, current }) {
    const normalizedAction = requiredString(action, "BROWSER_ELEMENT_ACTION_REQUIRED");
    if (!ALLOWED_ACTIONS.has(normalizedAction)) throw new Error("BROWSER_ELEMENT_ACTION_UNSUPPORTED");
    const target = this.revalidate({ elementRef, ...current });
    return Object.freeze({
      action: normalizedAction,
      rawNodeId: target.rawNodeId,
      fingerprint: target.fingerprint,
      descriptor: target.descriptor,
    });
  }

  #get(elementRef) {
    const normalizedRef = requiredString(elementRef, "BROWSER_ELEMENT_REF_REQUIRED");
    this.#cleanupExpired();
    const record = this.refs.get(normalizedRef);
    if (!record) throw new Error("BROWSER_ELEMENT_REF_UNKNOWN");
    if (record.expiresAt <= this.clock()) {
      this.refs.delete(normalizedRef);
      throw new Error("BROWSER_ELEMENT_REF_EXPIRED");
    }
    return record;
  }

  #cleanupExpired() {
    const now = this.clock();
    for (const [ref, record] of this.refs) {
      if (record.expiresAt <= now) this.refs.delete(ref);
    }
  }

  #trim() {
    while (this.refs.size > this.maxRefs) {
      const oldest = this.refs.keys().next().value;
      this.refs.delete(oldest);
    }
  }
}

export const BROWSER_ELEMENT_REF_ACTIONS = Object.freeze([...ALLOWED_ACTIONS]);
