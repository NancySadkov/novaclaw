import { describe, expect, test } from "bun:test"
import { lifecycleSession, shellCall, toolLabelsEnabled, workerCall, workerSuccess, WorkerLabelPairs } from "./sampler"

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

  test("recognises only a settled spawn receipt with a child id", () => {
    expect(
      workerSuccess({
        type: "session.next.tool.success",
        data: { sessionID: "parent", callID: "call", structured: { childID: "child" } },
      }),
    ).toEqual({ sessionID: "parent", callID: "call", childID: "child" })
    expect(
      workerSuccess({ type: "session.next.tool.success", data: { sessionID: "parent", callID: "call", structured: {} } }),
    ).toBeUndefined()
    expect(
      workerSuccess({
        type: "session.next.tool.failed",
        data: { sessionID: "parent", callID: "call", structured: { childID: "child" } },
      }),
    ).toBeUndefined()
  })

  test("joins worker labels and child receipts in either order without cross-session collisions", () => {
    const pairs = new WorkerLabelPairs()
    expect(pairs.label("parent-a", "same-call", "Audit battle scene")).toBeUndefined()
    expect(pairs.child("parent-b", "same-call", "child-b")).toBeUndefined()
    expect(pairs.child("parent-a", "same-call", "child-a")).toEqual({
      childID: "child-a",
      title: "Audit battle scene",
    })
    expect(pairs.label("parent-b", "same-call", "Review combat pacing")).toEqual({
      childID: "child-b",
      title: "Review combat pacing",
    })
  })

  test("presentation labels are detached and receive only their own tool input", () => {
    expect(source).toContain("fork(routeSample(sessionID, ++lifecycleRevision))")
    expect(source).toContain("fork(labelTool(presentation))")
    expect(source).toContain("text: command.command")
    expect(source).toContain("text: worker.prompt")
    expect(source).not.toContain("text: yield* store.context")
  })
})

describe("per-agent tool-label opt-out", () => {
  test("absent means ON, and only an explicit false opts out", () => {
    expect(toolLabelsEnabled(undefined)).toBe(true)
    expect(toolLabelsEnabled({})).toBe(true)
    expect(toolLabelsEnabled({ toolLabels: undefined })).toBe(true)
    expect(toolLabelsEnabled({ toolLabels: true })).toBe(true)
    expect(toolLabelsEnabled({ toolLabels: false })).toBe(false)
  })

  test("the opt-out skips the model request, not merely its result", () => {
    // Skipping after `labeller.short` would still pay for the generation this is meant to avoid.
    const gate = source.indexOf("if (!toolLabelsEnabled(declared)) return")
    const request = source.indexOf('task: "tool-title"')
    expect(gate).toBeGreaterThan(-1)
    expect(request).toBeGreaterThan(gate)
  })
})
