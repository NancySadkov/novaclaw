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
import { SettingsProvider } from "@/context/settings"
import { PlatformProvider } from "@/context/platform"
import { dict } from "@/i18n/en"

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
 *   typed into Name before the fetch landed wrote `title` away as an empty string.
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
  /** Drives the kernel's enablement predicate; absent means every model is runnable. */
  modelsEnabled?: (key: { providerID: string; modelID: string }) => boolean
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
  const modelsStub = {
    list: () => options.models?.() ?? MODELS,
    connected: () => true,
    // The kernel's own enablement predicate (Settings → Models). Default ON so every existing test
    // keeps its runnable catalog; a test drives the switched-off path through `modelsEnabled`.
    enabled: (key: { providerID: string; modelID: string }) => options.modelsEnabled?.(key) ?? true,
  }
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
      <PlatformProvider value={{ platform: "web" } as never}>
        <MemoryRouter>
          <Route
            path="/"
            component={() => (
              <SettingsProvider>
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
              </SettingsProvider>
            )}
          />
        </MemoryRouter>
      </PlatformProvider>
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
/**
 * Pick an option by its VISIBLE text rather than its key.
 *
 * ⚠️ Needed for the "No requirement" choice: its key is a sentinel (`none`), and reading the control
 * back by the word a user actually picks is the assertion that matters.
 */
const chooseText = async (select: HTMLElement, label: string) => {
  await openSelect(select)
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === label,
  )
  expect(option, `option "${label}" should be present`).toBeDefined()
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
/**
 * Controls that could rewrite the CHARTER: a text field, a textarea, a picker. Counted, not returned
 * — see the note at `charterControls`'s first use below on what handing a failing assertion an
 * ELEMENT costs. A checkbox is deliberately NOT one of these.
 */
const charterControls = () =>
  document.querySelectorAll('input[type="text"], input:not([type]), textarea, [data-component="select-v2"]').length
const dialogText = () => document.body.textContent ?? ""
/**
 * How many times one i18n KEY was rendered, counted on the STRING rather than on a node.
 *
 * ⚠️ `\\b` is load-bearing: the translator echoes the key, so a plain `includes` would count
 * `agentConfig.clone` inside `agentConfig.cloneNovaTitle` — a toast this dialog never renders, which
 * would make "Clone is absent" pass for the wrong reason. After a word boundary, `clone` followed by
 * `N` is not a match and `clone` followed by `.` (the bare label) is.
 */
const labelCount = (key: string) =>
  (dialogText().match(new RegExp(`${key.replace(/\./g, "\\.")}\\b`, "g")) ?? []).length

