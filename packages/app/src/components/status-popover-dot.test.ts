import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { STATUS_DOT_CLASS, statusDotTone, type StatusDotTone } from "./status-popover-dot"

/**
 * The titlebar health dot is the one place a person looks to answer "is my instance alive?", and it
 * answers with colour alone. So the only thing worth testing is that the three answers it can give
 * are three DIFFERENT answers, and that every input reaches exactly one of them.
 *
 * It shipped not doing that. The dot's colour was four independent booleans in a `classList`, and an
 * edit that folded "the server is down" and "we have not heard from the server yet" into one "the
 * server is up" test broke both directions at once:
 *
 *   · a HEALTHY instance matched three of the four predicates, so its colour was whatever the
 *     cascade resolved — and a `.tsx`-imported stylesheet is unlayered, so which one that is cannot
 *     be read off the JSX;
 *   · an UNREACHABLE instance matched none, so the dot rendered with no background at all —
 *     invisible, at exactly the moment it exists for.
 *
 * Neither shape is visible to a test that only checks the healthy case, which is why these assert on
 * the single resolved tone: a value that cannot be two things and cannot be nothing.
 *
 * ⚠️ Why the tone and not the rendered pixel: `packages/app` has no Solid render harness, and a
 * class list is not a colour anyway — the old bug was three classes present at once, which any
 * "contains the success class" assertion passes with flying colours. `statusDotTone` returns one
 * value, `STATUS_DOT_CLASS` maps it to one class, and both halves are pinned below.
 */
describe("titlebar health dot: three states, three answers", () => {
  test("a healthy instance is healthy — and NOT also unreachable", () => {
    const tone = statusDotTone({ serverHealth: true, ready: true })
    expect(tone).toBe("healthy")
    // The instance failure: a live instance wearing the "your instance is down" colour.
    expect(tone).not.toBe("unreachable")
  })

  test("an unreachable instance is VISIBLY unreachable, not blank", () => {
    const tone = statusDotTone({ serverHealth: false, ready: true })
    expect(tone).toBe("unreachable")
    // The half that matters most: it is not the pale "we have not heard yet" dot, and it is not the
    // no-answer case that rendered transparent.
    expect(tone).not.toBe("unknown")
    expect(STATUS_DOT_CLASS[tone]).toBeTruthy()
  })

  test("a known-down server stays down even before the rest of the picture loads", () => {
    // `ready` is the MCP sync having arrived. It may soften an unknown into an unknown; it must
    // never soften a fact we already have.
    expect(statusDotTone({ serverHealth: false, ready: false })).toBe("unreachable")
  })

  test("not yet heard from is its own answer, distinct from both", () => {
    expect(statusDotTone({ serverHealth: undefined, ready: true })).toBe("unknown")
    expect(statusDotTone({ serverHealth: undefined, ready: false })).toBe("unknown")
    // A server that is up while the MCP picture is still loading is also "not yet" — it is not a
    // clean bill of health, because half the things the dot reports have not reported in.
    expect(statusDotTone({ serverHealth: true, ready: false })).toBe("unknown")
  })

  test("MCP trouble on a live server is graded, and never impersonates an outage colour it isn't", () => {
    expect(statusDotTone({ serverHealth: true, ready: true, issue: "warning" })).toBe("warning")
    expect(statusDotTone({ serverHealth: true, ready: true, issue: "critical" })).toBe("unreachable")
    // …and an MCP issue on a server we have not heard from is still "not yet heard from": the dot
    // must not claim to know the server is up.
    expect(statusDotTone({ serverHealth: undefined, ready: true, issue: "critical" })).toBe("unknown")
  })

  test("every state a person can be in gets exactly one answer, and the answers look different", () => {
    // Totality: the function is exhaustive over the whole input space, so "no colour at all" is not
    // reachable by any combination.
    const tones = new Set<StatusDotTone>()
    for (const serverHealth of [true, false, undefined] as const)
      for (const ready of [true, false] as const)
        for (const issue of [undefined, "warning", "critical"] as const)
          tones.add(statusDotTone({ serverHealth, ready, issue }))
    expect(tones).toEqual(new Set<StatusDotTone>(["healthy", "warning", "unreachable", "unknown"]))

    // Distinctness: two tones sharing a class would be two states nobody can tell apart.
    const classes = Object.values(STATUS_DOT_CLASS)
    expect(classes.every((value) => value.length > 0)).toBe(true)
    expect(new Set(classes).size).toBe(classes.length)
  })
})

/**
 * ─── the SOURCE guards ──────────────────────────────────────────────────────────────────────────
 *
 * The two above are behavioural. These two pin the shape, because the defect was not a wrong
 * predicate so much as a shape that lets a wrong predicate hide: independent per-colour booleans,
 * and a second copy of the derivation in a component nothing rendered any more.
 *
 * ⚠️ Source assertions are the weakest kind of test in this repo. They are used here only because
 * `packages/app` has no Solid render harness, and `status-popover.tsx` cannot even be IMPORTED by a
 * unit test — Kobalte throws "Client-only API called on the server side" at module load — so "what
 * the DOM actually got" is not assertable here at all.
 */
describe("the dot's shape is pinned, because the shape is what failed", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "status-popover.tsx"), "utf8")

  test("the rendered dot takes ONE class from the table, not a per-colour predicate list", () => {
    expect(source).toContain("STATUS_DOT_CLASS[tone()]")
    // The old shape. Any return of it re-opens both failure directions at once.
    expect(source).not.toContain('"bg-icon-success-base":')
    expect(source).not.toContain('"bg-border-weak-base":')
  })

  test("there is only ONE derivation of the dot, so no copy of it can drift unnoticed", () => {
    // The collapse landed in a second, unrendered copy of this component and sat there: a dead
    // duplicate is a derivation nothing can contradict — no screen shows it, no test covers it, and
    // it still reads like the real thing to whoever edits it next. Only the live one survives.
    expect(source).not.toContain("export function StatusPopover(")
    expect(source).not.toContain("const serverHealthy =")
    // The view reads the shared decision rather than restating it. A local `function statusDotTone`
    // here would be the same trap with a new address.
    expect(source).toContain('from "./status-popover-dot"')
    expect(source).not.toContain("function statusDotTone(")
  })
})
