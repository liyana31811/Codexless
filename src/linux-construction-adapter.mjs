import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { preciseEditAuthorized, registerConstructionTools } from "./construction-tools.mjs";

// Keep the canonical construction module unchanged. Only Linux writes need this
// adapter to execute through the official Codex authority sandbox.
const GUARDED_EDIT_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const data = JSON.parse(require('node:zlib').gunzipSync(Buffer.from(process.argv.slice(1).join(''), 'base64')).toString('utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const root = fs.realpathSync(data.root);
const target = fs.realpathSync(data.target);
if (root !== data.root || target !== data.target) throw new Error('precise edit refused: canonical path changed before sandboxed write');
const relative = path.relative(root, target);
if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('precise edit refused path outside trusted root');
const fd = fs.openSync(target, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
try {
  const info = fs.fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1) throw new Error('precise edit requires a regular file without additional hard links');
  const before = fs.readFileSync(fd);
  if (hash(before) !== data.beforeSha256) throw new Error('precise edit refused: file changed before sandboxed write');
  const parts = before.toString('utf8').split(data.expectedText);
  if (parts.length - 1 !== data.expectedOccurrences) throw new Error('precise edit refused: occurrence count changed');
  const after = Buffer.from(parts.join(data.replacementText), 'utf8');
  if (hash(after) !== data.afterSha256) throw new Error('precise edit refused: intended output hash mismatch');
  fs.ftruncateSync(fd, 0);
  let position = 0;
  while (position < after.length) position += fs.writeSync(fd, after, position, after.length - position, position);
  fs.fsyncSync(fd);
  process.stdout.write(JSON.stringify({afterSha256: hash(fs.readFileSync(target))}));
} finally { fs.closeSync(fd); }
`;


export function registerPlatformConstructionTools(server, { authorityExecutor, platform = process.platform }) {
  if (platform !== "linux") return registerConstructionTools(server, { authorityExecutor });
  return registerConstructionTools({
    registerTool(name, config, handler) {
      return server.registerTool(name, config, name === "codex.precise_edit"
        ? async (input) => structured(() => preciseEditLinuxAuthorized({ authorityExecutor, ...input }))
        : handler);
    },
  }, { authorityExecutor });
}

export async function preciseEditLinuxAuthorized({ authorityExecutor, previewOnly = false, ...input }) {
  // Canonical preview performs root resolution, exact-text/hash validation, and
  // constructs the same public result without ever taking its host-write path.
  const preview = await preciseEditAuthorized({ authorityExecutor, ...input, previewOnly: true });
  if (previewOnly) return preview;
  if (preview.permissionProfile === ":read-only") {
    throw new Error("precise edit refused: local Codex authority is read-only");
  }
  if (typeof authorityExecutor.exec !== "function") {
    throw new Error("precise edit requires the official Codex sandboxed command executor");
  }
  const editPayload = gzipSync(Buffer.from(JSON.stringify({
    root: preview.trustedAncestor,
    target: preview.path,
    beforeSha256: preview.beforeSha256,
    afterSha256: preview.afterSha256,
    expectedText: input.expectedText,
    replacementText: input.replacementText,
    expectedOccurrences: preview.occurrenceCount,
  }), "utf8")).toString("base64");
  // ASCII chunks avoid Linux's per-argument byte limit and UTF-16 splitting.
  const chunks = [];
  for (let index = 0; index < editPayload.length; index += 16_000) chunks.push(editPayload.slice(index, index + 16_000));
  const result = await authorityExecutor.exec({
    command: [process.execPath, "-e", GUARDED_EDIT_SCRIPT, ...chunks],
    cwd: preview.cwd,
    access: "inherit",
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`precise edit sandboxed write failed: ${String(result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 2_000)}`);
  }
  let receipt;
  try { receipt = JSON.parse(result.stdout); }
  catch { throw new Error("precise edit returned no verifiable sandboxed write receipt; do not blindly replay"); }
  if (receipt?.afterSha256 !== preview.afterSha256) {
    throw new Error("precise edit sandboxed write receipt hash mismatch; do not blindly replay");
  }
  const writtenSha256 = createHash("sha256").update(await readFile(preview.path)).digest("hex");
  if (writtenSha256 !== preview.afterSha256) {
    throw new Error("precise edit verification failed: written file hash does not match intended output");
  }
  return { ...preview, status: "applied", previewOnly: false };
}

async function structured(task) {
  try {
    const payload = await task();
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}
