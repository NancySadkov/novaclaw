import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "@novaclaw/core/test/source-scan"

/**
 * 🔴 `packages/novaclaw/src/permission/` IS NOT THE PERMISSION GATE, and this is what makes that
 * sentence checkable instead of aspirational.
 *
 * The module's own header says it: the live gate is `packages/core/src/permission.ts`, a different
 * module with the same name, and what lives here is only the ruleset ALGEBRA. That is structurally
 * true — `packages/core` cannot import `packages/novaclaw`, so the live evaluator never sees a rule
 * written into an `Agent.Info.permission` — but a structural truth nobody measures is how three
 * inert permission keys survived in the config vocabulary until 2026-09-04 (`doom_loop`,
 * `question`, `external_directory`).
 *
 * The cost of not measuring it was not the dead rules. It was that a finding described
 * `external_directory` as governing a LIVE path and deferred its own fix for a measurement that was
 * never needed, because the rules it worried about could not fire. So the thing to pin is the
 * CLAIM — who reads this island, and which actions they spend — not any particular verdict.
 *
 * ⚠️ A SOURCE scan, deliberately, matching `core/test/permission-actions.test.ts`: the alternative is
 * building the whole instance layer to observe two function calls.
 */
const ROOT = path.resolve(import.meta.dir, "..")

const read = (file: string) => stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"))

/** Every file that imports the island's algebra, found by walking `src` rather than by memory. */
const importers = (() => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const source = read(rel)
        // `@/permission`, `../permission`, `./permission` — never `@/permission/…` deeper, and never
        // `@novaclaw/core/…`, which is the OTHER module this exists to keep separate.
        if (/from\s+"(?:@\/|\.{1,2}\/)permission"/.test(source)) found.push(rel)
      }
    }
  }
  walk("src")
  return found.sort()
})()

/** Every action spent against a ruleset built by this island. */
const spent = new Set(
  importers
    .filter((file) => file !== "src/agent/agent.ts")
    .flatMap((file) => [...read(file).matchAll(/evaluate\(\s*"([a-zA-Z_.\-]+)"/g)].map((match) => match[1]!)),
)

describe("the legacy permission island", () => {
  test("the scan is real — it finds the island and its importers", () => {
    // Non-vacuity: a scan that found nothing would make both assertions below pass forever.
    expect(fs.existsSync(path.join(ROOT, "src/permission/index.ts"))).toBe(true)
    expect(importers.length).toBeGreaterThan(0)
    expect(importers).toContain("src/agent/agent.ts")
  })

  test("🔴 exactly three files touch it: the one that BUILDS and the two that SPEND", () => {
    expect(
      importers,
      "a fourth reader of the legacy ruleset — either it wants the live gate (core/src/permission.ts), " +
        "or this island grew a consumer and its comment, agent.ts's seam note and this test all need updating",
    ).toEqual(["src/agent/agent.ts", "src/skill/index.ts", "src/tool/truncate.ts"])
  })

  test("🔴 the ruleset answers exactly two actions", () => {
    // Everything else `agent/agent.ts` writes is decoration. When this list grows, the seam note in
    // `agent/agent.ts` ("only `*`, `skill` and `task` are ever read out of this ruleset") has become
    // false, and a reader who trusts it will file another finding about a path that is not live.
    expect([...spent].sort(), "the island's spent actions changed").toEqual(["skill", "task"])
  })
})
