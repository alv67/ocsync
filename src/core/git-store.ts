import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DeviceIndex, RevisionRecord } from "./types.js"

export class GitError extends Error {
  override readonly name = "GitError"
  readonly args: string[]
  readonly stderr: string

  constructor(args: string[], stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`)
    this.args = args
    this.stderr = stderr
  }
}

export interface GitStoreOptions {
  root: string
  remote: string
  branch?: string
}

function runGit(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    }).trim()
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : String(error)
    if (allowFailure) return ""
    throw new GitError(args, stderr)
  }
}

/** A small, append-only Git store used as the sync transport. */
export class GitStore {
  readonly root: string
  readonly remote: string
  readonly branch: string

  constructor(options: GitStoreOptions) {
    this.root = options.root
    this.remote = options.remote
    this.branch = options.branch ?? "main"
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  ensure(): void {
    mkdirSync(this.root, { recursive: true })

    if (!existsSync(this.path(".git"))) {
      runGit(this.root, ["init", "-b", this.branch])
      runGit(this.root, ["remote", "add", "origin", this.remote])
    } else {
      const remotes = runGit(this.root, ["remote"], true)
      if (!remotes.split("\n").includes("origin")) {
        runGit(this.root, ["remote", "add", "origin", this.remote])
      } else {
        runGit(this.root, ["remote", "set-url", "origin", this.remote])
      }
    }

    runGit(this.root, ["config", "user.name", "ocsync"])
    runGit(this.root, ["config", "user.email", "ocsync@localhost"])

    const hasRemoteBranch = runGit(this.root, ["rev-parse", "--verify", `origin/${this.branch}`], true).length > 0
    if (!hasRemoteBranch) {
      runGit(this.root, ["fetch", "origin", this.branch], true)
    } else {
      runGit(this.root, ["fetch", "origin", this.branch])
    }

    const remoteAfterFetch = runGit(this.root, ["rev-parse", "--verify", `origin/${this.branch}`], true).length > 0
    if (remoteAfterFetch) {
      const current = runGit(this.root, ["rev-parse", "--abbrev-ref", "HEAD"], true)
      if (current !== this.branch) {
        runGit(this.root, ["checkout", "-B", this.branch, `origin/${this.branch}`])
      } else {
        runGit(this.root, ["pull", "--rebase", "--autostash", "origin", this.branch], true)
      }
    } else {
      runGit(this.root, ["checkout", "-B", this.branch], true)
    }
  }

  pullRebase(): void {
    const hasRemoteBranch = runGit(this.root, ["rev-parse", "--verify", `origin/${this.branch}`], true).length > 0
    if (!hasRemoteBranch) {
      runGit(this.root, ["fetch", "origin", this.branch], true)
    }
    const remoteExists = runGit(this.root, ["rev-parse", "--verify", `origin/${this.branch}`], true).length > 0
    if (remoteExists) {
      runGit(this.root, ["pull", "--rebase", "--autostash", "origin", this.branch], true)
    }
  }

  commitAll(message: string): boolean {
    runGit(this.root, ["add", "-A"])
    if (!this.hasStagedChanges()) return false
    runGit(this.root, ["commit", "-m", message])
    return true
  }

  private hasStagedChanges(): boolean {
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], {
        cwd: this.root,
        stdio: ["ignore", "ignore", "ignore"],
      })
      return false
    } catch {
      return true
    }
  }

  push(): void {
    runGit(this.root, ["push", "origin", `HEAD:${this.branch}`])
  }

  commitAndPush(message: string): void {
    this.pullRebase()
    const committed = this.commitAll(message)
    if (!committed) return

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.push()
        return
      } catch (error) {
        if (attempt === 2) throw error
        this.pullRebase()
      }
    }
  }

  readJson<T>(path: string, fallback: T): T {
    const absolute = this.path(path)
    if (!existsSync(absolute)) return fallback
    return JSON.parse(readFileSync(absolute, "utf8")) as T
  }

  writeJson(path: string, value: unknown): void {
    const absolute = this.path(path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
  }

  readBinary(path: string): Uint8Array | null {
    const absolute = this.path(path)
    if (!existsSync(absolute)) return null
    return new Uint8Array(readFileSync(absolute))
  }

  writeBinary(path: string, value: Uint8Array): void {
    const absolute = this.path(path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, value)
  }

  deviceIndexPath(deviceID: string): string {
    return `devices/${deviceID}.json`
  }

  readDeviceIndex(deviceID: string): DeviceIndex {
    return this.readJson<DeviceIndex>(this.deviceIndexPath(deviceID), {
      schemaVersion: 1,
      deviceID,
      updatedAt: 0,
      sessions: {},
    })
  }

  writeDeviceIndex(index: DeviceIndex): void {
    this.writeJson(this.deviceIndexPath(index.deviceID), index)
  }

  listDeviceIndexes(): DeviceIndex[] {
    const directory = this.path("devices")
    if (!existsSync(directory)) return []
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as DeviceIndex)
  }

  revisionPath(revision: string): string {
    return `revisions/${revision}.json`
  }

  readRevision(revision: string): RevisionRecord | null {
    return this.readJson<RevisionRecord | null>(this.revisionPath(revision), null)
  }

  writeRevision(record: RevisionRecord): void {
    this.writeJson(this.revisionPath(record.revision), record)
  }

  projectDirectory(project: string): string {
    return `projects/${Buffer.from(project, "utf8").toString("base64url")}`
  }

  blobPath(project: string, sessionID: string, revision: string): string {
    return `${this.projectDirectory(project)}/sessions/${sessionID}/${revision}.json.gz.enc`
  }

  readBlob(project: string, sessionID: string, revision: string): Uint8Array | null {
    return this.readBinary(this.blobPath(project, sessionID, revision))
  }

  writeBlob(project: string, sessionID: string, revision: string, payload: Uint8Array): string {
    const path = this.blobPath(project, sessionID, revision)
    this.writeBinary(path, payload)
    return path
  }
}
