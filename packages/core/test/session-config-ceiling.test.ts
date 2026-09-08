import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { EFFECTIVE_CONFIG_DEFAULTS, stanceOf } from "@novaclaw/core/session/config-resolve"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { stripComments } from "./lib/source-scan"

/**
 * **An instance ceiling clamps down and never up.**
 *
 * The user's Memory switch is a PRIVACY choice, so nothing beneath it may grant what it withheld —
 * not a session, and not a `novaclaw.json` in a folder they cloned five minutes ago. It used to hold
 * only because all three readers ANDed `MemorySetting.memoryEnabled()` into their own expression; a
 * fourth reader would have been permissive by omission, silently, and "memory is off" would have
 * been true of the parts of the system that asked and false of the part that forgot.
 */

const SRC = path.resolve(import.meta.dir, "..", "src")

/** ⚠️ Comments first. A regex over raw source counts PROSE, and this file's own subject is discussed
 *  by name in two of the modules it scans. */

const walkDir = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walkDir(full)
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [full] : []
  })

/** Read ONCE, at module scope: a cold walk of the whole package outlives a test's default timeout. */
const SOURCES = walkDir(SRC).map((file) => ({
  rel: path.relative(SRC, file).replaceAll("\\", "/"),
  code: stripComments(fs.readFileSync(file, "utf8")),
}))

describe("the memory ceiling", () => {
  test("🔴 an explicit `true` beneath an off ceiling still resolves OFF", () => {
    // The attack this exists for: the chain says yes, the instance says no, and no is the answer.
    const asked = { ...EFFECTIVE_CONFIG_DEFAULTS, memory: true }
    expect(SessionEffectiveConfig.clampToCeilings(asked, { memory: false }).memory).toBe(false)
    expect(stanceOf("memory", SessionEffectiveConfig.clampToCeilings(asked, { memory: false }).memory)).toBe(false)
  })

  test("an absent stance beneath an off ceiling resolves OFF too", () => {
    // Absent means ON by the descriptor's fallback, so this is the case a clamp that only touched
    // explicit values would miss entirely — and it is the common one, since almost nobody sets it.
    const clamped = SessionEffectiveConfig.clampToCeilings(EFFECTIVE_CONFIG_DEFAULTS, { memory: false })
    expect(stanceOf("memory", clamped.memory)).toBe(false)
  })

  test("a raised ceiling changes nothing on its own — it is not a switch", () => {
    // The negative control. A ceiling permits; it never grants. With it up, an explicit `false`
    // stays false and an absent stance stays absent (so the descriptor's fallback still decides).
    const off = { ...EFFECTIVE_CONFIG_DEFAULTS, memory: false }
    expect(SessionEffectiveConfig.clampToCeilings(off, { memory: true }).memory).toBe(false)
    expect(SessionEffectiveConfig.clampToCeilings(EFFECTIVE_CONFIG_DEFAULTS, { memory: true }).memory).toBeUndefined()
  })

  test("the clamp runs on the RESOLVED config, not folded under the chain", () => {
    // ⚠️ A source claim, because the ordering is the property and no behavioural test can see it:
    // folding the ceiling into the defaults would put it BENEATH the chain, where an explicit `true`
    // climbs straight back over it — which is exactly the case the first test above forbids.
    // ⚠️ Pinned as NESTING, not as character offsets. The first version compared `indexOf` positions
    // of two formatting-specific literals, and both vanished when the entry point started walking the
    // chain itself and the call collapsed onto one line — it went red on a file whose ordering was
    // still correct. What this test is about is that the clamp WRAPS the resolve, so that is what it
    // reads.
    const source = fs.readFileSync(path.join(SRC, "session", "effective-config.ts"), "utf8")
    expect(source).toMatch(/ProjectDefaults\.fold\(/)
    // A project-file fault may strengthen the folded defaults before the chain walk, so pin the
    // intermediate layer's provenance as well as the nesting: clamp(resolve(guardedDefaults, …)).
    // The resolve is still the clamp ARGUMENT, so an explicit `true` cannot climb over the ceiling.
    expect(source).toMatch(/guardedDefaults\s*=\s*[^;]*folded\.defaults/)
    expect(source).toMatch(/clampToCeilings\(\s*resolve(SessionConfig|Config)\(\s*guardedDefaults/)
  })

  test("no reader re-applies the ceiling by hand", () => {
    // A reader ANDing `memoryEnabled()` back in is not wrong — it is a second copy of a rule that
    // now has one home, and the next one added will be the one that forgets.
    // Its own definition, its own caller, and the engine's capability gate — which asks a different
    // question (may a global engine work at all) and has no session to clamp. Both the explicit
    // KB and the separate world-model engine enforce that privacy switch on their maintenance loops.
    const allowed = new Set([
      "kb-graph/memory-setting.ts",
      "kb-graph/memory.ts",
      "kb-graph/world-memory.ts",
      "session/effective-config.ts",
    ])
    const offenders = SOURCES.filter(
      (item) => !allowed.has(item.rel) && /MemorySetting\.memoryEnabled\(/.test(item.code),
    ).map((item) => item.rel)
    expect({ offenders, fix: "the resolved config already carries the ceiling" }).toEqual({
      offenders: [],
      fix: expect.any(String),
    })
  })
})
