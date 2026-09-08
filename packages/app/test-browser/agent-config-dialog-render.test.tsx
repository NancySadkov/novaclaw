import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider, useDialog } from "@novaclaw/ui/context/dialog"
import { AgentConfigDialog } from "@/components/agent-config-dialog"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { ModelsContext } from "@/context/models"
import { TabsContext } from "@/context/tabs"
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
  // ⚠️ An OBJECT, not a ref string — `AgentLike.model` is `{ providerID, id }` and `modelValue()`
  // re-serialises it with `modelRef`. A string here silently yields "" and would have looked
  // exactly like the D2 defect this test exists to catch.
  model: { providerID: "spark", id: "qwen3.8-27b" },
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
  // ⚠️ `dispose()` does NOT clear the portal. `Kobalte.Portal` appends the dialog to `document.body`,
  // outside the mount host, so without this the previous test's dialog is still in the document and
  // `document.querySelector` returns ITS controls — every later assertion then reads a stale render
  // and passes or fails for the wrong reason. Caught by dumping the DOM: run alone the save button
  // was correctly `disabled=true`, run in sequence it was the prior test's enabled one.
  document.body.innerHTML = ""
})

/**
 * Mount the dialog under stub context values.
 *
 * `agents` decides what the roster fetch has produced: a list, or `undefined` for "still in flight"
 * — which is the window D3 lives in. `models` likewise, so the D2 race can be driven from either end.
 */
function mount(options: {
  agentID?: string
  agents?: unknown[]
  models?: () => unknown[]
  write?: (patch: unknown) => void
  remove?: (paths: string[][]) => void
}) {
  host = document.createElement("div")
  document.body.appendChild(host)

  // The server context's ONE shared roster (D8's fix) — `agents.list()` is what the dialog reads, and
  // `undefined` from it is the in-flight window D3 lives in.
  const connection = { url: "http://localhost:4096", http: "http://localhost:4096" }
  const agentsCache = {
    list: () => options.agents,
    loading: () => options.agents === undefined,
    error: () => undefined,
    refetch: () => {},
  }
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({ agents: agentsCache, sync: { data: { path: {} } } }),
  }
  const syncStub = () => ({
    data: { path: { directory: "/tmp/p" } },
    session: { data: { info: {} } },
    updateConfig: async (patch: unknown) => options.write?.(patch),
    removeConfig: async (paths: string[][]) => options.remove?.(paths),
  })
  const modelsStub = { list: () => options.models?.() ?? MODELS, connected: () => true }
  // The translator returns the KEY, so an assertion names the key rather than English prose that a
  // copy edit would break.
  // Deliberately echoes the KEY rather than resolving copy — this file asserts which key a row
  // reaches for, not what it says. `plural` echoes the group for the same reason.
  const languageStub = {
    t: (key: string) => key,
    plural: (group: string) => group,
    locale: () => "en",
    setLocale: () => {},
  }
  /**
   * ⚠️ Added when Clear and Retire started CLOSING the cleared chat's tab (2026-08-28). The dialog
   * had reached no further than its own server before that, so a context it now depends on was
   * missing here and every render in this file died on `Tabs context must be used within a context
   * provider` — the mount test caught it, which is the whole reason it exists.
   */
  const tabsStub = { closeSessionTab: () => {}, store: [] as never[] }

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
                      <TabsContext.Provider value={tabsStub as never}>
                        <DialogProvider>
                          <Opener agentID={options.agentID ?? "theron"} />
                        </DialogProvider>
                      </TabsContext.Provider>
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

/**
 * Mount the dialog THE WAY THE APP DOES — through the dialog stack, not bare.
 *
 * ⚠️ Not a convenience. `AgentConfigDialog` renders the v2 `Dialog` shell, whose `Kobalte.Content`
 * must sit under a Kobalte root; the stack is what supplies it (`ui/src/context/dialog.tsx` wraps
 * each layer in `<Kobalte modal open={…}>`). Mounting the component directly throws
 * `useDialogContext must be used within a Dialog component` — so a bare mount would be testing a
 * composition the product never builds.
 */
