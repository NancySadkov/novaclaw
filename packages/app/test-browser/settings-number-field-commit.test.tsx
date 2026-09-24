import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createConfigRemover } from "@/utils/config-remove"
import { render } from "solid-js/web"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { OfficerContext } from "@/components/settings-v2/officer-context"
import { SettingsNumberFieldV2 } from "@/components/settings-v2/parts/number-field"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

/**
 * **A settings number box must let you TYPE the value it is asking for.**
 *
 * 🔴 The class under test is *a control that writes on every keystroke, coercing the in-progress
 * value*, and it produced a bug in Context: the reminder budget's handler clamped to its own `min`
 * before persisting (typing `512` sent `Math.max(64, 5)`). The Strict tab's attempts row had the
 * twin (`parsed > 1` beside a `min="1"`); that tab is gone — officer Strict attempts is a Save-time
 * draft, which cannot coerce mid-typing by construction — and the shared control's remaining
 * live-write surface is Context, covered below.
 *
 * ⚠️ **The evidence for the first half is a request COUNT, not the final value.** A clamp that writes
 * the wrong number on the way and the right one at the end leaves identical stored state, so an
 * assertion that only reads the config back is green against the bug. The store below MOVES when it
 * is written, because that echo is what rewrote the box under the typist's hands.
 *
 * ⚠️ Every invariant here carries its opposite. A field that simply refused everything would satisfy
 * "typing does not write"; the control is that a real commit still persists, that three distinct
 * commits are three writes, and that an in-range value raises no refusal.
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

function mount(panel: (officer: () => Record<string, unknown>) => JSX.Element, initial: Record<string, unknown>) {
  const counts = { patch: 0, remove: 0 }
  const [store, setStore] = createStore<{ config: Record<string, unknown>; path: unknown }>({
    config: initial,
    path: { directory: "/tmp/tunes", home: "/home/tester" },
  })

  const sync = () => ({
    data: store,
    updateConfig: async (patch: Record<string, unknown>) => {
      counts.patch++
      // The server merges and this context re-reads — the move that used to rewrite the box.
      const merge = (before: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> => {
        const result = { ...before }
        for (const [key, value] of Object.entries(next)) {
          if (value === undefined) continue
          result[key] =
            value && typeof value === "object" && !Array.isArray(value)
              ? merge((result[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>)
              : value
        }
        return result
      }
      setStore("config", reconcile(merge(store.config, patch)))
      return {}
    },
    removeConfig: createConfigRemover({
      current: () => store.config,
      remove: async (paths) => {
        counts.remove++
        const next = JSON.parse(JSON.stringify(store.config))
        for (const path of paths) {
          let parent = next
          for (const key of path.slice(0, -1)) parent = parent[key]
          delete parent[path.at(-1)!]
        }
        setStore("config", reconcile(next))
      },
      refresh: async () => {},
    }),
    refetchConfig: async () => {
      setStore("config", (prev) => ({ ...prev }))
      return {}
    },
  })

  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <ServerSyncContext.Provider value={sync as never}>{panel(() => ((store.config.agents as Record<string, Record<string, unknown>>)?.nova ?? {}))}</ServerSyncContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  return { counts, config: () => store.config }
}

const settle = async (times = 8) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const box = (label: string) => {
  const found = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null
  if (!found) throw new Error(`no number box labelled "${label}"`)
  return found
}

/** What the browser does per character. Under the bug this ALONE persisted a clamped value. */
const typeInto = (input: HTMLInputElement, value: string) => {
  for (let i = 1; i <= value.length; i++) {
    input.value = value.slice(0, i)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }
}

