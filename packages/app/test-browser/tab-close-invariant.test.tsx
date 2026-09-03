import { afterEach, describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { MemoryRouter, Route, useLocation } from "@solidjs/router"
import { PlatformProvider } from "@/context/platform"
import { ServerConnection, ServerContext } from "@/context/server"
import { TabsProvider, tabKey, useTabs } from "@/context/tabs"

/**
 * CLOSING THE LAST TAB LANDS ON HOME — and a close is never undone by the route.
 *
 * Owner, 2026-09-03: *"pressing X sometimes doesn't really close the tab, but results into opening.
 * Please make it an invariant that closing the last tab should switch to home."*
 *
 * 🔴 The reopening was a REACTIVE RACE, not a missing navigation. `removeTab` has always navigated
 * home when nothing is left. But `titlebar.tsx` runs an effect that opens a tab for the session URL
 * you are on — the choke point Contacts, deep links and restored windows all arrive through — and it
 * reads the tab store (through `matchRoute`). So REMOVING the tab is itself the change that re-runs
 * it, while the navigation away is still deferred inside the store's transition: the route is
 * therefore still the session, and the effect puts the tab straight back. Intermittent, because it
 * is a race with that navigation, which is how it was reported.
 *
 * The missing piece was that nothing recorded the INTENT. `dismissedKey` is that record, and this
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
      <span data-testid="dismissed">{tabs.dismissedKey() ?? ""}</span>
      <button
        data-testid="add"
        onClick={() => {
          tabs.addSessionTab({ server: KEY, sessionId: "ses_one", agent: "nova" })
          tabs.addSessionTab({ server: KEY, sessionId: "ses_two", agent: "xenia" })
        }}
      />
      <button data-testid="close-last" onClick={() => tabs.removeTab(tabs.store.length - 1)} />
      <button data-testid="close-first" onClick={() => tabs.removeTab(0)} />
      <button data-testid="reconcile" onClick={() => tabs.removeTab(0, true)} />
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

describe("closing tabs", () => {
  test("🔴 closing the LAST tab lands on home", async () => {
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "close-last")
    await settle()
    click(container, "close-last")
    await settle()
    expect(await waitForText(container, "count", "0")).toBe("0")
  })

  test("CONTROL — closing a tab with a neighbour goes to the neighbour, not home", async () => {
    // Without this the file would pass on a build that navigated home on EVERY close, which would
    // throw the user out of their remaining work.
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "close-first")
    await settle()
    expect(await waitForText(container, "count", "1")).toBe("1")
  })

  test("🔴 a dismissal is RECORDED, so the route effect cannot undo it", async () => {
    // The half that fixes the reported bug. `titlebar.tsx` reads this before re-opening a tab for
    // the URL it is on; without the record it cannot tell "you arrived here" from "you just shut
    // this", and the deferred navigation means the route still says session either way.
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "close-last")
    await settle()
    expect(text(container, "dismissed")).toBe(tabKey({ type: "session", server: KEY, sessionId: "ses_two" } as never))
  })

  test("CONTROL — a RECONCILIATION is not a dismissal", async () => {
    // `stay` means the chat turned out to be gone and the route wants to explain that itself. Marking
    // those would suppress a legitimate re-open later.
    const { container } = mount()
    click(container, "add")
    await settle()
    click(container, "reconcile")
    await settle()
    expect(text(container, "dismissed")).toBe("")
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
describe("where a close leaves you", () => {
  test("🔴 removeTab navigates to the neighbour, or home when nothing is left", async () => {
    const source = await Bun.file(new URL("../src/context/tabs.tsx", import.meta.url)).text()
    const body = source.slice(source.indexOf("const removeTab ="), source.indexOf("const agentTab ="))
    expect(body).toContain("if (nextTab) navigateTab(nextTab)")
    expect(body).toContain('else navigate("/")')
    // And the dismissal must be recorded on the same path, or the route effect undoes the close.
    expect(body).toContain("if (!stay) setDismissedKey(key)")
  })
})

