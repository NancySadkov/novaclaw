import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { SessionSchema } from "@novaclaw/core/session/schema"

test("deferred local messages coalesce into one eventual wake", async () => {
  const chatID = SessionSchema.ID.make("ses_deferred_test")
  let count = 0
  let done!: () => void
  const completed = new Promise<void>((resolve) => { done = resolve })
  const wake = () => Effect.sync(() => {
    count++
    done()
    return true
  })
  ColleagueHandoff.scheduleDeferredWake(chatID, wake, 10)
  ColleagueHandoff.scheduleDeferredWake(chatID, wake, 10)
  let timeout!: ReturnType<typeof setTimeout>
  try {
    await Promise.race([completed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("deferred wake timed out")), 1_000)
    })])
  } finally {
    clearTimeout(timeout)
  }
  expect(count).toBe(1)
})
