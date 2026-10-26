# ocsync

[![CI](https://github.com/alv67/ocsync/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/alv67/ocsync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Project](https://img.shields.io/badge/project-roadmap-2f81f7)](https://github.com/users/alv67/projects/5)

Git-backed session sync for OpenCode V2.

> **Status: pre-alpha.** The core sync engine, CLI, and OpenCode server plugin are implemented and covered by unit and end-to-end tests. Child-session transfer and deletion propagation are still pending.

`ocsync` keeps OpenCode sessions in sync across machines without a resident sync service. Sessions are exported through the official OpenCode V2 HTTP API, stored as encrypted immutable blobs in a private Git repository, and imported on the other machine when needed.

## Why

OpenCode stores sessions in a local SQLite database. That is excellent for a single machine, but it means a session created on a laptop is invisible on a desktop. `ocsync` is built for people who use the same project from more than one computer and want to continue a session where they left it.

It is intentionally **not** a real-time collaboration layer. For that, connect multiple clients to the same OpenCode server. `ocsync` solves the offline and multi-server case.

## Design principles

- **Official API only.** Sessions are transferred with `session.export` and `session.import`. The OpenCode database is never modified directly.
- **No resident service.** The sync engine runs on demand, either from the CLI or from the OpenCode server plugin.
- **Deletion-safe.** Remote deletions are applied only when the local session is unchanged; otherwise they become conflicts. Local deletions are published as tombstones.
- **Conflict-preserving.** Two divergent edits to the same session are never silently merged or overwritten. Both branches are preserved.
- **Encrypted at rest.** Session blobs are encrypted before they reach Git.
- **No credential sync.** `ocsync` syncs sessions only. Provider credentials, auth files, and OpenCode configuration stay on each machine.
- **Boring transport.** A private Git repository is the source of truth, so the data is versioned and auditable.

## How it works

```text
OpenCode server ──export/import──> ocsync core ──> private Git repository
        ▲                                │
        └──────── plugin trigger ────────┘
```

- The **CLI** performs `status`, `push`, `pull`, `sync`, `key`, `doctor`, and `resolve`. Conflicts are reported for explicit resolution.
- The **server plugin** watches session events and invokes the CLI with a debounce. It runs inside the OpenCode server that is already running, so there is no extra daemon.
- Every session revision is an immutable encrypted blob. A per-device index points at the current head. Revisions form a hash chain, which lets `ocsync` distinguish a fast-forward from a real divergence.

See [docs/architecture.md](docs/architecture.md) for the full design.

## Requirements

- OpenCode V2 (`>= 2.0.29`)
- Git
- Bun 1.4+ for development and for building from source

## Install from source

```bash
git clone https://github.com/alv67/ocsync.git
cd ocsync
bun install
bun run build
bun link
ocsync --help
```

The npm package and prebuilt binaries are not published yet. The GitHub Project tracks the release work.

## Development

```bash
bun install
bun run check
bun run build
```

`bun run check` runs Biome, TypeScript, and the test suite.

### End-to-end check

With OpenCode V2 on `PATH`, run:

```bash
bash scripts/e2e.sh
```

The script starts two isolated OpenCode servers, creates a temporary session, pushes it from one server, pulls it into the other, and verifies the transcript. Set `KEEP_E2E=1` to keep the temporary directory for inspection.

The repository uses a two-branch model:

- `main` is release-only and protected.
- `develop` is the integration branch.
- Feature branches target `develop` through pull requests.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/github-workflow.md](docs/github-workflow.md).

## Documentation

- [Architecture](docs/architecture.md)
- [GitHub workflow](docs/github-workflow.md)
- [Feasibility spike — 2026-10-26](docs/spike-2026-10-26.md)
- [Project board](https://github.com/users/alv67/projects/5)

## Security

Do not report security issues in public issues. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

`ocsync` is an independent community project and is not affiliated with the OpenCode maintainers.
