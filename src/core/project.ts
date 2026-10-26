import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

export class ProjectKeyError extends Error {
  override readonly name = "ProjectKeyError"
}

function gitRemote(directory: string): string | null {
  try {
    const output = execFileSync("git", ["-C", directory, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}

/** Turn common Git remote URL forms into a stable host/path key. */
export function normalizeRemote(remote: string): string {
  let value = remote.trim()
  if (value.length === 0) throw new ProjectKeyError("Empty Git remote.")

  if (value.startsWith("git@")) {
    value = value.slice("git@".length).replace(":", "/")
  } else if (value.includes("://")) {
    const url = new URL(value)
    if (url.protocol === "file:") return localProjectKey(url.pathname)
    value = `${url.hostname}${url.pathname}`
  } else if (isAbsolute(value) || value.startsWith("~")) {
    return localProjectKey(value)
  } else if (/^[^/]+@[^/]+:/.test(value)) {
    value = value.replace(/^[^@]+@/, "").replace(":", "/")
  }

  value = value
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
  if (value.length === 0) throw new ProjectKeyError(`Cannot derive a project key from remote: ${remote}`)
  return value
}

export function localProjectKey(directory: string): string {
  const absolute = resolve(directory)
  let canonical = absolute
  try {
    canonical = realpathSync(absolute)
  } catch {
    // The directory may not exist yet; the resolved path is still stable.
  }
  return `local:${bytesToHex(sha256(new TextEncoder().encode(canonical))).slice(0, 32)}`
}

/** Stable identity of a project across machines. */
export function projectKey(directory: string): string {
  const absolute = isAbsolute(directory) ? directory : resolve(process.cwd(), directory)
  const remote = gitRemote(absolute)
  if (remote) {
    try {
      return normalizeRemote(remote)
    } catch {
      return localProjectKey(absolute)
    }
  }
  return localProjectKey(absolute)
}

export function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2))
  return value
}

export function isPathWithin(child: string, parent: string): boolean {
  const normalizedChild = resolve(child)
  const normalizedParent = resolve(parent)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
}

/** Cache project-key lookups; the engine filters every session on every run. */
export class ProjectKeyCache {
  private readonly cache = new Map<string, string>()

  get(directory: string): string {
    const cached = this.cache.get(directory)
    if (cached) return cached
    const key = projectKey(directory)
    this.cache.set(directory, key)
    return key
  }

  clear(): void {
    this.cache.clear()
  }
}
