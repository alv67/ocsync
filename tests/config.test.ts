import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError, loadConfig, loadOrCreateDeviceID } from "../src/core/config.js"

describe("config", () => {
  test("loads defaults and JSONC comments", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocsync-config-"))
    const previousState = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = join(directory, "state")
    try {
      const path = join(directory, "config.jsonc")
      writeFileSync(
        path,
        `{
          // Private data repository
          "remote": "git@github.com:acme/ocsync-data.git",
          "device": "dev_test"
        }`,
      )
      const config = loadConfig(path)
      expect(config.remote).toBe("git@github.com:acme/ocsync-data.git")
      expect(config.branch).toBe("main")
      expect(config.device).toBe("dev_test")
      expect(config.pullIntervalSec).toBe(120)
      expect(config.pushDebounceSec).toBe(30)
      expect(config.maxSessionBytes).toBe(20 * 1024 * 1024)
    } finally {
      restoreState(previousState)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("creates and reuses a device identifier", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocsync-device-"))
    const previousState = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = directory
    try {
      const first = loadOrCreateDeviceID()
      const second = loadOrCreateDeviceID()
      expect(first).toBe(second)
      expect(first).toStartWith("dev_")
    } finally {
      restoreState(previousState)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects an empty remote", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocsync-config-"))
    try {
      const path = join(directory, "config.json")
      writeFileSync(path, '{"remote": ""}')
      expect(() => loadConfig(path)).toThrow(ConfigError)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects a missing file", () => {
    expect(() => loadConfig(join(tmpdir(), "ocsync-missing-config.json"))).toThrow(ConfigError)
  })
})

function restoreState(previous: string | undefined): void {
  if (previous === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = previous
}
