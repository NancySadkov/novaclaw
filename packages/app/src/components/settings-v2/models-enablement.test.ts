import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { dict as en } from "@/i18n/en"

/**
 * Guards for the claim: *"toggling off the model in Models has no immediate effect — a working agent
 * keeps using the turned-off model."*
 *
 * The claim was true, and the reason was a store mix-up. The Models tab's switch called
 * `setVisibility`, which writes a PER-CLIENT picker preference (a persisted store keyed per instance,
 * in this browser). The server never heard of it, so `catalog.model.available()` — which is what every
 * turn, every colleague and every scheduled run resolves through — kept answering with the model that
 * had just been "switched off". The switch was a decoration.
 *
 * Real enablement is config: `providers.<id>.models.<id>.disabled` → `model.enabled`
 * (`core/src/config/plugin/provider.ts`), and `providers` is a `catalog` reload trigger, so a write
 * rebuilds the catalog in place. These tests pin that the UI writes THAT, and that the two stores were
 * not quietly merged back into one another.
 */
const tab = fs.readFileSync(path.join(import.meta.dir, "models.tsx"), "utf8")
const context = fs.readFileSync(path.join(import.meta.dir, "..", "..", "context", "models.tsx"), "utf8")
const dialog = fs.readFileSync(path.join(import.meta.dir, "dialog-model-config.tsx"), "utf8")
const styles = fs.readFileSync(path.join(import.meta.dir, "settings-v2.css"), "utf8")

describe("Models tab — enablement is a server fact, not a browser preference", () => {
  test("🔴 the switch reads and writes ENABLEMENT, not picker visibility", () => {
    // A/B: revert the switch to `checked={models.visible(key)}` + `setVisibility` and both of the
    // first two assertions fail while the file still renders a perfectly ordinary-looking toggle.
    expect(tab).toContain("checked={models.enabled(key)}")
    expect(tab).toContain(".setEnabled(key, checked)")
    // The switch must not ALSO flip the local preference: one control, one store, or the two drift
    // and the UI shows a state the server contradicts.
    expect(tab).not.toContain("models.setVisibility(key, checked)")
  })

  test("🔴 the write is a config write of `disabled`, and the catalog is refetched after it", () => {
    expect(context).toContain("updateConfig({")
    expect(context).toContain("disabled: on ? false : true")
    // Without the refetch the client keeps rendering the pre-write catalog it already has, and the
    // user watches a switch they just moved snap back.
    expect(context).toContain("refetchProviders()")
    // The provider fragment must RESTATE the provider it overrides — a layered patch is appended as a
    // new layer, so a one-field fragment would be the whole new layer and would drop the URL/auth.
    expect(context).toContain("...provider,")
    expect(context).toContain("...(provider.models ?? {})")
    expect(context).toContain("...entry,")
  })

  test("🔴 a switched-off model leaves the picker, because offering it would be a lie", () => {
    expect(context).toContain("if (disabledInConfig(model)) return false")
    // ...and it is checked BEFORE the per-client preference, so a stale "show" in this browser cannot
    // resurrect a model the instance turned off.
    const at = context.indexOf("if (disabledInConfig(model)) return false")
    const preference = context.indexOf("const state = visibility().get(key)")
    expect(at).toBeGreaterThan(-1)
    expect(preference).toBeGreaterThan(at)
  })

  test("the two stores stay separate: visibility is still a client preference for the picker", () => {
    // Removing this would be its own regression — decluttering a 400-model catalog is a per-person
    // choice, and making it instance-wide would hide other people's models from them.
    expect(context).toContain("setVisibility")
    expect(context).toContain('update(model, state ? "show" : "hide")')
  })

  test("the switch says what it did, including that agents now resolve something else", () => {
    expect(en["settings.models.enable.toast.on"]).toContain("{{model}}")
    expect(en["settings.models.enable.toast.off"]).toContain("{{model}}")
    expect(en["settings.models.enable.toast.failed"]).toContain("{{error}}")
  })
})

