import { afterEach, describe, expect, test } from "bun:test"
import { createEffect, ErrorBoundary, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { ServerSDKProvider } from "@/context/server-sdk"
import { TabsContext } from "@/context/tabs"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { SettingsProvider, type ExpertiseLevel } from "@/context/settings"
import { useExpertise } from "@/context/expertise"
import { RegistryPage, REGISTRY_COPY } from "@/pages/registry"
import { TerminalPage } from "@/pages/terminal"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

/**
 * **TWO DEVELOPER SURFACES THAT USED TO SAY NOTHING AT ALL WHEN A READ FAILED — plus the two forms
 * that shared one draft.**
 *
 * 🔴 Ruling 2, second half: *an unavailable subsystem names itself instead of rendering empty.*
 *
 * - **Registry's table rail** was a bare `<For each={tables() ?? []}>` with no fallback of any kind.
 *   A failed `/registry/tables` produced an empty 224px column — not an empty state, not an error,
 *   nothing — while the pane beside it said *"Pick a table — hives on the left, rows here."*, an
 *   instruction about a list that had just failed to arrive. It is the strongest form of the
 *   defect: a user cannot tell an empty database from a broken one from a broken app.
 * - **Terminal** held the same `GET /path` read the rail does, folded its failure into `""`, and
 *   gated a `<Show>` on that falsy value — so it rendered *"Loading terminal..."* forever, over a
 *   resource that had already settled and would never re-run. A spinner that will never resolve is
 *   the same false claim as an empty list wearing a different animation.
 *
 * ⚠️ **The pair is the proof, not the failure case.** A screen that always shows its error passes a
 * failure-only test, so every read here is exercised three ways — failing, answering EMPTY, and
 * answering with data — and each case asserts the other two sentences are *absent*.
 *
 * ⚠️ **The third invariant is not about rendering at all.** Registry's *New row* and *Edit rowid N*
 * forms were two booleans over ONE draft store, so opening a row while the insert form was up made
 * both forms the same form: typing in either edited the other, and **Insert** wrote a duplicate of
 * the row the user had opened to look at — on `runtime_setting`, an instance that will not boot. The
 * assertion below reads back what EACH form holds, in both directions, because "they are separate"
 * is only proved by neither one carrying the other's text.
 *
 * ⚠️ **What this file does NOT reach, said rather than left as a gap.** Terminal's success branch
 * mounts `SDKProvider` + `TerminalProvider`, and the workspace those build needs more of the real
 * application than a page-level fixture supplies (`workspace()` comes back undefined here). So the
 * control for *"the failure copy is conditional"* is the still-in-flight case below, which is the
 * one that matters: the old page rendered its spinner forever, and a fix that renders the failure
 * whenever there is no directory yet would be the same lie facing the other way. The success path
 * of the shared `GET /path` read IS exercised, on Registry, where the content does mount.
 *
 * ⚠️ The language stub resolves against the REAL `en` dictionary, so the Terminal assertions are
 * about the sentence a person reads. Echoing keys back would pass just as happily against a raw
 * `terminal.unavailable.title` printed into the page.
 */



const HOME = "/home/tester"
const DIRECTORY = "/home/tester/workshop"
const HTTP = { url: "http://localhost:4096" }
const connection = { type: "http", key: "local", url: HTTP.url, http: HTTP }

/** How `GET /path` behaves. `blank` is a 200 carrying no folder — an ANSWER, not a failure. */
type PathMode = "ok" | "reject" | "blank" | "pending"
/** How a registry read behaves. */
type ReadMode = "ok" | "fail" | "empty"

let pathMode: PathMode = "ok"
let storedPath: Record<string, unknown> | undefined = { home: HOME, directory: DIRECTORY }
let tablesMode: ReadMode = "ok"
let rowsMode: ReadMode = "ok"

const TABLES = [
  { name: "runtime_setting", rowCount: 3 },
  { name: "session", rowCount: 41 },
]
const ROWS = {
  table: "runtime_setting",
  columns: ["key", "value"],
  rowCount: 2,
  rows: [
    { rowid: 1, values: { key: "theme", value: "nova" } },
    { rowid: 2, values: { key: "locale", value: "en" } },
  ],
}

const boom = () => {
  throw new TypeError("Failed to fetch")
}

/** The one server context every page reaches through — `ServerSDKProvider` delegates to it. */
const serverCtx = {
  // ⚠️ `resolveInstanceGlobalDirectory` reads the sync store FIRST and only asks the server when the
  // store has not answered. A fixture that leaves a path here can never reach `GET /path`, so every
  // fault case below has to empty it — which is also the real shape of the bug: a cold client.
  get sync() {
    return { data: { path: storedPath, config: {} }, updateConfig: async () => undefined }
  },
  agents: { list: () => [] },
  sdk: {
    server: { http: HTTP },
    client: {
      path: {
        get: async () => {
          if (pathMode === "reject") return boom()
          if (pathMode === "pending") return await new Promise<never>(() => {})
          if (pathMode === "blank") return { data: {} }
          return { data: { home: HOME, directory: DIRECTORY, data: HOME, roots: [HOME], places: [] } }
        },
      },
      v2: {
        agent: { list: async () => ({ data: { data: [] } }) },
        pty: { list: async () => ({ data: { data: [] } }) },
      },
    },
  },
}

const globalStub = {
  servers: { list: () => [connection] },
  ensureServerCtx: () => serverCtx,
}
const syncStub = () => serverCtx.sync
const tabsStub = { newDraft: () => {}, list: () => [], current: undefined }

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined
let restoreFetch: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
  // ⚠️ The gate runs this whole directory in ONE process, so a global left swapped here is a
  // neighbouring file's mystery failure. Restore before resetting the knobs.
  restoreFetch?.()
  restoreFetch = undefined
  pathMode = "ok"
  storedPath = { home: HOME, directory: DIRECTORY }
  tablesMode = "ok"
  rowsMode = "ok"
  localStorage.clear()
})

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

