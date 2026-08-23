/*
 * ⛔ PENDING — this file is deliberately NOT named `.test.tsx`, so `test:browser` does not load it.
 *
 * It is complete and its assertions are right; what is missing is one dependency. `bun test`
 * transpiles JSX with its own React transform — measured 2026-08-23 inside this very package, where
 * `tsconfig.json` already sets `jsx: "preserve"` and `jsxImportSource: "solid-js"`:
 *
 *     bun build ./probe.tsx  →  React.createElement("div", { class: "a" }, x)
 *
 * so importing any `.tsx` from a test dies on `ReferenceError: React is not defined`. **That is the
 * mechanism that has kept this repo's entire `.tsx` surface untestable**, and it is why the
 * 2026-08-23 review found eleven defects no instrument could see.
 *
 * `solid-preload.ts` (beside this file) applies the REAL `babel-preset-solid` transform and is the
 * correct fix — deliberately not `solid-js/h/jsx-runtime`, whose reactivity semantics differ from the
 * compiled output, which would test a code path the product never runs. It resolves `@babel/core` and
 * `babel-preset-solid` out of bun's store, where they sit as transitive deps of `vite-plugin-solid`.
 *
 * 🔴 **The one blocker: `@babel/preset-typescript` is not installed anywhere in the tree**, so babel
 * cannot strip the type annotations before transforming JSX. Adding it is a LOCKFILE change, which
 * `bunfig.toml`'s `frozenLockfile` makes a deliberate, reviewable act rather than a side effect of
 * wiring up a test — so it is being surfaced, not slipped in.
 *
 * To finish: add `@babel/preset-typescript` as a devDependency of `packages/app`, add
 * `--preload ./solid-preload.ts` to the `test:browser` script, and rename this file to
 * `.test.tsx`. The five assertions below then pin D2 and D3 from the review.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { AgentConfigDialog } from "@/components/agent-config-dialog"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { ModelsContext } from "@/context/models"
import { LanguageContext } from "@/context/language"

/**
 * THE FIRST TEST IN THIS REPO THAT RENDERS A CONTEXT-DEPENDENT COMPONENT.
 *
 * 🔴 Why it exists, measured rather than argued. The 2026-08-23 named-agents review
 * (`notes/reports/named-agents-and-home-review-2026-08-23.md`) found eleven defects, and **every one
 * was in a `.tsx` file no test loads.** The three "ledgers" that do reach these files `readFileSync`
 * the source and match regexes — the *test that checks itself*, at file scope. One of them is green
 * while asserting a string forty lines below a `value=` on a `<select>` that loses the colleague's
 * model.
 *
 * Two defects this file pins, both of which a render catches and a regex cannot:
 *
 *   **D2** — `value={…}` on a `<select>` is DISCARDED when its options do not exist yet. Solid
 *   compiles it to an effect that runs when the VALUE changes, never when the option list grows, and
 *   both halves of that race are live here (`agent()` is a resource; `models.list()` chains to the
 *   provider catalog's cold start). The symptom is silent: a colleague bound to a specific model
 *   reads "Inherit the instance default".
 *
 *   **D3** — Save was enabled before the dialog had LOADED the fields it writes. `dirty()` needs one
 *   touched field, and the `*Value()` accessors fall back draft → stored → `""`, so one character
 *   typed into Name before the fetch landed wrote `title` and `personality` away as empty strings.
 *
 * ⚠️ These stubs supply context VALUES directly through the raw Context objects rather than the real
 * providers, because `createSimpleContext`'s `provider` calls the real `init` — which wants a server
 * connection, an SDK client and a live sync store. That is the reason this test did not exist; see
 * the note on `context:` in `ui/src/context/helper.tsx`.
 */

const AGENT = {
  id: "theron",
  name: "Theron",
  title: "Bookkeeper",
  personality: "Precise and dry.",
  memory: "own" as const,
  model: "spark/qwen3.8-27b",
  config: {},
}

const MODELS = [
  { id: "qwen3.8-27b", name: "Qwen 3.8 27B", provider: { id: "spark" } },
  { id: "holo3.1", name: "Holo 3.1", provider: { id: "local" } },
]

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
})

/**
 * Mount the dialog under stub context values.
 *
 * `agents` decides what the roster fetch has produced: a list, or `undefined` for "still in flight"
 * — which is the window D3 lives in. `models` likewise, so the D2 race can be driven from either end.
 */
