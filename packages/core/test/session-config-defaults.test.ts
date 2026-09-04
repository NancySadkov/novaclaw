import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  resolveConfig,
  SESSION_CONFIG_FIELD_KEYS,
  SESSION_CONFIG_FIELDS,
  stanceOf,
} from "@novaclaw/core/session/config-resolve"
import { stripComments } from "./lib/source-scan"

/**
 * **Every field's default is declared once, on the descriptor, and applied from there.**
 *
 * Before this, four defaults lived in `EFFECTIVE_CONFIG_DEFAULTS` and the rest lived at the readers
 * in three idioms — `x === true`, `x ?? true`, `x !== false`. Nothing connected them, so the answer
 * to *"what happens if nobody sets this?"* could only be got by finding every reader; two readers of
 * one field could disagree and no test would notice, because a tri-state that nobody sets is the
 * state every test is already in.
 *
 * ⚠️ The four kinds are not interchangeable and the distinction is what makes this checkable:
 * `base` is present in the resolved config, `stance` deliberately is NOT (its absence has to survive
 * so the introspection view can say "nobody set this"), and `instance`/`derived` say the answer
 * lives somewhere else entirely.
 */

/** `packages/core/test` → `packages/core/src`. */
const SRC = path.resolve(import.meta.dir, "..", "src")

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) return []
    return [full]
  })

const keysOf = <T extends object>(value: T) => Object.keys(value).sort()

describe("a default can be read off the descriptor", () => {
  test("every field declares a fallback", () => {
    const missing = SESSION_CONFIG_FIELD_KEYS.filter((key) => SESSION_CONFIG_FIELDS[key].fallback === undefined)
    expect(missing.map(String)).toEqual([])
  })

  test("EFFECTIVE_CONFIG_DEFAULTS is exactly the `base` fallbacks — same keys, same values", () => {
    const base = SESSION_CONFIG_FIELD_KEYS.filter((key) => SESSION_CONFIG_FIELDS[key].fallback.kind === "base")
    expect(
      keysOf(EFFECTIVE_CONFIG_DEFAULTS),
      "the shipped defaults and the descriptor's `base` fallbacks name different fields — one of them is a second list",
    ).toEqual(base.map(String).sort())
    const disagreed = base.filter((key) => {
      const fallback = SESSION_CONFIG_FIELDS[key].fallback
      return !Object.is(EFFECTIVE_CONFIG_DEFAULTS[key], (fallback as { readonly value: unknown }).value)
    })
    expect(disagreed.map(String), "a shipped default differs from the value its descriptor declares").toEqual([])
  })

  test("🔴 a `stance` field is ABSENT from the resolved config, not defaulted into it", () => {
    // This is the property the introspection view rests on. Folding `surgicalEdits: false` into the
    // base would make "nobody set this" and "someone chose the default" the same wire value, and
    // the surface that exists to tell them apart would answer wrongly for every unset switch.
    const resolved = resolveConfig(EFFECTIVE_CONFIG_DEFAULTS, [])
    const leaked = SESSION_CONFIG_FIELD_KEYS.filter(
      (key) => SESSION_CONFIG_FIELDS[key].fallback.kind === "stance" && resolved[key] !== undefined,
    )
    expect(leaked.map(String)).toEqual([])
  })

  test("`stanceOf` applies the declared value, and an explicit stance always wins", () => {
    expect(stanceOf("safeMode", undefined)).toBe(false)
    expect(stanceOf("thinkingBudget", undefined)).toBe(true)
    // Both directions explicitly: a field whose fallback is `true` must still honour a `false`, or
    // the switch would be one-way for the user who turned it off.
    expect(stanceOf("thinkingBudget", false)).toBe(false)
    expect(stanceOf("safeMode", true)).toBe(true)
  })

  test("`stanceOf` REFUSES a field whose answer lives elsewhere", () => {
    // Returning a literal for `quality` would silently shadow the instance block that decides it —
    // a wrong answer where the honest one is "ask the setting". Throwing is the point.
    expect(() => stanceOf("quality", undefined)).toThrow(/instance/)
    expect(() => stanceOf("model", undefined)).toThrow(/derived/)
  })

  test("an `instance` fallback names a block, a `derived` one names its resolver", () => {
    const empty = SESSION_CONFIG_FIELD_KEYS.filter((key) => {
      const fallback = SESSION_CONFIG_FIELDS[key].fallback
      if (fallback.kind === "instance") return fallback.block.trim().length === 0
      if (fallback.kind === "derived") return fallback.by.trim().length === 0
      return false
    })
    // An unnamed source is the same as no declaration: the reader still has to be found by hand.
    expect(empty.map(String)).toEqual([])
  })

  test("no reader spells a stance fallback by hand any more", () => {
    // ⚠️ The direction that keeps this from becoming a fifth list nobody applies. A reader writing
    // `x ?? true` again is a second copy of an answer the descriptor already holds, and it compiles,
    // typechecks and passes — exactly like the three idioms this replaced.
    const stances = SESSION_CONFIG_FIELD_KEYS.filter((key) => SESSION_CONFIG_FIELDS[key].fallback.kind === "stance")
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      // The descriptor itself declares the literals; `stanceOf` is what applies them.
      if (file.endsWith(path.join("session", "config-resolve.ts"))) continue
      // ⚠️ EXEMPT, and the reason is a real distinction rather than a convenience. These two are the
      // pure host-execution gates (ruling 6). They never see a `SessionConfig`: a caller hands them
      // a decision, and their `=== true` answers *"the caller told us nothing"*, which for a safety
      // gate must stay permissive-by-omission exactly as it was before the switch existed. That is a
      // different question from *"the session declared no stance"*, which is what the descriptor
      // holds and what `stanceOf` answers — one collapse point each, for two different inputs.
      if (file.endsWith("agent-jail.ts") || file.endsWith("host-exec.ts")) continue
      const source = stripComments(fs.readFileSync(file, "utf8"))
      for (const key of stances) {
        const hand = new RegExp(`\\.${String(key)}\\s*(\\?\\?\\s*(true|false)|===\\s*true|!==\\s*false)`)
        if (hand.test(source)) offenders.push(`${path.relative(SRC, file).replaceAll("\\", "/")}: ${String(key)}`)
      }
    }
    expect({
      offenders,
      fix: "call stanceOf(key, value) — the descriptor holds the fallback",
    }).toEqual({ offenders: [], fix: expect.any(String) })
  })
})
