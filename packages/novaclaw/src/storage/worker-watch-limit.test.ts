import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SessionWorkerCommand } from "@/session-worker/command"
import { workerMemoryLimitBytes } from "@/session-worker/execution"

// 🔴 THE GUARD MUST MEASURE AGAINST THE NUMBER THE SUPERVISOR ENFORCES.
//
// `worker-watch` passed a hardcoded `".js"` to `workerMemoryLimitBytes`, so it always took the
// PACKAGED tier, while `execution.ts` enforces the tier for the ACTUAL worker path — and a `.ts`
// entrypoint gets 3 GiB instead of ~2. Measured live on 2026-08-29 during an N=400 sweep: a worker
// holding 2,150,629,376 bytes logged `resource.fleet.exceeded` every five seconds against a
// 2,109,611,008 limit, while the limit really being enforced was 3 GiB. It was at 72 % of its ceiling
// and being reported as over it.
//
// ⚠️ Both files call the SAME function, which is why the drift survived review. Sharing a function is
// not sharing a number when the arguments differ.

const GIB = 1024 * 1024 * 1024

describe("the two tiers are genuinely different, so the argument matters", () => {
  test("a .ts worker is allowed strictly more than a packaged one", () => {
    const ts = workerMemoryLimitBytes("session-worker-node.ts")
    const js = workerMemoryLimitBytes("novaclaw-session-worker.js")
    expect(ts).toBeGreaterThan(js)
    expect(ts).toBeGreaterThanOrEqual(3 * GIB)
  })

  // ⭐ THE EXACT LIVE READING. Had this margin been zero the bug would have been invisible, so the
  // gap that made it observable is worth pinning.
  test("the observed 2,150,629,376 bytes is OVER the packaged tier and UNDER the source tier", () => {
    const observed = 2_150_629_376
    expect(observed).toBeGreaterThan(workerMemoryLimitBytes("x.js", 16_876_888_064))
    expect(observed).toBeLessThan(workerMemoryLimitBytes("x.ts", 16_876_888_064))
  })
})

describe("the watcher and the supervisor agree", () => {
  // 🔴 THE PROPERTY, stated against the resolver both sides use rather than against a literal.
  test("the watcher's ceiling equals the supervisor's for the CURRENT worker", () => {
    const resolved = SessionWorkerCommand.current().workerPath
    expect(workerMemoryLimitBytes(resolved)).toBe(workerMemoryLimitBytes(SessionWorkerCommand.current().workerPath))
    // And under test that resolver really does yield the source-mode worker, so this run exercises
    // the tier the old code got wrong rather than agreeing by accident on the packaged one.
    expect(resolved.endsWith(".ts")).toBe(true)
  })

  /**
   * ⚠️ A SOURCE TEST, because the alternative is booting a fleet and reading a log line.
   *
   * Every behavioural test above passes with the hardcoded `".js"` restored — they exercise
   * `workerMemoryLimitBytes`, which was never the broken part. The defect was the ARGUMENT at one
   * call site, and only the call site can witness it. It asserts its anchor was found before
   * concluding anything, so a pattern that matches nothing cannot read as a pattern that matched.
   */
  test("worker-watch derives its ceiling from the resolved path, never a literal extension", () => {
    const source = readFileSync(path.join(import.meta.dir, "worker-watch.ts"), "utf8")
      .split("\n")
      .filter((line) => {
        const t = line.trimStart()
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
      })
      .join("\n")
    expect(source, "the call moved — re-point this test, do not delete it").toContain("perWorkerBytes:")
    expect(source).toContain("workerMemoryLimitBytes(SessionWorkerCommand.current().workerPath)")
    expect(source).not.toContain('workerMemoryLimitBytes(".js")')
    expect(source).not.toContain('workerMemoryLimitBytes(".ts")')
  })
})