function Opener(props: { agentID: string }) {
  const dialog = useDialog()
  onMount(() => void dialog.show(() => <AgentConfigDialog agentID={props.agentID} onDismiss={() => {}} />))
  return null
}

/** Let the roster resource settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * ⚠️ Queries run against `document`, NOT the mount host. `Kobalte.Portal` moves the dialog out of the
 * host subtree and onto `document.body`, so `host.querySelector` finds nothing and every assertion
 * would pass or fail for the wrong reason. Reading the document is what the user sees.
 */
const selects = () => [...document.querySelectorAll<HTMLElement>('[data-component="select-v2"]')]
const selectText = (select: HTMLElement) =>
  select.querySelector<HTMLElement>('[data-slot="select-v2-value-text"]')?.textContent ?? ""
const openSelect = async (select: HTMLElement) => {
  select.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
  )
  await Promise.resolve()
  select.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }))
  await settle()
}
const choose = async (select: HTMLElement, key: string) => {
  await openSelect(select)
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.dataset.key === key)
  expect(option, `option ${key} should be present`).toBeDefined()
  option!.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
  )
  await Promise.resolve()
  option!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }))
  await settle()
}
const saveButton = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("agentConfig.save")) as
    | HTMLButtonElement
    | undefined
const dialogText = () => document.body.textContent ?? ""