describe("Model Configure — the default model finally has a writer", () => {
  test("🔴 Make Default writes config's `model` key, which is the instance default", () => {
    /**
     * `catalog.model.default()` falls back to the newest RELEASED model when nothing sets the key —
     * a fact about upstream release calendars posing as a user's choice. The key existed, the server
     * path existed (`config-store-write.ts`: `patch.model` → `catalog.setDefault`), and no surface
     * ever wrote it.
     */
    expect(dialog).toContain("updateConfig({ model:")
    expect(dialog).toContain("const defaultRef = () => `${props.providerID}/${props.modelID}`")
    expect(dialog).toContain("updateConfig({ model: defaultRef() }")
    expect(dialog).toContain("refetchProviders()")
    // It shows which model IS the default rather than offering the act again, and it is not a button
    // that lies about being finished.
    expect(dialog).toContain("disabled={isDefault()}")
    expect(en["settings.models.config.default.make"]).toBeTruthy()
    expect(en["settings.models.config.default.isDefault"]).toBeTruthy()
    expect(en["settings.models.config.toast.defaultSet"]).toContain("{{model}}")
  })
})

/**
 * The kernel half was fixed in `0ba4e8d52`/`6af2f1736` (a turn on a switched-off model is
 * substituted). The CLIENT kept naming the dead model, which is what the owner saw: *"disabling a
 * model still doesn't shortcircuit all its uses (e.g. clicking the context indicator ring still
 * shows the old model, despite it being disabled)"*. These pin the class at three call sites so a
 * lookup cannot drift back to ignoring enablement without a name.
 */
describe("A switched-off model is not a resolution anywhere", () => {
  const local = fs.readFileSync(path.join(import.meta.dir, "..", "..", "context", "local.tsx"), "utf8")
  const ctxTab = fs.readFileSync(path.join(import.meta.dir, "..", "session", "session-context-tab.tsx"), "utf8")
  // ⚠️ Re-pointed 2026-09-18 (per-agent tuning): the judge picker moved from the deleted
  // Settings → Introspection tab onto the officer's own Introspection tab. The CLASS is the same
  // — a picker that offers a switched-off model is a lie — so the assertion follows the control.
  const officerDialog = fs.readFileSync(path.join(import.meta.dir, "..", "officer-settings-screen.tsx"), "utf8")

  test("the composer's resolution chain rejects a switched-off model", () => {
    // `validModel` gates the session pin, the officer's model, the instance default and recents.
    expect(local).toContain("models.enabled(model)")
  })

  test("the context indicator names the model that will run, not the switched-off one", () => {
    expect(ctxTab).toContain("models.enabled({ providerID: historical.providerID, modelID: historical.id })")
  })

  test("the judge model picker does not offer a switched-off model", () => {
    // The picker's options come from `runnableModels()`, which is exactly this predicate.
    expect(officerDialog).toContain("models.list().filter((item) => models.enabled({ providerID: item.provider.id, modelID: item.id }))")
    expect(officerDialog).toContain("const intrModelOptions = createMemo(")
  })
})

describe("Models tab — quiet overview, details on demand", () => {
  test("moves measured quality and prefix diagnostics into Configure and keeps endpoint URLs out of the list", () => {
    expect(tab).not.toContain("<DialogModelTier")
    expect(dialog).toContain("settings.models.config.taxonomy.name")
    expect(dialog).toContain("prefixCacheEnabled")
    expect(tab).toContain("<DialogModelStats")
    expect(tab).toContain("description={modelProviderLabel(props.item.provider.name)}")
    expect(tab).toContain("return /^https?:\\/\\//i.test")
  })

  test("the model name is the legible drag target, with a roomy one-line control bar", () => {
    expect(tab).toContain('class="settings-v2-models-drag-target"')
    expect(tab).not.toContain('name="dot-grid"')
    expect(en["settings.models.order.hint"]).toContain("model name")
    expect(styles).toContain("@container (min-width: 46rem)")
    expect(styles).toMatch(/\.settings-v2-models-row-controls\s*\{\s*flex-wrap: nowrap;/)
  })

  test("🔴 a long probe detail cannot collapse the model name", () => {
    // The base media query pins the control at `flex-shrink: 0`, so a long status could not shrink IT
    // and the COPY absorbed the whole overflow — `overflow-wrap: anywhere` then drew the name one
    // character per line (owner report, 2026-09-22). The control shrinks to the buttons' min-content
    // and the status stretches so it wraps beside it.
    expect(styles).toMatch(
      /\.settings-v2-models \[data-slot="settings-v2-row-control"\]\s*\{\s*min-width: 0;\s*flex-shrink: 1;/,
    )
    expect(styles).toMatch(/\.settings-v2-models-row-actions\s*\{[^}]*flex: 0 1 auto;[^}]*align-items: stretch;/)
    expect(styles).toMatch(/\.settings-v2-models-probe-result\s*\{[^}]*align-self: stretch;/)
  })
})
