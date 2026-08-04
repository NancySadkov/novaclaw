import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defaultMemoryLimitBytes, pausedNotice } from "./execution"

test("the production HTTP graph routes admitted drains through the worker executor", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../server/routes/instance/httpapi/server.ts", import.meta.url)),
    "utf8",
  )
  expect(source).toContain("Layer.provide(SessionExecutionWorker.defaultLayer)")
  expect(source).not.toContain("Layer.provide(SessionExecutionLocal.defaultLayer)")
})

test("worker memory ceiling scales by host tier and stays bounded", () => {
  const gib = 1024 ** 3
  expect(defaultMemoryLimitBytes(4 * gib)).toBe(768 * 1024 ** 2)
  expect(defaultMemoryLimitBytes(8 * gib)).toBe(1 * gib)
  expect(defaultMemoryLimitBytes(16 * gib)).toBe(2 * gib)
  expect(defaultMemoryLimitBytes(128 * gib)).toBe(2 * gib)
})

test("paused sessions explain uncertainty and preserve selectable technical detail", () => {
  const uncertain = pausedNotice("outcome-unknown", "worker exited 42")
  expect(uncertain).toContain("did not replay")
  expect(uncertain).toContain("Inspect the target")
  expect(uncertain).toContain("Technical detail: worker exited 42")

  const repeated = pausedNotice("repeated-failure", "heartbeat timeout")
  expect(repeated).toContain("other chats are unaffected")
  expect(repeated).toContain("choose another model")
})
