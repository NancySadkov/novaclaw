import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { UnfinishedSet } from "@novaclaw/core/session/runner/unfinished-set"

/**
 * The set drive must decide WHAT WAS ASKED once, not re-read it from a shrinking context.
 *
 * 🔴 Measured 2026-08-20, run 11 — and it explains every run in this task. The drive steered three
 * times correctly (373 → 363 → 360 remaining), then reported:
 *
 *     session.finish.set.branch   session.set.asked: FALSE   session.set.calls: 41
 *
 * `calls` had been 48 a moment earlier. The session's events show **two compactions**. Compaction
 * summarises the history, the original prompt stops being a real user turn inside the window, and
 * `lastRealUserText(context)` stops returning it — so `asksForSet` answers false and the drive quietly
 * abandons a job with ~290 files left.
 *
 * ⚠️ **This was the ~100 ceiling.** Every run landed near 100 files no matter what else was fixed,
 * because compaction arrives at roughly the same conversation size each time. That pattern looked
 * exactly like model stamina, and it was not: the model kept working (196 read calls), the harness
 * stopped asking.
 *
 * The general defect: a FIXED property of the request was being re-derived every turn from a MUTABLE
 * source. `asksForSet` and `requestedLimit` describe the user's words, which do not change; the
 * window that holds them does.
 */

describe("what the request WAS cannot change while the drive runs", () => {
  const SET_PROMPT = "Describe each of the 400 png files in this folder."

  test("the prompt reads as a set request while it is still in the window", () => {
    expect(UnfinishedSet.asksForSet(SET_PROMPT)).toBe(true)
    expect(UnfinishedSet.requestedLimit(SET_PROMPT)).toBe(400)
  })

  test("and the SAME question answers false once compaction has taken it away", () => {
    // 🔴 This is the whole bug in one assertion. Nothing about the user's request changed; only the
    // text still visible did. Re-deriving here does not fail loudly — it returns a confident `false`.
    expect(UnfinishedSet.asksForSet("")).toBe(false)
    expect(UnfinishedSet.asksForSet("continue")).toBe(false)
    // …and the count is worse than false: an absent limit means "the whole folder", so a drive that
    // re-derived it after compaction would silently rescope the job rather than stop.
    expect(UnfinishedSet.requestedLimit("")).toBeUndefined()
  })
})

describe("the runner latches it", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dir, "../src/session/runner/llm.ts"),
    "utf8",
  )

  test("the decision is stored per SESSION, not in a drain local", () => {
    // 🔴 The first version of this fix used drain locals and did nothing. Run 12: one `set.branch`
    // for a 36-minute run, `asked: false`, `calls: 0`. Every steer admits a prompt and starts a NEW
    // drain with fresh locals — that run had three — so after compaction each new drain re-derived
    // from the compacted window and never latched. The lifetime has to outlive the drain.
    expect(source).toContain("const setRequests = new Map<string, { readonly asked: boolean; readonly limit?: number }>()")
    expect(source).toContain("const askedForSet = setRequest?.asked ?? false")
    expect(source).toContain("const requested = setRequest?.limit")
    // …and NOT the drain locals it replaced.
    expect(source).not.toContain("let setAsked: boolean | undefined")
  })

  test("it is written only when unset, so a shrinking window cannot overwrite it", () => {
    // ⭐ The load-bearing clause. Without the `has` guard the latch would be re-stamped every turn and
    // would inherit exactly the failure it exists to prevent.
    expect(source).toContain("if (!setRequests.has(input.sessionID) && realUserText !== undefined)")
  })

  test("it is keyed by session, so two sessions cannot inherit each other's request", () => {
    // A process-wide map with no key would let one session's "describe each" latch drive another's
    // unrelated turn — the same shape as the memory-recall contamination this project has hit before.
    expect(source).toContain("setRequests.set(input.sessionID,")
    expect(source).toContain("setRequests.get(input.sessionID)")
  })

  test("the DRIVE no longer re-derives either decision from the live context", () => {
    // 🔴 The regression that would restore the bug. Both of the drive's own reads are latched, so the
    // steering decision and the requested count survive compaction.
    expect(source).not.toContain("UnfinishedSet.requestedLimit(lastRealUserText(context)")
    // Exactly ONE `asksForSet` call still reads the live context: the spawn gate in the per-step
    // request builder, which cannot see the drain scope where the latch lives. Its failure mode is
    // benign — after compaction `spawn` becomes available again, which is what shipped before the
    // gate existed — but it IS the same defect and this pins the count so it cannot quietly grow.
    const inline = source.split("UnfinishedSet.asksForSet(lastRealUserText(context)").length - 1
    expect(inline).toBe(1)
  })
})
