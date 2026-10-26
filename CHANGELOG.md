# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `ocsync resolve <session> --keep local|remote|both` for explicit conflict resolution.
- Deletion propagation: local deletions are published as tombstones, and remote tombstones are applied when the local session is unchanged and inactive.

## [0.1.0] - 2026-10-26

### Added

- Initial project scaffold.
- Revision projection and parent-aware revision chain.
- Encrypted Git store with per-device indexes.
- OpenCode V2 HTTP client and session export/import support.
- Push/pull engine with fast-forward and conflict detection.
- OpenCode server plugin that triggers sync on session events.
- CLI commands: `init`, `status`, `push`, `pull`, `sync`, `key`, `doctor`.
- End-to-end two-server test script.
- Unit tests for revisions, crypto, configuration, project keys, Git storage, and the engine.
- CI workflow for Linux, macOS, and Windows.
- Architecture, GitHub workflow, and feasibility spike documentation.

### Fixed

- Pull no longer hides an unpushed local edit when the remote head is unchanged.
- Honor `--key-file` during `ocsync init`.

### Known limitations

- Child sessions are not synced yet.
- Remote deletions are not applied automatically.
- File snapshots and revert state are not transferred.
- Pulling an open-but-idle session needs end-to-end UI validation.
