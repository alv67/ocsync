import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import type { SessionSnapshot } from "./types.js"

/**
 * Fields that do not survive an import (or that legitimately differ between
 * machines) are excluded from the revision projection.
 *
 * - projectID is local to each server.
 * - location.directory is remapped on import.
 * - time.updated is set to the import time, not the source time.
 * - time.viewed is local UI state.
 * - fork and revert metadata are not preserved by the V2 import route.
 */
const VOLATILE_INFO_FIELDS = ["projectID", "fork", "revert"] as const
const VOLATILE_TIME_FIELDS = ["updated", "viewed"] as const

/**
 * Return a deterministic projection of a session snapshot.
 *
 * Two exports that describe the same transferable session state produce the
 * same projection even when they come from different machines.
 */
export function sessionProjection(snapshot: SessionSnapshot): unknown {
  const info: Record<string, unknown> = { ...snapshot.info }

  for (const field of VOLATILE_INFO_FIELDS) delete info[field]

  if (info.time && typeof info.time === "object") {
    const time: Record<string, unknown> = { ...(info.time as Record<string, unknown>) }
    for (const field of VOLATILE_TIME_FIELDS) delete time[field]
    info.time = time
  }

  if (info.location && typeof info.location === "object") {
    const location: Record<string, unknown> = { ...(info.location as Record<string, unknown>) }
    delete location.directory
    info.location = location
  }

  return {
    info,
    messages: snapshot.messages,
  }
}

/** Stable JSON serialization: object keys sorted, array order preserved. */
export function stableStringify(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    return `{${entries.join(",")}}`
  }
  return "null"
}

/** Compute the content address of a session snapshot. */
export function revisionOf(snapshot: SessionSnapshot): string {
  const projection = sessionProjection(snapshot)
  return bytesToHex(sha256(new TextEncoder().encode(stableStringify(projection))))
}

/**
 * Build the revision identity for a content hash and its parent.
 *
 * Content alone is not sufficient: the same snapshot can be reached from two
 * different history points. Including the parent keeps the revision graph
 * unambiguous and makes ancestry checks reliable.
 */
export function chainRevision(parentRevision: string | null, contentRevision: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${parentRevision ?? "root"}:${contentRevision}`)))
}

/** First 12 hex characters, useful for logs. */
export function shortRevision(revision: string): string {
  return revision.slice(0, 12)
}
