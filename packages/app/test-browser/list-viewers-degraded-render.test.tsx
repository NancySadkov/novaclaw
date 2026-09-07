import { afterEach, describe, expect, test } from "bun:test"
import { ErrorBoundary, type JSX } from "solid-js"
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
import { SettingsProvider } from "@/context/settings"
import { TrashPage } from "@/pages/trash"
import { FilesPage } from "@/pages/files"
import { NotesPage } from "@/pages/notes"
import { CalendarPage } from "@/pages/calendar"
import { SkillsPage } from "@/pages/skills"
import { RecipesPage } from "@/pages/recipes"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

/**
 * **SIX LIST VIEWERS, RENDERED AGAINST A SUBSYSTEM THAT WILL NOT ANSWER.**
 *
 * 🔴 Ruling 2: *an unavailable subsystem names itself instead of rendering empty.* Every page here
 * broke it in the same way — a failed listing became `[]` (or `undefined`) and the screen printed
 * the sentence it prints when there is genuinely nothing, so *"Trash is empty."*, *"No notes yet"*,
 * *"No recipes yet"* and *"No skills yet"* were each told to someone whose data was still there.
 *
 * ⚠️ **Calendar's is the one with consequences beyond a wrong word.** *"No tasks yet — add one
 * below"* is an INVITATION, and the schedules it denies are still firing on the instance: acting on
 * that sentence gives every unattended task a duplicate.
 *
 * ⚠️ **Three cases per viewer, and the second is what keeps the fix honest.**
 *   1. The read fails → the page NAMES the failure, and the boundary around it did not fire.
 *   2. The read succeeds and is EMPTY → the ordinary empty copy renders, and the failure copy does
 *      not. A test that only checked case 1 would pass against a page showing the error always.
 *   3. The read succeeds with data → the rows render.
 *
 * ⚠️ The language stub resolves against the REAL `en` dictionary, so these assertions are about the
 * sentence a person reads. Echoing keys back would pass just as happily against a raw
 * `trash.loadFailed` printed into the page.
 */



const HOME = "/home/tester"
const DIRECTORY = "/home/tester/workshop"
const HTTP = { url: "http://localhost:4096" }
const connection = { type: "http", key: "local", url: HTTP.url, http: HTTP }

type Mode = "fail" | "empty" | "ok"

/** Which read takes the fault, and how it behaves. Every other read stays healthy. */
let target = ""
let mode: Mode = "ok"
const faulty = (name: string) => target === name && mode === "fail"
const blank = (name: string) => target === name && mode === "empty"

const TRASHED = [
  { id: "tr1", originalPath: `${HOME}/quarterly-report.txt`, type: "file", trashedAt: Date.now() - 3_600_000 },
]
const FILE_ROWS = [
  { name: "readme.md", path: "readme.md", absolute: `${DIRECTORY}/readme.md`, type: "file", ignored: false },
]
const NOTE_ROWS = [
  { name: "shopping-list.md", path: "shopping-list.md", absolute: `${HOME}/notes/shopping-list.md`, type: "file", ignored: false },
]
const SKILL_ROWS = [{ name: "brew-tea", description: "Makes a pot", location: `${HOME}/.novaclaw/skills/brew-tea.md`, content: "Boil water." }]
const RECIPE_ROWS = [
  { slug: "hundred-digits", name: "Hundred digits of pi", description: "A Machin-like formula", prompt: "Compute it.", assets: [], builtin: true, updatedAt: 1 },
]
const SCHEDULE_ROWS = [
  {
    id: "sch1",
    title: "Water the plants",
    recurrence: { kind: "daily", time: { hour: 9, minute: 0 } },
    tzOffsetMin: 0,
    prompt: "Remind me",
    agent: null,
    model: null,
    location: null,
    permissionMode: null,
    enabled: true,
    nextFireAt: Date.now() + 3_600_000,
    lastFiredAt: null,
    timeCreated: 1,
    timeUpdated: 1,
  },
]

const boom = () => {
  throw new TypeError("Failed to fetch")
}

/** The one server context every page reaches through — `ServerSDKProvider` delegates to it. */
const serverCtx = {
  sync: {
    data: { path: { home: HOME, directory: DIRECTORY, data: HOME, roots: [HOME], places: [] }, config: {} },
    updateConfig: async () => undefined,
  },
  agents: { list: () => [] },
  sdk: {
    server: { http: HTTP },
    client: {
      path: {
        get: async () => (faulty("path") ? boom() : { data: { home: HOME, directory: DIRECTORY, data: HOME, roots: [HOME], places: [] } }),
      },
      file: {
        list: async () => (faulty("list") ? boom() : { data: blank("list") ? [] : [...FILE_ROWS, ...NOTE_ROWS] }),
        read: async () => ({ data: { type: "text", content: "hello" } }),
      },
      v2: {
        directory: {
          browse: async () => (faulty("list") ? boom() : { data: blank("list") ? [] : [...FILE_ROWS, ...NOTE_ROWS] }),
        },
        skill: {
          list: async () => (faulty("skills") ? boom() : { data: { data: blank("skills") ? [] : SKILL_ROWS } }),
        },
        agent: { list: async () => ({ data: { data: [] } }) },
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
  restoreFetch?.()
  restoreFetch = undefined
  target = ""
  mode = "ok"
})

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

/** The raw-fetch routes (`utils/instance-fetch.ts`). A rejecting fetch is the transport outage. */
function stubFetch() {
  const original = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input))
    if (url.includes("file/trash")) {
      if (faulty("trash")) throw new TypeError("Failed to fetch")
      return json(blank("trash") ? [] : TRASHED)
    }
    if (url.includes("api/calendar/schedule")) {
      if (faulty("schedules")) throw new TypeError("Failed to fetch")
      return json(blank("schedules") ? [] : SCHEDULE_ROWS)
    }
    if (url.includes("api/calendar/fires")) return json([])
    if (url.includes("api/recipe")) {
      if (faulty("recipes")) throw new TypeError("Failed to fetch")
      return json(blank("recipes") ? [] : RECIPE_ROWS)
    }
    if (url.includes("api/project")) return json({ kind: "none" })
    return json({})
  }) as typeof fetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = original
  }
}

