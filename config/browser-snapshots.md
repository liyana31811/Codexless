# Browser dependency snapshots

The public Browser household binds a verified local copy of the official dependency set. Codex Desktop may replace its source package while this copy remains active. New source candidates are selected only at the next household binding; they never replace a running Browser child.

## Layout and lifecycle

The default store is `<Codexless state root>/browser-snapshots/v1/` (normally `~/.config/codexless/browser-snapshots/v1`). A host can set `CODEXLESS_BROWSER_SNAPSHOT_STORE` to a private local directory. This is an installation setting, not a public tool argument.

Each SHA-256-named generation contains `chrome/`, `browser/`, `node/`, `codex/`, and `manifest.json`. The closure includes the complete selected Chrome and Browser plugin trees, the configured node_repl executable and sibling Node/module/native dependency tree, and the selected Codex CLI directory with its matching sandbox helpers. No user profiles, authentication files, or browser session credentials are copied. Package notices and licenses remain with the unchanged copied files; copies are local runtime state, never part of a release or Git checkout.

Binding validates matching plugin generations, entrypoints, configured node_repl paths, trusted-service identity, required resources, and the Windows sandbox helpers. A canonical identity includes platform/architecture, source build, entrypoint/module/trusted-code mappings, and every file's relative path, byte count, and SHA-256. Source paths, timestamps, discovery ordering, process IDs, ports, and connected browser ordering are not generation identity. The immutable manifest also records source roots, final snapshot root, and creation time for diagnostics.

Materialization runs under an exclusive process-owned transaction lock. It inventories the source, copies to an owned staging directory, verifies the copy and rechecks the source, then atomically renames the stage to its content-addressed name. An identical complete snapshot is verified and reused. Corrupt cached content is refused, never repaired in place. Files and ancestor directories containing symbolic links/junctions are refused. The store is restricted to 12,000 files and 2 GiB per dependency set; unexpected future layouts fail closed rather than copying arbitrary dependencies.

The isolated Browser child uses the copied CLI and node_repl paths. The primary Codex CLI selection/configuration is unchanged. The official `NODE_REPL_TRUSTED_CODE_PATHS` boundary is retained: source code must already fall under an admitted root; broad source roots are narrowed to only copied Chrome/Browser/module directories. Neither the entire store nor the entire snapshot becomes a trusted code root. Filesystem permissions, confirmation policy, environment allowlists, tab claims, action/generation binding, and URL validation are unchanged.

Every Browser readiness check hashes the complete active snapshot, verifies the pinned manifest, and checks node_repl availability. It does not rediscover source Skills or packages. Missing, extra, changed, or linked active files produce `BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED` before dispatch. Its sanitized `changedComponents` identifies `chrome`, `browser`, `node`, `codex`, or `snapshot`; provider IDs and private paths are not diagnostic payloads. A failed generation is never hot-switched.

## Retention

Live process leases protect every bound snapshot. After successful official Browser bootstrap, the snapshot becomes the current known-good generation and the previous known-good generation remains retained. Failed bootstrap does not rotate rollback history. Startup cleanup deletes at most two complete verified unleased snapshots and two abandoned, link-free staging trees with a matching dead-owner receipt. Unknown/corrupt state and live owners are retained; cleanup uncertainty does not invalidate a verified binding. Dead transaction locks are moved to nonce tombstones, which prevent stale reclaimers from taking a new owner's lock. Tombstones and unidentifiable staging remnants need explicit offline review.

## Costs and limits

The measured Windows closure for Browser build `26.930.31730` and the matching complete pinned CLI is about 672 MiB. Active plus rollback costs about 1.31 GiB; staging a third generation peaks near 1.97 GiB. Reuse avoids copying, but full hashing on each readiness check still adds disk work. This favors integrity over metadata-based caching that could miss a same-size/same-mtime mutation.

Snapshots isolate static executable/package churn. They do not copy the running Desktop IPC service, Chrome extension/native host, user tabs, or external backend connections. Changes to those live dependencies can still require recovery. The snapshot is logically immutable to Codexless, not protected from the owning user's deliberate filesystem edits; those edits are checked before dispatch.

Source package relocation is validated against the official runtime's actual APIs/configuration. New unknown source layouts or nonempty node_repl launch arguments require compatibility review rather than speculative remapping. Cross-platform native dependencies still need live validation on the target platform.

## Validation

`npm run test:browser-snapshots` covers source removal and candidate churn, restart selection, content tampering (including size/mtime spoofing), missing files, incoherence, reuse, unsafe links, bounded cleanup, interrupted staging, and rollback preservation. Run the maintained Browser operator/reader, public guardrail/registration, release identity, and full `npm test` gates as well. A real test should use owned fixture tabs and an isolated source copy, never delete the user's Desktop cache to simulate an update.
