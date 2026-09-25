import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
// Every officer-settings tab must have a CSS visibility rule, or selecting it shows a blank
// panel: `.agent-settings-panels [data-settings-tab]` is `display: none` unless the active
// tab's rule re-enables it. Measured 2026-09-18 — four new tabs rendered in the DOM (and
// passed every DOM assertion) while the shipped stylesheet hid them all, which no render
// test could see because happydom does not apply stylesheets the way the product does.
//
// ⚠️ Source-derived, like the clone/carry ledgers: the alternative is a visual check no
// unit can do. If the tab strip moves files, re-point the paths, not the invariant.

const dir = path.dirname(fileURLToPath(import.meta.url))
const dialog = readFileSync(path.join(dir, "officer-settings-screen.tsx"), "utf8")
const css = readFileSync(path.join(dir, "..", "index.css"), "utf8")

/** Tab ids from the rail (`{ id: "work" as const, ... }`). */
const tabIds = () => {
  const ids = new Set<string>()
  const pattern = /\{\s*id:\s*"([a-z]+)"\s*as\s*const/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(dialog)) !== null) ids.add(match[1]!)
  return [...ids].sort()
}

/** Tabs the stylesheet reveals (`data-active-tab="work"`). */
const cssTabs = () => {
  const ids = new Set<string>()
  const pattern = /data-active-tab="([a-z]+)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) ids.add(match[1]!)
  return [...ids].sort()
}

/**
 * Sections the component tags with a tab id. A section whose id no rail entry can select is
 * PERMANENTLY hidden — the same blank-panel defect as a tab with no CSS rule, one step over.
 */
const sectionTabs = () => {
  const ids = new Set<string>()
  const pattern = /data-settings-tab="([a-z-]+)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(dialog)) !== null) ids.add(match[1]!)
  return [...ids].sort()
}

describe("every officer tab is visible when selected", () => {
  test("the rail offers tabs, so the check is not vacuous", () => {
    expect(tabIds().length).toBeGreaterThan(5)
    for (const tab of ["work", "capabilities", "profile", "mind", "context", "quality", "nudges"])
      expect(tabIds()).toContain(tab)
  })

  test("every tab id has exactly the CSS rule that reveals it", () => {
    expect(cssTabs()).toEqual(tabIds())
  })

  test("every section is reachable — its tab id is one the rail can select", () => {
    expect(sectionTabs().length).toBeGreaterThan(5)
    expect(sectionTabs().filter((id) => !tabIds().includes(id))).toEqual([])
  })
})
