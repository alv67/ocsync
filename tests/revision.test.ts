import { describe, expect, test } from "bun:test"
import { chainRevision, revisionOf, sessionProjection } from "../src/core/revision.js"
import type { SessionSnapshot } from "../src/core/types.js"

function snapshot(overrides: Partial<SessionSnapshot["info"]> = {}): SessionSnapshot {
  return {
    info: {
      id: "ses_test",
      title: "Test session",
      time: { created: 1, updated: 2 },
      location: { directory: "/machine/a/project" },
      ...overrides,
    },
    messages: [
      {
        id: "msg_1",
        type: "user",
        text: "hello",
        time: { created: 2 },
      },
    ],
  }
}

describe("session revision", () => {
  test("ignores fields that change on import", () => {
    const left = snapshot()
    const right = snapshot({
      projectID: "project-local",
      location: { directory: "/machine/b/project" },
      time: { created: 1, updated: 99, viewed: 42 },
      revert: { files: [] },
      fork: { sessionID: "ses_parent", boundary: { type: "through", messageID: "msg_1" } },
    })

    expect(revisionOf(left)).toBe(revisionOf(right))
    expect(sessionProjection(left)).toEqual(sessionProjection(right))
  })

  test("changes when message content changes", () => {
    const left = snapshot()
    const right = snapshot()
    const first = right.messages[0]
    if (!first) throw new Error("fixture is missing its first message")
    right.messages = [{ ...first, text: "goodbye" }]

    expect(revisionOf(left)).not.toBe(revisionOf(right))
  })

  test("changes when message order changes", () => {
    const left = snapshot()
    left.messages.push({ id: "msg_2", type: "user", text: "second", time: { created: 3 } })
    const right = snapshot()
    right.messages.unshift({ id: "msg_2", type: "user", text: "second", time: { created: 3 } })

    expect(revisionOf(left)).not.toBe(revisionOf(right))
  })

  test("chains revisions through their parent", () => {
    const content = revisionOf(snapshot())
    const first = chainRevision(null, content)
    const second = chainRevision(first, content)

    expect(second).not.toBe(first)
    expect(chainRevision(null, content)).toBe(first)
  })
})
