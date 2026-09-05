import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const DEFAULT_PER_FILE_CHARS = 50_000;
const MAX_PER_FILE_CHARS = 200_000;
const DEFAULT_TOTAL_CHARS = 200_000;
const MAX_TOTAL_CHARS = 500_000;
const DEFAULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_PDF_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PDF_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_PDF_MAX_PAGES = 10;
const MAX_PDF_MAX_PAGES = 25;
const DEFAULT_PDF_MAX_TEXT_CHARS = 50_000;
const MAX_PDF_MAX_TEXT_CHARS = 200_000;
const DEFAULT_PDF_MAX_RENDER_PIXELS = 12_000_000;
const MAX_PDF_MAX_RENDER_PIXELS = 30_000_000;

export function registerConstructionTools(server, { authorityExecutor }) {
  if (!authorityExecutor) return;

  server.registerTool(
    "codex.read_many",
    {
      title: "Read Multiple Authorized Project Files",
      description:
        "Read several UTF-8 text files in one model-free call while preserving Codex project authority. Paths may be absolute or relative to cwd, but every resolved real path must remain inside the Codex trusted authority root for cwd. Returns bounded per-file text plus hashes and truncation metadata. It does not follow a junction/symlink outside the authorized root and does not use the broad raw host filesystem preview.",
      inputSchema: z.object({
        paths: z.array(z.string().min(1).max(32_768)).min(1).max(20),
        cwd: z.string().min(1).max(32_768).optional(),
        maxCharsPerFile: z.number().int().min(1_000).max(MAX_PER_FILE_CHARS).default(DEFAULT_PER_FILE_CHARS),
        maxTotalChars: z.number().int().min(1_000).max(MAX_TOTAL_CHARS).default(DEFAULT_TOTAL_CHARS),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => structured(() => readManyAuthorized({ authorityExecutor, ...input }))
  );

  server.registerTool(
    "codex.read_image",
    {
      title: "Read Authorized Project Image",
      description:
        "Return one authorized local PNG or JPEG directly as standard MCP image content without starting a Codex model turn. The resolved real path must remain inside the same Codex trusted authority root used by construction reads. File signature and bounded size are validated; caller-supplied Base64/raw bytes are not accepted. This household compatibility surface should retire in favor of an equivalent maintained upstream model-free image handoff when one becomes available.",
      inputSchema: z.object({
        path: z.string().min(1).max(32_768),
        cwd: z.string().min(1).max(32_768).optional(),
        maxBytes: z.number().int().min(1_024).max(MAX_IMAGE_MAX_BYTES).default(DEFAULT_IMAGE_MAX_BYTES),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => imageStructured(() => readImageAuthorized({ authorityExecutor, ...input }))
  );

  server.registerTool(
    "codex.read_pdf",
    {
      title: "Read Authorized Project PDF",
      description:
        "Read one authorized local PDF without a Codex model turn. Reuses the same Codex trusted-root/realpath authority as construction reads, validates the PDF signature and bounded byte/page/render budgets, extracts bounded text, and returns rendered pages as standard MCP PNG image content for scanned or visual PDFs. PDF scripting is not executed. This compatibility surface should retire when a maintained upstream model-free local-PDF handoff becomes available.",
      inputSchema: z.object({
        path: z.string().min(1).max(32_768),
        cwd: z.string().min(1).max(32_768).optional(),
        maxBytes: z.number().int().min(1_024).max(MAX_PDF_MAX_BYTES).default(DEFAULT_PDF_MAX_BYTES),
        maxPages: z.number().int().min(1).max(MAX_PDF_MAX_PAGES).default(DEFAULT_PDF_MAX_PAGES),
        maxTextChars: z.number().int().min(1_000).max(MAX_PDF_MAX_TEXT_CHARS).default(DEFAULT_PDF_MAX_TEXT_CHARS),
        maxRenderPixels: z.number().int().min(100_000).max(MAX_PDF_MAX_RENDER_PIXELS).default(DEFAULT_PDF_MAX_RENDER_PIXELS),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => pdfStructured(() => readPdfAuthorized({ authorityExecutor, ...input }))
  );

  server.registerTool(
    "codex.precise_edit",
    {
      title: "Guarded Precise Project Edit",
      description:
        "Apply one guarded exact-text edit to an existing UTF-8 project file without shell quoting. The service first resolves Codex authority for cwd, requires the file's real path to stay inside that trusted root, optionally checks the current SHA-256, requires expectedText to occur exactly expectedOccurrences times, rechecks the source hash immediately before writing, and then replaces only those exact occurrences. previewOnly validates and previews without writing. Any drift or mismatch fails closed.",
      inputSchema: z.object({
        path: z.string().min(1).max(32_768),
        expectedText: z.string().min(1).max(200_000),
        replacementText: z.string().max(200_000),
        expectedOccurrences: z.number().int().min(1).max(100).default(1),
        expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
        cwd: z.string().min(1).max(32_768).optional(),
        previewOnly: z.boolean().default(false),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => preciseEditAuthorized({ authorityExecutor, ...input }))
  );
}

export async function readManyAuthorized({ authorityExecutor, paths, cwd, maxCharsPerFile = DEFAULT_PER_FILE_CHARS, maxTotalChars = DEFAULT_TOTAL_CHARS }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "readOnly" });
  const root = await canonicalRoot(authority);
  let remaining = maxTotalChars;
  const files = [];

  for (const requestedPath of paths) {
    const target = await canonicalExistingFile({ requestedPath, cwd: authority.effectiveCwd, root });
    const buffer = await readFile(target);
    const text = buffer.toString("utf8");
    const allowed = Math.max(0, Math.min(maxCharsPerFile, remaining));
    const returnedText = text.slice(0, allowed);
    files.push({
      requestedPath,
      path: target,
      text: returnedText,
      chars: text.length,
      returnedChars: returnedText.length,
      truncated: returnedText.length < text.length,
      byteLength: buffer.length,
      sha256: sha256(buffer),
    });
    remaining -= returnedText.length;
  }

  return {
    status: "ok",
    cwd: authority.effectiveCwd,
    trustedAncestor: root,
    permissionProfile: authority.permissionProfile,
    count: files.length,
    returnedChars: maxTotalChars - remaining,
    totalCharsLimit: maxTotalChars,
    files,
  };
}

export async function resolveAuthorizedExistingFile({
  authorityExecutor,
  path: requestedPath,
  cwd,
  includeSha256 = false,
  maxBytes = null,
}) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "readOnly" });
  const root = await canonicalRoot(authority);
  const target = await canonicalExistingFile({ requestedPath, cwd: authority.effectiveCwd, root });
  const info = await stat(target);
  if (Number.isFinite(maxBytes) && maxBytes >= 0 && info.size > maxBytes) {
    throw new Error(`authorized construction tool refused file above ${maxBytes} bytes: ${target} (${info.size} bytes)`);
  }
  return {
    path: target,
    cwd: authority.effectiveCwd,
    trustedAncestor: root,
    permissionProfile: authority.permissionProfile,
    byteLength: info.size,
    sha256: includeSha256 ? await sha256File(target) : null,
  };
}

export async function readImageAuthorized({ authorityExecutor, path: requestedPath, cwd, maxBytes = DEFAULT_IMAGE_MAX_BYTES }) {
  const resolved = await resolveAuthorizedExistingFile({ authorityExecutor, path: requestedPath, cwd, maxBytes });
  const buffer = await readFile(resolved.path);
  const mimeType = detectImageMime(buffer);
  if (!mimeType) {
    throw new Error(`authorized image read supports only signature-valid PNG or JPEG files: ${resolved.path}`);
  }
  return {
    metadata: {
      status: "ok",
      path: resolved.path,
      cwd: resolved.cwd,
      trustedAncestor: resolved.trustedAncestor,
      permissionProfile: resolved.permissionProfile,
      byteLength: buffer.length,
      mimeType,
    },
    image: { type: "image", data: buffer.toString("base64"), mimeType },
  };
}

export async function readPdfAuthorized({
  authorityExecutor,
  path: requestedPath,
  cwd,
  maxBytes = DEFAULT_PDF_MAX_BYTES,
  maxPages = DEFAULT_PDF_MAX_PAGES,
  maxTextChars = DEFAULT_PDF_MAX_TEXT_CHARS,
  maxRenderPixels = DEFAULT_PDF_MAX_RENDER_PIXELS,
}) {
  const resolved = await resolveAuthorizedExistingFile({ authorityExecutor, path: requestedPath, cwd, maxBytes });
  const buffer = await readFile(resolved.path);
  if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`authorized PDF read requires a signature-valid PDF file: ${resolved.path}`);
  }

  const [{ getDocument }, { createCanvas }] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("@napi-rs/canvas")]);
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    if (document.numPages > maxPages) {
      throw new Error(`authorized PDF read refused ${document.numPages} pages above maxPages=${maxPages}: ${resolved.path}`);
    }

    let remainingText = maxTextChars;
    let remainingPixels = maxRenderPixels;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent({ disableNormalization: false });
      const fullText = textContent.items.map((item) => typeof item?.str === "string" ? item.str : "").filter(Boolean).join(" ");
      const text = fullText.slice(0, remainingText);
      remainingText -= text.length;

      const baseViewport = page.getViewport({ scale: 1 });
      const basePixels = Math.max(1, Math.ceil(baseViewport.width) * Math.ceil(baseViewport.height));
      const scale = Math.min(1.5, Math.sqrt(remainingPixels / basePixels));
      if (!Number.isFinite(scale) || scale <= 0 || remainingPixels < basePixels) {
        throw new Error(`authorized PDF read exceeded aggregate render budget maxRenderPixels=${maxRenderPixels} at page ${pageNumber}`);
      }
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const pixels = width * height;
      if (pixels > remainingPixels) {
        throw new Error(`authorized PDF read exceeded aggregate render budget maxRenderPixels=${maxRenderPixels} at page ${pageNumber}`);
      }
      remainingPixels -= pixels;
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      const png = await canvas.encode("png");
      pages.push({ pageNumber, text, textTruncated: text.length < fullText.length, width, height, pixels, image: { type: "image", data: png.toString("base64"), mimeType: "image/png" } });
      page.cleanup();
    }

    return {
      metadata: {
        status: "ok",
        path: resolved.path,
        cwd: resolved.cwd,
        trustedAncestor: resolved.trustedAncestor,
        permissionProfile: resolved.permissionProfile,
        byteLength: buffer.length,
        pageCount: document.numPages,
        returnedTextChars: maxTextChars - remainingText,
        textTruncated: remainingText === 0,
        renderedPixels: maxRenderPixels - remainingPixels,
        scriptingExecuted: false,
      },
      pages,
    };
  } finally {
    await loadingTask.destroy();
  }
}