describe("AgentConfigDialog renders", () => {
  test("VR-001 · the governing colleague is edited like any other, minus the three fixed things", async () => {
    const writes: unknown[] = []
    mount({
      agentID: "nova",
      agents: [{ ...AGENT, id: "nova", name: "Nova" }],
      write: (patch) => writes.push(patch),
    })
    await settle()

    // 🔴 Re-pinned 2026-09-15 to the owner's ruling — *"ensure Nova's profile is as editable by user as
    // any other officer, except user can't assign Nova a project folder, clone or retire Nova"*. The
    // read-only projection screen (`data-agent-profile="governing-readonly"`) is GONE; the ordinary
    // editable form is what renders, and the note that replaced the old lock sentence names the three
    // exceptions rather than leaving the user to discover a refusal.
    expect(dialogText()).toContain("agentConfig.governingNote")
    // The form really is editable: text fields and pickers are mounted, not the old two checkboxes.
    // ⚠️ A NUMBER, never the nodes — handing `expect()` an element here is what took 407 s and
    // 11.38 GB to say one sentence; see `happydom.ts`.
    expect(charterControls()).toBeGreaterThan(0)
    // …and exactly three things are absent, because the store refuses them.
    expect(labelCount("agentConfig.clone")).toBe(0)
    expect(labelCount("agentConfig.retire")).toBe(0)
    expect(dialogText()).toContain("agentConfig.folderGoverning")
    // The lifecycle actions that still apply ARE present — pausing is not one of the three exceptions,
    // and Save is now unconditional because the profile above it is editable.
    // ⚠️ ONE object comparison rather than two `toBe(true)`s, so a failure NAMES the control that is
    // missing instead of reporting a bare `false`. Asserting on booleans, never on the nodes.
    expect({
      pause: document.querySelector('[data-action="agent-pause"]') !== null,
      // ⚠️ Found by its LABEL, not by a `data-action`: the ordinary footer's Save has never carried
      // one (only the deleted governing screen did), and inventing an attribute to satisfy a test is
      // the tail wagging the dog. `saveButton()` is the helper the rest of this file already uses.
      save: saveButton() !== undefined,
      clearChat: document.querySelector('[data-action="agent-clear-chat"]') !== null,
    }).toEqual({ pause: true, save: true, clearChat: true })
    // The claim VR-001 was always about: a Save may exist, but the dialog wrote nothing merely for
    // being opened.
    expect(writes).toEqual([])
    expect(dialogText()).not.toContain("NOTHING was written")
  })

  test("memory actions live in the Memory tab instead of the lifecycle footer", async () => {
    mount({ agents: [AGENT] })
    await settle()
    // The guard on the instrument: if this is empty every assertion below is vacuous.
    expect(dialogText()).not.toContain("agentConfig.who")
    expect(selects().length).toBeGreaterThan(0)
    expect(document.querySelector('[data-component="control-scope"][data-scope="colleague"]')).not.toBeNull()
    const memoryCard = document.querySelector('[data-section="memory"][data-settings-tab="memory"]')
    const clear = document.querySelector('[data-action="agent-clear-memory"]')
    const open = document.querySelector('[data-action="agent-open-memory"]')
    expect(memoryCard).not.toBeNull()
    expect(clear?.closest('[data-settings-tab="memory"]')).toBe(memoryCard)
    expect(open?.closest('[data-settings-tab="memory"]')).toBe(memoryCard)
    expect(open?.textContent).toBe("agentConfig.memoryOpen")
    expect(dict["agentConfig.memoryOpen"]).toBe("Memories")
    expect(document.querySelectorAll('[data-action="agent-clear-memory"]').length).toBe(1)
    expect(document.querySelectorAll('[data-action="agent-open-memory"]').length).toBe(1)
  })

  test("the restored officer controls each live in their own settings tab", async () => {
    const writes: unknown[] = []
    mount({ agents: [AGENT], write: (patch) => writes.push(patch) })
    await settle()

    const navigation = document.querySelector('nav[aria-label="Officer settings"]')
    expect(navigation?.classList.contains("overflow-x-auto")).toBe(true)
    expect(navigation?.classList.contains("md:flex-col")).toBe(true)
    expect([...navigation!.querySelectorAll("button")].every((button) => button.classList.contains("min-h-10"))).toBe(
      true,
    )

    const mind = document.querySelector('[data-section="model"][data-settings-tab="mind"]')
    // 🔴 Re-pinned 2026-09-15 (twice): the Interactive/Unattended PAIR became ONE switch, and then
    // that switch and the durable Goal moved to the WORK tab. Re-pinned again 2026-09-16 (owner): Mood
    // sampling moved to the END of this list, and Superior and Maximum tool wait moved OUT of it.
    // The translator echoes keys, so Mind is asserted to hold what it still owns — how this officer
    // THINKS (its models) and how its thinking is bounded.
    expect(mind?.textContent).toContain("Mood sampling")
    expect(mind?.textContent).not.toContain("agentConfig.unattended")
    expect(mind?.textContent).not.toContain("Goal")
    // The two that left: the reporting line is identity, and a per-step timeout is how the officer
    // works. Neither is a fact about its model.
    expect(mind?.textContent).not.toContain("agentConfig.superior")
    expect(mind?.textContent).not.toContain("agentConfig.maxToolTimeout")
    // 🔴 "At the end of the list" is a DOM-ORDER claim, not a membership one: Mood sampling is the
    // LAST labelled control in the Mind card. A membership assertion would pass with it back at the
    // top, which is the state the owner asked to leave.
    const mindLabels = [...(mind?.querySelectorAll("label") ?? [])]
    expect(mindLabels.at(-1)?.textContent).toContain("Mood sampling")

    const work = document.querySelector('[data-section="work"][data-settings-tab="work"]')
    // 🔴 The operating choices — posture, permissions, Strict, and now Maximum tool wait — live here.
    expect(work?.textContent).toContain("agentConfig.unattended")
    expect(work?.textContent).toContain("agentConfig.unattended.off")
    // The control is a real switch, not a radio pair. Asserted as a BOOLEAN — never hand `expect()` an
    // element; see the note at `charterControls` above.
    expect((work?.querySelector('[data-component="switch"]') ?? null) !== null).toBe(true)
    expect((work?.querySelector('input[type="radio"]') ?? null) === null).toBe(true)
    expect(work?.textContent).toContain("Goal")
    expect(work?.textContent).toContain("agentConfig.maxToolTimeout")
    expect(work?.textContent).toContain("Context guard")
    expect(work?.textContent).toContain("Edits instead of overwriting")
    expect(work?.textContent).toContain("Stuck detector")
    expect(work?.textContent).toContain("Quality gates")

    expect(document.querySelector('[data-section="nudges"][data-settings-tab="nudges"]')).not.toBeNull()
    const io = document.querySelector('[data-section="input-output"][data-settings-tab="io"]')
    expect(io?.textContent).toContain("Input / Output")
    expect(io?.querySelector('[data-section="remote-chat"]')).not.toBeNull()

    const profile = document.querySelector('[data-section="profile"][data-settings-tab="profile"]')
    expect(profile?.textContent).toContain("Import profile")
    expect(profile?.textContent).toContain("Export profile")
    expect(profile?.querySelector('[data-action="agent-personality-import"]')?.classList.contains("w-full")).toBe(true)
    // 🔴 The reporting line is identity, so it lives here (owner, 2026-09-16), LAST — after the name,
    // title, job brief and portrait. Asserted in DOM order for the same reason as Mood
    // sampling above: "moved to Profile" is satisfied by any position, and this pins the position.
    expect(profile?.textContent).toContain("agentConfig.superior")
    const profileLabels = [...(profile?.querySelectorAll("label") ?? [])]
    expect(profileLabels.at(-1)?.textContent).toContain("agentConfig.superior")

    // 🔴 The mode control is a SWITCH now (owner ruling 2026-09-15), and it lives in the WORK tab
    // (owner, 2026-09-15), so this drives it the way a person does: one click turns Unattended ON.
    // It used to click the "interactive" radio, which was the old default's resting state — a control
    // that is already off proves nothing about being wired, so the assertion below reads "unattended"
    // rather than "interactive".
    document.querySelector<HTMLInputElement>('[data-section="work"] [data-component="switch"] input')!.click()
    const goal = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Goal"]')!
    goal.value = "Publish the reviewed manuscript."
    goal.dispatchEvent(new Event("input", { bubbles: true }))
    for (const title of [
      "Context guard",
      "Edits instead of overwriting",
      "Stuck detector",
      "Quality gates",
      "Mood sampling",
    ]) {
      const label = [...document.querySelectorAll("label")].find((row) => row.textContent?.includes(title))
      label?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click()
    }
    saveButton()!.click()
    await settle()
    expect(writes.at(-1)).toMatchObject({
      agents: {
        theron: {
          // One click on the Work tab's switch, and it reaches the save payload as the unattended
          // mode. This is the half that proves the control is WIRED rather than merely rendered.
          operationMode: "unattended",
          goal: "Publish the reviewed manuscript.",
          contextBudget: false,
          surgicalEdits: true,
          introspection: true,
          quality: true,
          affective: true,
        },
      },
    })
  })

  test("portrait selection is a readable button with its filename separate", async () => {
    mount({ agents: [AGENT] })
    await settle()
    const input = document.querySelector<HTMLInputElement>("#agent-portrait-file")
    const label = document.querySelector<HTMLLabelElement>('label[for="agent-portrait-file"]')
    expect(input).not.toBeNull()
    expect(input!.classList.contains("sr-only")).toBe(true)
    expect(label?.textContent).toContain("agentConfig.portraitChoose")
    expect(dialogText()).toContain("agentConfig.portraitNone")
    expect(dialogText()).not.toContain("agentConfig.portraitRemove")
  })

  test("an uploaded portrait can be removed once, then the action disappears", async () => {
    mount({ agents: [{ ...AGENT, avatar: "/api/agent/theron/avatar?v=1" }] })
    await settle()
    const remove = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "agentConfig.portraitRemove",
    )
    expect(remove).toBeDefined()

    remove!.click()
    expect(dialogText()).not.toContain("agentConfig.portraitRemove")
  })

  test("the command-caption switch belongs to Model, not How it works", async () => {
    mount({ agents: [AGENT] })
    await settle()
    const model = document.querySelector('[data-section="model"]')
    const work = document.querySelector('[data-section="work"]')
    expect(model?.textContent).toContain("agentConfig.toolLabels")
    expect(work?.textContent).not.toContain("agentConfig.toolLabels")
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

  test("🔴 a switched-off model is not offered, and the bound one is LABELLED rather than hidden", async () => {
    // The colleague is bound to `spark/qwen3.8-27b`, which the instance switched off. The kernel
    // substitutes for it (owner: a disabled model IS unavailable and only the owner may re-enable
    // it), so offering it as a fresh pick would be a control that lies. What must NOT happen is the
    // other lie: silently filtering it out of the option list, which makes the select display
    // "Default Model" while the stored setting still says otherwise.
    mount({
      agents: [AGENT],
      modelsEnabled: (key) => !(key.providerID === "spark" && key.modelID === "qwen3.8-27b"),
    })
    await settle()
    const model = document.querySelector<HTMLElement>('[aria-label="agentConfig.mind"]')!
    expect(selectText(model)).toBe("agentConfig.modelSwitchedOff")
    expect(model.textContent).not.toContain("agentConfig.modelInherit")
    // …and the row below names the one repair that exists.
    expect(document.querySelector('[data-section="model"]')?.textContent).toContain("agentConfig.modelSwitchedOffHelp")

    await openSelect(model)
    const labels = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent)
    // The bound model is shown as its own labelled entry, not as a runnable choice…
    expect(labels).toContain("agentConfig.modelSwitchedOff")
    expect(labels).not.toContain("Qwen 3.8 27B")
    // …and the runnable sibling it COULD be moved to is still offered.
    expect(labels).toContain("Holo 3.1")
  })

  test("D3 · Save is disabled while the roster is still in flight", async () => {
    // `agents: undefined` is the blank window — `agent()` is undefined, so `titleValue()` resolves
    // to "". Save must not be reachable here even once a field is dirty.
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

test("the class a colleague may REQUIRE never offers Special", async () => {
  // 🔴 The two vocabularies are deliberately different lengths. `special` marks a model the harness
  // must not route to by itself, so "this role requires a Special model" is a contradiction the server
  // refuses at the SCHEMA — and the picker must not offer a choice the write would reject.
  mount({ agents: [{ ...AGENT, config: {} }], write: () => {}, remove: () => {} })
  await settle()
  const select = document.querySelector<HTMLElement>("#agent-needs-taxonomy")!
  await openSelect(select)
  expect(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((item) => item.textContent?.trim()),
  ).toEqual(["agentConfig.needsTaxonomyNone", "taxonomy.smart", "taxonomy.usual", "taxonomy.fast"])
})

test("returning a colleague to default model and no requirement deletes both overrides", async () => {
  const writes: unknown[] = []
  const removals: string[][][] = []
  mount({
    agents: [{ ...AGENT, config: { needsTaxonomy: "smart", reasoningBudget: 512 } }],
    write: (patch) => writes.push(patch),
    remove: (paths) => removals.push(paths),
  })
  await settle()
  const model = document.querySelector<HTMLElement>('[aria-label="agentConfig.mind"]')!
  const taxonomy = document.querySelector<HTMLElement>("#agent-needs-taxonomy")!
  await choose(model, "inherit")
  await chooseText(taxonomy, "agentConfig.needsTaxonomyNone")
  const budget = document.querySelector("#agent-reasoning-budget") as HTMLInputElement
  budget.value = ""
  budget.dispatchEvent(new Event("input", { bubbles: true }))
  saveButton()!.click()
  await settle()
  const patch = writes[0] as { agents: { theron: Record<string, unknown> } }
  expect(patch.agents.theron.model).toBeUndefined()
  expect(patch.agents.theron.needsTaxonomy).toBeUndefined()
  expect(removals).toEqual([
    [
      ["agents", "theron", "model"],
      ["agents", "theron", "needsTaxonomy"],
      ["agents", "theron", "reasoningBudget"],
    ],
  ])
})
