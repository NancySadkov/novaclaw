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
    const preference = context.indexOf('const state = visibility().get(key)')
    expect(at).toBeGreaterThan(-1)
    expect(preference).toBeGreaterThan(at)
  })

  test("the two stores stay separate: visibility is still a client preference for the picker", () => {
    // Removing this would be its own regression — decluttering a 400-model catalog is a per-person
    // choice, and making it instance-wide would hide other people's models from them.
    expect(context).toContain("setVisibility")
    expect(context).toContain("update(model, state ? \"show\" : \"hide\")")
  })

  test("the switch says what it did, including that agents now resolve something else", () => {
    expect(en["settings.models.enable.toast.on"]).toContain("{{model}}")
    expect(en["settings.models.enable.toast.off"]).toContain("{{model}}")
    expect(en["settings.models.enable.toast.failed"]).toContain("{{error}}")
  })
})

describe("Model Configure — the default model finally has a writer", () => {
  const dialog = fs.readFileSync(path.join(import.meta.dir, "dialog-model-config.tsx"), "utf8")

  test("🔴 Make Default writes config's `model` key, which is the instance default", () => {
    /**
     * `catalog.model.default()` falls back to the newest RELEASED model when nothing sets the key —
     * a fact about upstream release calendars posing as a user's choice. The key existed, the server
     * path existed (`config-store-write.ts`: `patch.model` → `catalog.setDefault`), and no surface
     * ever wrote it.
     */
    expect(dialog).toContain("updateConfig({ model:")
    expect(dialog).toContain("${props.providerID}/${modelID}")
    expect(dialog).toContain("refetchProviders()")
    // It shows which model IS the default rather than offering the act again, and it is not a button
    // that lies about being finished.
    expect(dialog).toContain("disabled={!form.modelID.trim() || isDefault()}")
    expect(en["settings.models.config.default.make"]).toBeTruthy()
    expect(en["settings.models.config.default.isDefault"]).toBeTruthy()
    expect(en["settings.models.config.toast.defaultSet"]).toContain("{{model}}")
  })
})
