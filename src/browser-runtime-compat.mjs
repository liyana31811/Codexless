import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function pathForService(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function isRegularFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readPluginManifest(versionRoot) {
  const manifestPath = path.join(versionRoot, ".codex-plugin", "plugin.json");
  try {
    const text = await readFile(manifestPath, "utf8");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { path: manifestPath, value };
  } catch {
    return null;
  }
}

function unavailable(reason, details = {}) {
  return {
    status: "unavailable",
    reason,
    source: "codex-skills-list",
    ...details,
    overrides: [],
  };
}

export function defaultBrowserRuntimeCwd({ env = process.env } = {}) {
  const override = typeof env?.CODEX_TOOLBOX_BROWSER_RUNTIME_CWD === "string" && env.CODEX_TOOLBOX_BROWSER_RUNTIME_CWD.trim()
    ? env.CODEX_TOOLBOX_BROWSER_RUNTIME_CWD.trim()
    : typeof env?.CODEXLESS_BROWSER_RUNTIME_CWD === "string"
      ? env.CODEXLESS_BROWSER_RUNTIME_CWD.trim()
      : "";
  return path.resolve(override || os.homedir());
}

export async function resolveBrowserRuntimeCompatibility({ codexBin, chromeSkillPath, chromePluginBuild, env = process.env } = {}) {
  if (typeof codexBin !== "string" || !codexBin.trim()) {
    throw new Error("resolveBrowserRuntimeCompatibility requires codexBin");
  }

  const browserRuntimeCwd = defaultBrowserRuntimeCwd({ env });
  const hasSkillPath = typeof chromeSkillPath === "string" && Boolean(chromeSkillPath.trim());
  const normalizedPluginBuild = typeof chromePluginBuild === "string" ? chromePluginBuild.trim() : "";
  if (!hasSkillPath && !normalizedPluginBuild) {
    return unavailable("current_chrome_skill_unavailable", { browserRuntimeCwd });
  }
  if (normalizedPluginBuild && (!/^[0-9A-Za-z._-]+$/.test(normalizedPluginBuild) || normalizedPluginBuild === "." || normalizedPluginBuild === "..")) {
    return unavailable("current_chrome_plugin_build_untrusted", { build: normalizedPluginBuild, browserRuntimeCwd });
  }

  const codexHome = path.resolve(
    typeof env?.CODEX_HOME === "string" && env.CODEX_HOME.trim()
      ? env.CODEX_HOME
      : path.join(os.homedir(), ".codex")
  );
  const expectedBundleRoot = path.join(codexHome, "plugins", "cache", "openai-bundled");

  let bundleRoot;
  try {
    bundleRoot = await realpath(expectedBundleRoot);
  } catch {
    return unavailable("current_browser_plugin_path_escape", { browserRuntimeCwd });
  }

  let skillPath = null;
  let build = normalizedPluginBuild || null;
  if (hasSkillPath) {
    try {
      skillPath = await realpath(path.resolve(chromeSkillPath));
    } catch {
      return unavailable("current_chrome_skill_path_untrusted", {
        chromeSkillPath: path.resolve(chromeSkillPath),
        browserRuntimeCwd,
      });
    }
    if (!isPathWithin(bundleRoot, skillPath)) {
      return unavailable("current_chrome_skill_path_untrusted", { chromeSkillPath: skillPath, browserRuntimeCwd });
    }
    const relativeSkillPath = path.relative(bundleRoot, skillPath);
    const segments = relativeSkillPath.split(path.sep).filter(Boolean);
    const [pluginName, skillBuild] = segments;
    if (pluginName?.toLowerCase() !== "chrome" || !skillBuild || segments.length < 3) {
      return unavailable("current_chrome_skill_path_untrusted", { chromeSkillPath: skillPath, browserRuntimeCwd });
    }
    if (build && build !== skillBuild) {
      return unavailable("current_chrome_plugin_manifest_mismatch", { build, chromeSkillPath: skillPath, browserRuntimeCwd });
    }
    build = skillBuild;
  }

  const expectedChromeVersionRoot = path.join(bundleRoot, "chrome", build);
  const expectedBrowserVersionRoot = path.join(bundleRoot, "browser", build);
  let chromeVersionRoot;
  let browserVersionRoot;
  try {
    [chromeVersionRoot, browserVersionRoot] = await Promise.all([
      realpath(expectedChromeVersionRoot),
      realpath(expectedBrowserVersionRoot),
    ]);
  } catch {
    return unavailable("current_browser_plugin_pair_not_found", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  if (skillPath && !isPathWithin(chromeVersionRoot, skillPath)) {
    return unavailable("current_chrome_skill_path_untrusted", { build, chromeSkillPath: skillPath, browserRuntimeCwd });
  }

  const [chromeManifest, browserManifest] = await Promise.all([
    readPluginManifest(chromeVersionRoot),
    readPluginManifest(browserVersionRoot),
  ]);
  if (
    !chromeManifest ||
    !browserManifest ||
    chromeManifest.value?.name !== "chrome" ||
    browserManifest.value?.name !== "browser" ||
    chromeManifest.value?.version !== build ||
    browserManifest.value?.version !== build
  ) {
    return unavailable("current_browser_plugin_manifest_mismatch", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  const expectedBrowserClientPath = path.join(chromeVersionRoot, "scripts", "browser-client.mjs");
  const expectedBrowserServicePath = path.join(browserVersionRoot, "scripts", "browser-service.mjs");
  if (!await isRegularFile(expectedBrowserClientPath) || !await isRegularFile(expectedBrowserServicePath)) {
    return unavailable("current_browser_plugin_pair_not_found", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  let browserClientPath;
  let browserServicePath;
  try {
    [browserClientPath, browserServicePath] = await Promise.all([
      realpath(expectedBrowserClientPath),
      realpath(expectedBrowserServicePath),
    ]);
  } catch {
    return unavailable("current_browser_plugin_pair_not_found", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  if (!isPathWithin(chromeVersionRoot, browserClientPath) || !isPathWithin(browserVersionRoot, browserServicePath)) {
    return unavailable("current_browser_plugin_path_escape", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  const browserClientSha256 = createHash("sha256")
    .update(await readFile(browserClientPath))
    .digest("hex");
  const trustedServices = JSON.stringify({
    browser: pathForService(browserServicePath),
    sky: "@oai/sky/service",
  });
  const resolvedCodexBin = path.resolve(codexBin);

  return {
    status: "ok",
    source: skillPath ? "codex-skills-list" : "codex-plugin-list",
    build,
    chromeSkillPath: skillPath,
    chromePluginRoot: chromeVersionRoot,
    browserRuntimeCwd,
    browserServicePath,
    browserClientPath,
    browserClientSha256,
    chromeManifestPath: chromeManifest.path,
    browserManifestPath: browserManifest.path,
    overrides: [
      `mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION=${tomlString(build)}`,
      `mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES=${tomlString(trustedServices)}`,
      `mcp_servers.node_repl.env.CODEX_CLI_PATH=${tomlString(resolvedCodexBin)}`,
      `shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S=${tomlString(browserClientSha256)}`,
    ],
  };
}
