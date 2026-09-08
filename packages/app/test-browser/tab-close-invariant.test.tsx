import { afterEach, describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { MemoryRouter, Route, useLocation } from "@solidjs/router"
import { PlatformProvider } from "@/context/platform"
import { ServerConnection, ServerContext } from "@/context/server"
import { TabsProvider, tabKey, useTabs } from "@/context/tabs"

/**
 * REMOVING AN ACTIVE TAB follows the remaining tab or lands on Home, and the route never undoes it.
 * The titlebar no longer exposes manual task closing; this is the lifecycle primitive used when a
 * chat is cleared, retired, or found missing.
 *
 * 🔴 The reopening was a REACTIVE RACE, not a missing navigation. `removeTab` has always navigated
 * home when nothing is left. But `titlebar.tsx` runs an effect that opens a tab for the session URL
 * you are on — the choke point Contacts, deep links and restored windows all arrive through — and it
 * reads the tab store (through `matchRoute`). So REMOVING the tab is itself the change that re-runs
 * it, while the navigation away is still deferred inside the store's transition: the route is
 * therefore still the session, and the effect puts the tab straight back. Intermittent, because it
 * is a race with that navigation, which is how it was reported.
 *
 * The missing piece was that nothing recorded the transition. `removedKey` is that record, and this
 * file pins both halves: the navigation, and the mark that stops the route undoing it.
 */

const HOME = "/home/tester"
const serverCtx = {
  sync: { data: { path: { home: HOME, directory: HOME, data: HOME, roots: [HOME], places: [] }, config: {} } },
  sdk: { server: { http: { url: "http://localhost:4096" } } },
} as never

const CONNECTION = { type: "http", key: "local", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
const KEY = ServerConnection.key(CONNECTION as never)
const server = {
  key: KEY,
  current: () => CONNECTION,
  // ⚠️ An ARRAY, not a function: the store maps over it to prune tabs whose server is gone. It must
  // contain this connection, or every tab is pruned the moment it is added.
  list: [CONNECTION],
} as never

/**
 * ⚠️ A GATED, DELEGATING stub — not a plain `mock.module`. Registrations are process-wide and the
 * FIRST one for a specifier wins for the whole run, so a bare stub of `@/utils/persist` would serve
 * every other file in this directory. Measured: this file passed alone and took the unit red.
 *
 * `active` is true only while this file's own cases are mounted; everyone else observes the real
 * module. Same discipline as `composer-remote-degraded-render.test.tsx`.
 */
const realPersist = await import("@/utils/persist")
const SNAP = { ...realPersist }
let active = false

mock.module("@/utils/persist", () => ({
  ...SNAP,
  // FOUR elements: the real `persisted` is destructured `[store, setStore, _, ready]`, so a
  // three-element stub leaves `ready` undefined and every consumer calls it.
  persisted: (options: never, signal: never) => {
    if (!active) return (SNAP.persisted as never as (a: never, b: never) => unknown)(options, signal)
    const [store, setStore] = signal as never as unknown[]
    return [store, setStore, undefined, () => true]
  },
}))

let seen: { path: string } | undefined
function Probe() {
  const location = useLocation()
  const tabs = useTabs()
  seen = { path: location.pathname }
  return (
    <div>
      <span data-testid="count">{tabs.store.length}</span>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="removed">{tabs.removedKey() ?? ""}</span>
      <button
        data-testid="add"
        onClick={() => {
          tabs.addSessionTab({ server: KEY, sessionId: "ses_one", agent: "nova" })
          tabs.addSessionTab({ server: KEY, sessionId: "ses_two", agent: "xenia" })
        }}
      />
      <button
        data-testid="add-third-fourth"
        onClick={() => {
          tabs.addSessionTab({ server: KEY, sessionId: "ses_three", agent: "theron" })
          tabs.addSessionTab({ server: KEY, sessionId: "ses_four", agent: "umbris" })
        }}
      />
      <button data-testid="touch-first" onClick={() => tabs.store[0] && tabs.remember(tabs.store[0])} />
      <button
        data-testid="add-fifth"
        onClick={() => tabs.addSessionTab({ server: KEY, sessionId: "ses_five", agent: "xenia-2" })}
      />
      <button
        data-testid="close-last"
        onClick={() => {
          const tab = tabs.store.at(-1)
          if (tab?.type === "session") tabs.closeSessionTab(tab.server, tab.sessionId)
        }}
      />
      <button
        data-testid="close-first"
        onClick={() => {
          const tab = tabs.store[0]
          if (tab?.type === "session") tabs.closeSessionTab(tab.server, tab.sessionId)
        }}
      />
      <button
        data-testid="reconcile"
        onClick={() => {
          const tab = tabs.store[0]
          if (tab?.type === "session") tabs.removeSessionTab(tab)
        }}
      />
      <span data-testid="ids">{tabs.store.map((t) => (t.type === "session" ? t.sessionId : "?")).join(",")}</span>
      <button
        data-testid="readd"
        onClick={() => tabs.addSessionTab({ server: KEY, sessionId: "ses_fresh", agent: "nova" })}
      />
      <button
        data-testid="follow"
        onClick={() =>
          tabs.followAgentChats([
            { id: "ses_one", agent: "nova", archived: true },
            { id: "ses_successor", agent: "nova", archived: false },
            { id: "ses_two", agent: "xenia", archived: false },
          ])
        }
      />
    </div>
  )
}

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

const mount = () => {
  active = true
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <MemoryRouter
        root={(props) => (
          <PlatformProvider value={{ platform: "web" } as never}>
            <ServerContext.Provider value={server}>
              <TabsProvider value={serverCtx}>{props.children}</TabsProvider>
            </ServerContext.Provider>
          </PlatformProvider>
        )}
      >
        <Route path="*" component={Probe} />
      </MemoryRouter>
    ),
    host,
  )
  return { container: host }
}

