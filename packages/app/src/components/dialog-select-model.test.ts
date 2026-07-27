import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// Three model-picker behaviours the owner asked for on 2026-07-27. They are asserted against the SOURCE
// because each one is a routing decision that renders identically when wrong — a picker that opens an
// empty list, or a button that opens the old dialog, both look like a working UI.
//
//   1. no models configured → the picker is skipped and the add-model flow opens directly;
//   2. "Manage models" opens Settings → Models;
//   3. the obsolete DialogManageModels is gone, so nothing can route back to it.

const HERE = import.meta.dir
const selectModel = fs.readFileSync(path.join(HERE, "dialog-select-model.tsx"), "utf8")

describe("model picker routing", () => {
  test("the obsolete Manage-models dialog no longer exists", () => {
    expect(fs.existsSync(path.join(HERE, "dialog-manage-models.tsx"))).toBe(false)
  })

  test("nothing imports or renders it any more", () => {
    // A stale dynamic import would only fail at runtime, when the user clicks — hence a static check.
    // Asserted on the MODULE reference and the JSX usage rather than the bare identifier: the comment
    // above handleManage names the old dialog on purpose, to explain why it went away.
    expect(selectModel).not.toContain("dialog-manage-models")
    expect(selectModel).not.toMatch(/<\s*[\w.]*DialogManageModels/)
  })

  test("both Manage-models handlers open Settings on the Models tab", () => {
    // Two entry points exist (the popover's sliders button and the dialog's footer button) and they must
    // agree; one was previously left behind when the other changed.
    const opens = selectModel.match(/defaultTab="models"/g) ?? []
    expect(opens.length).toBeGreaterThanOrEqual(2)
    const managers = selectModel.match(/const (handleManage|manage) = \(\) => \{/g) ?? []
    expect(managers.length).toBe(2)
  })

  test("an empty model list short-circuits to the add-model flow, in BOTH the popover and the dialog", () => {
    // The popover intercepts opening; the dialog (opened by the composer's /model command) redirects on
    // mount. Missing either one leaves a dead end on that path only.
    expect(selectModel).toContain("noModels()")
    expect(selectModel).toMatch(/if \(next && noModels\(\)\) \{[\s\S]{0,120}handleConnectProvider\(\)/)
    expect(selectModel).toMatch(/onMount\(\(\) => \{[\s\S]{0,220}openAddModel\(/)
  })

  test("emptiness is judged on models CONFIGURED, not models visible", () => {
    // Using the visible-filtered list would hijack the picker for someone who merely hid their models,
    // hiding the very control that unhides them.
    expect(selectModel).toMatch(/noModels = \(\) => \(props\.model \?\? local\.model\)\.list\(\)\.length === 0/)
  })
})

describe("add-model provider order", () => {
  const newModel = fs.readFileSync(path.join(HERE, "settings-v2", "dialog-new-model.tsx"), "utf8")

  test("Custom endpoint is rendered BEFORE the branded presets", () => {
    const custom = newModel.indexOf('data-action="new-model-custom"')
    const presets = newModel.indexOf("<For each={visiblePresets()}>")
    expect(custom).toBeGreaterThan(-1)
    expect(presets).toBeGreaterThan(-1)
    expect(custom).toBeLessThan(presets)
  })
})