export async function preciseEditAuthorized({ authorityExecutor, path: requestedPath, expectedText, replacementText, expectedOccurrences = 1, expectedSha256, cwd, previewOnly = false }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
  const root = await canonicalRoot(authority);
  const target = await canonicalExistingFile({ requestedPath, cwd: authority.effectiveCwd, root });
  const initialBuffer = await readFile(target);
  const initialText = initialBuffer.toString("utf8");
  const beforeSha256 = sha256(initialBuffer);

  if (expectedSha256 && beforeSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`precise edit refused: expectedSha256 does not match current file ${target}`);
  }

  const occurrenceCount = countOccurrences(initialText, expectedText);
  if (occurrenceCount !== expectedOccurrences) {
    throw new Error(`precise edit refused: expectedText occurs ${occurrenceCount} times, expected exactly ${expectedOccurrences}`);
  }

  const nextText = replaceExactOccurrences(initialText, expectedText, replacementText, expectedOccurrences);
  const afterBuffer = Buffer.from(nextText, "utf8");
  const afterSha256 = sha256(afterBuffer);
  const preview = buildPreview(initialText, nextText, expectedText);

  if (!previewOnly) {
    const currentBuffer = await readFile(target);
    const currentSha256 = sha256(currentBuffer);
    if (currentSha256 !== beforeSha256) {
      throw new Error("precise edit refused: file changed after validation and before write; re-read and retry with current content");
    }
    await writeFile(target, afterBuffer);
    const writtenBuffer = await readFile(target);
    const writtenSha256 = sha256(writtenBuffer);
    if (writtenSha256 !== afterSha256) {
      throw new Error("precise edit verification failed: written file hash does not match intended output");
    }
  }

  return {
    status: previewOnly ? "preview" : "applied",
    path: target,
    cwd: authority.effectiveCwd,
    trustedAncestor: root,
    permissionProfile: authority.permissionProfile,
    occurrenceCount,
    beforeSha256,
    afterSha256,
    beforeBytes: initialBuffer.length,
    afterBytes: afterBuffer.length,
    changed: beforeSha256 !== afterSha256,
    previewOnly,
    preview,
  };
}

