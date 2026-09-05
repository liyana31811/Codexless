import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrowserRuntimeCompatibility } from "../src/browser-runtime-compat.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "toolwire-browser-runtime-compat-"));
try {
  const codexHome = path.join(root, "ユーザー Space", "custom codex home");
  const bundleRoot = path.join(codexHome, "plugins", "cache", "openai-bundled");
  const build = "26.999.12345";
  const chromeVersionRoot = path.join(bundleRoot, "chrome", build);
  const browserVersionRoot = path.join(bundleRoot, "browser", build);
  const skillPath = path.join(chromeVersionRoot, "skills", "control-chrome", "nested-layout", "SKILL.md");
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
    CODEX_TOOLBOX_BROWSER_RUNTIME_CWD: path.join(root, "neutral"),
  };
  const codexBin = path.join(root, "Program Files", "Codex 日本語", "codex.exe");
  const resolved = await resolveBrowserRuntimeCompatibility({
    codexBin,
    chromeSkillPath: skillPath,
    env,
  });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.source, "codex-skills-list");
  assert.equal(resolved.build, build);
  assert.equal(path.resolve(resolved.chromeSkillPath), path.resolve(skillPath));
  assert.equal(path.resolve(resolved.browserClientPath), path.resolve(clientPath));
  assert.equal(path.resolve(resolved.browserServicePath), path.resolve(servicePath));
  assert.equal(path.resolve(resolved.browserRuntimeCwd), path.resolve(env.CODEX_TOOLBOX_BROWSER_RUNTIME_CWD));
  assert.match(resolved.browserClientSha256, /^[a-f0-9]{64}$/);
  assert.equal(resolved.overrides.length, 4);
  assert.match(resolved.overrides.join("\n"), new RegExp(build.replaceAll(".", "\\.")));
  assert.match(resolved.overrides.join("\n"), /NODE_REPL_TRUSTED_SERVICES/);
  assert.match(resolved.overrides.join("\n"), /CODEX_CLI_PATH/);
  assert.match(resolved.overrides.join("\n"), /NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S/);
  assert.ok(resolved.overrides.some((value) => value.includes(path.resolve(codexBin).replaceAll("\\", "\\\\"))), "Codex paths with spaces/non-ASCII must stay quoted in the generated TOML override");

  const skilllessPlugin = await resolveBrowserRuntimeCompatibility({
    codexBin,
    chromeSkillPath: null,
    chromePluginBuild: build,
    env,
  });
  assert.equal(skilllessPlugin.status, "ok");
  assert.equal(skilllessPlugin.source, "codex-plugin-list");
  assert.equal(skilllessPlugin.chromeSkillPath, null);
  assert.equal(path.resolve(skilllessPlugin.chromePluginRoot), path.resolve(chromeVersionRoot));
  assert.equal(path.resolve(skilllessPlugin.browserClientPath), path.resolve(clientPath));
  assert.equal(path.resolve(skilllessPlugin.browserServicePath), path.resolve(servicePath));

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

  console.log("Household Browser runtime compatibility resolver PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
