import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * A SOURCE ledger, because this defect is invisible to behaviour.
 *
 * The Computer Use panel shipped written INSIDE `<TabsV2.List>`, between the "computer" and "tools"
 * triggers. Kobalte renders `Content` wherever it is written, so the whole tab appeared squeezed
 * into the left tab rail — and nothing failed: the tab was selectable, the panel mounted, the
 * controls worked, every unit test stayed green. Only a human looking at the screen could see it.
 *
 * So the check has to read the file. Both assertions below are about PLACEMENT, which is the thing
 * a rendering test of the component could not tell you either.
 */
const source = readFileSync(path.join(import.meta.dir, "dialog-settings-v2.tsx"), "utf8")

const listBody = () => {
  const start = source.indexOf("<TabsV2.List>")
  const end = source.indexOf("</TabsV2.List>")
  expect(start, "TabsV2.List opening tag").toBeGreaterThan(-1)
  expect(end, "TabsV2.List closing tag").toBeGreaterThan(start)
  return source.slice(start, end)
}

const values = (pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match[1]!)

describe("the settings dialog keeps panels out of the tab rail", () => {
  test("🔴 no TabsV2.Content is written inside TabsV2.List", () => {
    expect(listBody()).not.toContain("TabsV2.Content")
  })

  test("every trigger has a panel, and every panel has a trigger", () => {
    const triggers = values(/<TabsV2\.Trigger value="([^"]+)"/g)
    const panels = values(/<TabsV2\.Content value="([^"]+)"/g)
    expect(triggers.length).toBeGreaterThan(0)
    expect([...panels].sort()).toEqual([...triggers].sort())
  })

  test("a tab hidden by expertise hides BOTH halves, or the rail and the panel disagree", () => {
    // The gated tabs are read out of TAB_LEVELS rather than listed here, so adding one to that map
    // puts it under this check automatically instead of silently opting out of it.
    const block = source.slice(source.indexOf("const TAB_LEVELS"), source.indexOf("export const DialogSettings"))
    const gated = [...block.matchAll(/^\s*"?([a-z-]+)"?:\s*"(?:advanced|developer)"/gm)].map((match) => match[1]!)
    expect(gated.length).toBeGreaterThan(0)

    // Each gated tab is wrapped in `<Show when={tabVisible("<tab>")}>` twice — once around its
    // trigger, once around its panel. A single occurrence means one half renders unconditionally.
    for (const tab of gated) {
      const guards = values(new RegExp(`tabVisible\\("(${tab})"\\)`, "g"))
      expect(guards.length, `tabVisible("${tab}") guards`).toBe(2)
    }
  })
})
