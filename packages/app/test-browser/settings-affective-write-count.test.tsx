import { afterEach, describe, expect, test } from "bun:test"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { GlobalContext } from "@/context/global"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { ServerContext } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { SettingsAffectiveV2 } from "@/components/settings-v2/affective"
import { SettingsWebSearchV2 } from "@/components/settings-v2/web-search"
import { languageStub } from "./language-stub"

/**
 * **ONE GESTURE ON THE AFFECTIVE TAB MUST PRODUCE ONE WRITE.**
 *
 * 🔴 The evidence in this file is a **request COUNT**, not a final value, and that distinction is
 * the whole reason the defect it guards survived. A duplicated config write is idempotent — the
 * stored `affective` object ends up identical whether it was written once or a thousand times — so
 * every assertion that reads the store back was green while the tab was hammering the server. It was
 * only visible to someone watching the network, which is how the owner found it on 2026-09-01: one
 * click, two `PATCH /global/config`; one pick of "Default", two `POST /api/config/remove`, the
 * second answering **400** for a path that no longer named anything, surfaced to the user as
 * *"Saving affective settings failed"* after a clear that had in fact worked.
 *
 * ⚠️ **The mechanism is a REACTIVE re-entry, not a doubled event binding** — the second request
 * arrives after the first one's refetch has settled. `PresetFieldV2` hands `SelectV2` an option
 * array it rebuilds from the current value (a "Custom (…)" entry comes and goes, so the array cannot
 * be memoised on identity). Kobalte's `SelectBase` runs an effect on every change of its option keys
 * — *"delete selected keys that do not match any option in the listbox"* — which calls
 * `setSelectedKeys`; `SelectBase` defaults `allowDuplicateSelectionEvents` to `true`, so that fires
 * `onChange` **with the selection unchanged**. Write → refetch → options rebuilt → the droplist
 * re-reports its own selection → write again. Against the live app it stopped at two writes only
 * because TanStack Query's structural sharing returns the identical object for the second, unchanged
 * refetch; the store below does not share structure, so before the fix these cases ran to five
 * figures. Both endings are the same defect.
 *
 * ⚠️ **The Web Search tab is the CONTROL, and it is a control for a reason**: it drives the same
 * `updateConfig`, the same `Switch`, the same `<Show><TabsV2.Content>` wrapper — and has no
 * reactively rebuilt droplist. It was correct before this fix and must still be correct after it. A
 * change that moves its count has broken the shared write path rather than this tab.
 */


let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
})

/** Every mutation the tab can reach the server with, counted separately: they are different verbs. */
type Counts = { patch: number; remove: number; removeFailed: number }

/**
 * Mount one settings panel over a config store that MOVES when it is written, because a re-entry
 * that only fires on the refetch is invisible to a store that stands still.
 *
 * The `remove` stub reproduces `POST /api/config/remove`'s real contract — a path that names nothing
 * is a **400**, not a silent success (ruling 2) — so a duplicated clear shows up here as the failure
 * the user actually saw, rather than as a second harmless request.
 */
function mount(panel: () => JSX.Element, initial: Record<string, unknown>) {
  const counts: Counts = { patch: 0, remove: 0, removeFailed: 0 }
  const [store, setStore] = createStore<{ config: Record<string, unknown>; path: unknown }>({
    config: initial,
    path: { directory: "/tmp/affective", home: "/home/tester" },
  })

  const sync = () => ({
    data: store,
    updateConfig: async (patch: Record<string, unknown>) => {
      counts.patch++
      // The server merges, and this context then re-reads — which is what moves the store under the
      // handler that just wrote, and the only condition under which the re-entry is observable.
      setStore("config", (prev) => ({ ...prev, ...patch }))
      return {}
    },
    refetchConfig: async () => {
      setStore("config", (prev) => ({ ...prev }))
      return {}
    },
  })

  const sdk = {
    client: {
      v2: {
        config: {
          remove: async (input: { configRemoveRequest: { paths: string[][] } }) => {
            counts.remove++
            const [head, key] = input.configRemoveRequest.paths[0] as [string, string]
            const section = { ...((store.config[head] as Record<string, unknown>) ?? {}) }
            if (!(key in section)) {
              counts.removeFailed++
              throw new Error("NOTHING was removed. The whole request was rolled back.")
            }
            delete section[key]
            setStore("config", (prev) => ({ ...prev, [head]: section }))
            return {}
          },
        },
      },
    },
  }

  const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
  const globalStub = { servers: { list: () => [connection] }, ensureServerCtx: () => ({ sdk }) }

  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      // The REAL Platform and Settings providers: every `SettingsRowV2` gates on expertise, and a
      // hand-made level here would let this file drift from how the dialog resolves it.
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={globalStub as never}>
              <ServerContext.Provider value={{ current: connection } as never}>
                <ServerSDKProvider>
                  <ServerSyncContext.Provider value={sync as never}>
                    <DialogProvider>{panel()}</DialogProvider>
                  </ServerSyncContext.Provider>
                </ServerSDKProvider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  return { counts, config: () => store.config }
}

