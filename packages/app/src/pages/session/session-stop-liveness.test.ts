import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 The composer Stop control must track VISIBLE activity, not only bookkeeping (owner,
 * 2026-09-26: Stop clicks ignored while Daedalus was visibly streaming in the packaged app;
 * Esc stopped it seconds later on the same tab — and Esc only aborts while `working()`).
 *
 * `working()` read only `session_status` (streamed events) and the execution attempt (2 s poll).
 * Both can lag the activity they record; a click landing in that lag reads `false`, shows Send,
 * and goes to the send path instead of stopping. The working computation therefore also samples
 * the live-rate feed — direct observation of generation within its window — so a visibly
 * streaming agent is stoppable even when its rows disagree.
 *
 * ⚠️ Source-reading, like its sibling `prompt-input-stop-wiring.test.ts`: the session page needs
 * the full app context to mount, and the failure is a WIRING one.
 */
const source = () =>
  readFileSync(join(import.meta.dir, "..", "..", "pages", "session.tsx"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n")

describe("the session page working computation", () => {
  test("🔴 a recently-generating agent counts as working, however its rows read", () => {
    const text = source()
    expect(text).toContain("session_live(id)?.tps")
    // Bounded by the live-rate window (`tps > 0` decays to zero when quiet), so a missing
    // settle event cannot pin the control on Stop forever.
    expect(text).toContain("> 0")
  })

  test("🔴 the bookkeeping predicate still decides the settled cases", () => {
    // Liveness is OR-ed onto the durable answer, never a replacement for it: an idle session
    // with no recent generation must still read idle.
    expect(source()).toContain("isSessionWorking(sync().data.session_status[id], attempt)")
  })
})