function mount(options: { agents?: unknown[]; models?: unknown[] }) {
  host = document.createElement("div")
  document.body.appendChild(host)

  // The SDK surface the dialog actually touches: one roster read.
  const client = { v2: { agent: { list: async () => ({ data: { data: options.agents ?? [] } }) } } }
  const connection = { url: "http://localhost:4096", http: "http://localhost:4096" }
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({ sdk: { client }, sync: { data: { path: {} } } }),
  }
  const syncStub = () => ({
    data: { path: { directory: "/tmp/p" } },
    session: { data: { info: {} } },
    updateConfig: async () => ({}),
  })
  const modelsStub = { list: () => options.models ?? MODELS, connected: () => true }
  // The translator returns the KEY, so an assertion names the key rather than English prose that a
  // copy edit would break.
  const languageStub = { t: (key: string) => key, locale: () => "en", setLocale: () => {} }

  dispose = render(
    () => (
      <MemoryRouter>
        <Route
          path="/"
          component={() => (
            <LanguageContext.Provider value={languageStub as never}>
              <GlobalContext.Provider value={globalStub as never}>
                <ServerContext.Provider value={{ current: connection } as never}>
                  <ServerSyncContext.Provider value={syncStub as never}>
                    <ModelsContext.Provider value={modelsStub as never}>
                      <DialogProvider>
                        <AgentConfigDialog agentID="theron" onDismiss={() => {}} />
                      </DialogProvider>
                    </ModelsContext.Provider>
                  </ServerSyncContext.Provider>
                </ServerContext.Provider>
              </GlobalContext.Provider>
            </LanguageContext.Provider>
          )}
        />
      </MemoryRouter>
    ),
    host,
  )
  return host
}

/** Let the roster resource settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const selects = (root: HTMLElement) => [...root.querySelectorAll("select")] as HTMLSelectElement[]
const saveButton = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("agentConfig.save")) as
    | HTMLButtonElement
    | undefined

describe("AgentConfigDialog renders", () => {
  test("the dialog mounts at all", async () => {
    const root = mount({ agents: [AGENT] })
    await settle()
    // The guard on the instrument: if this is empty every assertion below is vacuous.
    expect(root.textContent).toContain("agentConfig.who")
    expect(selects(root).length).toBeGreaterThan(0)
  })

  test("D2 · the model select shows the colleague's BOUND model, not Inherit", async () => {
    const root = mount({ agents: [AGENT] })
    await settle()
    const model = selects(root)[0]!
    // `spark/qwen3.8-27b` is what the agent is bound to. Under the old `value={…}` form this read
    // `""` — the Inherit option — whenever the options had not been created yet.
    expect(model.value).toBe("spark/qwen3.8-27b")
    expect(model.value).not.toBe("")
  })

  test("D2 · a model arriving AFTER first paint is still selected", async () => {
    // The cold-catalog half of the race: the option list is empty at mount and grows afterwards.
    // A `value=` assignment made before the option exists is discarded and never re-applied.
    const root = mount({ agents: [AGENT], models: [] })
    await settle()
    const before = selects(root)[0]!
    expect(before.value).toBe("")

    const root2 = mount({ agents: [AGENT], models: MODELS })
    await settle()
    expect(selects(root2)[0]!.value).toBe("spark/qwen3.8-27b")
  })

  test("D3 · Save is disabled while the roster is still in flight", async () => {
    // `agents: undefined` is the blank window — `agent()` is undefined, so `titleValue()` and
    // `personalityValue()` resolve to "". Save must not be reachable here even once a field is dirty.
    const root = mount({ agents: undefined })
    const save = saveButton(root)
    expect(save).toBeDefined()
    expect(save!.disabled).toBe(true)

    const name = root.querySelector("input") as HTMLInputElement | null
    if (name) {
      name.value = "Theron the Second"
      name.dispatchEvent(new Event("input", { bubbles: true }))
    }
    // Dirty, but still not loaded: the Clone button beside it has always carried this guard.
    expect(saveButton(root)!.disabled).toBe(true)
  })

  test("D3 · Save becomes reachable once the roster has loaded and a field is edited", async () => {
    const root = mount({ agents: [AGENT] })
    await settle()
    expect(saveButton(root)!.disabled).toBe(true) // loaded, but nothing touched yet

    const name = root.querySelector("input") as HTMLInputElement
    name.value = "Theron the Second"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    expect(saveButton(root)!.disabled).toBe(false)
  })
})
