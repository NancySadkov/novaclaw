import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { OfficerSettingsScreen } from "@/components/officer-settings-screen"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
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
 *   **D3** — Save was enabled before the screen had loaded the fields it writes. `dirty()` needs one
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
const originalMatchMedia = window.matchMedia

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
  window.matchMedia = originalMatchMedia
})

/**
 * Mount the screen under stub context values.
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

  // The server context's ONE shared roster (D8's fix) — `agents.list()` is what the screen reads, and
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
    ensureServerCtx: () => ({
      agents: agentsCache,
      sync: { data: { path: {} } },
      sdk: { server: { http: { url: connection.url } }, event: { listen: () => () => {} } },
    }),
  }
  const syncStub = () => ({
    data: { path: { directory: "/tmp/p" }, config: {} },
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
   * ⚠️ Added when Clear and Retire started CLOSING the cleared chat's tab (2026-08-28). The screen
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
                      <ServerSDKProvider>
                        <ServerSyncContext.Provider value={syncStub as never}>
                          <ModelsContext.Provider value={modelsStub as never}>
                            <TabsContext.Provider value={tabsStub as never}>
                              <DialogProvider>
                                <OfficerSettingsScreen agentID={options.agentID ?? "theron"} onDismiss={() => {}} />
                              </DialogProvider>
                            </TabsContext.Provider>
                          </ModelsContext.Provider>
                        </ServerSyncContext.Provider>
                      </ServerSDKProvider>
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

/** Let the roster resource settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Queries run against `document` so select menus portalled to the body are included.
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
const screenText = () => document.body.textContent ?? ""
/**
 * How many times one i18n KEY was rendered, counted on the STRING rather than on a node.
 *
 * ⚠️ `\\b` is load-bearing: the translator echoes the key, so a plain `includes` would count
 * `agentConfig.clone` inside `agentConfig.cloneNovaTitle` — a toast this screen never renders, which
 * would make "Clone is absent" pass for the wrong reason. After a word boundary, `clone` followed by
 * `N` is not a match and `clone` followed by `.` (the bare label) is.
 */
const labelCount = (key: string) =>
  (screenText().match(new RegExp(`${key.replace(/\./g, "\\.")}\\b`, "g")) ?? []).length

