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

test("a stopped session settles the durable rows of jobs whose process died with it", () => {
  // 🔴 Owner report 2026-09-22: clearing a chat killed the worker, so the background job's own
  // finalizer never ran and its row stayed `running` forever — the commands list showed a phantom
  // and the manual stop was a silent no-op. The interrupt path must settle each visited session's
  // rows, and a stop with no live worker must settle rather than do nothing.
  const execution = readFileSync(fileURLToPath(new URL("./execution.ts", import.meta.url)), "utf8")
  expect(execution).toContain("yield* BashJobs.interruptSessions(database.db, [String(sessionID)])")
  expect(execution).toContain("return (yield* BashJobs.interruptSessions(database.db, [String(sessionID)])) > 0")
})

test("a drain refuses an archived session, so a late wake cannot resurrect it", () => {
  // Archiving stops the tree; a queued input, nudge or recovery adoption that arrives afterwards must
  // not start a drain for a chat the user can no longer see. Restoring unarchives and runs normally.
  const execution = readFileSync(fileURLToPath(new URL("./execution.ts", import.meta.url)), "utf8")
  expect(execution).toContain("if (stored.time?.archived !== undefined) return")
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
