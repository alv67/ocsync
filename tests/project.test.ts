import { describe, expect, test } from "bun:test"
import { isPathWithin, normalizeRemote, ProjectKeyCache } from "../src/core/project.js"

describe("project keys", () => {
  test("normalizes common Git remotes", () => {
    expect(normalizeRemote("git@github.com:alv67/ocsync.git")).toBe("github.com/alv67/ocsync")
    expect(normalizeRemote("https://github.com/alv67/ocsync.git")).toBe("github.com/alv67/ocsync")
    expect(normalizeRemote("ssh://git@github.com/alv67/ocsync.git")).toBe("github.com/alv67/ocsync")
    expect(normalizeRemote("https://github.com/alv67/ocsync/")).toBe("github.com/alv67/ocsync")
  })

  test("maps local paths to a stable local key", () => {
    const first = normalizeRemote("/tmp/ocsync-project")
    const second = normalizeRemote("/tmp/ocsync-project/")

    expect(first).toBe(second)
    expect(first).toStartWith("local:")
  })

  test("caches project keys", () => {
    const cache = new ProjectKeyCache()
    const first = cache.get(process.cwd())
    const second = cache.get(process.cwd())

    expect(first).toBe(second)
  })

  test("recognizes nested paths", () => {
    expect(isPathWithin("/tmp/project/src", "/tmp/project")).toBe(true)
    expect(isPathWithin("/tmp/project-other", "/tmp/project")).toBe(false)
  })
})
