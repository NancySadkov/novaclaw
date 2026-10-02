import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * The Debug app's tab contract, pinned the way the Officer Settings one is.
 *
 * 🔴 **WHY THIS EXISTS.** The Debug app used to be one long scroll with a jump bar of
 * `<a href="#debug-…">` anchors. Every panel is now a tab behind a signal, and the reveal is CSS —
 * which means the three sets that must agree (the rail entries, the CSS reveal rules, and the
 * `data-debug-tab` tags on the panels) are exactly the kind of thing that compiles green while a
 * section is permanently unreachable. `agent-settings-tabs.test.ts` learned this for the officer
 * screen; this is the same contract for Debug.
 *
 * ⚠️ The reveal rules MUST stay in `debug.css`, never `index.css`: the officer test asserts that
 * every `data-active-tab="…"` in index.css is an officer rail id, so copying these there would fail
 * that test. This test reads `debug.css` directly, which is the point.
 */
const here = import.meta.dir

const read = (rel: string) => fs.readFileSync(path.join(here, rel), "utf8")

const tabIds = (): string[] =>
  [...read("debug.tsx").matchAll(/\{\s*id:\s*"([a-z]+)"\s*as\s*const,\s*label:\s*"/g)].map((match) => match[1]!)

const cssRevealIds = (): string[] =>
  [...read("debug.css").matchAll(/data-active-tab="([a-z]+)"/g)].map((match) => match[1]!)

const sectionIds = (): string[] =>
  [...read("debug.tsx").matchAll(/data-debug-tab="([a-z]+)"/g)].map((match) => match[1]!)

describe("the Debug app's tabs", () => {
  test("the rail still parses, so an empty result cannot pass vacuously", () => {
    expect(tabIds().length, "no Debug rail ids parsed — the parser or the rail broke").toBeGreaterThan(5)
    expect(tabIds()).toContain("memory")
  })

  test("every rail id has exactly one CSS reveal rule, and vice versa", () => {
    expect([...cssRevealIds()].sort()).toEqual([...tabIds()].sort())
  })

  test("every panel's tag is selectable — a section no tab can reach is permanently hidden", () => {
    const rails = new Set(tabIds())
    expect(sectionIds().filter((id) => !rails.has(id))).toEqual([])
  })

  test("🔴 no panel is reached by a URL anchor — the click class that broke the app is gone", () => {
    // The old jump bar set `location.hash`; on a custom-protocol renderer that is a navigation the
    // router never asked for. A tab is a signal, so no Debug control is an `href="#…"`.
    const source = read("debug.tsx")
    expect(source).not.toMatch(/href="#debug/)
    expect(source).toContain("KobalteTabs")
    expect(source).toContain("setActiveTab")
  })
})
