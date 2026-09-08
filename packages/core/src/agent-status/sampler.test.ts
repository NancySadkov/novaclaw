import { describe, expect, test } from "bun:test"
import { lifecycleSession, shellCall, workerCall } from "./sampler"

const source = await Bun.file(new URL("./sampler.ts", import.meta.url)).text()

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

  test("routes only complete spawn calls to the parallel worker labeller", () => {
    expect(
      workerCall({
        type: "session.next.tool.called",
        data: {
          sessionID: "s",
          assistantMessageID: "m",
          callID: "c",
          tool: "spawn",
          input: { prompt: "Audit the battle scene" },
        },
      }),
    ).toEqual({
      sessionID: "s",
      assistantMessageID: "m",
      callID: "c",
      prompt: "Audit the battle scene",
    })
    expect(
      workerCall({
        type: "session.next.tool.called",
        data: {
          sessionID: "s",
          assistantMessageID: "m",
          callID: "legacy",
          tool: "task",
          input: { description: "Review the legacy worker path" },
        },
      })?.prompt,
    ).toBe("Review the legacy worker path")
    expect(workerCall({ type: "session.next.tool.called", data: { tool: "read" } })).toBeUndefined()
  })

  test("presentation labels are detached and receive only their own tool input", () => {
    expect(source).toContain("fork(routeSample(sessionID, ++lifecycleRevision))")
    expect(source).toContain("fork(labelTool(presentation))")
    expect(source).toContain("text: command.command")
    expect(source).toContain("text: worker.prompt")
    expect(source).not.toContain("text: yield* store.context")
  })
})
