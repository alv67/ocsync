import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { LoadedConfig } from "./config.js"
import { stateDir } from "./config.js"
import { decryptJson, encryptJson } from "./crypto.js"
import type { GitStore } from "./git-store.js"
import { projectKey as computeProjectKey, isPathWithin, ProjectKeyCache } from "./project.js"
import { chainRevision, revisionOf, shortRevision } from "./revision.js"
import type { DeviceIndex, DeviceSessionState, RevisionRecord, SessionInfo, SessionSnapshot } from "./types.js"

export interface SyncAdapter {
  listSessions(): Promise<SessionInfo[]>
  exportSession(sessionID: string): Promise<SessionSnapshot>
  importSession(snapshot: SessionSnapshot, directory: string): Promise<SessionInfo>
  deleteSession(sessionID: string): Promise<void>
  activeSessions(): Promise<Set<string>>
}

export interface SyncEngineOptions {
  config: LoadedConfig
  store: GitStore
  adapter: SyncAdapter
  key: Uint8Array
  projectDirectory: string
  projectKey?: string
  backupDir?: string
  now?: () => number
  log?: (message: string) => void
}

export interface SessionStatus {
  id: string
  title: string | null
  directory: string
  active: boolean
  hasChildren: boolean
  localRevision: string | null
  head: string | null
  remoteTip: string | null
  state: "untracked" | "clean" | "local-ahead" | "remote-ahead" | "diverged" | "remote-only" | "deleted"
}

export interface StatusReport {
  project: string
  directory: string
  device: string
  branch: string
  sessions: SessionStatus[]
  conflicts: SessionStatus[]
}

export interface PushResult {
  pushed: string[]
  skipped: { id: string; reason: string }[]
}

export interface PullResult {
  pulled: string[]
  skipped: { id: string; reason: string }[]
  conflicts: SessionStatus[]
}

export interface SyncResult {
  push: PushResult
  pull: PullResult
}

export class SyncError extends Error {
  override readonly name = "SyncError"
}

export class SyncEngine {
  readonly config: LoadedConfig
  readonly store: GitStore
  readonly adapter: SyncAdapter
  readonly key: Uint8Array
  readonly projectDirectory: string
  readonly project: string
  readonly backupDir: string
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly projectKeys = new ProjectKeyCache()

  constructor(options: SyncEngineOptions) {
    this.config = options.config
    this.store = options.store
    this.adapter = options.adapter
    this.key = options.key
    this.projectDirectory = options.projectDirectory
    this.project = options.projectKey ?? computeProjectKey(options.projectDirectory)
    this.backupDir = options.backupDir ?? join(stateDir(), "backups")
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
  }

  private emptyIndex(): DeviceIndex {
    return {
      schemaVersion: 1,
      deviceID: this.config.device,
      updatedAt: this.now(),
      sessions: {},
    }
  }

  private readIndex(): DeviceIndex {
    return this.store.readDeviceIndex(this.config.device) ?? this.emptyIndex()
  }

  private writeIndex(index: DeviceIndex): void {
    index.updatedAt = this.now()
    this.store.writeDeviceIndex(index)
  }

  private async sessionsForProject(): Promise<SessionInfo[]> {
    const sessions = await this.adapter.listSessions()
    return sessions.filter((session) => this.projectKeys.get(session.location.directory) === this.project)
  }

  private async activeSessionIDs(): Promise<Set<string>> {
    return this.adapter.activeSessions()
  }

  private hasChildren(sessionID: string, sessions: SessionInfo[]): boolean {
    return sessions.some((session) => session.parentID === sessionID)
  }

  private lastMessageID(snapshot: SessionSnapshot): string | null {
    return snapshot.messages.length > 0 ? (snapshot.messages[snapshot.messages.length - 1]?.id ?? null) : null
  }

  private backup(snapshot: SessionSnapshot): string {
    mkdirSync(this.backupDir, { recursive: true, mode: 0o700 })
    const path = join(this.backupDir, `${snapshot.info.id}-${this.now()}.json`)
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    return path
  }

