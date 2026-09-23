import { afterEach, expect, test } from "bun:test"
import { Show, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { toasterV2 } from "@novaclaw/ui/v2/toast-v2"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { ModelConfigScreen } from "@/components/settings-v2/dialog-model-config"
import { ToastRegion } from "@/utils/toast"
import { languageStub } from "./language-stub"
import { Schema } from "effect"
import { ConfigProvider } from "@novaclaw/core/config/provider"

let dispose: (() => void) | undefined
const originalMatchMedia = window.matchMedia
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
  toasterV2.clear()
  window.matchMedia = originalMatchMedia
})
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const click = (node: Element) => node.dispatchEvent(new MouseEvent("click", { bubbles: true }))
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === name)!
const field = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
const fill = (name: string, value: string) => {
  const node = field(name)
  node.value = value
  node.dispatchEvent(new Event("input", { bubbles: true }))
}
/** Open a `SelectV2` trigger and click one option by its key (`[role="option"][data-key]`). */
const choose = async (select: HTMLElement, key: string) => {
  select.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
  )
  await Promise.resolve()
  select.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }))
  await settle()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.dataset.key === key)
  expect(option, `option ${key} should be present`).toBeDefined()
  option!.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
  )
  await Promise.resolve()
  option!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }))
  await settle()
}
const selectText = (select: HTMLElement) =>
  select.querySelector<HTMLElement>('[data-slot="select-v2-value-text"]')?.textContent ?? ""
function merge(target: any, patch: any): any {
  for (const [key, value] of Object.entries(patch))
    target[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(target[key] ?? {}, value) : value
  return target
}
function mount(failRemoval = false, inheritedLimits = false) {
  let config: any = {
    devices: {
      local: { endpoints: ["http://localhost:8000"], concurrency: 4, locality: "local" },
    },
    providers: {
      local: {
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://localhost:8000/v1" },
        models: {
          test: {
            name: "Test",
            request: { body: { temperature: 0.7, top_p: 0.8, custom: "preserved" } },
            capabilities: { tools: false, input: ["text"], output: ["text"] },
            limit: { context: 65536, output: 8192, images: 3 },
          },
        },
      },
    },
  }
  if (inheritedLimits) config.providers.local.models.test.limit = {}
  const catalogDefaults = {
    limit: { context: 65536, output: 8192, images: 3 },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
  }
  const [store, setStore] = createStore({ config: structuredClone(config) })
  const sync = () => ({
    data: store,
    updateConfig: async (patch: any) => {
      // The real schema drops obsolete fields and the store merges nested patches.
      const decoded = patch.providers?.local
        ? Schema.decodeUnknownSync(ConfigProvider.Info)(patch.providers.local)
        : undefined
      config = merge(config, {
        ...(decoded === undefined ? {} : { providers: { local: decoded } }),
        ...(patch.devices === undefined ? {} : { devices: patch.devices }),
      })
      setStore("config", reconcile(structuredClone(config)))
    },
    removeConfig: async (paths: string[][]) => {
      if (failRemoval) throw new Error("deletion refused")
      for (const path of paths) {
        let node = config
        for (const key of path.slice(0, -1)) node = node?.[key]
        if (node) delete node[path.at(-1)!]
      }
      setStore("config", reconcile(structuredClone(config)))
    },
  })
  // The configure surface is a full-screen route now; the harness mounts it directly and a real
  // "Configure test" button toggles it, preserving the open → save → reopen flow the tests assert.
  const [configured, setConfigured] = createSignal(false)
  const Open = () => (
    <>
      <button onClick={() => setConfigured(true)}>Configure test</button>
      <Show when={configured()}>
        <ModelConfigScreen
          defaults={inheritedLimits ? catalogDefaults : undefined}
          providerID="local"
          modelID="test"
          modelName="Test"
          apiModelID="test"
          providerApi={config.providers.local.api}
          onDismiss={() => setConfigured(false)}
        />
      </Show>
    </>
  )
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <ServerSyncContext.Provider value={sync as never}>
              <DialogProvider>
                <Open />
                <ToastRegion />
              </DialogProvider>
            </ServerSyncContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  return Object.assign(() => config.providers.local.models.test, { config: () => config })
}
test("model settings phone tabs navigate horizontally and retain drafted fields across panels", async () => {
  window.matchMedia = (query: string) => {
    const result = originalMatchMedia.call(window, query)
    if (query === "(min-width: 768px)") Object.defineProperty(result, "matches", { value: false })
    return result
  }
  mount()
  click(button("Configure test"))
  await settle()
  const navigation = document.querySelector<HTMLElement>('nav[role="tablist"]')!
  const tabs = [...navigation.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!
  expect(navigation.getAttribute("aria-orientation")).toBe("horizontal")
  expect(tabs.filter((tab) => tab.tabIndex === 0).length).toBe(1)
  fill("Temperature", "0.3")
  tabs[0]!.focus()
  tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
  expect(panel.dataset.activeTab).toBe("sampling")
  expect(document.activeElement).toBe(tabs[1])
  expect(panel.getAttribute("aria-labelledby")).toBe(tabs[1]!.id)
  expect(field("Temperature").value).toBe("0.3")
  tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }))
  expect(panel.dataset.activeTab).toBe("scheduler")
  tabs.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }))
  expect(panel.dataset.activeTab).toBe("identity")
  expect(field("Temperature").value).toBe("0.3")
})

