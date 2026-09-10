import { describe, expect, test } from "bun:test"
import { FinishAudit } from "./finish-audit"
import { SessionMessage } from "../message"
import { applySteerProvenance } from "../steer-provenance"
import { DateTime } from "effect"
import { ProviderV2 } from "../../provider"
import { ModelV2 } from "../../model"

const user = (text: string): SessionMessage.Message => ({
  id: SessionMessage.ID.create(),
  type: "user",
  text,
  time: { created: DateTime.makeUnsafe(Date.now()) },
})

const assistant = (content: SessionMessage.Assistant["content"]): SessionMessage.Message => ({
  id: SessionMessage.ID.create(),
  type: "assistant",
  agent: "test",
  model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") },
  content,
  time: { created: DateTime.makeUnsafe(Date.now()), completed: DateTime.makeUnsafe(Date.now()) },
})

const exitPart = (input: unknown, status: "completed" | "error" = "completed") =>
  ({
    type: "tool",
    id: "exit-call",
    name: "exit",
    state:
      status === "completed"
        ? { status, input, output: "reviewing", structured: { completed: false } }
        : { status, input, error: "failed" },
  }) as unknown as SessionMessage.Assistant["content"][number]

describe("exit completion audit", () => {
  test("finds only a successfully executed exit on the newest assistant turn", () => {
    expect(FinishAudit.exitRequest([user("work"), assistant([exitPart({ result: "done" })])])).toEqual({
      result: "done",
    })
    expect(FinishAudit.exitRequest([assistant([exitPart(JSON.stringify({ result: "encoded" }))])])).toEqual({
      result: "encoded",
    })
    expect(FinishAudit.exitRequest([assistant([exitPart({ result: "no" }, "error")])])).toBeUndefined()
    expect(
      FinishAudit.exitRequest([
        assistant([exitPart({ result: "old" })]),
        assistant([{ type: "text", id: "t", text: "new" }]),
      ]),
    ).toBeUndefined()
  })

  test("uses recent real requests and excludes harness steers", () => {
    const evidence = FinishAudit.excerpt(
      [
        user("old task"),
        user(applySteerProvenance("automated redirect")),
        user("current task"),
        assistant([{ type: "text", id: "text", text: "I verified it" }]),
        assistant([exitPart({ result: "all requested work landed" })]),
      ],
      { result: "all requested work landed" },
    )
    expect(evidence).toContain("old task")
    expect(evidence).toContain("current task")
    expect(evidence).not.toContain("automated redirect")
    expect(evidence).toContain("explicitly requested exit")
    expect(evidence).toContain("all requested work landed")
  })

  test("accepts only an affirmative audit", () => {
    expect(FinishAudit.verdict("YES")).toBe("yes")
  })

  test("the sole completion steer is grounded in a rejected exit", () => {
    expect(FinishAudit.verdict("No — one check remains")).toBe("no")
    expect(FinishAudit.CONTINUE_NUDGE).toContain("exit request was reviewed")
    expect(FinishAudit.CONTINUE_NUDGE).toContain("Continue now")
    expect(FinishAudit.CONTINUE_NUDGE).toContain("one concrete")
  })

  test("an unusable judge reply is not mistaken for completion", () => {
    expect(FinishAudit.verdict(" ")).toBe("unknown")
    expect(FinishAudit.verdict("perhaps")).toBe("unknown")
  })
})
