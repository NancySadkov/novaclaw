import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "../message"
import { interruptedChildIDs } from "./recovery-join"

const assistant = (name: string, status: "pending" | "running", input: unknown) =>
  ({
    type: "assistant",
    content: [{ type: "tool", name, state: { status, input } }],
  }) as unknown as SessionMessage.Message

describe("interrupted child joins", () => {
  test("recovers wait targets from both streamed JSON and dispatched input", () => {
    expect(
      interruptedChildIDs([
        assistant("wait", "pending", '{"sessionID":"ses_a"}'),
        assistant("wait", "running", { sessionID: "ses_b" }),
      ]),
    ).toEqual(["ses_a", "ses_b"])
  })

  test("ignores malformed, settled, and unrelated tool input", () => {
    expect(
      interruptedChildIDs([assistant("wait", "pending", "{"), assistant("spawn", "running", { sessionID: "ses_x" })]),
    ).toEqual([])
  })
})
