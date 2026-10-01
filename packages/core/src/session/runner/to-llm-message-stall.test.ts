import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "../message"
import { toLLMMessages } from "./to-llm-message"

test("an unanswered-message reminder reaches the model as a nudge tool result", () => {
  const reminder = SessionMessage.Synthetic.make({
    id: SessionMessage.ID.make("msg_stall_aris_theron"),
    sessionID: "ses_aris" as never,
    type: "synthetic",
    text: "The message to theron is still unanswered.",
    time: { created: DateTime.makeUnsafe(1) },
  })
  const lowered = toLLMMessages([reminder], { id: "qwen", providerID: "local" } as never)
  expect(lowered.map((message) => message.role)).toEqual(["assistant", "tool"])
  expect(JSON.stringify(lowered)).toContain("The message to theron is still unanswered.")
  expect(JSON.stringify(lowered)).not.toContain("[Automated NovaClaw check")
})
