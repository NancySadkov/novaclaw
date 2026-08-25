import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * THE PARKING, MADE SELF-INVALIDATING.
 *
 * `notes/named-agents.md` parks *"reuse the colleague-loop envelope on the P2P community path"* as
 * NOT URGENT. That was true and is still true, but the item recorded no way to CHECK it — it claimed
 * "three conditions" and listed none, so nobody, including a later me, could tell whether the parking
 * still held. A parking nobody can re-check is not parked, it is forgotten.
 *
 * 🔴 The reason it is not urgent, measured rather than asserted: **a colleague hand-off cannot cross
 * the P2P boundary today.** `ColleagueBound` is reachable only from the session layer, and no module
 * under `community/` reaches `ColleagueHandoff`. There is nothing on that path for the bound to
 * govern.
 *
 * So this test IS the re-open trigger. The day somebody wires a community module to the hand-off
 * seam, it fails — and the item stops being parked because the assumption under it stopped being
 * true, not because somebody remembered to look.
 */

const SRC = path.join(import.meta.dir, "..", "src")

const sourcesUnder = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourcesUnder(full))
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full)
  }
  return out
}

describe("the colleague bound and the community path", () => {
  const community = sourcesUnder(path.join(SRC, "community"))

  test("🔴 the scan sees real files — this is not vacuously green", () => {
    // A moved or renamed directory would empty the list and this file would pass forever while
    // checking nothing, which is the exact failure the ledgers elsewhere in this suite guard against.
    expect(community.length).toBeGreaterThan(5)
  })

  test("🔴 no community module reaches ColleagueHandoff or the loop bound", () => {
    // If this fails, the parking in `notes/named-agents.md` is void: a hand-off can now cross to
    // another user's instance, where `bound-enforcement-is-on-the-attackers-path` applies and the
    // hop path is untrusted (`schema/prompt.ts` says a peer strips or forges it for free).
    const offenders = community.filter((file) => {
      const source = fs.readFileSync(file, "utf8")
      return source.includes("ColleagueHandoff") || source.includes("ColleagueBound")
    })
    expect(offenders.map((file) => path.basename(file))).toEqual([])
  })

  test("⚠️ …and the bound itself stays inside the session layer", () => {
    // The other direction: the bound growing a consumer outside `session/` is the same trigger seen
    // from the other end.
    const outside = sourcesUnder(SRC)
      .filter((file) => !file.includes(`${path.sep}session${path.sep}`))
      .filter((file) => fs.readFileSync(file, "utf8").includes("ColleagueBound."))
    expect(outside.map((file) => path.basename(file))).toEqual([])
  })
})
