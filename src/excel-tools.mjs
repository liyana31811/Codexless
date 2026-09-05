import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const DOCUMENT_SERVER = "codex_apps";
const LIST_SESSIONS = "codex_document_control.list_document_sessions";
const GET_SCHEMAS = "codex_document_control.get_document_tool_schemas";
const EXECUTE = "codex_document_control.execute_document_command";
const TYPED_EXCEL_TOOLS = new Set([
  "read_sheets_metadata",
  "read_ranges",
  "search_workbook",
  "write_range",
  "format_range",
]);
const EXCEL_DYNAMIC_EXECUTION_CLASSIFICATION = new Map([
  ...[...TYPED_EXCEL_TOOLS].map((name) => [name, "typed_shortcut"]),
  ["list_items", "dynamic_allowed"],
  ["read_range_image", "dynamic_allowed"],
  ["resize_range", "dynamic_allowed"],
  ["update_sheet_view", "dynamic_allowed"],
  ["copy_range_to", "dynamic_allowed"],
  ["update_sheet", "conditional"],
  ["update_workbook", "conditional"],
  ["chart", "conditional"],
  ["table", "conditional"],
  ["pivot_table", "conditional"],
  ["clear_range", "confirmation_required"],
  ["run_officejs", "wide_gate"],
]);
const MAX_DISCOVERED_EXCEL_TOOLS = 128;
const MAX_DYNAMIC_RESULT_BYTES = 200_000;
const MAX_DYNAMIC_STRING_CHARS = 50_000;
const MAX_DYNAMIC_COLLECTION_ITEMS = 200;
const MAX_DYNAMIC_RESULT_DEPTH = 12;
const AUTHORITY_BEARING_RESULT_KEYS = new Set([
  "executorsessionid",
  "executorid",
  "mcpserver",
  "server",
  "serverid",
  "serverurl",
  "surface",
  "transport",
  "transporthandle",
  "permissionprofile",
  "permissions",
  "sandbox",
  "sandboxpolicy",
  "approvalpolicy",
]);
const UNSUPPORTED_EXCEL_SCHEMA_KEYWORDS = new Set([
  "$ref",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
]);
const EXCEL_RESIZE_SPEC = z.object({
  type: z.enum(["autofit", "points", "standard"]),
  value: z.number().optional(),
}).strict();
const EXCEL_CELL_STYLES = z.object({
  fontColor: z.string().optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  fontWeight: z.enum(["normal", "bold"]).optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  fontLine: z.enum(["none", "underline", "line-through"]).optional(),
  backgroundColor: z.string().optional(),
  horizontalAlignment: z.enum(["left", "center", "right"]).optional(),
  numberFormat: z.string().optional(),
  borders: z.array(z.object({
    sides: z.array(z.enum(["top", "bottom", "left", "right"])).min(1),
    style: z.enum(["solid", "dashed", "dotted", "double"]),
    weight: z.enum(["thin", "medium", "thick"]),
    color: z.string().optional(),
  }).strict()).optional(),
}).strict();
const EXCEL_CELL_WRITE = z.object({
  cell: z.string().min(1).max(256),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  formula: z.string().optional(),
  note: z.union([z.string(), z.null()]).optional(),
  resizeColumn: EXCEL_RESIZE_SPEC.optional(),
  resizeRow: EXCEL_RESIZE_SPEC.optional(),
  cellStyles: EXCEL_CELL_STYLES.optional(),
}).strict();

