import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrowserRuntimeCompatibility } from "../src/browser-runtime-compat.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "codexless-browser-runtime-compat-"));
try {
  const codexHome = path.join(root, ".codex");
  const bundleRoot = path.join(codexHome, "plugins", "cache", "openai-bundled");
  const build = "26.999.12345";
  const chromeVersionRoot = path.join(bundleRoot, "chrome", build);
  const browserVersionRoot = path.join(bundleRoot, "browser", build);
  const skillPath = path.join(chromeVersionRoot, "skills", "control-chrome", "SKILL.md");
  const clientPath = path.join(chromeVersionRoot, "scripts", "browser-client.mjs");
  const servicePath = path.join(browserVersionRoot, "scripts", "browser-service.mjs");
  const chromeManifestPath = path.join(chromeVersionRoot, ".codex-plugin", "plugin.json");
  const browserManifestPath = path.join(browserVersionRoot, ".codex-plugin", "plugin.json");
  for (const filePath of [skillPath, clientPath, servicePath, chromeManifestPath, browserManifestPath]) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  writeFileSync(skillPath, "# fake current Chrome skill\n");
  writeFileSync(clientPath, "export const browserClient = true;\n");
  writeFileSync(servicePath, "export const browserService = true;\n");
  writeFileSync(chromeManifestPath, JSON.stringify({ name: "chrome", version: build }));
  writeFileSync(browserManifestPath, JSON.stringify({ name: "browser", version: build }));

  const env = {
    CODEX_HOME: codexHome,
    CODEXLESS_BROWSER_RUNTIME_CWD: path.join(root, "neutral"),
  };
  const resolved = await resolveBrowserRuntimeCompatibility({
    codexBin: path.join(root, "codex.exe"),
    chromeSkillPath: skillPath,
    env,
  });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.source, "codex-skills-list");
  assert.equal(resolved.build, build);
  // `realpath` canonicalizes macOS's `/var` symlink to `/private/var`; compare
  // against the same host-canonical form rather than a lexical path spelling.
  assert.equal(resolved.chromeSkillPath, realpathSync(skillPath));
  assert.equal(resolved.browserClientPath, realpathSync(clientPath));
  assert.equal(resolved.browserServicePath, realpathSync(servicePath));
  assert.equal(resolved.chromeManifestPath, realpathSync(chromeManifestPath));
  assert.equal(resolved.browserManifestPath, realpathSync(browserManifestPath));
  assert.match(resolved.browserClientSha256, /^[a-f0-9]{64}$/);
  assert.equal(resolved.overrides.length, 4);
  assert.match(resolved.overrides.join("\n"), new RegExp(build.replaceAll(".", "\\.")));
  assert.match(resolved.overrides.join("\n"), /NODE_REPL_TRUSTED_SERVICES/);
  assert.match(resolved.overrides.join("\n"), /CODEX_CLI_PATH/);
  assert.match(resolved.overrides.join("\n"), /NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S/);

  rmSync(servicePath);
  const macStockService = await resolveBrowserRuntimeCompatibility({
    codexBin: path.join(root, "codex"),
    chromeSkillPath: skillPath,
    env,
    platform: "darwin",
  });
  assert.equal(macStockService.status, "ok");
  assert.equal(macStockService.browserServicePath, null);
  assert.equal(macStockService.serviceSource, "stock-node-repl");
  assert.equal(macStockService.overrides.length, 3);
  assert.doesNotMatch(macStockService.overrides.join("\n"), /NODE_REPL_TRUSTED_SERVICES/);

  const windowsMissingService = await resolveBrowserRuntimeCompatibility({
    codexBin: path.join(root, "codex.exe"),
    chromeSkillPath: skillPath,
    env,
    platform: "win32",
  });
  assert.equal(windowsMissingService.status, "unavailable");
  assert.equal(windowsMissingService.reason, "current_browser_plugin_pair_not_found");
  writeFileSync(servicePath, "export const browserService = true;\n");

  writeFileSync(browserManifestPath, JSON.stringify({ name: "browser", version: `${build}-drift` }));
  const manifestMismatch = await resolveBrowserRuntimeCompatibility({
    codexBin: path.join(root, "codex.exe"),
    chromeSkillPath: skillPath,
    env,
  });
  assert.equal(manifestMismatch.status, "unavailable");
  assert.equal(manifestMismatch.reason, "current_browser_plugin_manifest_mismatch");
  writeFileSync(browserManifestPath, JSON.stringify({ name: "browser", version: build }));

  const missing = await resolveBrowserRuntimeCompatibility({
    codexBin: path.join(root, "codex.exe"),
    chromeSkillPath: null,
    env,
  });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.reason, "current_chrome_skill_unavailable");
  assert.deepEqual(missing.overrides, []);

  const outsideSkill = path.join(root, "elsewhere", "SKILL.md");
  mkdirSync(path.dirname(outsideSkill), { recursive: true });
  writeFileSync(outsideSkill, "# outside\n");
  const untrusted = await resolveBrowserRuntimeCompatibility({
    codexBin: path.join(root, "codex.exe"),
    chromeSkillPath: outsideSkill,
    env,
  });
  assert.equal(untrusted.status, "unavailable");
  assert.equal(untrusted.reason, "current_chrome_skill_path_untrusted");

  console.log("Browser runtime compatibility metadata resolver PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
