import { describe, expect, test } from "bun:test"
import { waitRow } from "./wait-row"

const t = ((key: string) => ({ "ui.transcript.tool.wait": "Waiting for worker" })[key] ?? key) as never

describe("wait transcript row", () => {
  test("reuses the purpose of the spawn that returned the waited child id", () => {
    const messages = [
      {
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        content: [
          {
            id: "call",
            type: "tool",
            name: "spawn",
            time: { created: 1, completed: 2 },
            state: {
              status: "completed",
              input: { prompt: "A verbose prompt whose details stay folded" },
              structured: { childID: "ses_child" },
              content: [],
            },
            title: "Audit the battle scene",
          },
        ],
        time: { created: 1, completed: 2 },
      },
    ] as never
    expect(waitRow({ sessionID: "ses_child" }, messages, t)).toEqual({
      title: "Waiting for worker",
      subtitle: "Audit the battle scene",
    })
  })

  test("uses a short fallback while the generated spawn title is pending", () => {
    const messages = [
      {
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        content: [
          {
            id: "call",
            type: "tool",
            name: "spawn",
            time: { created: 1, completed: 2 },
            state: {
              status: "completed",
              input: { prompt: "Investigate the cursor jump and cover every delayed hydration race" },
              structured: { childID: "ses_child" },
              content: [],
            },
          },
        ],
        time: { created: 1, completed: 2 },
      },
    ] as never
    expect(waitRow({ sessionID: "ses_child" }, messages, t).subtitle).toBe("Investigate the cursor jump and")
  })

  test("falls back to the child id when no spawn row is available", () => {
    expect(waitRow({ sessionID: "ses_child" }, [], t)).toEqual({
      title: "Waiting for worker",
      subtitle: "ses_child",
    })
  })
})
