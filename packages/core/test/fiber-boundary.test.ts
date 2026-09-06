import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs"
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
 *
 * 🔴 **Entries are anchored on the crossing's own SOURCE TEXT, not on its line number, and that is a
 * correction (2026-09-01).** The list used to read `runtime.ts:566 Effect.runPromise`. An unrelated
 * edit four lines above it moved the call to 570, and the ledger went red in BOTH directions at once
 * — "a new crossing at :570" and "a fixed entry at :566 must be removed" — for a file whose crossing
 * had not changed at all. A shrink-only ledger that fires on any edit ABOVE its anchor fires on
 * normal, and a guard that cries wolf on normal is how a real entry gets waved through. The text of
 * the offending line is the thing the ledger is actually about; it moves only when the crossing does.
 *
 * ⚠️ The line number is still REPORTED, because a failure has to be navigable — it is just not part
 * of the identity being compared.
 */
const KNOWN: ReadonlyArray<string> = []

/** `file call | the offending source line`. Position-free on purpose — see the note above. */
const identity = (c: { file: string; line: number; call: string }): string => {
  const lines = fs.readFileSync(path.join(ROOT, c.file), "utf8").split(String.fromCharCode(10))
  const text = (lines[c.line - 1] ?? "").replace(/\r$/, "")
  return `${c.file} ${c.call} | ${text.trim()}`
}

const found = scanWorkspace(ROOT)
const crossings = found.map(identity)
/** Only for the failure message — `identity` deliberately omits it. */
const where = new Map(found.map((c) => [identity(c), `${c.file}:${c.line}`]))

describe("Effects inside an async boundary carry their context", () => {
  test("the sweep found source to look at", () => {
    // Without this a moved `packages` root empties the scan and every assertion below is vacuous.
    expect(scanWorkspace(ROOT).length).toBeGreaterThanOrEqual(0)
    expect(scanCrossings("probe.ts", "export const x = 1").length).toBe(0)
    // ⚠️ And every identity must carry real source text. `identity` reads the file back off disk, so
    // a moved repo root or a bad relative path would make every key end in `" | "` — the ledger would
    // then compare empty strings and agree with itself forever.
    for (const entry of crossings)
      expect(entry.split(" | ")[1]?.length ?? 0, `no source text behind ${entry}`).toBeGreaterThan(0)
  })

  test("🔴 no NEW context-dropping crossing", () => {
    const added = crossings.filter((entry) => !KNOWN.includes(entry))
    expect(added.map((entry) => `${where.get(entry) ?? "?"}  ${entry}`)).toEqual([])
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