describe("AgentConfigDialog renders", () => {
  test("VR-001 · the governing colleague is read-only before a write can be attempted", async () => {
    const writes: unknown[] = []
    mount({
      agentID: "nova",
      agents: [{ ...AGENT, id: "nova", name: "Nova" }],
      write: (patch) => writes.push(patch),
    })
    await settle()

    expect(dialogText()).toContain("agentConfig.governingLocked")
    expect(saveButton()).toBeUndefined()
    expect(
      document.querySelector(
        'input:not([disabled]), textarea:not([disabled]), [data-component="select-v2"]:not([data-disabled])',
      ),
    ).toBeNull()
    expect(document.querySelector('[data-action="agent-clear-chat"]')).not.toBeNull()
    expect(dialogText()).toContain("agentConfig.clearChat")
    expect(dialogText()).toContain("agentConfig.clone")
    expect(writes).toEqual([])
    expect(dialogText()).not.toContain("NOTHING was written")
  })

  test("the dialog mounts at all", async () => {
    mount({ agents: [AGENT] })
    await settle()
    // The guard on the instrument: if this is empty every assertion below is vacuous.
    expect(dialogText()).toContain("agentConfig.who")
    expect(selects().length).toBeGreaterThan(0)
    expect(document.querySelector('[data-component="control-scope"][data-scope="colleague"]')).not.toBeNull()
  })

  test("D2 · the model select shows the colleague's BOUND model, not Inherit", async () => {
    mount({ agents: [AGENT] })
    await settle()
    const model = document.querySelector<HTMLElement>('[aria-label="agentConfig.mind"]')!
    // `spark/qwen3.8-27b` is what the agent is bound to. Under the old `value={…}` form this read
    // `""` — the Inherit option — whenever the options had not been created yet.
    expect(selectText(model)).toBe("Qwen 3.8 27B")
    expect(selectText(model)).not.toBe("agentConfig.modelInherit")
  })

  test("D2 · a model arriving AFTER first paint is still selected", async () => {
    // 🔴 THE COLD-CATALOG HALF OF THE RACE, and the one a second `mount()` cannot express: the
    // option list must be empty at first paint and then GROW in place, because that is what the
    // provider catalog does. `value={…}` compiles to an effect keyed on the VALUE, so an assignment
    // made before the option existed is discarded and never re-applied when the list arrives —
    // the colleague's bound model then reads "Inherit the instance default" forever.
    const [models, setModels] = createSignal<unknown[]>([])
    mount({ agents: [AGENT], models })
    await settle()
    const model = document.querySelector<HTMLElement>('[aria-label="agentConfig.mind"]')!
    expect(selectText(model)).toBe("agentConfig.modelInherit")

    setModels(MODELS)
    await settle()
    expect(selectText(model)).toBe("Qwen 3.8 27B")
  })

  test("D3 · Save is disabled while the roster is still in flight", async () => {
    // `agents: undefined` is the blank window — `agent()` is undefined, so `titleValue()` and
    // `personalityValue()` resolve to "". Save must not be reachable here even once a field is dirty.
    mount({ agents: undefined })
    await settle()
    const save = saveButton()
    expect(save).toBeDefined()
    expect(save!.disabled).toBe(true)

    const name = document.querySelector("input") as HTMLInputElement | null
    if (name) {
      name.value = "Theron the Second"
      name.dispatchEvent(new Event("input", { bubbles: true }))
    }
    // Dirty, but still not loaded: the Clone button beside it has always carried this guard.
    expect(saveButton()!.disabled).toBe(true)
  })

  test("D3 · Save becomes reachable once the roster has loaded and a field is edited", async () => {
    mount({ agents: [AGENT] })
    await settle()
    expect(saveButton()!.disabled).toBe(true) // loaded, but nothing touched yet

    const name = document.querySelector("input") as HTMLInputElement
    name.value = "Theron the Second"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    expect(saveButton()!.disabled).toBe(false)
  })

  test("an officer can set zero as a real reasoning override", async () => {
    const writes: unknown[] = []
    mount({ agents: [AGENT], write: (patch) => writes.push(patch) })
    await settle()
    const budget = document.querySelector("#agent-reasoning-budget") as HTMLInputElement
    budget.value = "0"
    budget.dispatchEvent(new Event("input", { bubbles: true }))
    expect(dialogText()).toContain("agentConfig.reasoningBudgetOff")
    saveButton()!.click()
    await settle()
    expect((writes[0] as { agents: { theron: Record<string, unknown> } }).agents.theron.reasoningBudget).toBe(0)
  })

  test("an officer can report through another officer, while descendants cannot create a cycle", async () => {
    const writes: unknown[] = []
    const iris = { ...AGENT, id: "iris", name: "Iris", superior: "theron" }
    const wren = { ...AGENT, id: "wren", name: "Wren" }
    mount({ agents: [AGENT, iris, wren], write: (patch) => writes.push(patch) })
    await settle()
    const superior = document.querySelector<HTMLElement>("#agent-superior")!
    await openSelect(superior)
    const superiorKeys = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
      option.getAttribute("data-key"),
    )
    expect(superiorKeys).not.toContain("iris")
    const nova = { ...AGENT, id: "nova", name: "Nova" }
    // Nova is represented by the default option rather than a duplicate roster choice.
    expect(superiorKeys.filter((key) => key === "nova")).toHaveLength(1)
    expect(nova.id).toBe("nova")
    const wrenOption = document.querySelector<HTMLElement>('[role="option"][data-key="wren"]')!
    wrenOption.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
    )
    await Promise.resolve()
    wrenOption.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
    )
    await settle()
    saveButton()!.click()
    await settle()
    expect((writes[0] as { agents: { theron: Record<string, unknown> } }).agents.theron.superior).toBe("wren")
  })
})

test("returning a colleague to default model and no requirement deletes both overrides", async () => {
  const writes: unknown[] = []
  const removals: string[][][] = []
  mount({
    agents: [{ ...AGENT, config: { needsTier: "medium", reasoningBudget: 512 } }],
    write: (patch) => writes.push(patch),
    remove: (paths) => removals.push(paths),
  })
  await settle()
  const model = document.querySelector<HTMLElement>('[aria-label="agentConfig.mind"]')!
  const tier = document.querySelector<HTMLElement>("#agent-needs-tier")!
  await choose(model, "inherit")
  await choose(tier, "none")
  const budget = document.querySelector("#agent-reasoning-budget") as HTMLInputElement
  budget.value = ""
  budget.dispatchEvent(new Event("input", { bubbles: true }))
  saveButton()!.click()
  await settle()
  const patch = writes[0] as { agents: { theron: Record<string, unknown> } }
  expect(patch.agents.theron.model).toBeUndefined()
  expect(patch.agents.theron.needsTier).toBeUndefined()
  expect(removals).toEqual([
    [
      ["agents", "theron", "model"],
      ["agents", "theron", "needsTier"],
      ["agents", "theron", "reasoningBudget"],
    ],
  ])
})