/** Enough turns for a write, its refetch, and anything the refetch wakes up, to have finished. */
const settle = async (times = 8) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const switches = () => [...document.querySelectorAll('[data-slot="switch-control"]')] as HTMLElement[]
const rawBox = () => document.querySelector('input[inputmode="decimal"]') as HTMLInputElement

/** Commit a value the way the raw box commits one: `commit="change"`, so `change` is the gesture. */
const commit = (value: string) => {
  const box = rawBox()
  box.value = value
  box.dispatchEvent(new Event("change", { bubbles: true }))
}

describe("the Affective tab writes once per gesture", () => {
  test("one click on Enable is one PATCH, with a temperature already set", async () => {
    // A stored temperature is what arms the re-entry: the droplist then has a selection to
    // re-report. With the field empty the second write lands on `clear()`, whose own guard swallows
    // it — so the empty case would pass against the bug and prove nothing.
    const { counts, config } = mount(() => <SettingsAffectiveV2 />, { affective: { temperature: 0.9 } })
    await settle()
    expect(switches().length).toBe(2)

    switches()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle()

    expect(counts.patch).toBe(1)
    // The gesture still did what it was for, and did not disturb the neighbouring row.
    expect(config().affective).toEqual({ temperature: 0.9, enabled: true })
  })

  test("one committed value is one PATCH; three distinct values are three, not six", async () => {
    const { counts, config } = mount(() => <SettingsAffectiveV2 />, { affective: {} })
    await settle()

    commit("0.9")
    await settle()
    expect(counts.patch).toBe(1)

    commit("0.3")
    await settle()
    commit("0.7")
    await settle()

    // Three real edits, three writes. This half is what keeps the fix from being a swallow: a guard
    // that suppressed everything would satisfy the count above and fail here.
    expect(counts.patch).toBe(3)
    expect(config().affective).toEqual({ temperature: 0.7 })
  })

  test("typing does NOT write — the box commits on change, one PATCH per commit", async () => {
    // The documented contract of `commit="change"` on this tab: `onValue` is a network write, so a
    // per-keystroke commit would send one PATCH per character and store the half-typed values on the
    // way. Asserted here so a later "fix" that restores the default cannot pass unnoticed.
    const { counts } = mount(() => <SettingsAffectiveV2 />, { affective: {} })
    await settle()

    const box = rawBox()
    for (const partial of ["0", "0.", "0.9"]) {
      box.value = partial
      box.dispatchEvent(new Event("input", { bubbles: true }))
    }
    await settle()
    expect(counts.patch).toBe(0)

    commit("0.9")
    await settle()
    expect(counts.patch).toBe(1)
  })

  test("a re-commit of the value already stored writes nothing at all", async () => {
    const { counts } = mount(() => <SettingsAffectiveV2 />, { affective: { temperature: 0.9 } })
    await settle()

    commit("0.9")
    await settle()

    expect(counts.patch).toBe(0)
    expect(counts.remove).toBe(0)
  })

  test("a clear is one remove, and no remove is ever answered 400", async () => {
    const { counts, config } = mount(() => <SettingsAffectiveV2 />, { affective: { temperature: 0.9, enabled: true } })
    await settle()

    commit("")
    await settle()

    expect(counts.remove).toBe(1)
    // The half the user saw: a second remove for a path that no longer names anything is a 400, and
    // a toast reporting that a clear which WORKED had failed.
    expect(counts.removeFailed).toBe(0)
    // A clear is the delete verb only — it must not also merge the key back in.
    expect(counts.patch).toBe(0)
    expect(config().affective).toEqual({ enabled: true })
  })
})

describe("the Web Search tab, unchanged", () => {
  test("one click on a built-in engine switch is still exactly one PATCH", async () => {
    const { counts, config } = mount(() => <SettingsWebSearchV2 />, { web_search: {} })
    await settle()
    expect(switches().length).toBe(2)

    switches()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle()

    expect(counts.patch).toBe(1)
    expect(config().web_search).toEqual({ disabledEngines: ["duckduckgo"] })
  })
})
