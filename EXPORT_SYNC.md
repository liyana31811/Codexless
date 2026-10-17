# Public export / sync contract

Codexless is the **narrow public release tree**. The wider Toolwire development tree may contain private, experimental, or not-yet-accepted capabilities.

Synchronization is intentionally **one way**:

> wider upstream implementation → explicit public allowlist → Codexless → public acceptance

Do not make the public tree mirror the whole upstream tree. Do not copy a directory recursively and then try to delete private files afterward.

## Source-of-truth rule

The wider upstream implementation can continue evolving independently. A change reaches Codexless only after the relevant public capability has been accepted for compatibility, product behavior, and security.

The public contract is defined by:

- `src/surface-contracts.mjs` for the exact public tool surface;
- the household-to-public Browser parity gate for canonical Browser implementation semantics;
- `test/public-contract.mjs` for the public runtime contract;
- the packed-artifact and privacy scans in this document.

The public tree must never become a second hand-maintained implementation with unrelated behavior. For the accepted Browser slice specifically, Codexless mirrors the household canonical `codex-browser-executor.mjs`, `browser-tools.mjs`, and `construction-tools.mjs` byte-for-byte and adds only the narrow `public-browser-workbench-adapter.mjs` needed to connect that implementation to the public runtime. `test/public-browser-export-parity.mjs` in the household tree hash-checks those canonical files, checks the exact 21 public Browser tools, rejects private/CUA leakage, and runs the copied Browser regression suite against the candidate. A hand-maintained Browser action hold-back table is not a release authority.

## Current public source allowlist

The first Technical Preview contains only these runtime source files:

- `src/agent-card-ui.mjs`
- `src/agent-resource.mjs`
- `src/agent-tools.mjs`
- `src/browser-tools.mjs` — byte-for-byte household canonical Browser registration
- `src/codex-browser-executor.mjs` — byte-for-byte household canonical Browser implementation
- `src/public-browser-workbench-adapter.mjs` — public-context adapter only; it does not reimplement Browser behavior
- `src/codex-agent-executor.mjs`
- `src/codex-app-server-client.mjs`
- `src/codex-authority-executor.mjs`
- `src/codex-bin.mjs`
- `src/codex-permission-executor.mjs`
- `src/codex-preview-account-preflight.mjs`
- `src/codex-quota-snapshot.mjs`
- `src/construction-tools.mjs` — byte-for-byte household canonical construction/authority helper used by Browser upload and project tools
- `src/json-file.mjs`
- `src/mcp-http.mjs`
- `src/mcp-stdio.mjs`
- `src/metered-consent.mjs`
- `src/public-context-executor.mjs`
- `src/public-context-tools.mjs`
- `src/public-runtime.mjs`
- `src/public-server-factory.mjs`
- `src/surface-contracts.mjs`
- `src/toolbox-method-registry.mjs`

Adding another runtime source file is a public-surface decision, not a routine copy operation.

Release engineering files are also intentionally bounded: `scripts/doctor.mjs`, `scripts/resolve-codex.mjs`, `scripts/launch.mjs`, `scripts/install.ps1`, `scripts/uninstall.ps1`, `scripts/install.sh`, `scripts/uninstall.sh`, and the accepted `bin/codexless-*.cmd` / `bin/codexless-*.sh` launchers. The platform installers copy an explicit release-entry list instead of recursively mirroring the upstream development tree.

## Linux Preview contribution

The Linux contribution reuses the public runtime and unchanged tool schemas, adding `src/linux-identity.mjs`, the `scripts/linux*.mjs` / `scripts/linux*.py` lifecycle helpers, `bin/codexless-linux*`, a non-secret example configuration, and Linux tests/documentation. The npm/release product remains `codexless`; `codexless-linux` is the independent Linux service and connection identity. This list is a proposed extension of the accepted release boundary for maintainer review, not permission to export a developer's installed configuration, runtime, credentials, or account resources.

The contribution changes the shared `src/construction-tools.mjs` authority helper. That file is normally a byte-for-byte canonical mirror, so local public-contract and Browser regressions alone cannot certify its export lineage. Before release, the maintainer must reconcile the helper with the canonical source and run the household `test:public-browser-export-parity` gate, including the atomic mirror and copied regressions required above. That household source/gate is unavailable in the standalone public checkout; do not report it as passed or replace it with a locally invented hash baseline.

