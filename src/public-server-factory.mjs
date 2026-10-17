import { createRequire } from "node:module";
import { codexlessIdentity } from "./linux-identity.mjs";
import { registerAgentPreviewTools } from "./agent-tools.mjs";
import { registerBrowserPreviewTools } from "./browser-tools.mjs";
import { registerConstructionTools } from "./construction-tools.mjs";
import { registerPublicContextTools } from "./public-context-tools.mjs";
import { installRecentCallToolInstrumentation } from "./recent-call-diagnostics.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "./surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");

const PUBLIC_BASE_INSTRUCTIONS =
  "Codexless Public Technical Preview. Public surface is deliberately small: authority-bounded project construction, Codex project context and Skills, a narrow existing-login Chrome Browser surface, and explicit metered Codex Agent delegation with visible consent/usage state. Browser exposes Reader plus the reviewed bounded Operator slice: dynamic confirmation-policy read, current viewport screenshot, prepared exact single-tab close/open/navigate/click/fill/download/upload, bounded scroll, and fixed Enter/Tab/Escape. Prepared refs are exact-action bindings rather than permission tokens; mutation uncertainty is fail-visible/no-replay; tab close revalidates one exact current tab and never batch-closes or blindly retries; upload file selection is not remote acceptance; download success requires a Chrome download event receipt. Arbitrary keys, raw selectors/JavaScript/coordinates, Computer Use, generic MCP calls/catalogs, raw host filesystem/process Workbench controls, and private household capabilities remain absent. Remote callers cannot widen Codex permission profiles, sandbox, approval policy, trusted roots, or network authority. Model-free work and metered Codex Agent work are separate lanes.";

export const PUBLIC_SKILL_ROUTING_INSTRUCTIONS =
  "Simple tasks do not require bootstrap. For non-simple local project, code, file, or tool work, prefer codex.project_context(cwd); use codex.skill_read only when a Skill is materially relevant, and revisit project context or that Skill if stuck.";

export const PUBLIC_SERVER_INSTRUCTIONS = `${PUBLIC_BASE_INSTRUCTIONS} ${PUBLIC_SKILL_ROUTING_INSTRUCTIONS}`;