/** The raw-fetch routes (`utils/instance-fetch.ts`). A rejecting fetch is the transport outage. */
function stubFetch() {
  const original = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input))
    if (url.includes("registry/tables")) {
      if (tablesMode === "fail") throw new TypeError("Failed to fetch")
      return json(tablesMode === "empty" ? [] : TABLES)
    }
    if (url.includes("registry/rows")) {
      if (rowsMode === "fail") throw new TypeError("Failed to fetch")
      return json(rowsMode === "empty" ? { ...ROWS, rowCount: 0, rows: [] } : ROWS)
    }
    // ⚠️ A DELEGATING default, not a blanket `{}`: anything this file did not think about still gets
    // a well-formed 200 rather than a parse error that reads like the regression under test.
    return json({})
  }) as typeof fetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = original
  }
}

/**
 * Both pages are behind an expertise gate, so the level has to be raised or every assertion below
 * is about the gate's copy. It is set through the REAL `useExpertise`, and re-asserted reactively
 * because the settings store loads from storage and would otherwise win the race.
 */
function SetExpertise(props: { level: ExpertiseLevel }) {
  const expertise = useExpertise()
  createEffect(() => {
    if (expertise.level() !== props.level) expertise.setLevel(props.level)
  })
  return null
}

function mount(page: () => JSX.Element, level: ExpertiseLevel) {
  stubFetch()
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <MemoryRouter
        root={(props) => (
          <PlatformProvider value={{ platform: "web" } as never}>
            <SettingsProvider>
              <LanguageContext.Provider value={languageStub as never}>
                <GlobalContext.Provider value={globalStub as never}>
                  <ServerContext.Provider value={{ current: connection, key: "local" } as never}>
                    <ServerSyncContext.Provider value={syncStub as never}>
                      <ServerSDKProvider>
                        <TabsContext.Provider value={tabsStub as never}>
                          <DialogProvider>
                            <SetExpertise level={level} />
                            <ErrorBoundary
                              fallback={(error: unknown) => (
                                <div data-slot="probe-boundary">the whole application is gone: {String(error)}</div>
                              )}
                            >
                              <div data-slot="probe-app">the rest of the application</div>
                              {props.children}
                            </ErrorBoundary>
                          </DialogProvider>
                        </TabsContext.Provider>
                      </ServerSDKProvider>
                    </ServerSyncContext.Provider>
                  </ServerContext.Provider>
                </GlobalContext.Provider>
              </LanguageContext.Provider>
            </SettingsProvider>
          </PlatformProvider>
        )}
      >
        <Route path="*" component={() => page()} />
      </MemoryRouter>
    ),
    host,
  )
}

const settle = async (times = 12) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const bodyText = () => document.body.textContent ?? ""
const boundaryFired = () => document.querySelector('[data-slot="probe-boundary"]') !== null
const appAlive = () => document.querySelector('[data-slot="probe-app"]') !== null

