import { afterEach, describe, expect, test } from "bun:test"
import { ErrorBoundary, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { SettingsProvider } from "@/context/settings"
import { NovaHealthBoard } from "@/components/settings-v2/nova-health"
import { SettingsProjectSection } from "@/components/settings-v2/project"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"
import { NotificationContext } from "@/context/notification"

/**
 * **TWO SETTINGS PANELS, RENDERED AGAINST AN INSTANCE THAT WILL NOT ANSWER.**
 *
 * 🔴 The vision clause this file exists to enforce is *"the UI never crashes to a dead-end"*: when
 * something faults, the surface degrades and says so. A `createResource` whose fetcher rejects
 * **throws from its own accessor** — `solid-js/dist/solid.cjs` `read()` re-throws the stored error,
 * and `.latest` does the same even when an `initialValue` was supplied — so a panel that reads one
 * without a guard does not degrade. It hands the outage to the app's single root `ErrorBoundary`,
 * which replaces the entire application with the error page.
 *
 * The health board made that self-defeating: its own *"could not be reached"* line could never
 * render, because the signal list read the accessor first. The tab a person opens **because**
 * something is already wrong was the one guaranteed to break in their hands. Settings → General's
 * project section had the same shape on the DEFAULT tab.
 *
 * ⚠️ **Three cases per panel, and the third is the one that keeps the fix honest.**
 *   1. The fetch rejects → the panel renders its NAMED failure copy, and the boundary around it did
 *      NOT fire. Both halves are asserted; either alone is satisfiable by the bug.
 *   2. The fetch succeeds → the ordinary content renders, unchanged.
 *   3. The fetch succeeds with an EMPTY answer → the ordinary empty state renders, and the failure
 *      copy does not. A guard that swallows a rejection into the same value an empty answer produces
 *      trades a white screen for a lie, which is the other half of the same defect.
 *
 * ⚠️ The language stub resolves against the REAL `en` dictionary rather than echoing keys back, so
 * these assertions are about the sentence a person reads. Echoing keys would pass just as happily
 * against a raw `settings.project.unreachable` printed into the page.
 */

const interpolate = (text: string, params?: Record<string, unknown>) =>
  params === undefined ? text : text.replace(/{{(\w+)}}/g, (whole, key) => String(params[key] ?? whole))


const DIRECTORY = "/tmp/workshop"
const HOME = "/home/tester"

/** A healthy board: one signal, plus a headline the control case can look for. */
const DIAGNOSIS = {
  overall: "ok",
  headline: "Two checks, nothing to do.",
  signals: [{ id: "database", label: "Database", status: "ok" }],
}
/** A healthy board with NOTHING to report — successful, and empty. */
const DIAGNOSIS_EMPTY = { overall: "ok", headline: "Nothing to report.", signals: [] }

/** A folder that IS a project. */
const PROJECT = {
  kind: "project",
  root: DIRECTORY,
  file: `${DIRECTORY}/novaclaw.json`,
  name: "Workshop",
  permissionRules: 0,
  permissions: [],
  exclude: [],
  skills: [],
  skillsRefused: [],
}
/** A folder with no project file — the successful EMPTY answer, which is not a fault. */
const PROJECT_NONE = { kind: "none" }

type Mode = "reject" | "http500" | "ok" | "empty"

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined
let restoreFetch: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
  restoreFetch?.()
  restoreFetch = undefined
})

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

/**
 * Answer the routes these two panels call. Only the route under test takes the fault; the side
 * routes stay healthy, so a failure that shows up in the DOM is the one this case introduced.
 */
function stubFetch(target: "api/diagnosis" | "api/project", mode: Mode) {
  const original = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input))
    if (url.includes(target)) {
      // A rejecting fetch is the TRANSPORT outage — `instance-fetch.ts` lets the runtime's own
      // `TypeError` travel unchanged, which is exactly what reaches the resource.
      if (mode === "reject") throw new TypeError("Failed to fetch")
      if (mode === "http500") return new Response("boom", { status: 500 })
      if (target === "api/diagnosis") return json(mode === "empty" ? DIAGNOSIS_EMPTY : DIAGNOSIS)
      return json(mode === "empty" ? PROJECT_NONE : PROJECT)
    }
    // Side routes, in their real shapes.
    if (url.includes("shell/status")) return json({ ok: true, shell: "bash" })
    if (url.includes("permission/saved")) return json({ data: [] })
    if (url.includes("api/project")) return json(PROJECT)
    if (url.includes("api/diagnosis")) return json(DIAGNOSIS)
    return json({})
  }) as typeof fetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = original
  }
}

/**
 * Mount one panel inside an `ErrorBoundary` that stands in for the app's root one, beside a marker
 * that stands in for the rest of the application. If the panel throws, the boundary swallows the
 * marker with it — which is precisely the "replaces the whole application" symptom, made local
 * enough for a test to observe.
 */
