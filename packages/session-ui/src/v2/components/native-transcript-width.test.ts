import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The transcript must never draw a horizontal scrollbar (owner, 2026-09-19).
 *
 * NovaClaw runs on phones: content narrows to the viewport instead of side-scrolling. The observed
 * case was a permission-denied notice carrying one unbreakable OS path. The mechanism is two-fold —
 * the root wraps (`overflow-wrap: anywhere`) and clips residue (`overflow-x: clip`), and the tool
 * bodies (input/output/path/shell, the diff) wrap rather than keeping `overflow-x: auto`. A source
 * assertion because a re-added `auto` compiles, renders, and reads like a deliberate choice.
 */
const css = readFileSync(join(import.meta.dir, "native-transcript.css"), "utf8")

describe("the transcript has one axis", () => {
  test("the transcript root wraps long tokens and clips horizontal residue", () => {
    const root = css.slice(
      css.indexOf('[data-component="native-transcript"]'),
      css.indexOf("}", css.indexOf('[data-component="native-transcript"]')),
    )
    expect(root).toContain("min-width: 0")
    expect(root).toContain("overflow-x: clip")
    expect(root).toContain("overflow-wrap: anywhere")
  })

  test("no transcript element scrolls sideways", () => {
    expect(css).not.toContain("overflow-x: auto")
  })
})