const click = (selector: string, why: string) => {
  const element = document.querySelector(selector) as HTMLElement | null
  expect(element, `${why} — no element matched ${selector}`).not.toBeNull()
  element!.click()
}

const typeInto = (selector: string, value: string) => {
  const field = document.querySelector(selector) as HTMLTextAreaElement | null
  expect(field, `nothing to type into: ${selector}`).not.toBeNull()
  field!.value = value
  field!.dispatchEvent(new Event("input", { bubbles: true }))
}

const valueOf = (selector: string) => {
  const field = document.querySelector(selector) as HTMLTextAreaElement | null
  expect(field, `expected a field at ${selector}`).not.toBeNull()
  return field!.value
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("Registry's table rail tells a failed read apart from an empty database", () => {
  test("a failed /registry/tables is NAMED, and the empty-state sentence is withheld", async () => {
    tablesMode = "fail"
    mount(() => <RegistryPage />, "developer")
    await settle()

    expect(bodyText()).toContain(REGISTRY_COPY.tablesFailed)
    // The whole defect in one line: the rail used to render NOTHING here, and "there are no tables"
    // is a claim about the user's database that a rail with no answer may not make.
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesEmpty)
    expect(boundaryFired()).toBe(false)
    expect(appAlive()).toBe(true)
  })

  test("a successful EMPTY answer is the ordinary empty state, never the failure copy", async () => {
    tablesMode = "empty"
    mount(() => <RegistryPage />, "developer")
    await settle()

    expect(bodyText()).toContain(REGISTRY_COPY.tablesEmpty)
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesFailed)
    expect(boundaryFired()).toBe(false)
  })

  test("tables render, and neither the empty nor the failure copy appears", async () => {
    mount(() => <RegistryPage />, "developer")
    await settle()

    expect(bodyText()).toContain("runtime_setting")
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesFailed)
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesEmpty)
    expect(document.querySelectorAll('[data-component="registry-table"]').length).toBe(TABLES.length)
  })

  test("a failed GET /path becomes the rail's failure, not a rail that never asks", async () => {
    // 🔴 The root fix reaching this screen. `resolveInstanceGlobalDirectory` used to swallow the
    // rejection and return "", which gates the table read off — so the rail sat at "not asked"
    // forever with nothing on it. It now rejects, and `failedWhen` makes it the rail's own failure.
    storedPath = undefined
    pathMode = "reject"
    mount(() => <RegistryPage />, "developer")
    await settle()

    expect(bodyText()).toContain(REGISTRY_COPY.tablesFailed)
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesEmpty)
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesLoading)
    expect(boundaryFired()).toBe(false)
  })

  test("tables render when the directory came from GET /path, not from the sync store", async () => {
    // The positive control for the contract change in `utils/routing-directory.ts`. Removing its
    // `.catch` had to leave the SUCCESS path untouched, and the test above it would pass just as
    // well against a resolver that had stopped answering at all.
    storedPath = undefined
    mount(() => <RegistryPage />, "developer")
    await settle()

    expect(bodyText()).toContain("runtime_setting")
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesFailed)
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesEmpty)
  })

  test("a 200 with no folder is also named — an instance that cannot route is not an empty one", async () => {
    storedPath = undefined
    pathMode = "blank"
    mount(() => <RegistryPage />, "developer")
    await settle()

    expect(bodyText()).toContain(REGISTRY_COPY.tablesFailed)
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesEmpty)
  })

  test("a read still in flight says it is reading — it does not claim a failure", async () => {
    // The control for the two above: a page that renders the failure unconditionally would pass
    // every assertion so far. `pending` never settles, so nothing may be concluded from it.
    storedPath = undefined
    pathMode = "pending"
    mount(() => <RegistryPage />, "developer")
    await settle()

    expect(bodyText()).toContain(REGISTRY_COPY.tablesLoading)
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesFailed)
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesEmpty)
  })

  test("a failed row read is named in the pane, and does not leave it saying Loading", async () => {
    rowsMode = "fail"
    mount(() => <RegistryPage />, "developer")
    await settle()
    click('[data-component="registry-table"]', "the table rail should have listed a table to open")
    await settle()

    expect(bodyText()).toContain(REGISTRY_COPY.rowsFailed)
    expect(bodyText()).not.toContain("Loading…")
    // The rail itself is healthy: one panel's fault must not be reported as the other's.
    expect(bodyText()).not.toContain(REGISTRY_COPY.tablesFailed)
    expect(boundaryFired()).toBe(false)
  })
})

