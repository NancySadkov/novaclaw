import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * 🔴 **AN EFFECT THAT WRITES THE STORE IT READS RE-ENTERS ITSELF, AND DIES.**
 *
 * Measured on the owner's machine, 2026-09-29, through a scripted click rather than a report:
 * clicking an officer in the roster who had no tab yet threw
 * `RangeError: Maximum call stack size exceeded`, twice, deterministically. The stack was entirely
 * Solid's scheduler —
 *
 *     at runUpdates (…)        at completeUpdates (…)      at runUpdates (…)  …
 *
 * — with no application frame anywhere in it, which is what pointed at the framework's own
 * update loop rather than at any single computation.
 *
 * The mechanism is structural. `titlebar.tsx`'s route effect READS the tab store (via `currentTab()`)
 * and then WROTE it with `addSessionTab`. In Solid a write inside an effect marks that same effect
 * dirty; `completeUpdates` runs the queue before the first frame returns; the pair recurses until the
 * stack is exhausted. So the fault belongs to the SHAPE — a reader that writes what it reads — not to
 * the one line that happened to do the writing.
 *
 * The controlled test that located it, and the reason this file asserts what it does: re-clicking an
 * officer who ALREADY had a tab threw nothing, while opening one that did not threw every time. The
 * only unguarded write on that path is `addSessionTab` — `remember` and `clearRemoved` both no-op
 * when the value is unchanged — which is exactly the asymmetry the symptom showed.
 */
const TITLEBAR = readFileSync(path.resolve(import.meta.dir, "titlebar.tsx"), "utf8")

/** Prose quotes the defect it describes, so structural assertions read code, not comments. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

/** The body of the route-reconciliation effect, from its declaration to its close. */
function reconciliationEffect(): string {
  const start = code(TITLEBAR).indexOf("createEffect(() => {\n          const route = layout.route()")
  expect(start, "the route-reconciliation effect has moved — re-derive this anchor").toBeGreaterThan(0)
  return code(TITLEBAR).slice(start, start + 4000)
}

describe("the route→tab reconciliation cannot re-enter itself", () => {
  test("🔴 every addSessionTab in the effect is preceded by a one-shot guard", () => {
    // The invariant, stated as the code must satisfy it: a write that this effect performs on the
    // store it reads may only happen once per route. A new unguarded write is the whole bug again.
    const body = reconciliationEffect()
    const writes = [...body.matchAll(/addSessionTab\(/g)]
    expect(writes.length, "no addSessionTab found in the effect — re-derive this anchor").toBeGreaterThan(0)
    for (const write of writes) {
      const before = body.slice(0, write.index)
      expect(
        before,
        "an addSessionTab is not guarded by the one-shot check, so the effect re-enters itself",
      ).toMatch(/if \(seenRoutes\.has\([A-Za-z]+\)\) return\s*\n\s*seenRoutes\.add\(/)
    }
  })

  test("the guard set is declared, and it is per-route rather than a single boolean", () => {
    // A bare `let done = false` would stop the recursion and also stop the app from ever opening a
    // second colleague's tab. The key has to carry the route, so a DIFFERENT officer still reconciles.
    const body = reconciliationEffect()
    expect(body).toContain("seenRoutes")
    const keys = [...body.matchAll(/const (\w+Key) = `(agent|session):\$\{/g)].map((m) => m[2])
    expect(new Set(keys), "both the officer and the session branch must be guarded").toEqual(
      new Set(["agent", "session"]),
    )
  })

  test("the guard is checked BEFORE the write, never after", () => {
    // Ordering is the fix: checking afterwards cannot undo a write that already re-triggered the
    // effect. This asserts the order directly rather than trusting that it "looks" right.
    const body = reconciliationEffect()
    for (const write of body.matchAll(/addSessionTab\(/g)) {
      const before = body.slice(0, write.index)
      const lastCheck = before.lastIndexOf("if (seenRoutes.has(")
      const lastAdd = before.lastIndexOf("seenRoutes.add(")
      expect(lastCheck, "the guard must exist before the write").toBeGreaterThan(-1)
      expect(lastAdd, "the guard must record the route before the write").toBeGreaterThan(-1)
      expect(lastCheck, "the check must come before the add").toBeLessThan(lastAdd)
      expect(lastAdd, "the record must come before the write").toBeLessThan(write.index)
    }
  })

  test("the other writers on this path stay guarded by VALUE, so they no-op when nothing changed", () => {
    // `remember` and `clearRemoved` are the same shape of hazard and are safe only because they
    // compare first. If one loses its comparison the cycle returns through a different door, and
    // this is the assertion that says so.
    const tabs = readFileSync(path.resolve(import.meta.dir, "..", "context", "tabs.tsx"), "utf8")
    const src = code(tabs)
    expect(src, "remember must compare before writing, or it re-triggers its own reader").toMatch(
      /remember\(tab: Tab\) \{[^}]*if \(recentKey\(\) !== key\) setRecentKey\(key\)/,
    )
  })
})