  private async remoteTips(): Promise<Map<string, { tips: string[]; records: RevisionRecord[] }>> {
    const heads = new Map<string, Set<string>>()
    for (const index of this.store.listDeviceIndexes()) {
      for (const [sessionID, state] of Object.entries(index.sessions)) {
        if (!state.revision) continue
        const set = heads.get(sessionID) ?? new Set<string>()
        set.add(state.revision)
        heads.set(sessionID, set)
      }
    }

    const result = new Map<string, { tips: string[]; records: RevisionRecord[] }>()
    for (const [sessionID, revisions] of heads) {
      const list = [...revisions]
      const tips = list.filter(
        (candidate) => !list.some((other) => candidate !== other && this.isAncestor(candidate, other)),
      )
      const records = tips.map((revision) => this.requireRevision(revision))
      result.set(sessionID, { tips, records })
    }
    return result
  }

  private requireRevision(revision: string): RevisionRecord {
    const record = this.store.readRevision(revision)
    if (!record) throw new SyncError(`Missing revision metadata for ${shortRevision(revision)}.`)
    return record
  }

  private isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true
    let current: string | null = descendant
    const seen = new Set<string>()
    while (current) {
      if (seen.has(current)) throw new SyncError(`Revision cycle detected at ${shortRevision(current)}.`)
      seen.add(current)
      const record: RevisionRecord | null = this.store.readRevision(current)
      if (!record) throw new SyncError(`Missing revision metadata for ${shortRevision(current)}.`)
      current = record.parentRevision
      if (current === ancestor) return true
    }
    return false
  }

  private baseState(revision: string, localRevision: string | null, record?: RevisionRecord): DeviceSessionState {
    return {
      revision,
      parentRevision: record?.parentRevision ?? null,
      deviceID: this.config.device,
      createdAt: record?.createdAt ?? this.now(),
      messageCount: record?.messageCount ?? 0,
      lastMessageID: record?.lastMessageID ?? null,
      blob: record?.blob ?? null,
      deleted: record?.deleted ?? false,
      localRevision,
    }
  }

  async status(): Promise<StatusReport> {
    this.store.ensure()
    const index = this.readIndex()
    const sessions = await this.sessionsForProject()
    const active = await this.activeSessionIDs()
    const tips = await this.remoteTips()
    const byID = new Map(sessions.map((session) => [session.id, session]))
    const rows: SessionStatus[] = []

    for (const session of sessions) {
      if (session.parentID) continue
      const state = index.sessions[session.id]
      const remote = tips.get(session.id)
      const snapshot = await this.adapter.exportSession(session.id)
      const localRevision = revisionOf(snapshot)
      rows.push({
        id: session.id,
        title: session.title ?? null,
        directory: session.location.directory,
        active: active.has(session.id),
        hasChildren: this.hasChildren(session.id, sessions),
        localRevision,
        head: state?.revision ?? null,
        remoteTip: remote?.tips[0] ?? null,
        state: this.classify(state, remote?.tips ?? [], localRevision),
      })
    }

    for (const [sessionID, remote] of tips) {
      if (byID.has(sessionID)) continue
      const record = remote.records[0]
      if (!record || record.project !== this.project) continue
      rows.push({
        id: sessionID,
        title: null,
        directory: this.projectDirectory,
        active: active.has(sessionID),
        hasChildren: false,
        localRevision: null,
        head: null,
        remoteTip: remote.tips[0] ?? null,
        state: record.deleted ? "deleted" : "remote-only",
      })
    }

    return {
      project: this.project,
      directory: this.projectDirectory,
      device: this.config.device,
      branch: this.config.branch,
      sessions: rows,
      conflicts: rows.filter((row) => row.state === "diverged"),
    }
  }

  private classify(
    state: DeviceSessionState | undefined,
    remoteTips: string[],
    localRevision: string,
  ): SessionStatus["state"] {
    if (remoteTips.length > 1) return "diverged"
    const remote = remoteTips[0] ?? null
    if (!state) return remote ? "diverged" : "untracked"
    if (state.deleted) return "deleted"
    if (remote === state.revision) {
      return localRevision === state.localRevision ? "clean" : "local-ahead"
    }
    if (!remote) return "local-ahead"
    if (this.isAncestor(state.revision, remote)) {
      return localRevision === state.localRevision ? "remote-ahead" : "diverged"
    }
    if (this.isAncestor(remote, state.revision)) return "local-ahead"
    return "diverged"
  }

  async push(input: { dryRun?: boolean } = {}): Promise<PushResult> {
    this.store.ensure()
    this.store.pullRebase()

    const index = this.readIndex()
    const sessions = await this.sessionsForProject()
    const active = await this.activeSessionIDs()
    const tips = await this.remoteTips()
    const result: PushResult = { pushed: [], skipped: [] }

    for (const session of sessions) {
      if (session.parentID) {
        result.skipped.push({ id: session.id, reason: "child sessions are not synced yet" })
        continue
      }
      if (active.has(session.id)) {
        result.skipped.push({ id: session.id, reason: "session is active" })
        continue
      }

      const snapshot = await this.adapter.exportSession(session.id)
      const contentRevision = revisionOf(snapshot)
      const size = Buffer.byteLength(JSON.stringify(snapshot), "utf8")
      if (size > this.config.maxSessionBytes) {
        result.skipped.push({ id: session.id, reason: `session is larger than ${this.config.maxSessionBytes} bytes` })
        continue
      }

      const state = index.sessions[session.id]
      if (state?.localRevision === contentRevision && !state.deleted) continue

      const remote = tips.get(session.id)
      if (remote && remote.tips.length > 1) {
        result.skipped.push({ id: session.id, reason: "diverged remote history" })
        continue
      }
      const remoteTip = remote?.tips[0]
      if (remoteTip && state) {
        if (remoteTip !== state.revision) {
          if (this.isAncestor(state.revision, remoteTip)) {
            result.skipped.push({ id: session.id, reason: "remote has changes; pull first" })
            continue
          }
          if (!this.isAncestor(remoteTip, state.revision)) {
            result.skipped.push({ id: session.id, reason: "histories diverged" })
            continue
          }
        }
      } else if (remoteTip && !state) {
        result.skipped.push({ id: session.id, reason: "remote session already exists; pull first" })
        continue
      }

      const parent = state?.revision ?? null
      const revision = chainRevision(parent, contentRevision)
      if (!input.dryRun) {
        const blob = this.store.writeBlob(this.project, session.id, revision, encryptJson(this.key, snapshot))
        const record: RevisionRecord = {
          schemaVersion: 1,
          revision,
          parentRevision: parent,
          sessionID: session.id,
          project: this.project,
          deviceID: this.config.device,
          createdAt: this.now(),
          messageCount: snapshot.messages.length,
          lastMessageID: this.lastMessageID(snapshot),
          blob,
          deleted: false,
        }
        this.store.writeRevision(record)
        index.sessions[session.id] = this.baseState(revision, contentRevision, record)
      }
      result.pushed.push(session.id)
      this.log(`push ${session.id} -> ${shortRevision(revision)}`)
    }

    if (!input.dryRun && result.pushed.length > 0) {
      this.writeIndex(index)
      this.store.commitAndPush(`ocsync: push ${result.pushed.length} session(s) from ${this.config.device}`)
    }

    return result
  }

  async pull(input: { dryRun?: boolean } = {}): Promise<PullResult> {
    this.store.ensure()
    this.store.pullRebase()

    const index = this.readIndex()
    const sessions = await this.sessionsForProject()
    const byID = new Map(sessions.map((session) => [session.id, session]))
    const active = await this.activeSessionIDs()
    const tips = await this.remoteTips()
    const result: PullResult = { pulled: [], skipped: [], conflicts: [] }

    for (const [sessionID, remote] of tips) {
      const records = remote.records
      if (records.length === 0) continue
      const record = records[0]
      if (!record || record.project !== this.project) continue

      const local = byID.get(sessionID)
      if (remote.tips.length > 1) {
        result.conflicts.push({
          id: sessionID,
          title: local?.title ?? null,
          directory: local?.location.directory ?? this.projectDirectory,
          active: active.has(sessionID),
          hasChildren: local ? this.hasChildren(sessionID, sessions) : false,
          localRevision: local ? revisionOf(await this.adapter.exportSession(sessionID)) : null,
          head: index.sessions[sessionID]?.revision ?? null,
          remoteTip: remote.tips[0] ?? null,
          state: "diverged",
        })
        continue
      }

      if (record.deleted) {
        if (local) result.skipped.push({ id: sessionID, reason: "remote deletion is not applied automatically" })
        continue
      }

      if (!record.blob) {
        result.skipped.push({ id: sessionID, reason: "remote revision has no blob" })
        continue
      }

      const payload = this.store.readBlob(record.project, record.sessionID, record.revision)
      if (!payload) {
        result.skipped.push({ id: sessionID, reason: "remote revision has no readable blob" })
        continue
      }
      const remoteSnapshot = decryptJson<SessionSnapshot>(this.key, payload)
      if (remoteSnapshot.info.parentID) {
        result.skipped.push({ id: sessionID, reason: "child sessions are not synced yet" })
        continue
      }

      if (local && active.has(sessionID)) {
        result.skipped.push({ id: sessionID, reason: "session is active" })
        continue
      }

      if (local && this.hasChildren(sessionID, sessions)) {
        result.skipped.push({ id: sessionID, reason: "session has child sessions; replacing it would delete them" })
        continue
      }

      if (!local) {
        if (input.dryRun) {
          result.pulled.push(sessionID)
          continue
        }
        await this.adapter.importSession(remoteSnapshot, this.projectDirectory)
        const imported = await this.adapter.exportSession(sessionID)
        index.sessions[sessionID] = this.baseState(remote.tips[0] ?? record.revision, revisionOf(imported), record)
        result.pulled.push(sessionID)
        this.log(`pull ${sessionID} -> ${shortRevision(record.revision)}`)
        continue
      }

      const localSnapshot = await this.adapter.exportSession(sessionID)
      const localRevision = revisionOf(localSnapshot)
      const state = index.sessions[sessionID]
      const remoteTip = remote.tips[0]
      if (!remoteTip) continue

      if (state?.revision === remoteTip) {
        // A remote head equal to the local head means there is no remote change.
        // Only refresh the local marker when the local content is also unchanged:
        // overwriting it here would hide an unpushed local edit from push.
        if (state.localRevision === localRevision) {
          index.sessions[sessionID] = { ...state, localRevision }
        }
        continue
      }

      if (!state) {
        if (localRevision === revisionOf(remoteSnapshot)) {
          index.sessions[sessionID] = this.baseState(remoteTip, localRevision, record)
          continue
        }
        result.conflicts.push(this.conflictRow(local, state, remoteTip, localRevision, sessions))
        continue
      }

      if (this.isAncestor(remoteTip, state.revision)) {
        result.skipped.push({ id: sessionID, reason: "local revision is ahead" })
        continue
      }

      if (this.isAncestor(state.revision, remoteTip)) {
        if (localRevision !== state.localRevision) {
          result.conflicts.push(this.conflictRow(local, state, remoteTip, localRevision, sessions))
          continue
        }
        if (input.dryRun) {
          result.pulled.push(sessionID)
          continue
        }
        this.backup(localSnapshot)
        await this.adapter.deleteSession(sessionID)
        await this.adapter.importSession(remoteSnapshot, this.projectDirectory)
        const imported = await this.adapter.exportSession(sessionID)
        index.sessions[sessionID] = this.baseState(remoteTip, revisionOf(imported), record)
        result.pulled.push(sessionID)
        this.log(`pull ${sessionID} -> ${shortRevision(remoteTip)}`)
        continue
      }

      result.conflicts.push(this.conflictRow(local, state, remoteTip, localRevision, sessions))
    }

    if (!input.dryRun && (result.pulled.length > 0 || index.updatedAt !== 0)) {
      this.writeIndex(index)
      if (result.pulled.length > 0) {
        this.store.commitAndPush(`ocsync: pull ${result.pulled.length} session(s) from ${this.config.device}`)
      }
    }

    return result
  }

  private conflictRow(
    local: SessionInfo,
    state: DeviceSessionState | undefined,
    remoteTip: string,
    localRevision: string,
    sessions: SessionInfo[],
  ): SessionStatus {
    return {
      id: local.id,
      title: local.title ?? null,
      directory: local.location.directory,
      active: false,
      hasChildren: this.hasChildren(local.id, sessions),
      localRevision,
      head: state?.revision ?? null,
      remoteTip,
      state: "diverged",
    }
  }

  async sync(input: { dryRun?: boolean } = {}): Promise<SyncResult> {
    const push = await this.push(input)
    const pull = await this.pull(input)
    return { push, pull }
  }

  /** True when both directories resolve to the same project key. */
  includes(directory: string): boolean {
    return this.projectKeys.get(directory) === this.project
  }

  /** True when the session directory is inside the current project. */
  owns(directory: string): boolean {
    return isPathWithin(directory, this.projectDirectory) || this.includes(directory)
  }
}