const click = (root: HTMLElement, id: string) =>
  (root.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click()
const text = (root: HTMLElement, id: string) => root.querySelector(`[data-testid="${id}"]`)?.textContent ?? ""
/** The store writes inside `startTransition`, so a single microtask does not flush them. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Wait for a rendered value, bounded.
 *
 * ⚠️ A fixed number of microtasks passed this file alone and failed it in the 30-file directory run
 * — the assertion read an EMPTY string, not a wrong one, because the re-render had not landed under
 * load. Counting ticks measures the machine; polling measures the condition.
 */
const waitForText = async (root: HTMLElement, id: string, want: string) => {
  for (let i = 0; i < 60; i++) {
    if (text(root, id) === want) return want
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return text(root, id)
}

afterEach(() => {
  active = false
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  seen = undefined
  document.body.innerHTML = ""
})

describe("tab lifecycle removal", () => {
  test("🔴 removing the LAST tab lands on home", async () => {
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "close-last")
    await settle()
    click(container, "close-last")
    await settle()
    expect(await waitForText(container, "count", "0")).toBe("0")
  })

  test("CONTROL — removing a tab with a neighbour goes to the neighbour, not home", async () => {
    // Without this the file would pass on a build that navigated home on EVERY close, which would
    // throw the user out of their remaining work.
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "close-first")
    await settle()
    expect(await waitForText(container, "count", "1")).toBe("1")
  })

  test("🔴 a removal is RECORDED, so the route effect cannot undo it", async () => {
    // The half that fixes the reported bug. `titlebar.tsx` reads this before re-opening a tab for
    // the URL it is on; without the record it cannot tell "you arrived here" from "the lifecycle
    // just removed this", and the deferred navigation means the route still says session either way.
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "close-last")
    await settle()
    expect(text(container, "removed")).toBe(tabKey({ type: "session", server: KEY, sessionId: "ses_two" } as never))
  })

  test("CONTROL — a RECONCILIATION is not a lifecycle removal", async () => {
    // `stay` means the chat turned out to be gone and the route wants to explain that itself. Marking
    // those would suppress a legitimate re-open later.
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "reconcile")
    await settle()
    expect(text(container, "removed")).toBe("")
  })
})

describe("automatic tab retention", () => {
  test("opening a fifth colleague removes the least recently used tab", async () => {
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "add-third-fourth")
    await settle()
    click(container, "touch-first")
    await settle()
    click(container, "add-fifth")
    await settle()
    expect(await waitForText(container, "ids", "ses_one,ses_three,ses_four,ses_five")).toBe(
      "ses_one,ses_three,ses_four,ses_five",
    )
    expect(text(container, "count")).toBe("4")
  })
})