export function createPublicToolRegistrationGate(server, {
  allowedToolNames = PUBLIC_TOOL_NAMES,
  strictUnknown = false,
} = {}) {
  if (!server || typeof server.registerTool !== "function") throw new Error("public tool registration gate requires an MCP server");
  const expected = [...allowedToolNames];
  const allowed = new Set(expected);
  if (allowed.size !== expected.length) throw new Error("PUBLIC_TOOL_ALLOWLIST_DUPLICATE");
  const counts = new Map(expected.map((name) => [name, 0]));
  const skipped = [];

  const registrationServer = new Proxy(server, {
    get(target, property) {
      if (property === "registerTool") {
        return (name, ...args) => {
          if (!allowed.has(name)) {
            skipped.push(String(name));
            if (strictUnknown) throw new Error(`PUBLIC_TOOL_REGISTRATION_FORBIDDEN:${String(name)}`);
            return undefined;
          }
          const nextCount = (counts.get(name) ?? 0) + 1;
          counts.set(name, nextCount);
          if (nextCount > 1) throw new Error(`PUBLIC_TOOL_REGISTRATION_DUPLICATE:${name}`);
          return Reflect.apply(target.registerTool, target, [name, ...args]);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  function assertComplete() {
    const missing = expected.filter((name) => counts.get(name) !== 1);
    if (missing.length) throw new Error(`PUBLIC_TOOL_REGISTRATION_INCOMPLETE:${missing.join(",")}`);
    return {
      expectedCount: expected.length,
      registeredCount: expected.length,
      skippedToolNames: [...skipped],
    };
  }

  return {
    server: registrationServer,
    assertComplete,
    skippedToolNames: skipped,
  };
}

export function createPublicServerFactory({
  executor,
  authorityExecutor,
  publicContext,
  browser,
  agentExecutor,
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  agentPreviewState = null,
  recentCallDiagnostics,
  maxConcurrent = 1,
}) {
  if (!executor) throw new Error("Codexless public server requires an authority executor");
  if (!authorityExecutor) throw new Error("Codexless public server requires authorityExecutor");
  if (!publicContext) throw new Error("Codexless public server requires publicContext");
  if (!browser) throw new Error("Codexless public server requires the accepted Browser executor");
  if (!agentExecutor) throw new Error("Codexless public server requires agentExecutor");
  if (!recentCallDiagnostics) throw new Error("Codexless public server requires recentCallDiagnostics");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) {
    throw new Error("maxConcurrent must be an integer between 1 and 4");
  }

  const commandSchema = z.object({
    command: z.array(z.string().max(32_768)).min(1).max(128)
      .describe("argv vector passed to official Codex command/exec under the locally resolved Codex permission profile"),
    cwd: z.string().min(1).max(32_768).optional()
      .describe("Optional local working-directory context. cwd does not let the caller select or widen a permission profile."),
    access: z.enum(["inherit", "readOnly"]).default("readOnly")
      .describe("readOnly is the safe compatibility default. inherit uses the locally authorized/resolved Codex permission profile."),
    timeoutMs: z.number().int().positive().max(30_000).default(10_000),
  }).strict();

  return function createServer() {
    let inFlight = 0;
    const server = new McpServer(
      {
        ...codexlessIdentity(),
        version: PUBLIC_SERVER_VERSION,
        description: "Local bridge that lets ChatGPT use accepted Codex-backed capabilities and explicitly escalate to Codex when needed.",
      },
      {
        instructions: PUBLIC_SERVER_INSTRUCTIONS,
      }
    );
    installRecentCallToolInstrumentation(server, recentCallDiagnostics);
    const publicRegistration = createPublicToolRegistrationGate(server);
    const publicServer = publicRegistration.server;

    publicServer.registerTool(
      "codex.command_exec",
      {
        title: "Codex Model-Free Command",
        description:
          "Run one buffered argv command through official Codex App Server command/exec without a Codex model turn. Codexless resolves the authorized Codex permission profile locally; the caller cannot select a stronger profile or permission envelope. This model-free lane must not launch Codex CLI directly or through recognized shell/interpreter wrappers; formal metered Codex work must use codex.agent_start / codex.agent_send so Task Card, quota state, and lifecycle remain visible. A bare executable name may be resolved through host PATH on Windows without changing authority.",
        inputSchema: commandSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ command, cwd, access, timeoutMs }) => {
        if (inFlight >= maxConcurrent) return toolError(`bridge concurrency limit reached (${maxConcurrent})`);
        inFlight += 1;
        try {
          const result = await executor.exec({ command, cwd, access, timeoutMs });
          const payload = {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            access,
            surfaceVersion: PUBLIC_SURFACE_VERSION,
          };
          if (typeof result.stdoutTruncated === "boolean") payload.stdoutTruncated = result.stdoutTruncated;
          if (typeof result.stderrTruncated === "boolean") payload.stderrTruncated = result.stderrTruncated;
          if (typeof result.permissionCeiling === "string") payload.permissionCeiling = result.permissionCeiling;
          if (typeof result.permissionProfile === "string") payload.permissionProfile = result.permissionProfile;
          if (typeof result.effectiveCwd === "string") payload.cwd = result.effectiveCwd;
          if (typeof result.authoritySource === "string") payload.authoritySource = result.authoritySource;
          if (typeof result.trustedAncestor === "string") payload.trustedAncestor = result.trustedAncestor;
          if (result.executableResolution && typeof result.executableResolution === "object") payload.executableResolution = result.executableResolution;
          if (typeof result.resolutionSource === "string") payload.resolutionSource = result.resolutionSource;
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: result.exitCode !== 0,
          };
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
            error && typeof error === "object" ? { errorCode: error.code, nextActions: error.nextActions } : undefined
          );
        } finally {
          inFlight -= 1;
        }
      }
    );

    registerPublicContextTools(publicServer, publicContext);
    registerConstructionTools(publicServer, { authorityExecutor });
    registerBrowserPreviewTools(publicServer, browser);
    registerAgentPreviewTools(publicServer, {
      agentExecutor,
      authorityExecutor,
      meteredConsentMode,
      meteredQuotaProvider,
      agentPreviewState,
    });
    publicRegistration.assertComplete();
    return server;
  };
}

function toolError(message, details = {}) {
  const structuredContent = { error: message };
  if (typeof details?.errorCode === "string") structuredContent.errorCode = details.errorCode;
  if (Array.isArray(details?.nextActions) && details.nextActions.every((value) => typeof value === "string")) {
    structuredContent.nextActions = details.nextActions;
  }
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
    isError: true,
  };
}
