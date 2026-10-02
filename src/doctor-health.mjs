export function normalizeBrowserReaderHealth(raw = {}) {
  const chromeSkill = normalizePrerequisite(raw.chromeSkill);
  const nodeRepl = normalizePrerequisite(raw.nodeRepl);
  const chromeBackends = (Array.isArray(raw.connectedBrowsers) ? raw.connectedBrowsers : [])
    .filter((backend) => backend.family === "chrome" && backend.supported === true && backend.capabilities?.listTabs === true);
  const connectedChrome = raw.status === "ok" && (raw.chrome?.family === "chrome" || chromeBackends.length > 0);
  const connectionStatus = connectedChrome
    ? "connected"
    : raw.reason === "chrome_not_connected"
      ? "disconnected"
      : raw.status === "unavailable"
        ? "unavailable"
        : "unknown";
  const status = connectedChrome ? "available" : "unavailable";
  return {
    status,
    reason: connectedChrome ? null : raw.reason ?? "browser_connection_unverified",
    prerequisites: {
      chromeSkill,
      nodeRepl,
    },
    backend: {
      status: connectionStatus,
      family: connectedChrome ? "chrome" : null,
      type: connectedChrome && typeof raw.chrome?.type === "string" ? raw.chrome.type : null,
      selectionRequired: raw.selectionRequired === true,
      name: connectedChrome && typeof raw.chrome?.name === "string" ? raw.chrome.name : null,
    },
    connection: {
      status: connectionStatus,
      verified: connectedChrome,
    },
    connectedBrowsers: Array.isArray(raw.connectedBrowsers) ? structuredClone(raw.connectedBrowsers) : [],
    nextActions: Array.isArray(raw.nextActions) ? [...raw.nextActions] : [],
  };
}

export function buildDoctorHealth({ checks = [], browserReader, projectRequested = false, project = null, optionalWarnings = [] } = {}) {
  const failedCoreChecks = checks.filter((check) => check?.required && !check?.ok);
  const capabilityIssues = [];
  if (browserReader?.status !== "available") capabilityIssues.push("browser-reader");
  if (projectRequested && !project?.ok) capabilityIssues.push("project-authority");
  return {
    core: {
      status: failedCoreChecks.length ? "error" : "ok",
      failedChecks: failedCoreChecks.map((check) => check.name),
    },
    capabilities: {
      status: capabilityIssues.length ? "degraded" : "ok",
      issues: capabilityIssues,
    },
    optionalDependencies: {
      status: optionalWarnings.length ? "warning" : "ok",
      warningCount: optionalWarnings.length,
    },
  };
}

export function legacyNodeReplView(browserReader) {
  const state = browserReader?.prerequisites?.nodeRepl ?? "unknown";
  if (state === "ok") return { status: "available" };
  if (state === "missing" || state === "unavailable") return { status: "unavailable" };
  return { status: "unknown" };
}

function normalizePrerequisite(value) {
  if (value === "ok") return "ok";
  if (value === "missing") return "missing";
  if (value === "unavailable") return "unavailable";
  return "unknown";
}
