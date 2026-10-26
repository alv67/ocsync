/**
 * Shared domain types for ocsync.
 *
 * The session shapes are intentionally permissive: OpenCode evolves, and ocsync
 * only needs a stable subset to identify and transfer a session. The full
 * payload is preserved when a session is exported and imported.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface SessionTime {
  created: number
  updated: number
  idle?: number
  viewed?: number
  archived?: number
}

export interface SessionLocation {
  directory: string
  [key: string]: unknown
}

export interface SessionInfo {
  id: string
  parentID?: string
  title?: string
  time: SessionTime
  location: SessionLocation
  [key: string]: unknown
}

export interface SessionMessage {
  id: string
  type: string
  time: {
    created: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface SessionSnapshot {
  info: SessionInfo
  messages: SessionMessage[]
}

/** A session head as recorded in a device index. */
export interface SessionHead {
  /** Revision hash of the exported session. */
  revision: string
  /** Revision this one was derived from, or null for the first revision. */
  parentRevision: string | null
  deviceID: string
  createdAt: number
  messageCount: number
  lastMessageID: string | null
  /** Repository-relative path of the encrypted session blob. */
  blob: string | null
  deleted: boolean
}

/** Immutable metadata stored next to a session blob. */
export interface RevisionRecord extends SessionHead {
  schemaVersion: 1
  sessionID: string
  /** Canonical project key, for example github.com/alv67/ocsync. */
  project: string
}

/** Per-device state for one session. */
export interface DeviceSessionState extends SessionHead {
  /** Content hash of the local export at the last successful sync. */
  localRevision: string | null
}

/** Per-device index. Each device writes only its own file. */
export interface DeviceIndex {
  schemaVersion: 1
  deviceID: string
  updatedAt: number
  sessions: Record<string, DeviceSessionState>
}
