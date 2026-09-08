import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Parity for color-scheme presets (uix.md §7.2): each preset override block must declare the SAME set
// of custom properties (so a preset can't silently miss a family the other remaps — the un-remapped
// "off-color over the field" bug class), every property must exist in the Nova base (no typos/phantom
// tokens), and the core hue tokens must be present (so a preset is never a near-no-op).

const THEMES_DIR = import.meta.dir
const APP_SRC = join(THEMES_DIR, "..")

function declaredProps(css: string): Set<string> {
  const out = new Set<string>()
  for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) out.add(match[1]!)
  return out
}

// The Nova base is the `body[data-new-layout] { … }` block in index.css (NOT the `… main {` aurora rule).
function novaBaseProps(): Set<string> {
  const index = readFileSync(join(APP_SRC, "index.css"), "utf8")
  const block = /body\[data-new-layout\]\s*\{([\s\S]*?)\n\}/.exec(index)
  if (!block) throw new Error("Could not locate the Nova base block in index.css")
  return declaredProps(block[1]!)
}

const CORE_TOKENS = [
  "--nc-accent-solid",
  "--nc-accent-gradient",
  "--nc-ink",
  "--nc-aurora",
  "--v2-background-bg-deep",
  "--v2-background-bg-base",
  "--v2-text-text-base",
  "--v2-text-text-accent",
]

const PRESETS = ["autumn", "summer"] as const

describe("color-scheme presets", () => {
  const presetProps = new Map(
    PRESETS.map((name) => [name, declaredProps(readFileSync(join(THEMES_DIR, `${name}.css`), "utf8"))] as const),
  )
  const nova = novaBaseProps()

  test("Nova base defines the core tokens", () => {
    for (const token of CORE_TOKENS) expect(nova.has(token)).toBe(true)
  })

  test("every preset declares the same set of properties", () => {
    const [first, ...rest] = PRESETS
    const ref = [...presetProps.get(first)!].sort()
    for (const other of rest) {
      expect([...presetProps.get(other)!].sort()).toEqual(ref)
    }
  })

  test("every preset property exists in the Nova base (no typos/phantom tokens)", () => {
    for (const name of PRESETS) {
      for (const prop of presetProps.get(name)!) {
        expect(nova.has(prop)).toBe(true)
      }
    }
  })

  test("every preset covers the core hue tokens", () => {
    for (const name of PRESETS) {
      for (const token of CORE_TOKENS) {
        expect(presetProps.get(name)!.has(token)).toBe(true)
      }
    }
  })
})