function mount(panel: () => JSX.Element) {
  host = document.createElement("div")
  document.body.appendChild(host)
  const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
  const globalStub = { servers: { list: () => [connection] }, ensureServerCtx: () => ({}) }
  const syncStub = () => ({ data: { path: { directory: DIRECTORY, home: HOME } } })

  dispose = render(
    () => (
      // ⚠️ The REAL Platform and Settings providers, not stubs. Every `SettingsRowV2` gates on
      // expertise, which reads the settings store, so a hand-made value here would let this file
      // drift from how the dialog actually resolves it. Both are cheap: Platform is its own prop,
      // and Settings is a `persisted` store over happy-dom's `localStorage`.
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={globalStub as never}>
              <ServerContext.Provider value={{ current: connection } as never}>
                <ServerSyncContext.Provider value={syncStub as never}>
                  <NotificationContext.Provider value={{ history: { recent: () => [] } } as never}>
                    <DialogProvider>
                      {/* ⚠️ The fallback REPORTS the error rather than just marking that one fired.
                          A boundary that says only "something threw" makes the next regression here
                          a bisect; naming the throw makes it a read. */}
                      <ErrorBoundary
                        fallback={(error: unknown) => (
                          <div data-slot="probe-boundary">the whole application is gone: {String(error)}</div>
                        )}
                      >
                        <div data-slot="probe-app">the rest of the application</div>
                        {panel()}
                      </ErrorBoundary>
                    </DialogProvider>
                  </NotificationContext.Provider>
                </ServerSyncContext.Provider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
}

const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const bodyText = () => document.body.textContent ?? ""
const boundaryFired = () => document.querySelector('[data-slot="probe-boundary"]') !== null
const appAlive = () => document.querySelector('[data-slot="probe-app"]') !== null

const UNREACHABLE = en["settings.health.unreachable"]

describe("the health board survives the instance it is diagnosing", () => {
  test("an unreachable instance is NAMED, and the surrounding app is still mounted", async () => {
    stubFetch("api/diagnosis", "reject")
    mount(() => <NovaHealthBoard />)
    await settle()

    // The copy the board carries for exactly this case — the one that could not render before.
    expect(bodyText()).toContain(UNREACHABLE)
    expect(boundaryFired()).toBe(false)
    expect(appAlive()).toBe(true)
  })

  test("a 500 from the diagnosis route is the same finding, not a crash", async () => {
    stubFetch("api/diagnosis", "http500")
    mount(() => <NovaHealthBoard />)
    await settle()

    expect(bodyText()).toContain(UNREACHABLE)
    expect(boundaryFired()).toBe(false)
  })

  test("a healthy instance renders its headline and its signals, unchanged", async () => {
    stubFetch("api/diagnosis", "ok")
    mount(() => <NovaHealthBoard />)
    await settle()

    expect(bodyText()).toContain(DIAGNOSIS.headline)
    expect(bodyText()).toContain("Database")
    expect(bodyText()).not.toContain(UNREACHABLE)
    expect(boundaryFired()).toBe(false)
  })

  test("a successful answer with NO signals is an empty board, never a failed one", async () => {
    // Empty and failed must not collapse: a guard that folds a rejection into the value an empty
    // answer produces would make this case indistinguishable from the outage above.
    stubFetch("api/diagnosis", "empty")
    mount(() => <NovaHealthBoard />)
    await settle()

    expect(bodyText()).toContain(DIAGNOSIS_EMPTY.headline)
    expect(bodyText()).not.toContain(UNREACHABLE)
    expect(boundaryFired()).toBe(false)
  })
})

describe("Settings → General survives a project route that will not answer", () => {
  test("a failed project read is NAMED, and the surrounding app is still mounted", async () => {
    stubFetch("api/project", "reject")
    mount(() => <SettingsProjectSection />)
    await settle()

    expect(document.querySelector('[data-slot="project-unavailable"]')?.textContent).toContain(UNREACHABLE)
    // The section still says which section it is, rather than vanishing without a word.
    expect(bodyText()).toContain(en["settings.project.section"])
    expect(boundaryFired()).toBe(false)
    expect(appAlive()).toBe(true)
  })

  test("a 500 from the project route is the same finding, not a crash", async () => {
    stubFetch("api/project", "http500")
    mount(() => <SettingsProjectSection />)
    await settle()

    expect(bodyText()).toContain(UNREACHABLE)
    expect(boundaryFired()).toBe(false)
  })

  test("a folder that IS a project renders its rows, unchanged", async () => {
    stubFetch("api/project", "ok")
    mount(() => <SettingsProjectSection />)
    await settle()

    expect(bodyText()).toContain("Workshop")
    expect(bodyText()).toContain(en["settings.project.fileLabel"])
    expect(bodyText()).not.toContain(UNREACHABLE)
    expect(document.querySelector('[data-slot="project-unavailable"]')).toBeNull()
    expect(boundaryFired()).toBe(false)
  })

  test("a folder with NO project file is the ordinary empty state, never the failure copy", async () => {
    stubFetch("api/project", "empty")
    mount(() => <SettingsProjectSection />)
    await settle()

    // `settings.project.none` — the invitation, which is not an error and must not read as one.
    expect(bodyText()).toContain(interpolate(en["settings.project.none"], { directory: DIRECTORY }))
    expect(bodyText()).not.toContain(UNREACHABLE)
    expect(document.querySelector('[data-slot="project-unavailable"]')).toBeNull()
    expect(boundaryFired()).toBe(false)
  })
})
