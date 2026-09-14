import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const ordinary = readFileSync(new URL("../src/session/runner/llm.ts", import.meta.url), "utf8")
const strict = readFileSync(new URL("../src/session/runner/strict-drain.ts", import.meta.url), "utf8")

test("every autonomous action loop yields to queued user input at its first safe boundary", () => {
  expect(ordinary).toContain('const queuedAtBoundary = yield* SessionInput.hasPending(db, input.sessionID, "queue")')
  expect(ordinary).toContain('promotion = queuedAtBoundary ? "queue" : "steer"')

  expect(strict).toContain("const yieldToQueuedUser = Effect.gen(function* ()")
  expect(strict).toContain('SessionInput.hasPending(db, sessionID, "queue")')
  expect(strict).toContain("actionBoundary(publishAction(action))")
  expect(strict).toContain("actionBoundary(recordAction(i)(action))")
})
