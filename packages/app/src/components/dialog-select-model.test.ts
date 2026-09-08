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

// Owner directive 2026-08-06: a picker row is "model name + its context", never the endpoint it is
// served from. Source-asserted for the same reason as the block above — both
// failure modes render as a perfectly normal-looking list, so nothing about them is visible to a test
// that only checks the picker opens.
describe("model picker row shows the model, not its endpoint", () => {
  test("the row does not render provider.name", () => {
    // The regression this pins is a re-added host suffix: for every user-added model `provider.name`
    // defaults to the serving endpoint's slug (settings-v2/dialog-new-model.tsx derives it from
    // hostname[-port]pathname), so this line put a URL beside every model in the list.
    expect(selectModel).not.toMatch(/\{\s*i\.provider\.name\s*\}/)
  })

  test("provider is still a SEARCH key, so typing a host narrows the list", () => {
    // Deleting it from the row must not delete it from search — displaying and matching are different
    // questions, and the directive was about what the row SAYS.
    expect(selectModel).toMatch(/filterKeys=\{\[[^\]]*"provider\.name"/)
  })

  test("context renders from the declared limit, not only from a successful probe", () => {
    // Before this change the {n}k tag was gated on `probe()?.status === "ok"`, so a model that had
    // never been probed — the majority, since probing is lazy and capped at PROBE_CAP per open —
    // showed no context at all. The declared value is the floor; the probed window overrides it.
    expect(selectModel).toMatch(/const context = \(\) => window\(\) \?\? i\.limit\?\.context/)
  })

  test("a declared context is distinguishable from a measured one", () => {
    // Ruling 2: a fault is never described falsely. A catalog claiming 256k on an endpoint that
    // honors 32k must not render as measured fact — the tag carries data-measured and the tooltip
    // says it in words.
    expect(selectModel).toMatch(/data-measured=\{window\(\) === undefined \? "false" : "true"\}/)
    expect(selectModel).toMatch(/measured=\{window\(\) !== undefined\}/)
    const tooltip = fs.readFileSync(path.join(HERE, "model-tooltip.tsx"), "utf8")
    expect(tooltip).toContain("model.tooltip.context.measured")
  })

  test("the tooltip reads the probe through an ACCESSOR, so it is not stale on the first open", () => {
    // Found in the live DOM 2026-08-07. The probes fire from onMount and resolve after the rows have
    // rendered, so `const window = probeResult(...)` is undefined for the entire first open — the tag
    // (an accessor) flipped to measured while the tooltip beside it still said declared, and in the
    // general case printed the DECLARED number next to the tag's honored one. Holo hid it locally
    // because its declared limit and its honored window are both 131072.
    //
    // Pinned as the absence of the captured form, not just the presence of the accessor: reverting
    // one line is exactly how this comes back.
    expect(selectModel).toMatch(/const window = \(\) => probeResult\(item\.provider\.id, item\.id\)\?\.window/)
    expect(selectModel).not.toMatch(/const window = probeResult\(/)
    expect(selectModel).toMatch(/model=\{tooltipModel\(\)\}/)
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

  test("the usable dialog mounts before provider discovery settles", () => {
    expect(newModel).not.toContain("createResource")
    expect(newModel).toMatch(/onMount\(\(\) => \{[\s\S]{0,300}providerPresets\(/)
  })
})
