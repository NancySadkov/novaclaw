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
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
  toasterV2.clear()
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

test("benchmark score and prefix-cache lifetime survive save and reopening", async () => {
  const saved = mount()
  click(button("Configure test"))
  await settle()
  fill("Terminal-Bench 4.0 score (%)", "42.5")
  const switches = document.querySelectorAll('input[role="switch"]')
  expect(switches).toHaveLength(2)
  click(switches[1]!)
  fill("Prefix lifetime (minutes)", "7")
  click(button("Save"))
  await settle()
  expect(saved().benchmark).toEqual({ name: "terminal-bench-4.0", score: 42.5, source: "user" })
  expect(saved().prefixCache).toEqual({ enabled: true, ttlMinutes: 7 })

  click(button("Configure test"))
  await settle()
  expect(field("Terminal-Bench 4.0 score (%)").value).toBe("42.5")
  expect(field("Prefix lifetime (minutes)").value).toBe("7")
})

test("device concurrency round-trips through the endpoint's Device entry", async () => {
  const saved = mount()
  click(button("Configure test"))
  await settle()
  expect(field("Device concurrency").value).toBe("4")
  fill("Device concurrency", "6")
  click(button("Save"))
  await settle()
  expect(saved.config().devices.local).toEqual({
    endpoints: ["http://localhost:8000"],
    concurrency: 6,
    locality: "local",
  })
})