describe("Registry's two forms cannot share a draft", () => {
  test("typing in New row, then opening an existing row, leaves each form holding its own text", async () => {
    mount(() => <RegistryPage />, "developer")
    await settle()
    click('[data-component="registry-table"]', "the rail should have listed runtime_setting")
    await settle()

    // Open the insert form and type a key into it.
    const addRow = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Add row"))
    expect(addRow, "the row pane should offer Add row once a table is open").toBeDefined()
    addRow!.click()
    await settle()
    typeInto('[data-registry-new-column="key"]', "brand-new-key")

    // Now click an existing row — the exact gesture in the report: "check a column name".
    click('[data-component="registry-row"]', "the row pane should have listed a row to open")
    await settle()

    // 🔴 Both directions. Before the fix these two selectors read the SAME store, so the second
    // form's `reconcile` had already overwritten the first form's text and the first assertion
    // failed; a fix that merely closed the insert form would fail it too, by deleting what was
    // typed. Neither form may carry the other's value.
    expect(valueOf('[data-registry-new-column="key"]')).toBe("brand-new-key")
    expect(valueOf('[data-registry-column="key"]')).toBe("theme")

    // And it holds while editing continues: typing in the editor does not reach the insert draft.
    typeInto('[data-registry-column="key"]', "theme-edited")
    await settle()
    expect(valueOf('[data-registry-new-column="key"]')).toBe("brand-new-key")
    expect(valueOf('[data-registry-column="key"]')).toBe("theme-edited")
  })

  test("switching tables takes the insert form with it, and does not point it at the new table", async () => {
    // The second facet: `openTable` used to leave `creating` true, so the insert form stayed on
    // screen with the PREVIOUS table's columns under a heading naming the new one.
    mount(() => <RegistryPage />, "developer")
    await settle()
    const rail = [...document.querySelectorAll('[data-component="registry-table"]')] as HTMLElement[]
    expect(rail.length).toBe(2)
    rail[0]!.click()
    await settle()

    const addRow = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Add row"))
    addRow!.click()
    await settle()
    typeInto('[data-registry-new-column="key"]', "half-typed")
    expect(document.querySelector('[data-component="registry-new-row"]')).not.toBeNull()

    rail[1]!.click()
    await settle()
    expect(document.querySelector('[data-component="registry-new-row"]')).toBeNull()

    // Going back restores the draft, because nothing threw it away — and it is still ITS table's.
    rail[0]!.click()
    await settle()
    expect(valueOf('[data-registry-new-column="key"]')).toBe("half-typed")
  })
})

describe("Terminal names an unresolvable working directory instead of spinning", () => {
  test("a failed GET /path is NAMED promptly, and the spinner is gone", async () => {
    storedPath = undefined
    pathMode = "reject"
    mount(() => <TerminalPage />, "advanced")
    await settle()

    expect(bodyText()).toContain(en["terminal.unavailable.title"])
    expect(bodyText()).toContain(en["terminal.unavailable.description"])
    // The defect itself: this sentence used to be the ONLY thing this page would ever say.
    expect(bodyText()).not.toContain(en["terminal.loading"])
    expect(document.querySelector('[data-slot="terminal-directory-failed"]')).not.toBeNull()
    expect(boundaryFired()).toBe(false)
    expect(appAlive()).toBe(true)
  })

  test("a 200 with no folder is named too — the instance answered, and has nowhere to run", async () => {
    storedPath = undefined
    pathMode = "blank"
    mount(() => <TerminalPage />, "advanced")
    await settle()

    expect(bodyText()).toContain(en["terminal.unavailable.title"])
    expect(bodyText()).not.toContain(en["terminal.loading"])
  })

  test("a read still in flight says Loading, and does NOT claim the terminal failed", async () => {
    // The control. A page that renders its failure whenever it has no directory yet would pass both
    // tests above and still be wrong — "could not start" is a settled claim.
    storedPath = undefined
    pathMode = "pending"
    mount(() => <TerminalPage />, "advanced")
    await settle()

    expect(bodyText()).toContain(en["terminal.loading"])
    expect(bodyText()).not.toContain(en["terminal.unavailable.title"])
    expect(boundaryFired()).toBe(false)
  })
})