test("model edits survive the wire schema, merge store and reopening; defaults delete overrides", async () => {
  const saved = mount()
  click(button("Configure test"))
  await settle()
  expect(field("Temperature").value).toBe("0.7")
  fill("Temperature", "0.3")
  fill("Top-P (nucleus)", "")
  fill("Thinking budget", "512")
  const tool = document.querySelector('input[role="switch"]')!
  click(tool)
  click(button("Save"))
  await settle()
  expect(saved().request.body).toMatchObject({ temperature: 0.3, thinkingBudget: 512, custom: "preserved" })
  expect(saved().request.body.top_p).toBeUndefined()
  expect(saved().capabilities.tools).toBe(true)
  click(button("Configure test"))
  await settle()
  expect(field("Temperature").value).toBe("0.3")
  expect(field("Top-P (nucleus)").value).toBe("")
  fill("Temperature", "")
  fill("Thinking budget", "")
  click(button("Save"))
  await settle()
  expect(saved().request.body).toEqual({ custom: "preserved" })
})
test("a refused default deletion keeps the form open and reports failure", async () => {
  const saved = mount(true)
  click(button("Configure test"))
  await settle()
  fill("Temperature", "")
  click(button("Save"))
  await settle()
  expect(saved().request.body.temperature).toBe(0.7)
  expect(field("Temperature")).not.toBeNull()
  expect(document.body.textContent).toContain("deletion refused")
})

test("unrelated model edits preserve inherited limits and retire connection-attempt overrides", async () => {
  const saved = mount(false, true)
  click(button("Configure test"))
  await settle()
  fill("Temperature", "0.4")
  click(button("Save"))
  await settle()
  expect(saved().limit).toEqual({})
  expect(saved().retry).toBeUndefined()
})

test("model class and prefix-cache lifetime survive save and reopening", async () => {
  const saved = mount()
  click(button("Configure test"))
  await settle()
  await choose(document.querySelector<HTMLElement>('[data-action="settings-model-taxonomy"]')!, "smart")
  const switches = document.querySelectorAll('input[role="switch"]')
  expect(switches).toHaveLength(2)
  click(switches[1]!)
  fill("Prefix lifetime (minutes)", "7")
  click(button("Save"))
  await settle()
  expect(saved().taxonomy).toBe("smart")
  expect(saved().prefixCache).toEqual({ enabled: true, ttlMinutes: 7 })

  click(button("Configure test"))
  await settle()
  expect(selectText(document.querySelector<HTMLElement>('[data-action="settings-model-taxonomy"]')!)).toBe("Smart")
  expect(field("Prefix lifetime (minutes)").value).toBe("7")
})

