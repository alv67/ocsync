# Architecture

`ocsync` is a Git-backed transport for OpenCode V2 sessions. It is deliberately small: the OpenCode server remains the owner of sessions, and the data repository is an append-only store of encrypted revisions.

## Goals

- Continue a session on another machine without copying the OpenCode database.
- Preserve both sides when two machines edit the same session concurrently.
- Keep the transport auditable and versioned.
- Run no background service of its own.
- Never modify the OpenCode database directly.

## Non-goals

- Real-time collaboration on a single session.
- Merging two conversation transcripts into one linear history.
- Syncing provider credentials, authentication files, or OpenCode configuration.
- Syncing file snapshots or working-tree state. Code belongs in Git.
- Replacing the native remote-server workflow.

## Components

```text
┌──────────────────┐       export / import        ┌──────────────┐
│  OpenCode server │ <──────────────────────────> │ ocsync core  │
└──────────────────┘                              │              │
        ▲                                         │  revisions   │
        │ events                                  │  conflicts   │
        │                                         │  crypto      │
┌───────┴──────────┐                              └──────┬───────┘
│  server plugin   │                                     │
└──────────────────┘                              ┌──────▼───────┐
                                                  │  Git remote  │
                                                  │  (private)   │
                                                  └──────────────┘
```

- **Core** — revision projection, Git store, encryption, push/pull engine.
- **CLI** — the user-facing entry point and the code the plugin invokes.
- **Server plugin** — listens to session events and triggers a debounced sync. It runs inside the existing OpenCode server; it is not a separate daemon.
- **TUI plugin** — optional future surface for a status indicator and a manual sync command.

## Data model

Each session revision is an immutable encrypted blob plus a plaintext metadata record.

```text
revisions/<revision>.json
projects/<project-key>/sessions/<session-id>/<revision>.json.gz.enc
devices/<device-id>.json
```

### Revision record

```json
{
  "schemaVersion": 1,
  "sessionID": "ses_...",
  "project": "github.com/alv67/ocsync",
  "revision": "…64 hex chars…",
  "parentRevision": "…64 hex chars… or null",
  "deviceID": "dev_...",
  "createdAt": 1793000000000,
  "messageCount": 12,
  "lastMessageID": "msg_...",
  "blob": "projects/.../sessions/.../revision.json.gz.enc",
  "deleted": false
}
```

A revision identity is `sha256(parentRevision + ":" + contentRevision)`, not just the content hash. The parent is part of the identity because the same transcript can be reached from different history points.

### Device index

Every device writes only its own `devices/<device-id>.json`:

```json
{
  "schemaVersion": 1,
  "deviceID": "dev_...",
  "updatedAt": 1793000000000,
  "sessions": {
    "ses_...": {
      "revision": "…",
      "parentRevision": "…",
      "localRevision": "…",
      "deviceID": "dev_...",
      "createdAt": 1793000000000,
      "messageCount": 12,
      "lastMessageID": "msg_...",
      "blob": "…",
      "deleted": false
    }
  }
}
```

Because each device owns its index file, Git never needs to merge a session file. Revisions and blobs are immutable.

## Revision projection

The content revision is a deterministic hash of a projection of the exported session. The following are excluded because they differ between machines or do not survive import:

- `info.projectID`
- `info.location.directory`
- `info.time.updated`
- `info.time.viewed`
- `info.revert`
- `info.fork`

The import route sets `time.updated` to the import time and remaps the location, so comparing raw exports would produce false changes.

## Sync algorithm

### Push

1. Fetch and rebase the local data-repository clone.
2. Read the device index and all other device indexes.
3. For each root session in the project:
   - skip active sessions;
   - export the session;
   - skip it when its content revision matches `localRevision`;
   - compare the remote head with the local head:
     - remote is an ancestor of local → push a new revision;
     - local is an ancestor of remote → skip and pull first;
     - unrelated histories → report a conflict;
   - write an encrypted blob and revision record;
   - update the local device index.
4. Commit and push the index and immutable files.

### Pull

1. Fetch the data repository.
2. Collect every device's head for each session and reduce them to tips.
3. For each tip in this project:
   - skip active sessions;
   - skip child sessions for now;
   - if no local session exists, import the remote snapshot;
   - if local is unchanged and the remote tip descends from the local head, back up the local snapshot, delete it, and import the remote snapshot;
   - if local is unchanged and the local head descends from the remote tip, do nothing;
   - otherwise report a conflict.
4. Update the device index and push it.

### Conflicts

A conflict means the two sides have revisions that are not ancestors of one another. `ocsync` never picks a winner automatically. The current version reports the conflict and leaves both sides untouched. `ocsync resolve <session> --keep local|remote|both` resolves it explicitly. `--keep both` imports the remote transcript as a new session and continues the local transcript on top of the remote head.

## Session replacement

OpenCode V2 has no in-place “update session” API. To replace a session with a newer revision, `ocsync`:

1. writes a plaintext local backup;
2. deletes the local session (the API cascades to child sessions);
3. imports the remote snapshot with the same session ID and the local project directory.

For that reason, a session with local child sessions is skipped until child-session sync is implemented.

## Encryption

- XChaCha20-Poly1305 with a 256-bit key.
- The blob format is `nonce (24 bytes) || ciphertext`.
- JSON is gzip-compressed before encryption.
- The key is stored at `~/.config/ocsync/key` with mode `0600`, or supplied through `OCSYNC_KEY` as base64.
- Git stores only ciphertext. The plaintext key never leaves the machine through `ocsync`.

Session transcripts can contain source code, shell output, and secrets. Treat the key as a secret. A private Git repository is still required, because metadata and commit history are visible.

## Server plugin

The plugin subscribes to the server event stream and filters by its location. It triggers pushes on:

- `session.execution.succeeded`
- `session.execution.failed`
- `session.execution.interrupted`
- `session.created`, `session.deleted`, `session.renamed`, `session.moved`
- `session.archived`, `session.unarchived`
- `session.idle`
- `session.status` with status `idle`

Pushes are debounced (`pushDebounceSec`, default 30 seconds). The plugin also pulls when the location opens and every `pullIntervalSec` seconds (default 120; set to `0` to disable).

The plugin invokes the `ocsync` binary as a subprocess. The server plugin context does not expose `session.export` or `session.import` directly, and subprocess execution was verified during the feasibility spike.

## Known limitations

- Child sessions (subagents) are not synced yet.
- Deletions are not propagated automatically.
- A session with local child sessions cannot be fast-forwarded safely and is skipped.
- File snapshots and revert history are not transferred.
- `fork` metadata and `revert` state are not preserved by the V2 import route.
- Pulling a session that is open but idle in a client can replace it; the engine only knows about active turns. This must be tested against TUI, web, and desktop clients.
- The desktop app must be verified to load server plugins from its configuration.

## Failure model

- The OpenCode database is never modified directly.
- Session blobs and revision records are immutable.
- Local snapshots are backed up before replacement.
- A failed import leaves the session deleted only if the backup step succeeded; the backup is written before any destructive call.
- A failed Git push can be retried; the local index is committed first.
- A missing or wrong key produces a decrypt error, not a partial import.
