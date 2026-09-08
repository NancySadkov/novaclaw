import { describe, expect, test } from "bun:test"
import { resetSessionModel, syncSessionModel, type SessionModelSeed } from "./session-model-helpers"

const seed = (input?: Partial<SessionModelSeed>): SessionModelSeed => ({
  sessionID: input?.sessionID ?? "session",
  agent: input?.agent ?? "build",
  model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
})

describe("syncSessionModel", () => {
  test("forwards the session model/agent seed to restore", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      seed({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    )

    expect(calls).toEqual([seed({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } })])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})
