import { expect, test } from "bun:test"
import { fireStatusLabel } from "./calendar-status"

/**
 * 🔴 NC-REL-027 — "ran" was a claim the calendar could not support. `spawned` is set when the
 * spawner returns a session id, which happens after a coordinator wake and BEFORE the worker has
 * resolved the model or agent. A schedule pointing at a mistyped model reported "ran".
 *
 * A/B: put "ran" back and this fails.
 */
test("🔴 a coordinator wake is reported as started, never as ran", () => {
  expect(fireStatusLabel("spawned")).toBe("started")
  expect(fireStatusLabel("spawned")).not.toBe("ran")
})

test("the other two statuses say what they are", () => {
  expect(fireStatusLabel("skipped")).toBe("skipped")
  expect(fireStatusLabel("error")).toBe("error")
})

test("terminal session outcomes replace the admission wording", () => {
  expect(fireStatusLabel("spawned", "succeeded")).toBe("completed")
  expect(fireStatusLabel("spawned", "failed")).toBe("failed")
  expect(fireStatusLabel("spawned", "interrupted")).toBe("interrupted")
  expect(fireStatusLabel("spawned", "pending")).toBe("started")
})
