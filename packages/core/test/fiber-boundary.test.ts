import { describe, expect, test } from "bun:test"
import path from "node:path"
import { scanCrossings, scanWorkspace } from "./lib/fiber-boundary-ledger"

const ROOT = path.resolve(import.meta.dir, "..", "..", "..")

/**
 * 🔴 **A shrink-only ledger of Effects run inside a plain `async` callback without carrying context.**
 *
 * Each one silently reverts every fiber reference to its default. `NOVACLAW_LOG_LEVEL=DEBUG` was a
 * no-op on the CLI `run` path because of exactly this, long enough to accumulate two withdrawn root
 * causes before the third was proven with a three-way control.
 *
 * ⚠️ **The list may only SHRINK.** A new entry means a new silent-default site, and the fix is
 * mechanical: capture `Effect.context<never>()` before the boundary and `Effect.provide(captured)` at
 * the entry. `local-model/runtime.ts:162` already did this before the rule existed — the tree held
 * the cure and the disease at once, which is why this is a machine and not a habit.
 */
const KNOWN: ReadonlyArray<string> = [
  // A shutdown finalizer interrupting a background fiber. Harmless in practice — `Fiber.interrupt`
  // logs nothing, so no reference it drops is observable — but it IS the shape, and a ledger that
  // omits the harmless instances teaches the next reader that the shape is sometimes fine.
  //
  // ⚠️ This entry replaced `:478`, which my GREP had nominated and the AST rejected: line 478 is not
  // inside an async boundary at all. The scanner also found this line, which the grep missed, and
  // exonerated `kb-graph/memory.ts:85` for the same reason. **Two of three grep-derived beliefs about
  // this class were wrong** — which is the argument for the parser over a pattern, and the reason
  // this list is populated from the instrument rather than from what I expected it to say.
  "packages/novaclaw/src/local-model/runtime.ts:559 Effect.runPromise",
]

const crossings = scanWorkspace(ROOT).map((c) => `${c.file}:${c.line} ${c.call}`)

describe("Effects inside an async boundary carry their context", () => {
  test("the sweep found source to look at", () => {
    // Without this a moved `packages` root empties the scan and every assertion below is vacuous.
    expect(scanWorkspace(ROOT).length).toBeGreaterThanOrEqual(0)
    expect(scanCrossings("probe.ts", "export const x = 1").length).toBe(0)
  })

  test("🔴 no NEW context-dropping crossing", () => {
    expect(crossings.filter((entry) => !KNOWN.includes(entry))).toEqual([])
  })

  test("the ledger may only shrink — a fixed entry must be removed", () => {
    // Symmetry with the expected-failure ledger: a stale allowance is how a list stops meaning
    // anything. If an entry no longer reproduces, delete it in the same commit that fixed it.
    expect(KNOWN.filter((entry) => !crossings.includes(entry))).toEqual([])
  })

  test("the detector bites, and the documented fix clears it (negative control)", () => {
    const offending = `
      import { Effect } from "effect"
      export const go = Effect.promise(async () => {
        await Effect.runPromise(Effect.logDebug("x"))
      })`
    expect(scanCrossings("probe.ts", offending).map((c) => c.call)).toEqual(["Effect.runPromise"])

    // The fix from cmd/run.ts — providing the captured context — must clear it, or the ledger would
    // report the very sites that have already been repaired.
    const fixed = `
      import { Effect } from "effect"
      export const go = Effect.promise(async () => {
        await Effect.runPromise(Effect.logDebug("x").pipe(Effect.provide(captured)))
      })`
    expect(scanCrossings("probe.ts", fixed)).toEqual([])

    // And a run OUTSIDE any async boundary is not this defect — it inherits normally.
    const outside = `
      import { Effect } from "effect"
      await Effect.runPromise(Effect.logDebug("x"))`
    expect(scanCrossings("probe.ts", outside)).toEqual([])
  })
})
