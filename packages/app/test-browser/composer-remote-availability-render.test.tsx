import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { LanguageContext } from "@/context/language"
import { dict as en } from "@/i18n/en"
import {
  RemoteChatSection,
  type ComposerRemoteChatChoice,
  type ComposerRemoteChatState,
} from "@/components/composer/features-control"

/**
 * **THE COMPOSER'S REMOTE-CHAT SECTION HAS THREE ANSWERS, NOT TWO.**
 *
 * 🔴 The controller has computed `availability: "ready" | "loading" | "failed"` since the messenger
 * lists were converted away from a throwing `createResource` — and **nothing rendered it**. The
 * section still branched on `accounts.length > 0` alone, so a refused `GET /api/messenger/account`
 * printed *"No messenger accounts yet — add one in Settings"*: a sentence that sends a user who has
 * three configured accounts to a Settings screen to hunt for a fault that is not there. A feature
 * that is built, tested and never called is not a feature, and the JOIN between the two halves is
 * exactly what neither half's test could see — `composer-remote-degraded-render.test.tsx` proves
 * the controller CARRIES the reading, and proved nothing about whether a user ever sees it.
 *
 * ⚠️ **Three cases, and the pair is what proves it.** "Failed names the outage" alone is satisfied
 * by a section that shouts about an outage whenever the list is empty, which is the same lie in the
 * other direction — so the empty-but-SUCCESSFUL case asserts the original sentence is still there,
 * word for word, and the loaded case asserts the picker is reached. The three differ only in
 * `availability`; the account list is identical between the first two.
 *
 * ⚠️ **Nothing here is process-wide.** The language dictionary is supplied through
 * `LanguageContext.Provider`, not `mock.module` — this directory runs as ONE `bun test` process and
 * the first registration for a specifier wins for every file in it, so a stub here would reach
 * files that never asked for one. `RemoteChatSection` needs no other context.
 */

const LANGUAGE = {
  t: (key: string, params?: Record<string, string | number | boolean>) => {
    const value = (en as Record<string, string>)[key]
    if (value === undefined) return key
    return params === undefined
      ? value
      : Object.entries(params).reduce((text, [name, sub]) => text.replaceAll("{{" + name + "}}", String(sub)), value)
  },
  locale: () => "en",
}

const ACCOUNTS = [
  { id: "a1", label: "Nancy Telegram", driverName: "Telegram", state: "connected" },
  { id: "a2", label: "Studio Discord", driverName: "Discord", state: "connected" },
]

function state(over: Partial<ComposerRemoteChatState>): ComposerRemoteChatState {
  return {
    availability: "ready",
    bindable: true,
    accounts: [],
    binding: undefined,
    loadChats: async () => ({ ok: true, chats: [] as ComposerRemoteChatChoice[] }),
    connect: async () => "ok" as const,
    disconnect: async () => undefined,
    openSettings: () => undefined,
    ...over,
  }
}

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
})

function mount(initial: ComposerRemoteChatState) {
  const [remote, setRemote] = createSignal(initial)
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <LanguageContext.Provider value={LANGUAGE as never}>
        <RemoteChatSection remote={remote()} />
      </LanguageContext.Provider>
    ),
    host,
  )
  return setRemote
}

const text = () => document.querySelector('[data-section="remote-chat"]')?.textContent ?? ""
const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`)
const action = (name: string) => document.querySelector(`[data-action="${name}"]`)

describe("the remote-chat section says WHICH of the three things happened", () => {
  test("a FAILED read names the outage and never claims the account list is empty", () => {
    mount(state({ availability: "failed", accounts: [] }))

    expect(slot("remote-unavailable")).not.toBeNull()
    expect(text()).toContain(en["prompt.remote.unavailable"])
    // The whole point: the false sentence is GONE, and so is the button that acts on it.
    expect(text()).not.toContain(en["prompt.remote.none"])
    expect(action("remote-open-settings")).toBeNull()
  })

  test("a failed read with accounts already in hand is still the outage, not a picker", () => {
    // `availability` folds BOTH lists. Accounts we happen to hold do not tell us whether this chat
    // is already bound, so offering "Link this chat…" would be a second unearned claim.
    mount(state({ availability: "failed", accounts: ACCOUNTS }))

    expect(slot("remote-unavailable")).not.toBeNull()
    expect(action("remote-link")).toBeNull()
  })

  test("CONTROL — a SUCCESSFUL read with no accounts still says exactly what it always said", () => {
    mount(state({ availability: "ready", accounts: [] }))

    expect(action("remote-open-settings")).not.toBeNull()
    expect(text()).toContain(en["prompt.remote.none"])
    expect(slot("remote-unavailable")).toBeNull()
    expect(slot("remote-checking")).toBeNull()
  })

  test("CONTROL — a successful read WITH accounts reaches the picker, unchanged", () => {
    mount(state({ availability: "ready", accounts: ACCOUNTS }))

    expect(action("remote-link")).not.toBeNull()
    expect(text()).toContain(en["prompt.remote.link"])
    expect(slot("remote-unavailable")).toBeNull()
  })

  test("a read still IN FLIGHT over an empty list says so, and does not blank a live picker", () => {
    const setRemote = mount(state({ availability: "loading", accounts: [] }))
    expect(slot("remote-checking")).not.toBeNull()
    expect(text()).not.toContain(en["prompt.remote.none"])

    // The refetch case: `messenger.*` events re-read both lists on every account change, and a
    // section that fell back to "Checking…" whenever a re-read was in flight would tear the picker
    // out from under whoever is using it.
    setRemote(state({ availability: "loading", accounts: ACCOUNTS }))
    expect(slot("remote-checking")).toBeNull()
    expect(action("remote-link")).not.toBeNull()
  })

  test("a draft (no session yet) is unchanged by any of this", () => {
    mount(state({ availability: "failed", bindable: false }))
    expect(text()).toContain(en["prompt.remote.draft"])
    expect(slot("remote-unavailable")).toBeNull()
  })
})
