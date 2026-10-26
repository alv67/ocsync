import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitStore } from "../src/core/git-store.js"
import type { DeviceIndex } from "../src/core/types.js"

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

describe("GitStore", () => {
  test("creates a store, pushes, and reads it from a second clone", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocsync-store-"))
    const remote = join(directory, "remote.git")
    const firstRoot = join(directory, "first")
    const secondRoot = join(directory, "second")
    try {
      git(directory, ["init", "--bare", remote])
      const first = new GitStore({ root: firstRoot, remote, branch: "main" })
      first.ensure()

      const index: DeviceIndex = {
        schemaVersion: 1,
        deviceID: "dev_test",
        updatedAt: 1,
        sessions: {},
      }
      first.writeDeviceIndex(index)
      first.writeJson("revisions/abc.json", { revision: "abc" })
      first.commitAndPush("test: store")

      const second = new GitStore({ root: secondRoot, remote, branch: "main" })
      second.ensure()
      expect(second.readDeviceIndex("dev_test").deviceID).toBe("dev_test")
      expect(second.readJson<{ revision: string }>("revisions/abc.json", { revision: "" })).toEqual({ revision: "abc" })
      expect(second.listDeviceIndexes()).toHaveLength(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("keeps a single device index per device", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocsync-store-"))
    const remote = join(directory, "remote.git")
    const root = join(directory, "store")
    try {
      git(directory, ["init", "--bare", remote])
      const store = new GitStore({ root, remote })
      store.ensure()
      store.writeDeviceIndex({ schemaVersion: 1, deviceID: "dev_a", updatedAt: 1, sessions: {} })
      store.writeDeviceIndex({ schemaVersion: 1, deviceID: "dev_b", updatedAt: 2, sessions: {} })
      expect(
        store
          .listDeviceIndexes()
          .map((index) => index.deviceID)
          .sort(),
      ).toEqual(["dev_a", "dev_b"])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("writes JSON atomically and returns a fallback when missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocsync-store-"))
    const remote = join(directory, "remote.git")
    const root = join(directory, "store")
    try {
      git(directory, ["init", "--bare", remote])
      const store = new GitStore({ root, remote })
      store.ensure()
      expect(store.readJson<{ ok: boolean }>("missing.json", { ok: true })).toEqual({ ok: true })
      store.writeJson("nested/value.json", { value: 1 })
      expect(store.readJson<{ value: number }>("nested/value.json", { value: 0 })).toEqual({ value: 1 })
      writeFileSync(join(root, "nested", "value.json"), '{"value":2}')
      expect(store.readJson<{ value: number }>("nested/value.json", { value: 0 })).toEqual({ value: 2 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