/** What the browser does on blur or Enter — the only gesture that may reach the network. */
const commit = (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

const refusals = () => [...document.querySelectorAll('[data-slot="settings-v2-number-refused"]')]

const CADENCE = en["officer.context.todo.cadence.title"]
const BUDGET = en["officer.context.todo.budget.title"]

describe("Context — a value below the field's minimum can be typed", () => {
  test("typing 512 into a min-64 box writes nothing until it is committed, then writes 512 once", async () => {
    const { counts, config } = mount((officer) => <OfficerContext agentID="nova" config={officer} />, { agents: { nova: { context: {} } } })
    await settle()

    // The exact sequence that used to persist 64 on its first character and leave `641` behind.
    typeInto(box(BUDGET), "512")
    await settle()
    expect(counts.patch).toBe(0)
    expect(box(BUDGET).value).toBe("512")

    commit(box(BUDGET), "512")
    await settle()

    expect(counts.patch).toBe(1)
    expect(((config().agents as { nova: { context: Record<string, unknown> } }).nova.context as { todo_reminder?: { max_tokens?: number } }).todo_reminder?.max_tokens).toBe(512)
    expect(box(BUDGET).value).toBe("512")
    expect(refusals()).toHaveLength(0)
  })

  test("the control: an ordinary in-range edit still persists, and three edits are three writes", async () => {
    const { counts, config } = mount((officer) => <OfficerContext agentID="nova" config={officer} />, { agents: { nova: { context: {} } } })
    await settle()

    commit(box(CADENCE), "12")
    await settle()
    expect(counts.patch).toBe(1)

    commit(box(CADENCE), "20")
    await settle()
    commit(box(CADENCE), "3")
    await settle()

    // A field that swallowed everything would pass the test above and fail this one.
    expect(counts.patch).toBe(3)
    expect(((config().agents as { nova: { context: Record<string, unknown> } }).nova.context as { todo_reminder?: { cadence?: number } }).todo_reminder?.cadence).toBe(3)
  })

  test("an out-of-range value is refused BY NAME and never stored", async () => {
    const { counts, config } = mount((officer) => <OfficerContext agentID="nova" config={officer} />, { agents: { nova: { context: {} } } })
    await settle()

    commit(box(BUDGET), "5000")
    await settle()

    expect(counts.patch).toBe(0)
    expect((config().agents as { nova: { context: Record<string, unknown> } }).nova.context).toEqual({})
    const said = refusals()
    expect(said).toHaveLength(1)
    // Not merely "invalid": the message names the range, so the user is not asked to guess it.
    expect(said[0]!.textContent).toBe("Enter a whole number between 64 and 4096")
    // The typed value stays put so it can be corrected rather than silently replaced.
    expect(box(BUDGET).value).toBe("5000")
  })

  test("returning to the field clears the refusal, and the correction then persists", async () => {
    const { counts, config } = mount((officer) => <OfficerContext agentID="nova" config={officer} />, { agents: { nova: { context: {} } } })
    await settle()

    commit(box(BUDGET), "5000")
    await settle()
    expect(refusals()).toHaveLength(1)

    // Focus is the "I am fixing it" signal — and it selects the value so the correction REPLACES it
    // rather than being inserted into it (`32768` clicked and typed `8192` → `327819268`).
    box(BUDGET).dispatchEvent(new FocusEvent("focus", { bubbles: false }))
    await settle()
    expect(refusals()).toHaveLength(0)

    commit(box(BUDGET), "512")
    await settle()
    expect(counts.patch).toBe(1)
    expect(((config().agents as { nova: { context: Record<string, unknown> } }).nova.context as { todo_reminder?: { max_tokens?: number } }).todo_reminder?.max_tokens).toBe(512)
  })
})

describe("a human-unit duration may explicitly accept fractions", () => {
  test("0.5 commits and empty clears through the same door", async () => {
    const commits: number[] = []
    let clears = 0
    const [value, setValue] = createSignal<number | undefined>()
    mount(
      () => (
        <SettingsNumberFieldV2
          value={value}
          min={0.5}
          max={60}
          step={0.5}
          allowDecimal
          ariaLabel="Timeout"
          onCommit={(next) => {
            commits.push(next)
            setValue(next)
          }}
          onClear={() => {
            clears += 1
            setValue(undefined)
          }}
        />
      ),
      {},
    )

    commit(box("Timeout"), "0.5")
    await settle()
    expect(commits).toEqual([0.5])

    commit(box("Timeout"), "")
    await settle()
    expect(clears).toBe(1)
    expect(refusals()).toHaveLength(0)
  })
})

/**
 * The Context tab (owner, 2026-09-19). Two structural claims the retired twenty-number-box panel
 * could not state: every session type is ONE 100% split, and the guard's switch lives with the
 * splits it governs. The arrow-key path is the deterministic edit a DOM test can drive — a pointer
 * drag needs layout, which happy-dom does not have.
 */
describe("Context tab — the guard card and its splits", () => {
  test("shows the new copy, four five-part bars, and the shipped threshold", async () => {
    mount((officer) => <OfficerContext agentID="nova" config={officer} />, { agents: { nova: { context: {} } } })
    await settle()

    expect(document.querySelector('[data-section="context-guard"]')?.textContent).toContain(
      en["officer.context.guard.enabled.title"],
    )

    const profiles = [...document.querySelectorAll<HTMLElement>("[data-context-profile]")]
    expect(profiles.map((profile) => profile.dataset.contextProfile)).toEqual([
      "interactive",
      "sub-agent",
      "auto-prompting",
      "goal-oriented",
    ])
    for (const profile of profiles) {
      expect(profile.querySelectorAll(".settings-v2-allocation-seg")).toHaveLength(5)
      expect(profile.querySelectorAll(".settings-v2-allocation-handle")).toHaveLength(4)
    }

    // The threshold row states what is in force even though nothing is stored (default 80).
    expect(box(en["officer.context.compaction.threshold.title"]).value).toBe("80")
  })

  test("an arrow key transfers one point between neighbours and commits once", async () => {
    const { counts, config } = mount((officer) => <OfficerContext agentID="nova" config={officer} />, { agents: { nova: { context: {} } } })
    await settle()

    const handle = document.querySelector<HTMLButtonElement>(
      '[data-context-profile="interactive"] .settings-v2-allocation-handle',
    )
    expect(handle).not.toBeNull()
    handle!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    await settle()

    expect(counts.patch).toBe(1)
    expect((config().agents as { nova: { context: Record<string, unknown> } }).nova.context).toMatchObject({
      profiles: { interactive: { system: 26, messages: 39, retrieval: 10, memory: 5, tool_output: 20 } },
    })
  })

  test("the compaction threshold commits through the shared number field", async () => {
    const { counts, config } = mount((officer) => <OfficerContext agentID="nova" config={officer} />, { agents: { nova: { context: {} } } })
    await settle()

    commit(box(en["officer.context.compaction.threshold.title"]), "70")
    await settle()

    expect(counts.patch).toBe(1)
    expect((config().agents as { nova: { compaction: Record<string, unknown> } }).nova.compaction).toMatchObject({ threshold: 70 })
  })
})