/**
 * Mount one page inside an `ErrorBoundary` standing in for the app's root one, beside a marker
 * standing in for the rest of the application. If the page throws, the boundary swallows the marker
 * with it — the "replaces the whole application" symptom, made local enough to observe.
 */
function mount(page: () => JSX.Element) {
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

const settle = async (times = 10) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const bodyText = () => document.body.textContent ?? ""
const boundaryFired = () => document.querySelector('[data-slot="probe-boundary"]') !== null
const appAlive = () => document.querySelector('[data-slot="probe-app"]') !== null

/** Every viewer's three cases, in the same shape, so a gap in one is visible against the others. */
interface Viewer {
  readonly title: string
  readonly page: () => JSX.Element
  readonly target: string
  /** The sentence a failed read must produce — and which must NOT appear in the other two cases. */
  readonly failure: string
  /** The ordinary empty copy — and which must NOT appear when the read failed. */
  readonly empty: string
  /** Something only real data can put on screen. */
  readonly loaded: string
  /** Reveal the panel under test, when it is not on screen by default. */
  readonly reveal?: () => void
}

/** Files keeps its Trash panel behind a toggle, so the panel has to be opened before it exists. */
const openFilesTrash = () => {
  const toggle = document.querySelector('[data-slot="files-trash-toggle"]') as HTMLButtonElement | null
  expect(toggle, "the Files Trash toggle is missing — this viewer's panel was never reached").not.toBeNull()
  toggle!.click()
}

const VIEWERS: readonly Viewer[] = [
  {
    title: "Trash",
    page: () => <TrashPage />,
    target: "trash",
    failure: en["trash.loadFailed"],
    empty: en["trash.empty"],
    loaded: "quarterly-report.txt",
  },
  {
    title: "Files → the Trash panel",
    page: () => <FilesPage />,
    target: "trash",
    failure: en["files.trashLoadFailed"],
    empty: en["files.trashEmpty"],
    loaded: "quarterly-report.txt",
    reveal: openFilesTrash,
  },
  {
    title: "Notes",
    page: () => <NotesPage />,
    target: "list",
    failure: en["notes.loadFailed"],
    empty: en["notes.empty"],
    loaded: "shopping-list",
  },
  {
    title: "Calendar",
    page: () => <CalendarPage />,
    target: "schedules",
    failure: "Could not read your scheduled tasks",
    empty: "No tasks yet",
    loaded: "Water the plants",
  },
  {
    title: "Skills",
    page: () => <SkillsPage />,
    target: "skills",
    failure: en["skills.loadFailed"],
    empty: en["skills.empty.none"],
    loaded: "brew-tea",
  },
  {
    title: "Recipes",
    page: () => <RecipesPage />,
    target: "recipes",
    failure: "Could not read your recipes",
    empty: "No recipes yet",
    loaded: "Hundred digits of pi",
  },
]

for (const viewer of VIEWERS) {
  describe(`${viewer.title} tells a failed listing apart from an empty one`, () => {
    test("a failed read is NAMED, and the surrounding app is still mounted", async () => {
      target = viewer.target
      mode = "fail"
      mount(viewer.page)
      await settle()
      if (viewer.reveal) {
        viewer.reveal()
        await settle()
      }

      expect(bodyText()).toContain(viewer.failure)
      // The whole defect in one line: the empty-state sentence is a claim about the user's data and
      // may not be made by a page that never got an answer.
      expect(bodyText()).not.toContain(viewer.empty)
      expect(boundaryFired()).toBe(false)
      expect(appAlive()).toBe(true)
    })

    test("a successful EMPTY answer is the ordinary empty state, never the failure copy", async () => {
      target = viewer.target
      mode = "empty"
      mount(viewer.page)
      await settle()
      if (viewer.reveal) {
        viewer.reveal()
        await settle()
      }

      expect(bodyText()).toContain(viewer.empty)
      expect(bodyText()).not.toContain(viewer.failure)
      expect(boundaryFired()).toBe(false)
    })

    test("data renders, and neither the empty nor the failure copy appears", async () => {
      target = viewer.target
      mode = "ok"
      mount(viewer.page)
      await settle()
      if (viewer.reveal) {
        viewer.reveal()
        await settle()
      }

      expect(bodyText()).toContain(viewer.loaded)
      expect(bodyText()).not.toContain(viewer.failure)
      expect(boundaryFired()).toBe(false)
    })
  })
}

describe("Calendar never invites a duplicate schedule over a listing it could not read", () => {
  test("the invitation and the count are both withheld when the read failed", async () => {
    // 🔴 The severity argument, asserted rather than described. "No tasks yet — add one below" is
    // an instruction, and following it while the real schedules keep firing is how one unattended
    // task becomes two. "(0)" is the same claim in numerals, so it is withheld too.
    target = "schedules"
    mode = "fail"
    mount(() => <CalendarPage />)
    await settle()

    expect(bodyText()).not.toContain("No tasks yet — add one below.")
    expect(bodyText()).not.toContain("Scheduled tasks (0)")
    expect(document.querySelector('[data-slot="calendar-schedules-failed"]')).not.toBeNull()
    expect(boundaryFired()).toBe(false)
  })
})