describe("Officer Settings screen renders", () => {
  test("settings tabs use horizontal phone keys, then vertical desktop keys without losing selection", async () => {
    let desktop = false
    let media: MediaQueryList | undefined
    window.matchMedia = (query: string) => {
      const result = originalMatchMedia.call(window, query)
      if (query === "(min-width: 768px)") {
        Object.defineProperty(result, "matches", { configurable: true, get: () => desktop })
        media = result
      }
      return result
    }
    mount({ agents: [AGENT] })
    await settle()

    const navigation = document.querySelector<HTMLElement>('nav[role="tablist"]')!
    const buttons = [...navigation.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!
    expect(navigation.getAttribute("aria-orientation")).toBe("horizontal")
    expect(buttons.filter((button) => button.tabIndex === 0).length).toBe(1)
    buttons[0]!.focus()
    buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    expect(panel.dataset.activeTab).toBe("capabilities")
    expect(document.activeElement).toBe(buttons[1])
    expect(panel.getAttribute("aria-labelledby")).toBe(buttons[1]!.id)
    expect(buttons[1]!.getAttribute("aria-selected")).toBe("true")

    desktop = true
    media!.dispatchEvent(Object.assign(new Event("change"), { matches: true }))
    expect(navigation.getAttribute("aria-orientation")).toBe("vertical")
    expect(panel.dataset.activeTab).toBe("capabilities")
    buttons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
    expect(panel.dataset.activeTab).toBe("profile")
    buttons[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }))
    expect(panel.dataset.activeTab).toBe("work")
  })

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
    expect(screenText()).toContain("agentConfig.governingNote")
    // The form really is editable: text fields and pickers are mounted, not the old two checkboxes.
    // ⚠️ A NUMBER, never the nodes — handing `expect()` an element here is what took 407 s and
    // 11.38 GB to say one sentence; see `happydom.ts`.
    expect(charterControls()).toBeGreaterThan(0)
    // …and exactly three things are absent, because the store refuses them.
    expect(labelCount("agentConfig.clone")).toBe(0)
    expect(labelCount("agentConfig.retire")).toBe(0)
    expect(screenText()).toContain("agentConfig.folderGoverning")
    // The lifecycle actions that still apply ARE present — pausing is not one of the three exceptions,
    // and Save is now unconditional because the profile above it is editable.
    // ⚠️ ONE object comparison rather than two `toBe(true)`s, so a failure NAMES the control that is
    // missing instead of reporting a bare `false`. Asserting on booleans, never on the nodes.
    expect({
      pause: document.querySelector('[data-action="agent-pause"]') !== null,
      save: saveButton() !== undefined,
      clearChat: document.querySelector('[data-action="agent-clear-chat"]') !== null,
    }).toEqual({ pause: true, save: true, clearChat: false })
    // The claim VR-001 was always about: a Save may exist, but the screen wrote nothing merely for
    // being opened.
    expect(writes).toEqual([])
    expect(screenText()).not.toContain("NOTHING was written")
  })

  test("officer actions share the header and Pause remains immediately reversible", async () => {
    const writes: unknown[] = []
    mount({ agents: [AGENT], write: (patch) => writes.push(patch) })
    await settle()
    const header = document.querySelector('[data-slot="agent-settings-header"]')
    expect(header !== null).toBe(true)
    for (const action of ["agent-pause", "agent-clone", "agent-retire", "agent-config-cancel", "agent-config-save"]) {
      const buttons = document.querySelectorAll(`[data-action="${action}"]`)
      expect(buttons.length).toBe(1)
      expect(header?.contains(buttons[0]!)).toBe(true)
    }
    expect(labelCount("agentConfig.close")).toBe(0)
    expect(document.querySelector('[data-action="agent-clear-chat"]') === null).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-action="agent-pause"]')!.click()
    await settle()
    expect(writes).toEqual([{ agents: { theron: { disabled: true } } }])
  })

  test("memory actions live in the Memory tab instead of the lifecycle footer", async () => {
    mount({ agents: [AGENT] })
    await settle()
    // The guard on the instrument: if this is empty every assertion below is vacuous.
    expect(screenText()).not.toContain("agentConfig.who")
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
    // Mode and the durable Goal live in Work. Re-pinned 2026-09-16 (owner): Mood
    // sampling moved to the END of this list, and Superior and Maximum tool wait moved OUT of it.
    // Re-pinned 2026-09-18 (per-agent tuning): Mood sampling moved OUT to its own Affective tab —
    // Mind is now only how this officer THINKS (its models) and how its thinking is bounded.
    // The translator echoes keys, so Mind is asserted to hold what it still owns.
    expect(mind?.textContent).not.toContain("Mood sampling")
    expect(mind?.textContent).not.toContain("agentConfig.mode.interactive")
    expect(mind?.textContent).not.toContain("Goal")
    // The two that left: the reporting line is identity, and a per-step timeout is how the officer
    // works. Neither is a fact about its model.
    expect(mind?.textContent).not.toContain("agentConfig.superior")
    expect(mind?.textContent).not.toContain("agentConfig.maxToolTimeout")

    const work = document.querySelector('[data-section="work"][data-settings-tab="work"]')
    // 🔴 The operating choices — posture, permissions, tool wait, mode, goal and the work rules —
    // live here. Strict and the stuck detector moved OUT to their own tabs (per-agent tuning,
    // 2026-09-18): they fine-tune the harness, not the work.
    const mode = work?.querySelector<HTMLElement>('[aria-label="agentConfig.posture"]')
    expect(mode).toBeDefined()
    expect(selectText(mode!)).toBe("agentConfig.mode.interactive")
    expect((work?.querySelector('input[type="radio"]') ?? null) === null).toBe(true)
    expect(work?.textContent).not.toContain("Goal")
    const capabilities = document.querySelector('[data-section="workers"][data-settings-tab="capabilities"]')
    expect(capabilities?.textContent).toContain("agentConfig.maxToolTimeout")
    expect(capabilities?.textContent).toContain("Edits instead of overwriting")
    expect(capabilities?.textContent).toContain("Maximum active workers")
    expect(document.querySelector('[data-section="context"][data-settings-tab="context"]')).not.toBeNull()
    expect(document.querySelector('[data-section="quality"][data-settings-tab="quality"]')).not.toBeNull()
    expect(work?.textContent).not.toContain("Stuck detector")

    // 🔴 The harness tabs exist beside Work, each owning its detail: Strict (levers + budgets),
    // Affective (mood sampling + temperature) and Introspection (judge + cadence + texts).
    expect(document.querySelector('[data-section="strict"][data-settings-tab="quality"]')).not.toBeNull()
    for (const tab of ["affective", "introspection"])
      expect(document.querySelector(`[data-section="${tab}"][data-settings-tab="mind"]`)).not.toBeNull()
    expect(document.querySelector('[data-section="strict"]')?.textContent).toContain("agentConfig.strict")
    expect(document.querySelector('[data-section="affective"]')?.textContent).toContain("Mood sampling")
    expect(document.querySelector('[data-section="introspection"]')?.textContent).toContain("Stuck detector")

    expect(document.querySelector('[data-section="nudges"][data-settings-tab="nudges"]')).not.toBeNull()
    const messengers = document.querySelector('[data-section="messengers"][data-settings-tab="work"]')
    expect(messengers?.querySelector('[data-section="remote-chat"]')).not.toBeNull()

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

    await choose(mode!, "agent")
    expect(selectText(mode!)).toBe("agentConfig.mode.agent")
    expect(work?.textContent).toContain("Goal")
    const goal = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Goal"]')!
    goal.value = "Publish the reviewed manuscript."
    goal.dispatchEvent(new Event("input", { bubbles: true }))
    for (const title of ["Edits instead of overwriting"]) {
      const label = [...document.querySelectorAll("label")].find((row) => row.textContent?.includes(title))
      label?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click()
    }
    saveButton()!.click()
    await settle()
    expect(writes.at(-1)).toMatchObject({
      agents: {
        theron: {
          // The Agent choice reaches the standing operation mode in the save payload.
          operationMode: "unattended",
          goal: "Publish the reviewed manuscript.",
          surgicalEdits: true,
        },
      },
    })
  })

  test("the Quality tab saves Strict attempts without wiping the stored levers", async () => {
    // 🔴 The merge this tab exists for: editing ONE subfield must not drop the rest of the
    // struct. A `{ attempts }`-only write depends on the store patch-merging structs, which this
    // screen refuses to assume — so it sends the merged struct and this test reads it back whole.
    const writes: unknown[] = []
    mount({
      agents: [{ ...AGENT, config: { strict: { enabled: true, attempts: 3, verification: false } } }],
      write: (patch) => writes.push(patch),
    })
    await settle()

    // The tab strip is literal labels, not i18n keys — find it the way a person does.
    const strictTab = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (button) => button.textContent?.trim() === "Quality",
    )
    expect(strictTab, "the Quality tab should be offered").toBeDefined()
    strictTab!.click()
    await settle()
    expect(document.querySelector("[data-active-tab]")?.getAttribute("data-active-tab")).toBe("quality")

    // The stored values show: the lever reads OFF, the race reads 3.
    const strict = document.querySelector('[data-section="strict"]')!
    expect(strict.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    const attempts = strict.querySelector<HTMLInputElement>('input[aria-label="Parallel attempts"]')!
    expect(attempts.value).toBe("3")
    attempts.value = "5"
    attempts.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()

    saveButton()!.click()
    await settle()
    expect(writes.at(-1)).toMatchObject({
      agents: { theron: { strict: { enabled: true, attempts: 5, verification: false } } },
    })
  })

  test("Mind upgrades a bare-boolean Affective row to a struct without losing the stance", async () => {
    // Old rows store `affective: true`. Touching temperature must keep the opt-in AND carry it
    // as a struct — a bare `true` has nowhere to put a temperature.
    const writes: unknown[] = []
    mount({
      agents: [{ ...AGENT, config: { affective: true } }],
      write: (patch) => writes.push(patch),
    })
    await settle()

    const affectiveTab = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (button) => button.textContent?.trim() === "Mind",
    )
    expect(affectiveTab, "the Mind tab should be offered").toBeDefined()
    affectiveTab!.click()
    await settle()
    expect(document.querySelector("[data-active-tab]")?.getAttribute("data-active-tab")).toBe("mind")

    const affective = document.querySelector('[data-section="affective"]')!
    expect(affective.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    const temperature = affective.querySelector<HTMLInputElement>('input[aria-label="Calm-baseline temperature"]')!
    temperature.value = "0.4"
    temperature.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()

    saveButton()!.click()
    await settle()
    expect(writes.at(-1)).toMatchObject({
      agents: { theron: { affective: { enabled: true, temperature: 0.4 } } },
    })
  })

  test("Mind shows the stored Introspection detail and resets to inherit", async () => {
    const removed: string[][][] = []
    mount({
      agents: [{ ...AGENT, config: { introspection: { enabled: true, cadence: 5 } } }],
      write: () => {},
      remove: (paths) => removed.push(paths),
    })
    await settle()

    const introspectionTab = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (button) => button.textContent?.trim() === "Mind",
    )
    expect(introspectionTab, "the Mind tab should be offered").toBeDefined()
    introspectionTab!.click()
    await settle()
    expect(document.querySelector("[data-active-tab]")?.getAttribute("data-active-tab")).toBe("mind")

    const introspection = document.querySelector('[data-section="introspection"]')!
    expect(introspection.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    expect(introspection.querySelector<HTMLInputElement>('input[aria-label="Introspection cadence"]')?.value).toBe("5")

    // Reset confirms (destructive) and then deletes exactly the tab's key — nothing else.
    document.querySelector<HTMLButtonElement>('[data-action="agent-reset-introspection"]')!.click()
    await settle()
    expect(screenText()).toContain("agentConfig.resetTab.title")
    const confirmReset = [...document.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes("agentConfig.resetTab.action"),
    )
    confirmReset.at(-1)!.click()
    await settle()
    expect(removed.at(-1)).toEqual([["agents", "theron", "introspection"]])
  })

  test("Capabilities denies a tool live and adds a private recipe", async () => {
    // 🔴 Horizon and recipes save LIVE (like Nudges), not through Save: they are
    // replace-semantics lists, and a second save path for the same struct is how one of them
    // silently wins. Each action below asserts its own write the moment it lands.
    const writes: unknown[] = []
    const removed: string[][][] = []
    mount({
      agents: [{ ...AGENT, config: { tools: { bash: false } } }],
      write: (patch) => writes.push(patch),
      remove: (paths) => removed.push(paths),
    })
    await settle()

    const toolsTab = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (button) => button.textContent?.trim() === "Capabilities",
    )
    expect(toolsTab, "the Capabilities tab should be offered").toBeDefined()
    toolsTab!.click()
    await settle()

    const tools = document.querySelector('[data-section="tools"]')!
    expect(tools.textContent).toContain("bash")
    // Forgetting the only rule deletes the key rather than storing `{}` — an officer that
    // never tuned its horizon and one that tuned it back must read the same.
    const forget = tools.querySelector<HTMLButtonElement>('[data-action="agent-tool-forget"]')!
    forget.click()
    await settle()
    expect(removed.at(-1)).toEqual([["agents", "theron", "tools"]])

    // A suggestion denies with one click and writes the merged map, not just the delta.
    const denyRead = [...tools.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Deny read for this officer",
    )
    expect(denyRead, "a read suggestion should be offered").toBeDefined()
    denyRead!.click()
    await settle()
    expect(writes.at(-1)).toMatchObject({ agents: { theron: { tools: { read: false } } } })

    // A private recipe is added through the collision-guarded planner and written whole.
    const add = tools.querySelector<HTMLButtonElement>('[data-action="agent-recipe-add"]')!
    add.click()
    await settle()
    const editor = tools.querySelector('[data-component="officer-recipe-editor"]')!
    const name = editor.querySelector<HTMLInputElement>('input[aria-label="Recipe name"]')!
    name.value = "deploy"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    const description = editor.querySelector<HTMLInputElement>('input[aria-label="Recipe description"]')!
    description.value = "Ship it"
    description.dispatchEvent(new Event("input", { bubbles: true }))
    const manual = editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="Recipe manual"]')!
    manual.value = "run ./ship"
    manual.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    editor.querySelector<HTMLButtonElement>('[data-action="agent-recipe-save"]')!.click()
    await settle()
    expect(writes.at(-1)).toMatchObject({
      agents: { theron: { adhocTools: [{ name: "deploy", description: "Ship it", manual: "run ./ship" }] } },
    })
  })

  test("copy tuning adopts the prototype's model and strict, never its job", async () => {
    // 🔴 The inverse of a clone: tuning crosses, identity and work do not. The fragment must
    // carry `model` and `strict` while `system` and `name` stay on the prototype's side.
    const writes: unknown[] = []
    mount({
      agents: [
        AGENT,
        {
          ...AGENT,
          id: "iris",
          name: "Iris",
          title: "Scout",
          config: {
            model: "spark/qwen",
            strict: { enabled: true, attempts: 3 },
            system: "Find people. Never hire without a trial.",
            name: "Iris",
          },
        },
      ],
      write: (patch) => writes.push(patch),
    })
    await settle()

    document.querySelector<HTMLDetailsElement>("details")!.open = true
    const prototype = document.querySelector<HTMLElement>('[aria-label="Prototype officer"]')
    expect(prototype, "the prototype picker should be offered").toBeDefined()
    await choose(prototype as HTMLElement, "iris")
    document.querySelector<HTMLButtonElement>('[data-action="agent-copy-tuning"]')!.click()
    await settle()
    expect(writes.at(-1)).toMatchObject({
      agents: { theron: { model: "spark/qwen", strict: { enabled: true, attempts: 3 } } },
    })
    const fragment = (writes.at(-1) as { agents: { theron: Record<string, unknown> } }).agents.theron
    expect("system" in fragment).toBe(false)
    expect("name" in fragment).toBe(false)
  })

  test("copy tuning confirms before replacing the officer's own nudges", async () => {
    const writes: unknown[] = []
    mount({
      agents: [
        AGENT,
        {
          ...AGENT,
          id: "iris",
          name: "Iris",
          title: "Scout",
          config: {
            model: "spark/qwen",
            nudges: [
              {
                id: "n1",
                name: "Slow down",
                enabled: true,
                hook: { type: "tool-call", tool: "bash" },
                text: "Breathe.",
              },
            ],
          },
        },
      ],
      write: (patch) => writes.push(patch),
    })
    await settle()

    const prototype = document.querySelector<HTMLElement>('[aria-label="Prototype officer"]')!
    await choose(prototype as HTMLElement, "iris")
    document.querySelector<HTMLButtonElement>('[data-action="agent-copy-tuning"]')!.click()
    await settle()
    // Nothing written yet: replacing a private list destroys, so the copy waits for a yes.
    expect(writes.length).toBe(0)
    const confirmCopy = [...document.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes("Copy tuning"),
    )
    confirmCopy.at(-1)!.click()
    await settle()
    expect(writes.at(-1)).toMatchObject({
      agents: { theron: { model: "spark/qwen" } },
    })
    expect(((writes.at(-1) as { agents: { theron: { nudges: unknown[] } } }).agents.theron.nudges ?? []).length).toBe(1)
  })

  test("portrait selection is a readable button with its filename separate", async () => {
    mount({ agents: [AGENT] })
    await settle()
    const input = document.querySelector<HTMLInputElement>("#agent-portrait-file")
    const label = document.querySelector<HTMLLabelElement>('label[for="agent-portrait-file"]')
    expect(input).not.toBeNull()
    expect(input!.classList.contains("sr-only")).toBe(true)
    expect(label?.textContent).toContain("agentConfig.portraitChoose")
    expect(screenText()).toContain("agentConfig.portraitNone")
    expect(screenText()).not.toContain("agentConfig.portraitRemove")
  })

  test("an uploaded portrait can be removed once, then the action disappears", async () => {
    mount({ agents: [{ ...AGENT, avatar: "/api/agent/theron/avatar?v=1" }] })
    await settle()
    const remove = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "agentConfig.portraitRemove",
    )
    expect(remove).toBeDefined()

    remove!.click()
    expect(screenText()).not.toContain("agentConfig.portraitRemove")
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
    expect(screenText()).toContain("agentConfig.reasoningBudgetOff")
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