test("the class picker starts on Usual and offers exactly the four classes", async () => {
  // `Usual` IS the documented default for an unrated model, so the control states what is in force
  // rather than showing an empty picker (AGENTS.md 12d).
  mount()
  click(button("Configure test"))
  await settle()
  const select = document.querySelector<HTMLElement>('[data-action="settings-model-taxonomy"]')!
  expect(selectText(select)).toBe("Usual")
  // And the LIST is pinned here because it is hand-copied: a rating the app can offer but the
  // instance's closed vocabulary rejects would save nothing and say it saved. `special` is the one
  // that must be here — it is the class the harness refuses to route to on its own.
  select.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse" }))
  await Promise.resolve()
  select.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse" }))
  await settle()
  expect(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((item) => item.textContent?.trim()),
  ).toEqual(["Smart", "Usual", "Fast", "Special"])
})

test("every field's explanation is behind a `?` beside its NAME, not a paragraph under it", async () => {
  mount()
  click(button("Configure test"))
  await settle()
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="settings-v2-row-title"]')]
  expect(rows.length).toBeGreaterThan(4)
  // ⚠️ INSIDE the title element is the whole claim: a `?` on the next line is what the owner asked to
  // get rid of (2026-09-16), and it is indistinguishable from the wrong one by count alone.
  for (const title of rows) expect(title.querySelector('[data-slot="settings-explain"]')).not.toBeNull()
  // And the inline paragraph is gone from every row of this screen.
  expect(document.querySelectorAll('[data-slot="settings-v2-row-description"]')).toHaveLength(0)

  // 🔴 And the `?` actually CARRIES the text, on the real screen rather than in the primitive's own
  // test: the row's short `desc` and its `desc.more` both had to arrive at the same popover.
  const first = document.querySelector<HTMLElement>('[data-slot="settings-explain"]')!
  expect(first.getAttribute("aria-label")).toBe("API path")
  first.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerId: 1, pointerType: "mouse" }))
  await settle()
  const panel = document.querySelector<HTMLElement>('[data-component="info-popover-v2"]')
  expect(panel?.textContent).toContain("The endpoint Nova connects to.")
  expect(panel?.textContent).toContain("Shared by every model from this provider, not just this one.")
})

test("device concurrency round-trips through the endpoint's Device entry", async () => {
  const saved = mount()
  click(button("Configure test"))
  await settle()
  expect(field("Concurrency").value).toBe("4")
  fill("Concurrency", "6")
  click(button("Save"))
  await settle()
  expect(saved.config().devices.local).toEqual({
    endpoints: ["http://localhost:8000"],
    concurrency: 6,
    locality: "local",
  })
})

test("🔴 API type round-trips onto the MODEL's api, and inherit removes the override", async () => {
  // The runner dispatches on the resolved model's `api.package`; a model override is how one
  // gateway's models ride different wires (a gateway serving `/responses` for one model and
  // `/chat/completions` for its siblings — measured 2026-09-21).
  const saved = mount()
  click(button("Configure test"))
  await settle()
  const select = document.querySelector<HTMLElement>('[data-action="settings-model-api-type"]')!
  // Defaults to the provider's own channel, stated rather than left blank.
  expect(selectText(select)).toBe("Same as provider")

  await choose(select, "@ai-sdk/openai")
  click(button("Save"))
  await settle()
  expect(saved().api).toEqual({ id: "test", type: "aisdk", package: "@ai-sdk/openai" })

  click(button("Configure test"))
  await settle()
  const reopened = document.querySelector<HTMLElement>('[data-action="settings-model-api-type"]')!
  expect(selectText(reopened)).toBe("OpenAI")
  // Back to inherit: the override must be GONE, not merely unwritten — PATCH merges, so a stale
  // `package` would keep the model on a wire the user just turned off.
  await choose(reopened, "inherit")
  click(button("Save"))
  await settle()
  expect(saved().api).toEqual({ id: "test" })
})