export function registerExcelTools(server, { workbench, sessionRefs = null }) {
  if (!workbench) return;
  const adapter = new ExcelDocumentAdapter({ workbench, sessionRefs });
  const sessionRef = z.string().min(1).max(256).optional();
  const cwd = z.string().min(1).max(32_768).optional();

  server.registerTool("codex.excel_status", {
    title: "Excel Connected Workbook Status",
    description: "Freshly discover Excel workbooks connected through Codex Document Control. Returns Codexless opaque sessionRef values plus sanitized exact supported-tool exposure classes, never raw executor session ids. No Codex model turn is started.",
    inputSchema: z.object({ cwd }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => structured(() => adapter.status(input)));

  server.registerTool("codex.excel_tool_schemas", {
    title: "Read Connected Excel Tool Schemas",
    description: "Read the current input schemas for exact tools advertised by one freshly revalidated connected Excel session. Returns only opaque session identity plus advertised tool name/version/exposure and input_schema; never raw executor session ids or execution authority. No workbook command is dispatched.",
    inputSchema: z.object({
      sessionRef,
      cwd,
      toolNames: z.array(z.string().min(1).max(256)).min(1).max(32),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => structured(() => adapter.toolSchemas(input)));

  server.registerTool("codex.excel_execute_tool", {
    title: "Execute Reviewed Excel Document Tool",
    description: "Household-only stock-shaped Excel gateway. Freshly revalidates one connected Excel session, requires one exact server-reviewed dynamic exposure, fetches its current advertised schema, and dispatches once with a caller-stable idempotency key. Unknown, confirmation-required, wide-gate, and typed-shortcut leaves fail before dispatch. A confirmed generic receipt does not prove workbook-state verification.",
    inputSchema: z.object({
      sessionRef,
      cwd,
      toolName: z.string().min(1).max(256),
      arguments: z.record(z.string().min(1).max(256), z.unknown()),
      idempotencyKey: z.string().min(8).max(512),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => structured(() => adapter.executeDynamic(input)));

  server.registerTool("codex.excel_read_sheets_metadata", {
    title: "Read Connected Excel Sheet Metadata",
    description: "Freshly revalidate one connected Excel workbook, fetch the live advertised schema, then read sheet metadata through Codex Document Control.",
    inputSchema: z.object({ sessionRef, cwd, summary: z.string().max(2000).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => structured(() => adapter.executeRead("read_sheets_metadata", input, { summary: input.summary })));

  server.registerTool("codex.excel_read_ranges", {
    title: "Read Connected Excel Ranges",
    description: "Freshly revalidate one connected Excel workbook and read bounded ranges using its current live schema.",
    inputSchema: z.object({ sessionRef, cwd, sheetId: z.string().min(1).max(1024), ranges: z.array(z.string().min(1).max(256)).min(1).max(50), includeStyles: z.boolean().default(false), cellLimit: z.number().int().min(1).max(10000).default(1000), summary: z.string().max(2000).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => structured(() => adapter.executeRead("read_ranges", input, pick(input, ["summary", "sheetId", "ranges", "includeStyles", "cellLimit"]))));

  server.registerTool("codex.excel_search_workbook", {
    title: "Search Connected Excel Workbook",
    description: "Freshly revalidate one connected Excel workbook and search it using the workbook's currently advertised search_workbook schema.",
    inputSchema: z.object({ sessionRef, cwd, query: z.string().min(1).max(4000), summary: z.string().max(40).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => structured(() => adapter.executeRead("search_workbook", input, withoutControl(input))));

  server.registerTool("codex.excel_write_range", {
    title: "Write Connected Excel Range",
    description: "Write values/formulas to one freshly revalidated connected workbook with a caller-stable idempotency key. The adapter never blindly replays an uncertain dispatch and performs an Excel readback of verifyRanges before returning.",
    inputSchema: z.object({ sessionRef, cwd, sheetId: z.string().min(1).max(1024), writes: z.array(EXCEL_CELL_WRITE).min(1).max(5000), idempotencyKey: z.string().min(8).max(512), verifyRanges: z.array(z.string().min(1).max(256)).min(1).max(50), summary: z.string().max(40).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => structured(() => adapter.executeMutation("write_range", input, { summary: input.summary ?? "Update Excel cells", sheetId: input.sheetId, writes: input.writes }, { sheetId: input.sheetId, ranges: input.verifyRanges })));

  server.registerTool("codex.excel_format_range", {
    title: "Format Connected Excel Range",
    description: "Apply bounded cell formatting to one freshly revalidated connected workbook with a caller-stable idempotency key, then read the formatted range back from Excel. Uncertain dispatch is never replayed.",
    inputSchema: z.object({ sessionRef, cwd, sheetId: z.string().min(1).max(1024), range: z.string().min(1).max(256), cellStyles: EXCEL_CELL_STYLES, idempotencyKey: z.string().min(8).max(512), summary: z.string().max(40).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => structured(() => adapter.executeMutation("format_range", input, pick(input, ["summary", "sheetId", "range", "cellStyles"]), { sheetId: input.sheetId, ranges: [input.range], includeStyles: true })));
}

export class ExcelDocumentAdapter {
  #workbench;
  #refs;
  constructor({ workbench, sessionRefs = null }) {
    this.#workbench = workbench;
    this.#refs = sessionRefs ?? new Map();
  }

  async status({ cwd } = {}) {
    const sessions = await this.#discover(cwd);
    return { connected: sessions.length > 0, sessionCount: sessions.length, sessions: sessions.map((session) => this.#publicSession(session)) };
  }

  async toolSchemas(input) {
    const session = await this.#resolveSession(input.sessionRef, input.cwd);
    const uniqueNames = [...new Set(input.toolNames)];
    if (uniqueNames.length !== input.toolNames.length) throw new Error("EXCEL_SCHEMA_LOOKUP_DUPLICATE_TOOL: toolNames must be unique");
    const advertised = uniqueNames.map((toolName) => this.#requireAdvertisedTool(session, toolName));
    const response = await this.#workbench.mcpCall({
      server: DOCUMENT_SERVER,
      tool: GET_SCHEMAS,
      arguments: { items: advertised.map((tool) => ({ surface: "excel", tool_name: tool.name, version: tool.version })) },
      cwd: input.cwd,
    });
    if (response?.isError) throw new Error(`EXCEL_SCHEMA_LOOKUP_FAILED: ${response.text ?? "upstream error"}`);
    const schemas = payload(response)?.tool_schemas ?? [];
    await this.#assertSessionStillAdvertises(session, advertised, input.cwd);
    const exact = advertised.map((tool) => {
      const schema = schemas.find((item) => item?.tool_name === tool.name && String(item?.version) === String(tool.version));
      if (!schema?.input_schema || typeof schema.input_schema !== "object") throw new Error(`EXCEL_SCHEMA_DRIFT: current ${tool.name}@${tool.version} schema was not returned exactly`);
      const schemaJson = JSON.stringify(schema.input_schema);
      if (Buffer.byteLength(schemaJson, "utf8") > MAX_DYNAMIC_RESULT_BYTES) throw new Error(`EXCEL_SCHEMA_TOO_LARGE: ${tool.name}@${tool.version}`);
      assertNoAuthorityBearingSchemaKeys(schema.input_schema, tool.name);
      return {
        name: tool.name,
        version: tool.version,
        exposure: publicExcelExposure(tool.name),
        inputSchema: schema.input_schema,
      };
    });
    return {
      workbookTitle: session.document_title ?? null,
      sessionRef: this.#refFor(session),
      tools: exact,
    };
  }

  async executeDynamic(input) {
    const session = await this.#resolveSession(input.sessionRef, input.cwd);
    const advertised = this.#requireAdvertisedTool(session, input.toolName);
    const baseExposure = dynamicExecutionClassification(input.toolName);
    if (baseExposure === "typed_shortcut") throw new Error(`EXCEL_DYNAMIC_TOOL_TYPED_SHORTCUT: ${input.toolName}`);
    const schema = await this.#fetchLiveSchema(session, advertised, input.cwd);
    assertSchemaCompatible(schema.input_schema, input.arguments, input.toolName);
    await this.#assertSessionStillAdvertises(session, [advertised], input.cwd);
    const exposure = dynamicExecutionClassification(input.toolName, input.arguments);
    if (exposure === "confirmation_required") throw new Error(`EXCEL_DYNAMIC_TOOL_CONFIRMATION_REQUIRED: ${input.toolName}`);
    if (exposure === "wide_gate") throw new Error(`EXCEL_TOOL_WIDE_GATE_REQUIRED: ${input.toolName}`);
    if (exposure !== "dynamic_allowed") throw new Error(`EXCEL_DYNAMIC_TOOL_NOT_YET_EXPOSED: ${input.toolName}`);
    let dispatch;
    try {
      dispatch = await this.#execute(session, input.toolName, input.arguments, input.idempotencyKey, input.cwd);
    } catch {
      return {
        workbookTitle: session.document_title ?? null,
        sessionRef: this.#refFor(session),
        toolName: input.toolName,
        toolVersion: advertised.version,
        dispatchStatus: "uncertain",
        verificationStatus: "not_performed_by_generic_gateway",
        replayAllowed: false,
        error: "EXCEL_DYNAMIC_DISPATCH_RESULT_UNCERTAIN",
      };
    }
    const sanitized = sanitizeDynamicResult(payload(dispatch));
    return {
      workbookTitle: session.document_title ?? null,
      sessionRef: this.#refFor(session),
      toolName: input.toolName,
      toolVersion: advertised.version,
      dispatchStatus: dispatch?.isError === true ? "confirmed_error" : "confirmed",
      verificationStatus: "not_performed_by_generic_gateway",
      replayAllowed: false,
      ...sanitized,
    };
  }

  async executeRead(toolName, input, args) {
    const session = await this.#resolveSession(input.sessionRef, input.cwd);
    const schema = await this.#requireLiveSchema(session, toolName, input.cwd);
    const dispatchArgs = adaptReadArgs(toolName, args);
    assertSchemaCompatible(schema.input_schema, dispatchArgs, toolName);
    const result = await this.#execute(session, toolName, dispatchArgs, `excel-read-${randomUUID()}`, input.cwd);
    return { workbook: session.document_title, sessionRef: this.#refFor(session), tool: toolName, status: "succeeded", result: payload(result) };
  }

  async executeMutation(toolName, input, args, readbackArgs) {
    const session = await this.#resolveSession(input.sessionRef, input.cwd);
    const mutationSchema = await this.#requireLiveSchema(session, toolName, input.cwd);
    const readbackSchema = await this.#requireLiveSchema(session, "read_ranges", input.cwd);
    assertSchemaCompatible(mutationSchema.input_schema, args, toolName);
    const verificationArgs = { summary: `Verify ${toolName}`, ...readbackArgs, cellLimit: 10000 };
    assertSchemaCompatible(readbackSchema.input_schema, verificationArgs, "read_ranges");
    let dispatch;
    let dispatchError = null;
    try {
      dispatch = await this.#execute(session, toolName, args, input.idempotencyKey, input.cwd);
      if (dispatch?.isError === true || payload(dispatch)?.ok === false) dispatchError = new Error("Excel mutation returned an error result");
    } catch (error) {
      dispatchError = error instanceof Error ? error : new Error(String(error));
    }
    let readback = null;
    let readbackError = null;
    try {
      readback = await this.#execute(session, "read_ranges", verificationArgs, `excel-readback-${randomUUID()}`, input.cwd);
    } catch (error) {
      readbackError = error instanceof Error ? error.message : String(error);
    }
    const observed = readback ? payload(readback) : null;
    const verificationStatus = classifyMutationReadback(toolName, args, observed);
    if (dispatchError) {
      return {
        workbook: session.document_title,
        sessionRef: this.#refFor(session),
        tool: toolName,
        dispatchStatus: "uncertain",
        verificationStatus,
        mutationStatus: verificationStatus,
        replayAllowed: false,
        error: dispatchError.message,
        readbackStatus: readback ? "available" : "unavailable",
        readback: observed,
        readbackError,
      };
    }
    return {
      workbook: session.document_title,
      sessionRef: this.#refFor(session),
      tool: toolName,
      dispatchStatus: "confirmed",
      verificationStatus,
      mutationStatus: verificationStatus,
      replayAllowed: false,
      upstream: payload(dispatch),
      readbackStatus: readback ? "available" : "unavailable",
      readback: observed,
      readbackError,
    };
  }

  async #discover(cwd) {
    const response = await this.#workbench.mcpCall({ server: DOCUMENT_SERVER, tool: LIST_SESSIONS, arguments: { surface: "excel" }, cwd });
    if (response?.isError) throw new Error(`Excel session discovery failed: ${response.text ?? "unknown error"}`);
    return (payload(response)?.executors ?? []).filter((session) => session?.status === "connected" && session?.surface === "excel");
  }

  async #resolveSession(ref, cwd) {
    const sessions = await this.#discover(cwd);
    if (!ref) {
      if (sessions.length === 0) throw new Error("EXCEL_NOT_CONNECTED: no connected Excel workbook is currently registered");
      if (sessions.length !== 1) throw new Error(`EXCEL_SESSION_AMBIGUOUS: ${sessions.length} connected workbooks; choose a sessionRef from codex.excel_status`);
      this.#refFor(sessions[0]);
      return sessions[0];
    }
    const binding = this.#refs.get(ref);
    if (!binding) throw new Error("EXCEL_SESSION_REF_UNKNOWN_OR_RETIRED: refresh codex.excel_status");
    const matches = sessions.filter((session) => session.executor_session_id === binding.executorSessionId && session.document_title === binding.title);
    if (matches.length !== 1) {
      this.#refs.delete(ref);
      throw new Error("EXCEL_SESSION_STALE: workbook/Add-in session changed; refresh codex.excel_status");
    }
    return matches[0];
  }

  async #requireLiveSchema(session, toolName, cwd) {
    if (!TYPED_EXCEL_TOOLS.has(toolName)) throw new Error(`EXCEL_TOOL_NOT_ALLOWED: ${toolName}`);
    const advertised = this.#requireAdvertisedTool(session, toolName);
    return this.#fetchLiveSchema(session, advertised, cwd);
  }

  #requireAdvertisedTool(session, toolName) {
    const advertised = (session.supported_tools ?? []).find((tool) => tool?.name === toolName);
    if (!advertised?.version) throw new Error(`EXCEL_TOOL_UNAVAILABLE: ${toolName}`);
    return advertised;
  }

  async #fetchLiveSchema(session, advertised, cwd) {
    const response = await this.#workbench.mcpCall({
      server: DOCUMENT_SERVER,
      tool: GET_SCHEMAS,
      arguments: { items: [{ surface: "excel", tool_name: advertised.name, version: advertised.version }] },
      cwd,
    });
    const schemas = payload(response)?.tool_schemas ?? [];
    const exact = schemas.find((schema) => schema?.tool_name === advertised.name && String(schema?.version) === String(advertised.version));
    if (response?.isError || !exact) throw new Error(`EXCEL_SCHEMA_DRIFT: current ${advertised.name}@${advertised.version} schema was not returned exactly`);
    return exact;
  }

  async #assertSessionStillAdvertises(session, advertisedTools, cwd) {
    const sessions = await this.#discover(cwd);
    const current = sessions.find((candidate) => candidate.executor_session_id === session.executor_session_id && candidate.document_title === session.document_title);
    if (!current) throw new Error("EXCEL_SESSION_STALE: workbook/Add-in session changed during schema validation");
    for (const advertised of advertisedTools) {
      const stillAdvertised = (current.supported_tools ?? []).find((tool) => tool?.name === advertised.name);
      if (!stillAdvertised || String(stillAdvertised.version) !== String(advertised.version)) {
        throw new Error(`EXCEL_SCHEMA_STALE: ${advertised.name}@${advertised.version} changed during schema validation`);
      }
    }
  }

  async #execute(session, toolName, args, idempotencyKey, cwd) {
    return this.#workbench.mcpCall({
      server: DOCUMENT_SERVER,
      tool: EXECUTE,
      arguments: { executor_session_id: session.executor_session_id, idempotency_key: idempotencyKey, tool_name: toolName, args },
      cwd,
    });
  }

  #refFor(session) {
    for (const [ref, binding] of this.#refs) {
      if (binding.executorSessionId === session.executor_session_id && binding.title === session.document_title) return ref;
    }
    const ref = `excel_session_${randomUUID()}`;
    if (this.#refs.size >= 256) {
      const oldest = this.#refs.keys().next().value;
      if (oldest) this.#refs.delete(oldest);
    }
    this.#refs.set(ref, { executorSessionId: session.executor_session_id, title: session.document_title });
    return ref;
  }

  #publicSession(session) {
    const supported = (session.supported_tools ?? [])
      .filter((tool) => typeof tool?.name === "string" && tool.name && tool?.version !== undefined && tool?.version !== null)
      .map((tool) => ({ name: tool.name, version: tool.version, exposure: publicExcelExposure(tool.name) }));
    return {
      sessionRef: this.#refFor(session),
      title: session.document_title ?? null,
      status: session.status,
      supportedTools: supported.slice(0, MAX_DISCOVERED_EXCEL_TOOLS),
      supportedToolsTruncated: supported.length > MAX_DISCOVERED_EXCEL_TOOLS,
    };
  }
}

function dynamicExecutionClassification(toolName, args = null) {
  const classification = EXCEL_DYNAMIC_EXECUTION_CLASSIFICATION.get(toolName) ?? "unclassified";
  if (classification !== "conditional" || !args) return classification;
  const operation = typeof args?.operation === "string" ? args.operation : "";
  if (!operation) return "conditional";
  return operation === "delete" ? "confirmation_required" : "dynamic_allowed";
}

function publicExcelExposure(toolName) {
  const classification = dynamicExecutionClassification(toolName);
  if (classification === "typed_shortcut") return "typed";
  if (classification === "dynamic_allowed") return "dynamic";
  return classification;
}

function assertNoAuthorityBearingSchemaKeys(value, toolName, depth = 0) {
  if (depth > MAX_DYNAMIC_RESULT_DEPTH) throw new Error(`EXCEL_SCHEMA_DEPTH_EXCEEDED: ${toolName}`);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) assertNoAuthorityBearingSchemaKeys(child, toolName, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (AUTHORITY_BEARING_RESULT_KEYS.has(normalized)) throw new Error(`EXCEL_SCHEMA_AUTHORITY_FIELD_REJECTED: ${toolName}.${key}`);
    assertNoAuthorityBearingSchemaKeys(child, toolName, depth + 1);
  }
}

function sanitizeDynamicResult(value) {
  const state = { truncated: false, nodes: 0 };
  const sanitized = sanitizeDynamicValue(value, state, 0);
  let json = "";
  try { json = JSON.stringify(sanitized); } catch { state.truncated = true; }
  const resultBytes = Buffer.byteLength(json || "null", "utf8");
  if (!json || resultBytes > MAX_DYNAMIC_RESULT_BYTES) {
    return { result: null, resultOmitted: true, resultBytes, resultTruncated: true };
  }
  return { result: sanitized, resultOmitted: false, resultBytes, resultTruncated: state.truncated };
}

function sanitizeDynamicValue(value, state, depth) {
  state.nodes += 1;
  if (depth > MAX_DYNAMIC_RESULT_DEPTH || state.nodes > 10_000) {
    state.truncated = true;
    return "[truncated]";
  }
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") {
    if (value.length <= MAX_DYNAMIC_STRING_CHARS) return value;
    state.truncated = true;
    return `${value.slice(0, MAX_DYNAMIC_STRING_CHARS)}[truncated]`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DYNAMIC_COLLECTION_ITEMS) state.truncated = true;
    return value.slice(0, MAX_DYNAMIC_COLLECTION_ITEMS).map((item) => sanitizeDynamicValue(item, state, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value);
  const entries = Object.entries(value);
  if (entries.length > MAX_DYNAMIC_COLLECTION_ITEMS) state.truncated = true;
  const out = {};
  for (const [key, child] of entries.slice(0, MAX_DYNAMIC_COLLECTION_ITEMS)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (AUTHORITY_BEARING_RESULT_KEYS.has(normalized)) continue;
    out[key] = sanitizeDynamicValue(child, state, depth + 1);
  }
  return out;
}

function payload(response) { return response?.data?.structuredContent ?? response?.data ?? null; }

function assertSchemaCompatible(schema, value, toolName) {
  if (!schema || typeof schema !== "object") throw new Error(`EXCEL_SCHEMA_DRIFT: ${toolName} returned no usable input_schema`);
  assertSupportedSchemaKeywords(schema, toolName);
  const errors = [];
  validateJsonSchema(schema, value, "$", errors);
  if (errors.length) throw new Error(`EXCEL_SCHEMA_DRIFT: ${toolName} arguments no longer satisfy current schema (${errors.slice(0, 3).join("; ")})`);
}

function assertSupportedSchemaKeywords(schema, toolName, path = "$", depth = 0) {
  if (!schema || typeof schema !== "object") return;
  if (depth > MAX_DYNAMIC_RESULT_DEPTH) throw new Error(`EXCEL_SCHEMA_DRIFT: ${toolName} schema exceeds supported depth at ${path}`);
  for (const keyword of UNSUPPORTED_EXCEL_SCHEMA_KEYWORDS) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword)) throw new Error(`EXCEL_SCHEMA_DRIFT: ${toolName} uses unsupported schema keyword ${keyword} at ${path}`);
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) assertSupportedSchemaKeywords(child, toolName, `${path}.properties.${name}`, depth + 1);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)) {
    assertSupportedSchemaKeywords(schema.additionalProperties, toolName, `${path}.additionalProperties`, depth + 1);
  }
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) assertSupportedSchemaKeywords(schema.items, toolName, `${path}.items`, depth + 1);
  for (const keyword of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (let i = 0; i < schema[keyword].length; i += 1) assertSupportedSchemaKeywords(schema[keyword][i], toolName, `${path}.${keyword}[${i}]`, depth + 1);
  }
}

function validateJsonSchema(schema, value, path, errors) {
  if (!schema || typeof schema !== "object" || errors.length >= 4) return;
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((candidate) => { const nested = []; validateJsonSchema(candidate, value, path, nested); return nested.length === 0; })) errors.push(`${path} matches no anyOf branch`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => { const nested = []; validateJsonSchema(candidate, value, path, nested); return nested.length === 0; }).length;
    if (matches !== 1) errors.push(`${path} matches ${matches} oneOf branches`);
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => jsonTypeMatches(type, value))) { errors.push(`${path} type mismatch`); return; }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) errors.push(`${path} const mismatch`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) errors.push(`${path} enum mismatch`);
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${path} shorter than minLength`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path} longer than maxLength`);
    if (typeof schema.pattern === "string") {
      let pattern;
      try { pattern = new RegExp(schema.pattern); } catch { errors.push(`${path} has invalid schema pattern`); return; }
      if (!pattern.test(value)) errors.push(`${path} pattern mismatch`);
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} above maximum`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${path} below exclusiveMinimum`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(`${path} above exclusiveMaximum`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key} required`);
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validateJsonSchema(properties[key], child, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateJsonSchema(schema.additionalProperties, child, `${path}.${key}`, errors);
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${path} shorter than minItems`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path} longer than maxItems`);
    if (schema.uniqueItems === true) {
      const fingerprints = value.map((item) => JSON.stringify(item));
      if (new Set(fingerprints).size !== fingerprints.length) errors.push(`${path} items not unique`);
    }
    if (schema.items) for (let i = 0; i < value.length; i += 1) validateJsonSchema(schema.items, value[i], `${path}[${i}]`, errors);
  }
}

function jsonTypeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function classifyMutationReadback(toolName, requested, observed) {
  if (!observed) return "uncertain";
  if (toolName === "write_range") return classifyWriteReadback(requested, observed);
  if (toolName === "format_range") return classifyFormatReadback(requested, observed);
  return "uncertain";
}

function classifyWriteReadback(requested, observed) {
  if (hasUnverifiedWriteEffects(requested)) return "uncertain";
  const wanted = extractRequestedCells(requested);
  const seen = extractObservedCells(observed);
  if (!wanted.length || !seen.size) return "uncertain";
  let compared = 0;
  let mismatch = 0;
  for (const item of wanted) {
    const actual = seen.get(item.cell.toUpperCase());
    if (!actual) continue;
    compared += 1;
    if (item.formula !== undefined ? actual.formula !== item.formula : !excelScalarEqual(actual.value, item.value)) mismatch += 1;
  }
  if (compared !== wanted.length) return "uncertain";
  return mismatch === 0 ? "applied" : "uncertain";
}

function hasUnverifiedWriteEffects(requested) {
  const verifiableFields = new Set(["cell", "value", "formula", "range", "values", "formulas"]);
  for (const write of requested?.writes ?? []) {
    if (!write || typeof write !== "object" || Array.isArray(write)) return true;
    if (Object.keys(write).some((key) => !verifiableFields.has(key))) return true;
  }
  return false;
}

function extractRequestedCells(requested) {
  const out = [];
  for (const write of requested?.writes ?? []) {
    if (typeof write?.cell === "string" && ("value" in write || "formula" in write)) out.push({ cell: write.cell, value: write.value, formula: write.formula });
    if (typeof write?.range === "string" && Array.isArray(write.values)) {
      const origin = parseA1Origin(write.range);
      if (!origin) continue;
      for (let r = 0; r < write.values.length; r += 1) for (let c = 0; c < (write.values[r] ?? []).length; c += 1) out.push({ cell: a1(origin.row + r, origin.col + c), value: write.values[r][c] });
    }
    if (typeof write?.range === "string" && Array.isArray(write.formulas)) {
      const origin = parseA1Origin(write.range);
      if (!origin) continue;
      for (let r = 0; r < write.formulas.length; r += 1) for (let c = 0; c < (write.formulas[r] ?? []).length; c += 1) if (write.formulas[r][c] != null) out.push({ cell: a1(origin.row + r, origin.col + c), formula: write.formulas[r][c] });
    }
  }
  return out;
}

function extractObservedCells(observed) {
  const map = new Map();
  const ranges = observed?.result ?? observed?.ranges ?? observed?.data?.result ?? [];
  if (typeof ranges === "string") {
    for (const block of parseExcelRangesXml(ranges)) {
      for (const [cell, value] of block.cells) map.set(cell, value);
    }
    return map;
  }
  for (const block of Array.isArray(ranges) ? ranges : [ranges]) {
    const origin = parseA1Origin(block?.range ?? block?.address ?? "");
    if (!origin) continue;
    const values = block?.values ?? [];
    const formulas = block?.formulas ?? [];
    const rows = Math.max(values.length, formulas.length);
    for (let r = 0; r < rows; r += 1) {
      const cols = Math.max(values[r]?.length ?? 0, formulas[r]?.length ?? 0);
      for (let c = 0; c < cols; c += 1) map.set(a1(origin.row + r, origin.col + c), { value: values[r]?.[c], formula: formulas[r]?.[c] });
    }
  }
  return map;
}

function classifyFormatReadback(requested, observed) {
  const styles = requested?.cellStyles;
  const requestedRange = canonicalA1Range(requested?.range);
  if (!styles || typeof styles !== "object" || !requestedRange) return "uncertain";
  const allEntries = Object.entries(styles);
  if (!allEntries.length || allEntries.some(([, value]) => !(value === null || ["string", "number", "boolean"].includes(typeof value)))) return "uncertain";
  const entries = allEntries;
  const ranges = observed?.result ?? observed?.ranges ?? observed?.data?.result ?? [];
  const blocks = typeof ranges === "string" ? parseExcelRangesXml(ranges) : (Array.isArray(ranges) ? ranges : [ranges]);
  const block = blocks.find((item) => canonicalA1Range(item?.range ?? item?.address) === requestedRange);
  if (!block) return "uncertain";
  const observedStyles = block.styles ?? block.style ?? block.cellStyles;
  if (!observedStyles || typeof observedStyles !== "object" || Array.isArray(observedStyles)) return "uncertain";
  return entries.every(([key, value]) => deepEqual(observedStyles[key], value)) ? "applied" : "uncertain";
}

function parseExcelRangesXml(xml) {
  if (typeof xml !== "string" || !xml.includes("<range>")) return [];
  const blocks = [];
  const rangePattern = /<range>([\s\S]*?)<\/range>/gi;
  let rangeMatch;
  while ((rangeMatch = rangePattern.exec(xml)) !== null) {
    const body = rangeMatch[1];
    const addressMatch = body.match(/<address\s+range="([^"]+)"[^>]*>([\s\S]*?)<\/address>/i);
    if (!addressMatch) continue;
    const cells = new Map();
    const cellPattern = /<([A-Z]+\d+)>([\s\S]*?)<\/\1>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(addressMatch[2])) !== null) {
      const cellBody = cellMatch[2];
      const value = xmlTagValue(cellBody, "v");
      const formula = xmlTagValue(cellBody, "f");
      cells.set(cellMatch[1].toUpperCase(), {
        value,
        formula: formula ?? undefined,
      });
    }
    const stylesBody = body.match(/<styles>([\s\S]*?)<\/styles>/i)?.[1] ?? "";
    blocks.push({
      range: decodeXml(addressMatch[1]),
      styles: parseExcelStylesXml(stylesBody),
      cells,
    });
  }
  return blocks;
}

function parseExcelStylesXml(xml) {
  if (!xml) return {};
  const styles = {};
  const fill = xmlTagValue(xml, "fill");
  if (fill !== null) styles.backgroundColor = fill;
  const horizontalAlignment = xmlTagValue(xml, "horizontalAlignment");
  if (horizontalAlignment !== null) styles.horizontalAlignment = horizontalAlignment;
  const verticalAlignment = xmlTagValue(xml, "verticalAlignment");
  if (verticalAlignment !== null) styles.verticalAlignment = verticalAlignment;
  const font = xml.match(/<font>([\s\S]*?)<\/font>/i)?.[1] ?? "";
  const fontColor = xmlTagValue(font, "color");
  if (fontColor !== null) styles.fontColor = fontColor;
  const fontSize = xmlTagValue(font, "size");
  if (fontSize !== null && Number.isFinite(Number(fontSize))) styles.fontSize = Number(fontSize);
  const bold = xmlTagValue(font, "bold");
  if (bold !== null && /^(?:true|1)$/i.test(bold)) styles.fontWeight = "bold";
  return styles;
}

function xmlTagValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(value) {
  return String(value).replace(/&#x([0-9a-f]+);|&#(\d+);|&quot;|&apos;|&lt;|&gt;|&amp;/gi, (entity, hex, dec) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
    return { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" }[entity.toLowerCase()] ?? entity;
  });
}

function excelScalarEqual(actual, expected) {
  if (typeof expected === "number") return typeof actual === "number" ? actual === expected : typeof actual === "string" && actual.trim() !== "" && Number(actual) === expected;
  if (typeof expected === "boolean" && typeof actual === "string") return actual.toLowerCase() === String(expected);
  return deepEqual(actual, expected);
}

function canonicalA1Range(range) {
  if (typeof range !== "string" || !range.trim()) return null;
  const local = range.includes("!") ? range.slice(range.lastIndexOf("!") + 1) : range;
  return local.replace(/\$/g, "").trim().toUpperCase();
}

function parseA1Origin(range) {
  const match = String(range).match(/(?:^|!)(\$?)([A-Z]+)(\$?)(\d+)/i);
  if (!match) return null;
  let col = 0;
  for (const ch of match[2].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return { row: Number(match[4]), col };
}
function a1(row, col) { let letters = ""; for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters; return `${letters}${row}`; }
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function adaptReadArgs(toolName, args) {
  if (toolName !== "search_workbook") return args;
  const { query, ...rest } = args ?? {};
  return { ...rest, searchTerm: query };
}
function pick(value, keys) { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])); }
function withoutControl(value) { const { sessionRef, cwd, ...rest } = value; return rest; }
async function structured(fn) {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], structuredContent: { error: message }, isError: true };
  }
}
