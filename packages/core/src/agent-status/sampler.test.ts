import { describe, expect, test } from "bun:test"
import { lifecycleSession, shellCall } from "./sampler"

describe("agent lifecycle sampler routing", () => {
  test("samples prompts, compactions, and terminal states", () => {
    expect(lifecycleSession({ type: "session.next.prompted", data: { sessionID: "s" } })).toBe("s")
    expect(lifecycleSession({ type: "session.next.compaction.ended", data: { sessionID: "s" } })).toBe("s")
    expect(lifecycleSession({ type: "session.status", data: { sessionID: "s", status: { type: "idle" } } })).toBe("s")
    expect(lifecycleSession({ type: "session.status", data: { sessionID: "s", status: { type: "exited" } } })).toBe("s")
  })

  test("does not spend a label on intermediate or unrelated events", () => {
    expect(lifecycleSession({ type: "session.status", data: { sessionID: "s", status: { type: "busy" } } })).toBe(
      undefined,
    )
    expect(lifecycleSession({ type: "session.next.delta", data: { sessionID: "s" } })).toBe(undefined)
    expect(lifecycleSession({ type: "session.next.prompted", data: {} })).toBe(undefined)
  })

  test("routes only complete bash calls to the parallel command labeller", () => {
    expect(
      shellCall({
        type: "session.next.tool.called",
        data: {
          sessionID: "s",
          assistantMessageID: "m",
          callID: "c",
          tool: "bash",
          input: { command: "bun test" },
        },
      }),
    ).toEqual({
      sessionID: "s",
      assistantMessageID: "m",
      callID: "c",
      command: "bun test",
    })
    expect(shellCall({ type: "session.next.tool.called", data: { tool: "read" } })).toBeUndefined()
  })
})
