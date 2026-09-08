import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * The matcher and durable claim service have direct behavioural tests, but neither can prove the
 * runner emits the events they consume. This source ratchet is deliberately about reachability at
 * the orchestration seam; standing up a complete provider/tool/compaction drain for each event would
 * test far more machinery than the four calls below.
 */
test("the runner dispatches every Nudge event family and pressure is absent from ambient context", () => {
  const runner = readFileSync(new URL("../src/session/runner/llm.ts", import.meta.url), "utf8")
  const builtins = readFileSync(new URL("../src/system-context/builtins.ts", import.meta.url), "utf8")

  expect(runner, "the dispatcher moved — re-point this test rather than deleting the reachability check").toContain(
    'const deliverNudges = Effect.fn("SessionRunner.deliverNudges")',
  )
  expect(runner.match(/type: "compaction"/g)?.length).toBe(2)
  expect(runner).toContain('type: "tool"')
  expect(runner).toContain('type: "clock"')
  expect(runner).toContain('type: "resource"')
  expect(runner).toContain("resourcePressure.level()")
  expect(builtins).not.toContain("ResourcePressureContext")
})
