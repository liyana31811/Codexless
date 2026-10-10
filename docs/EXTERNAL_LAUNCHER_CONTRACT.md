# External Codexless Launcher Contract

Status: Documentation of the existing Codexless 0.1.2 Preview runtime boundary.

Baseline:
- Release: `0.1.2-preview.0`
- Commit: `62c9ad20e90887a5bb8e3efca375fe9d955ad6cd`

This document describes the current integration boundary for an external companion launcher. It
does not add new runtime behavior, a new supervisor API, or a new startup mechanism.

## Startup entry

The existing launcher entry supports:

```sh
node scripts/launch.mjs http
```

and:

```sh
node scripts/launch.mjs stdio
```

Run the command from a release/repository root containing the `scripts` directory, or use an
equivalent absolute path to the launcher entry.

The process working directory and the selected project working directory are separate concepts.
`CODEXLESS_DEFAULT_CWD` controls the runtime project context; it does not describe where the
launcher script itself must be started.

## Runtime configuration inputs

The following variables are launcher-related runtime inputs:

- `CODEXLESS_DEFAULT_CWD`
- `CODEXLESS_PROFILE`
- `CODEXLESS_CONFIG_OVERRIDES_FILE`

`CODEXLESS_DEFAULT_CWD` selects the default project working directory. If it is not provided,
the runtime uses the process current working directory.

`CODEXLESS_PROFILE` provides the selected runtime profile input.

`CODEXLESS_CONFIG_OVERRIDES_FILE` points to a JSON configuration file containing an `overrides`
string array used as configuration override entries.

These variables are not a complete inventory of all environment variables used internally by
Codexless.

`CODEX_BIN` can be used for explicit Codex executable selection. On Windows, it should resolve to
a native executable rather than an npm command shim.

## HTTP binding

The public HTTP entry defaults to `127.0.0.1:7690`. Its existing binding inputs are
`CODEX_TOOLBOX_PUBLIC_HOST` and `CODEX_TOOLBOX_PUBLIC_PORT`. The entry accepts only loopback
hosts (`127.0.0.1`, `localhost`, or `::1`); a companion tunnel remains separately managed.

## Health endpoints

The HTTP runtime exposes:

```text
GET /healthz
GET /readyz
```

Both endpoints currently use the same handler and return the same runtime status payload.

The current implementation does not define separate liveness and readiness semantics.

The health response does not claim to continuously verify every downstream dependency, including
Codex availability for every future operation. It reports the current runtime status exposed by
the handler.

## Startup failures and HTTP errors

Startup failures are separate from HTTP request handling errors.

The launch entry writes usage information to stderr and exits with code `2` for an invalid mode.
Unsupported platforms and Node.js versions below 22 produce a prerequisite message on stderr and
exit with code `1`. Runtime initialization, import, or listen failures propagate through the
existing process error behavior; this document does not define a structured startup error receipt
or a stable mapping for other startup failures.

The HTTP handler `internal_error` response is an HTTP request handling response. It is not a
startup failure protocol.

## Shutdown

The HTTP runtime contains cleanup paths for:

- `SIGINT`
- `SIGTERM`

The cleanup path attempts cooperative cleanup before process exit. This static path is not
evidence that cleanup always succeeds; its final process exit is not a cleanup-success receipt.

This documents the static cleanup path in the runtime. End-to-end Windows companion signal delivery
has not been validated by this contract.

## Version and lifecycle compatibility

The public runtime identifies:

```text
version: 0.1.2-preview.0
surfaceVersion: codexless-public-preview-v1
```

Codexless contains lifecycle receipt version `1` for its existing installation, update, and repair
lifecycle operations. This is distinct from runtime `version` and `surfaceVersion`.

The lifecycle receipt version is not defined as a receipt emitted for every runtime startup.

## Companion responsibilities

The external companion launcher may manage:

- persistence;
- tunnel credentials;
- task registration;
- supervisor recovery.

Those responsibilities remain outside the runtime behavior documented here.

## Scope

This document only describes existing behavior in the `0.1.2-preview.0` public baseline.

It does not add:

- a new launcher command;
- a restart protocol;
- an uninstall protocol;
- a Windows service contract;
- new runtime APIs.
