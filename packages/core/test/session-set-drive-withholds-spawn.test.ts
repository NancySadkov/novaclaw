import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SpawnTool } from "@novaclaw/core/tool/spawn"
import { UnfinishedSet } from "@novaclaw/core/session/runner/unfinished-set"

/**
 * `spawn` is not offered while the harness is driving a set.
 *
 * 🔴 Measured over nine runs of one 400-icon prompt, 2026-08-20:
 *
 *   · no spawn  → 100 files in ~7 minutes
 *   · spawn ×2  →  83 files in ~58 minutes, including 600 s where NEITHER parent nor child emitted
 *                  a single event
 *   · spawn ×2  →  31 files, one 460 s stall
 *   · spawn ×1  →   7 files, the child unadmitted for 581 s
 *
 * Not one delegated run beat the undelegated one. The reason is structural rather than incidental:
 * when the request asks for a set the HARNESS is the controller — it enumerates the folder, names the
 * next batch, counts coverage and decides when the work is done. A sub-agent is a second controller
 * over the same set, holding coverage the parent cannot see behind a join the parent blocks on.
 *
 * ⚠️ Mechanical, because the informational version did not convert. The fan-out advice was rewritten
 * the same day to key on image SIZE and to say small images should not be delegated — and the model
 * kept spawning. Third informational lever in this area to fail; the tool list is the one that
 * decides.
 */

describe("the withholding is scoped to a set request", () => {
  test("the predicate is the SAME one the drive uses, so the two cannot disagree", () => {
    // ⭐ If the tool list and the drive read the request differently, a session could be denied
    // `spawn` while nothing steers it — the worst of both. One predicate, one answer.
    expect(UnfinishedSet.asksForSet("Describe each of the 400 png files in this folder.")).toBe(true)
    expect(UnfinishedSet.asksForSet("Look at every png in this folder")).toBe(true)
    expect(UnfinishedSet.asksForSet("read them all")).toBe(true)
  })

  test("an ordinary request is untouched — spawn stays available", () => {
    // The narrowness IS the safety. Delegation is a real capability and this must not become a
    // general ban on it.
    expect(UnfinishedSet.asksForSet("what is in icon_004.png?")).toBe(false)
    expect(UnfinishedSet.asksForSet("refactor the auth module and run the tests")).toBe(false)
    expect(UnfinishedSet.asksForSet("describe this glyph")).toBe(false)
  })
})

describe("the runner actually applies it", () => {
  test("materialization filters spawn on a set request", () => {
    // A source pin, for the same reason as the scheduler's: the real call site needs a live model,
    // registry and stream. What is asserted is the WIRING — that the filter names the spawn tool and
    // is gated on the set predicate — not the phrasing around it.
    const source = fs.readFileSync(path.join(import.meta.dir, "../src/session/runner/llm.ts"), "utf8")
    expect(source).toContain("drivingASet")
    expect(source).toContain("!(drivingASet && name === SpawnTool.name)")
    // Gated on the shared predicate rather than a second, drifting copy of the rule.
    expect(source).toContain("const drivingASet = UnfinishedSet.asksForSet(")
  })

  test("it withholds by the tool's OWN name, so a rename cannot silently disable it", () => {
    // 🔴 A string literal "spawn" here would keep compiling and quietly stop matching the day the
    // tool is renamed — the failure mode `session-system-compose.test.ts` already pins for the
    // runner's other spawn reference.
    expect(SpawnTool.name).toBe("spawn")
  })
})