async function canonicalRoot(authority) {
  const candidate = authority?.trustedAncestor ?? authority?.effectiveCwd;
  if (!candidate) throw new Error("authorized construction tool requires a trusted Codex root");
  return realpath(candidate);
}

async function canonicalExistingFile({ requestedPath, cwd, root }) {
  const resolved = path.resolve(cwd, requestedPath);
  const target = await realpath(resolved);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`authorized construction tool refused path outside trusted root: ${target}`);
  }
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`target is not a regular file: ${target}`);
  return target;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(target) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function replaceExactOccurrences(text, needle, replacement, count) {
  let output = "";
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    const index = text.indexOf(needle, offset);
    output += text.slice(offset, index) + replacement;
    offset = index + needle.length;
  }
  return output + text.slice(offset);
}

function buildPreview(before, after, needle) {
  const index = before.indexOf(needle);
  const radius = 240;
  const beforeStart = Math.max(0, index - radius);
  const beforeEnd = Math.min(before.length, index + needle.length + radius);
  const afterIndex = Math.max(0, Math.min(after.length, index));
  const afterEnd = Math.min(after.length, afterIndex + Math.max(needle.length, 1) + radius * 2);
  return {
    beforeExcerpt: before.slice(beforeStart, beforeEnd),
    afterExcerpt: after.slice(Math.max(0, afterIndex - radius), afterEnd),
  };
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  return null;
}

async function pdfStructured(task) {
  try {
    const { metadata, pages } = await task();
    const pageMetadata = pages.map(({ image, ...page }) => page);
    const payload = { ...metadata, pages: pageMetadata };
    const content = [{ type: "text", text: JSON.stringify(payload) }];
    for (const page of pages) content.push(page.image);
    return { content, structuredContent: payload, isError: false };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}

async function imageStructured(task) {
  try {
    const { metadata, image } = await task();
    return {
      content: [{ type: "text", text: JSON.stringify(metadata) }, image],
      structuredContent: metadata,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
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
