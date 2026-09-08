import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createConfigRemover } from "@/utils/config-remove"
import { render } from "solid-js/web"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { SettingsStrictV2 } from "@/components/settings-v2/strict"
import { SettingsTunesV2 } from "@/components/settings-v2/tunes"
import { SettingsNumberFieldV2 } from "@/components/settings-v2/parts/number-field"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

/**
 * **A settings number box must let you TYPE the value it is asking for.**
 *
 * 🔴 The class under test is *a control that writes on every keystroke, coercing the in-progress
 * value*, and it produced two different-looking bugs in two files. On Tunes, the reminder budget's
 * handler clamped to its own `min` before persisting: typing `512` sent `Math.max(64, 5)` → the
 * instance config was written with **64**, the echoed store rewrote the box to `64`, and the next
 * character appended to give `641`. No keystroke sequence reached 512. On Strict, "Attempts" checked
 * `parsed > 1` beside a `min="1"` on the same element, so typing the `1` its own copy documents
 * stored `0` and blanked the field.
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

function mount(panel: () => JSX.Element, initial: Record<string, unknown>) {
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
            <ServerSyncContext.Provider value={sync as never}>{panel()}</ServerSyncContext.Provider>
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

const CADENCE = en["settings.tunes.todo.cadence.title"]
const BUDGET = en["settings.tunes.todo.budget.title"]
const ATTEMPTS = en["settings.strict.row.attempts.title"]

test("every Strict group can be re-enabled against a merging config store", async () => {
  const groups = ["verification", "recovery", "editingAids", "budgetSteering"] as const
  const { config } = mount(() => <SettingsStrictV2 />, {
    strict: Object.fromEntries(groups.map((key) => [key, false])),
  })
  await settle()
  for (const group of groups) {
    const title = en[`settings.strict.row.${group}.title`]
    const input = [...document.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find((node) =>
      node
        .getAttribute("aria-labelledby")
        ?.split(" ")
        .some((id) => document.getElementById(id)?.textContent === title),
    )!
    expect(input.checked).toBe(false)
    input.click()
    await settle()
    expect((config().strict as Record<string, unknown>)[group]).toBe(true)
    expect(input.checked).toBe(true)
  }
})

describe("Tunes — a value below the field's minimum can be typed", () => {
  test("typing 512 into a min-64 box writes nothing until it is committed, then writes 512 once", async () => {
    const { counts, config } = mount(() => <SettingsTunesV2 />, { context: {} })
    await settle()

    // The exact sequence that used to persist 64 on its first character and leave `641` behind.
    typeInto(box(BUDGET), "512")
    await settle()
    expect(counts.patch).toBe(0)
    expect(box(BUDGET).value).toBe("512")

    commit(box(BUDGET), "512")
    await settle()

    expect(counts.patch).toBe(1)
    expect((config().context as { todo_reminder?: { max_tokens?: number } }).todo_reminder?.max_tokens).toBe(512)
    expect(box(BUDGET).value).toBe("512")
    expect(refusals()).toHaveLength(0)
  })

  test("the control: an ordinary in-range edit still persists, and three edits are three writes", async () => {
    const { counts, config } = mount(() => <SettingsTunesV2 />, { context: {} })
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
    expect((config().context as { todo_reminder?: { cadence?: number } }).todo_reminder?.cadence).toBe(3)
  })

  test("an out-of-range value is refused BY NAME and never stored", async () => {
    const { counts, config } = mount(() => <SettingsTunesV2 />, { context: {} })
    await settle()

    commit(box(BUDGET), "5000")
    await settle()

    expect(counts.patch).toBe(0)
    expect(config().context).toEqual({})
    const said = refusals()
    expect(said).toHaveLength(1)
    // Not merely "invalid": the message names the range, so the user is not asked to guess it.
    expect(said[0]!.textContent).toBe("Enter a whole number between 64 and 4096")
    // The typed value stays put so it can be corrected rather than silently replaced.
    expect(box(BUDGET).value).toBe("5000")
  })

  test("returning to the field clears the refusal, and the correction then persists", async () => {
    const { counts, config } = mount(() => <SettingsTunesV2 />, { context: {} })
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
    expect((config().context as { todo_reminder?: { max_tokens?: number } }).todo_reminder?.max_tokens).toBe(512)
  })
})

describe("Strict — Attempts stores the value its own copy documents", () => {
  test("committing the documented 1 stores 1, and the field keeps showing 1", async () => {
    const { counts, config } = mount(() => <SettingsStrictV2 />, { strict: {} })
    await settle()

    commit(box(ATTEMPTS), "1")
    await settle()

    expect(counts.patch).toBe(1)
    expect((config().strict as { attempts?: number }).attempts).toBe(1)
    expect(box(ATTEMPTS).value).toBe("1")
    expect(refusals()).toHaveLength(0)
  })

  test("the control: 3 still stores 3, and emptying the box clears the key", async () => {
    const { counts, config } = mount(() => <SettingsStrictV2 />, { strict: { attempts: 3 } })
    await settle()
    expect(box(ATTEMPTS).value).toBe("3")

    commit(box(ATTEMPTS), "4")
    await settle()
    expect((config().strict as { attempts?: number }).attempts).toBe(4)

    commit(box(ATTEMPTS), "")
    await settle()
    expect(counts.patch).toBe(1)
    expect(counts.remove).toBe(1)
    expect("attempts" in (config().strict as object)).toBe(false)
  })

  test("an out-of-range attempt count is refused visibly rather than clamped to 8", async () => {
    const { config } = mount(() => <SettingsStrictV2 />, { strict: {} })
    await settle()

    commit(box(ATTEMPTS), "20")
    await settle()

    expect((config().strict as { attempts?: number } | undefined)?.attempts).toBeUndefined()
    expect(refusals()).toHaveLength(1)
    expect(refusals()[0]!.textContent).toBe("Enter a whole number between 1 and 8")
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
