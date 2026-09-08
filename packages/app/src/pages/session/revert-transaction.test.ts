import { expect, test } from "bun:test"
import { runPromptRollbackMutation } from "./revert-transaction"

test("a failed optimistic rollback restores both session state and the captured prompt", async () => {
  let prompt = ["before"]
  let boundary = "before"
  let failure: unknown
  const error = new Error("stage failed")

  await runPromptRollbackMutation({
    capturePrompt: () => ({
      current: () => prompt,
      set: (value) => {
        prompt = value
      },
      reset: () => {},
    }),
    optimistic: (capture) => {
      boundary = "after"
      capture.set(["after"])
    },
    request: () => Promise.reject(error),
    complete: () => {},
    rollback: () => {
      boundary = "before"
    },
    fail: (value) => {
      failure = value
    },
  })

  expect(prompt).toEqual(["before"])
  expect(boundary).toBe("before")
  expect(failure).toBe(error)
})