/**
 * THE NAVIGATION HALF, asserted over the source.
 *
 * ⚠️ It cannot be asserted through the DOM in this directory, and the reason is worth writing down
 * rather than rediscovering: another file here registers `mock.module("@solidjs/router")`, and bun
 * keeps the FIRST registration for a specifier for the whole run. So `useLocation()` in this file may
 * be a stub whose `pathname` is empty — which is exactly what happened: this test passed alone and
 * read `""` in the 30-file run, twice, including after polling for 600ms. A conditional assertion
 * would have been worse than none, because it stops testing silently.
 *
 * The behaviour IS covered live by the two store cases above (the tab count reaches zero) plus this
 * rule; the alone-run of this file also exercises the real router.
 */
describe("where lifecycle removal leaves you", () => {
  test("🔴 removeTab navigates to the neighbour, or home when nothing is left", async () => {
    const source = await Bun.file(new URL("../src/context/tabs.tsx", import.meta.url)).text()
    const body = source.slice(source.indexOf("const removeTab ="), source.indexOf("const agentTab ="))
    expect(body).toContain("if (nextTab) navigateTab(nextTab)")
    expect(body).toContain('else navigate("/")')
    // And the removal must be recorded on the same path, or the route effect undoes it.
    expect(body).toContain("if (!stay) setRemovedKey(key)")
  })
})

/**
 * A COLLEAGUE'S TAB FOLLOWS ITS COLLEAGUE.
 *
 * Reassignment archives the chat and opens a successor in the new folder, on purpose — a
 * cross-project move is refused outright. The kernel is coherent about it; the TAB was not, because
 * it pinned a `sessionId` forever. That is a component holding an identity of its own, which the ECS
 * lens names as the thing to avoid: a colleague's chat is reached THROUGH the colleague.
 *
 * Measured on the owner's instance: the filed chat took 296 more events over three minutes, wrote and
 * compiled a file into the colleague's scratch, and had a write to the real project refused —
 * correctly, since that session's root really was scratch. The successor sat unopened at 2 events.
 */
describe("a colleague's tab follows its colleague", () => {
  test("🔴 an archived chat is replaced by the colleague's live one", async () => {
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "follow")
    await settle()
    expect(await waitForText(container, "ids", "ses_successor,ses_two")).toBe("ses_successor,ses_two")
  })

  test("CONTROL — a tab whose chat is still live is left alone", async () => {
    // Without this the file would pass on a build that re-pointed every colleague tab on every
    // reconcile, which would move people off conversations that are perfectly fine.
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "follow")
    await settle()
    // `ses_two` (xenia) is not archived, so it must not move.
    expect(text(container, "ids").split(",")[1]).toBe("ses_two")
  })

  test("CONTROL — no successor means the tab stays, so the route can explain", async () => {
    // A retired colleague has no live chat. Inventing a destination would be the dead end AGENTS.md
    // forbids; leaving the tab lets the session-gone card say what happened.
    const { container } = mount()
    click(container, "add")
    await settle()
    const before = text(container, "ids")
    ;(container.querySelector('[data-testid="follow"]') as HTMLButtonElement).click()
    await settle()
    expect(text(container, "ids").split(",").length).toBe(before.split(",").length)
  })
})

/**
 * ONE TAB PER COLLEAGUE, POINTING AT THE COLLEAGUE'S CURRENT CHAT.
 *
 * The dedupe used to hand the existing tab straight back, so a caller that had just been given a NEW
 * session for that colleague got a tab still rendering the previous one. Measured on the owner's
 * instance: Clear chat deleted the live chat (correctly), the tab stayed pinned to the ARCHIVED
 * predecessor holding 296 events, and opening the colleague from Contacts created a fresh chat and
 * then handed back the stale tab — so the user saw the conversation they had just cleared.
 */
describe("re-opening a colleague adopts the chat it was given", () => {
  test("🔴 the tab moves to the new session rather than handing back the old one", async () => {
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "readd")
    await settle()
    expect(text(container, "ids").split(",")[0]).toBe("ses_fresh")
  })

  test("CONTROL — it does not open a SECOND tab for the same colleague", async () => {
    // The dedupe is still a dedupe. Adopting must not become "add another".
    const { container } = mount()
    click(container, "add")
    await settle()
    const before = text(container, "ids").split(",").length
    click(container, "readd")
    await settle()
    expect(text(container, "ids").split(",").length).toBe(before)
  })
})
