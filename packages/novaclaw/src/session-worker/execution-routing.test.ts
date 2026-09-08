import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defaultMemoryLimitBytes, folderSubstitutedNotice, pausedNotice, workerMemoryLimitBytes } from "./execution"

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

test("paused sessions explain uncertainty and preserve selectable technical detail", () => {
  const uncertain = pausedNotice("outcome-unknown", "worker exited 42")
  expect(uncertain).toContain("did not replay")
  expect(uncertain).toContain("Inspect the target")
  expect(uncertain).toContain("Technical detail: worker exited 42")

  const repeated = pausedNotice("repeated-failure", "heartbeat timeout")
  expect(repeated).toContain("other chats are unaffected")
  expect(repeated).toContain("choose another model")
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
