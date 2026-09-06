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

describe("silent-finish completion audit", () => {
  test("uses recent real requests and excludes harness steers", () => {
    const evidence = FinishAudit.excerpt([
      user("old task"),
      user(applySteerProvenance("automated redirect")),
      user("current task"),
      assistant([{ type: "text", id: "text", text: "I verified it" }]),
      assistant([]),
    ])
    expect(evidence).toContain("old task")
    expect(evidence).toContain("current task")
    expect(evidence).not.toContain("automated redirect")
    expect(evidence).toContain("latest agent turn then ended with no text")
  })

  test("maps an affirmative audit to a reply nudge", () => {
    expect(FinishAudit.verdict("YES")).toBe("yes")
    expect(FinishAudit.nudge("yes")).toContain("final user-facing response")
    expect(FinishAudit.nudge("yes")).toContain("Do not call another tool")
  })

  test("maps an incomplete audit to continued work", () => {
    expect(FinishAudit.verdict("No — one check remains")).toBe("no")
    expect(FinishAudit.nudge("no")).toContain("Continue now")
    expect(FinishAudit.nudge("no")).toContain("one concrete")
  })

  test("an unusable judge reply is not mistaken for completion", () => {
    expect(FinishAudit.verdict(" ")).toBe("unknown")
    expect(FinishAudit.verdict("perhaps")).toBe("unknown")
    expect(FinishAudit.nudge("unknown")).toContain("Re-check")
  })
})