Review the Linux packaging roots together with all platform staging lists and the generated release manifest. Linux-specific docs and launchers belong in the artifact identity. Keep local acceptance probes, deployment receipts, installed XDG directories, Tunnel profiles, keys, and downloaded binary/runtime archives out of the contribution. Linux tests use isolated synthetic fixtures rather than user projects.

## Explicit exclusions

The export must not bring in implementation or registration for:

- raw host filesystem Workbench tools;
- generic host process / PTY controls or process receipts;
- Computer Use;
- generic MCP catalog or generic MCP call tools;
- Browser internals outside the accepted 21-tool public slice: raw selectors/JavaScript/coordinates/provider IDs, arbitrary keys/modifiers, generic CDP, unprepared generic tab management, or Browser→Computer Use auto-fallback. The accepted prepared exact single-tab close pair is part of the public slice and must not be manually held back;
- private household integrations;
- local tunnel identities, tokens, endpoints, or machine-specific service configuration;
- local test fixtures that contain user/project data.

Known forbidden public tool names are also asserted in `test/public-contract.mjs`. Runtime registration enforces the same boundary before exposure: tools outside `PUBLIC_TOOL_NAMES` are skipped, the server refuses to start if any required public tool is missing or duplicated, and `test/public-registration-allowlist.mjs` exercises a strict unknown-tool mode for engineering drift.

## Repeatable export checklist

For each upstream-to-public sync:

1. Identify the upstream commit/version being considered.
2. Identify the exact accepted public capability/change. Do not export unrelated upstream churn.
3. For Browser, copy the canonical household executor/registrar/construction helper and the copied household Browser regression as an atomic mirror; do not hand-port individual Browser methods or maintain a held-back action list. Copy other public files only through their accepted release path.
4. Run the household `npm run test:public-browser-export-parity -- <candidate-root>` gate. It must prove canonical hashes, exact 21 Browser tools, no private/CUA leakage, no retired duplicate Browser implementation, correct public adapter wiring, and 60/60 copied Browser regressions before the candidate can advance.
5. Review imports from every changed public file. Any new dependency or new internal module is a separate review item.
6. Confirm `src/surface-contracts.mjs` still contains the intended exact public tool list, then run `npm run test:public-registration`; runtime must expose exactly that list while strict mode rejects an unknown tool.
7. Install/freeze dependencies in the public tree itself and keep the release lockfile. Do not rely on a parent/global `NODE_PATH`; verify required packages resolve from this repository's own `node_modules`.
8. Run syntax checks on all public `.mjs` files.
9. Run `test/public-contract.mjs` through the public tree itself with `NODE_PATH` cleared. The contract intentionally poisons legacy `CODEX_TOOLBOX_*` variables so a regression cannot silently borrow household Toolwire configuration.
10. Start and probe both stdio and HTTP entry points from the public tree.
11. Verify HTTP binds only to loopback and health metadata does not expose the configured project path.
12. Run `npm pack --dry-run` and inspect the exact packed file list. Compare the measured compressed/unpacked size with the README's current package-size statement; if either published bound is exceeded, update the README in the same release rather than leaving a stale size claim. Package growth is a review signal, not permission to silently weaken the export boundary.
13. Scan the public tree and packed file list for secrets, user-specific absolute paths, tunnel IDs/URLs, account identifiers, and private project names.
14. Review `package.json`, lockfile, dependency versions, third-party notices, README, and SECURITY documentation for drift.
15. Run the release Golden path before declaring the exported version releasable.

If any step fails, the public export remains blocked even when the wider upstream implementation is healthy.

## Useful local verification commands

These commands are examples for the repository root. They do not replace review.

```powershell
Get-ChildItem src -Filter *.mjs -Recurse | ForEach-Object { node --check $_.FullName }
npm test
npm pack --dry-run
```

For machine-specific path/privacy scanning, inspect the actual release tree and packed list for strings such as the local user profile, mapped drives, tunnel IDs, bearer/token patterns, and internal-only project names. Do not commit the user's real paths as scan patterns into the public repository.

## Version mapping

Every published Codexless version should be traceable to the wider upstream revision(s) from which its accepted public slice was exported. The mapping can live in release notes or a release manifest; it does not require internal directory names to become public API.

The goal is simple: **one implementation lineage, two different exposure boundaries.**
