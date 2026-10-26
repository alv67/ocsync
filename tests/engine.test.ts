import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LoadedConfig } from "../src/core/config.js"
import { generateKey } from "../src/core/crypto.js"
import { type SyncAdapter, SyncEngine } from "../src/core/engine.js"
import { GitStore } from "../src/core/git-store.js"
import { projectKey } from "../src/core/project.js"
import type { SessionInfo, SessionSnapshot } from "../src/core/types.js"

class FakeAdapter implements SyncAdapter {
  readonly sessions = new Map<string, SessionSnapshot>()
  readonly active = new Set<string>()

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()].map((snapshot) => snapshot.info)
  }

  async exportSession(sessionID: string): Promise<SessionSnapshot> {
    const snapshot = this.sessions.get(sessionID)
    if (!snapshot) throw new Error(`missing session ${sessionID}`)
    return structuredClone(snapshot)
  }

  async importSession(snapshot: SessionSnapshot, directory: string): Promise<SessionInfo> {
    const copy = structuredClone(snapshot)
    copy.info = { ...copy.info, location: { ...copy.info.location, directory } }
    this.sessions.set(copy.info.id, copy)
    return copy.info
  }

  async deleteSession(sessionID: string): Promise<void> {
    this.sessions.delete(sessionID)
  }

  async activeSessions(): Promise<Set<string>> {
    return new Set(this.active)
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

function snapshot(id: string, directory: string, texts: string[], parentID?: string): SessionSnapshot {
  return {
    info: {
      id,
      ...(parentID ? { parentID } : {}),
      title: `Session ${id}`,
      time: { created: 1, updated: texts.length + 1 },
      location: { directory },
    },
    messages: texts.map((text, index) => ({
      id: `msg_${id}_${index}`,
      type: "user",
      text,
      time: { created: index + 1 },
    })),
  }
}

function config(remote: string, device: string, keyFile: string): LoadedConfig {
  return {
    remote,
    branch: "main",
    device,
    keyFile,
    projects: {},
    pullIntervalSec: 0,
    pushDebounceSec: 0,
    maxSessionBytes: 32 * 1024 * 1024,
    configPath: join(keyFile, "..", "config.jsonc"),
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ocsync-engine-"))
  const remote = join(root, "remote.git")
  git(root, ["init", "--bare", remote])

  const dirA = join(root, "machine-a")
  const dirB = join(root, "machine-b")
  for (const directory of [dirA, dirB]) {
    git(root, ["init", "-b", "main", directory])
    git(directory, ["remote", "add", "origin", "https://github.com/alv67/ocsync-test.git"])
  }

  const key = generateKey()
  const keyFile = join(root, "key")
  const adapterA = new FakeAdapter()
  const adapterB = new FakeAdapter()
  const storeA = new GitStore({ root: join(root, "store-a"), remote, branch: "main" })
  const storeB = new GitStore({ root: join(root, "store-b"), remote, branch: "main" })
  const project = projectKey(dirA)

  const engineA = new SyncEngine({
    config: config(remote, "dev_a", keyFile),
    store: storeA,
    adapter: adapterA,
    projectKey: project,
    projectDirectory: dirA,
    key,
  })
  const engineB = new SyncEngine({
    config: config(remote, "dev_b", keyFile),
    store: storeB,
    adapter: adapterB,
    projectKey: project,
    projectDirectory: dirB,
    key,
  })

  return { root, remote, dirA, dirB, adapterA, adapterB, storeA, storeB, engineA, engineB }
}

describe("sync engine", () => {
  test("pushes a session and pulls it on the other device", async () => {
    const context = setup()
    try {
      context.adapterA.sessions.set("ses_one", snapshot("ses_one", context.dirA, ["hello"]))

      const push = await context.engineA.push()
      expect(push.pushed).toEqual(["ses_one"])

      const pull = await context.engineB.pull()
      expect(pull.pulled).toEqual(["ses_one"])
      expect(pull.conflicts).toHaveLength(0)

      const imported = context.adapterB.sessions.get("ses_one")
      expect(imported?.messages.map((message) => message.text)).toEqual(["hello"])
      expect(imported?.info.location.directory).toBe(context.dirB)
    } finally {
      rmSync(context.root, { recursive: true, force: true })
    }
  })

  test("fast-forwards a session changed on the other device", async () => {
    const context = setup()
    try {
      context.adapterA.sessions.set("ses_one", snapshot("ses_one", context.dirA, ["hello"]))
      await context.engineA.push()
      await context.engineB.pull()

      const onB = context.adapterB.sessions.get("ses_one")
      onB?.messages.push({ id: "msg_second", type: "user", text: "from B", time: { created: 9 } })

      await context.engineB.push()
      const pull = await context.engineA.pull()

      expect(pull.pulled).toEqual(["ses_one"])
      expect(context.adapterA.sessions.get("ses_one")?.messages.map((message) => message.text)).toEqual([
        "hello",
        "from B",
      ])
    } finally {
      rmSync(context.root, { recursive: true, force: true })
    }
  })

  test("detects concurrent edits without overwriting either side", async () => {
    const context = setup()
    try {
      context.adapterA.sessions.set("ses_one", snapshot("ses_one", context.dirA, ["hello"]))
      await context.engineA.push()
      await context.engineB.pull()

      const onA = context.adapterA.sessions.get("ses_one")
      onA?.messages.push({ id: "msg_a", type: "user", text: "from A", time: { created: 10 } })
      const onB = context.adapterB.sessions.get("ses_one")
      onB?.messages.push({ id: "msg_b", type: "user", text: "from B", time: { created: 11 } })

      await context.engineA.push()
      const pull = await context.engineB.pull()

      expect(pull.conflicts).toHaveLength(1)
      expect(pull.conflicts[0]?.id).toBe("ses_one")
      expect(context.adapterB.sessions.get("ses_one")?.messages.map((message) => message.text)).toEqual([
        "hello",
        "from B",
      ])
    } finally {
      rmSync(context.root, { recursive: true, force: true })
    }
  })

  test("skips active sessions", async () => {
    const context = setup()
    try {
      context.adapterA.sessions.set("ses_one", snapshot("ses_one", context.dirA, ["hello"]))
      await context.engineA.push()
      await context.engineB.pull()

      const onA = context.adapterA.sessions.get("ses_one")
      onA?.messages.push({ id: "msg_a", type: "user", text: "from A", time: { created: 10 } })
      await context.engineA.push()

      context.adapterB.active.add("ses_one")
      const pull = await context.engineB.pull()

      expect(pull.pulled).toHaveLength(0)
      expect(pull.skipped.some((item) => item.reason.includes("active"))).toBe(true)
      expect(context.adapterB.sessions.get("ses_one")?.messages).toHaveLength(1)
    } finally {
      rmSync(context.root, { recursive: true, force: true })
    }
  })

  test("does not write anything in dry-run mode", async () => {
    const context = setup()
    try {
      context.adapterA.sessions.set("ses_one", snapshot("ses_one", context.dirA, ["hello"]))
      const result = await context.engineA.push({ dryRun: true })

      expect(result.pushed).toEqual(["ses_one"])
      expect(context.storeA.readDeviceIndex("dev_a").sessions.ses_one).toBeUndefined()
    } finally {
      rmSync(context.root, { recursive: true, force: true })
    }
  })

  test("skips child sessions until child sync is implemented", async () => {
    const context = setup()
    try {
      context.adapterA.sessions.set("ses_parent", snapshot("ses_parent", context.dirA, ["parent"]))
      context.adapterA.sessions.set("ses_child", snapshot("ses_child", context.dirA, ["child"], "ses_parent"))

      const result = await context.engineA.push()
      expect(result.pushed).toEqual(["ses_parent"])
      expect(result.skipped.some((item) => item.id === "ses_child")).toBe(true)
    } finally {
      rmSync(context.root, { recursive: true, force: true })
    }
  })
})
