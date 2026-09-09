import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  defaultMemoryLimitBytes,
  folderSubstitutedNotice,
  workerMemoryLimitBytes,
  workerRetryDelayMs,
} from "./execution"

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
  expect(workerMemoryLimitBytes("novaclaw-session-worker.js", 128 * gib)).toBe(2 * gib)
  expect(workerMemoryLimitBytes("session-worker-node.ts", 8 * gib)).toBe(3 * gib)
})

test("worker recovery starts at two seconds and doubles to a ten-minute ceiling", () => {
  expect([1, 2, 3, 4].map(workerRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000])
  expect(workerRetryDelayMs(20)).toBe(600_000)
  expect(workerRetryDelayMs(200)).toBe(600_000)
})

test("the folder-substitution notice names BOTH folders and says work continues", () => {
  // The `<env>` block tells the model where it now is; this tells the PERSON why it moved. A user
  // reading the chat would otherwise watch their working directory become `…/scratch/ses_…` with
  // nothing saying why — and the behaviour this replaced (isolating the session) did explain itself.
  const notice = folderSubstitutedNotice("D:\work\project", "C:\data\scratch\ses_1")
  // ⚠️ Both paths, because "your folder is gone" is only actionable if the reader knows WHICH one,
  // and "you are in a scratch folder" is only actionable if they know WHERE.
  expect(notice).toContain("D:\work\project")
  expect(notice).toContain("C:\data\scratch\ses_1")
  // It must not read as a failure: the session is still working, which is the whole point.
  expect(notice).toContain("Your work continues")
})
