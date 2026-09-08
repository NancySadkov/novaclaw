import { afterEach, describe, expect, test } from "bun:test"
import { ErrorBoundary, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { ServerSDKProvider } from "@/context/server-sdk"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { SettingsProvider } from "@/context/settings"
import { CommunityNetwork } from "@/pages/home-screen/community-network"
import { CalendarPage } from "@/pages/calendar"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

/**
 * **A COMMUNITY THAT COULD NOT BE READ, PRESENTED AS AN EMPTY ONE YOU HAD JOINED — and a schedule
 * form that disabled itself without a word.**
 *
 * 🔴 Ruling 2, second half: *an unavailable subsystem names itself instead of rendering empty.* The
 * community client caught every rejection and returned a fallback, so:
 *
 * - `contacts` fell back to `[]` and the panel printed **"People you know (0)"** over a peer list
 *   that never arrived;
 * - `identity` fell back to `undefined` and the key box showed `"…"` for ever, which reads as still
 *   loading;
 * - and `participation` fell back to `undefined`, which the panel's door gate
 *   (`participation() === undefined || participation()?.participating`) treated as **joined** — so
 *   an instance that could not be asked was shown the full panel with a **"Turn off"** button on it.
 *
 * ⚠️ **The last one is the sharp half and it is the one asserted hardest.** AGENTS.md: *joining is a
 * decision, not a default.* Telling somebody they have joined a peer-to-peer network — with a
 * control to leave it — is a claim about a decision only they can make, and this screen was making
 * it for them out of a failed HTTP read.
 *
 * ⚠️ **Three states, because the pair is what proves it.** A panel that always shows its error
 * passes a failure-only test. So every assertion below runs three ways — the read FAILING, the read
 * answering genuinely EMPTY, and the read answering with DATA — and each case asserts the other
 * two sentences are absent. Without the empty case, deleting the empty state entirely would pass.
 *
 * ⚠️ **And the app must still be there.** These reads no longer swallow their own rejections, so the
 * ONLY thing standing between a 500 and the root `ErrorBoundary` is `createSettledResource`. The
 * probe boundary and probe sibling below fail loudly if a rejection ever escapes an accessor again —
 * that is the original defect, and removing `softRead` is exactly the edit that could reopen it.
 *
 * ⚠️ Calendar's half is a different sentence about the same principle: three controls gated on a
 * directory that had not resolved, greyed out with nothing on screen to say why. The control is the
 * resolvable case, where the notice must be ABSENT and the buttons live.
 *
 * ⚠️ The language stub resolves against the REAL `en` dictionary, so every assertion is about the
 * sentence a person reads rather than a key echoed back.
 */

const HOME = "/home/tester"
const HTTP = { url: "http://localhost:4096" }
const connection = { type: "http", key: "local", url: HTTP.url, http: HTTP }

/** How a community read behaves. `empty` is a 200 carrying nothing — an ANSWER, not a failure. */
type ReadMode = "ok" | "fail" | "empty"

let participationMode: ReadMode = "ok"
let contactsMode: ReadMode = "ok"
let identityMode: ReadMode = "ok"
/** Whether the instance has told us which folder it works in. */
let storedPath: Record<string, unknown> | undefined = { home: HOME, directory: HOME }
let calendarWrites = 0

const CONTACTS = [
  { networkID: "nid_alice", petname: "Alice", routes: ["1.2.3.4:443"], blocked: false, addedAt: 1 },
  { networkID: "nid_bob", petname: "Bob", routes: [], blocked: false, addedAt: 2 },
]
const JOINED = {
  participating: true,
  consented: true,
  enabled: true,
  refusals: [],
  answers: { enabled: false, perDay: 5, today: 0 },
}

const serverCtx = {
  get sync() {
    return { data: { path: storedPath, config: {} }, updateConfig: async () => undefined }
  },
  agents: { list: () => [] },
  sdk: {
    server: { http: HTTP },
    client: {
      path: { get: async () => ({ data: storedPath ?? {} }) },
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

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined
let restoreFetch: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
  // ⚠️ The gate runs this whole directory in ONE process, so a global left swapped here becomes a
  // neighbouring file's mystery failure. Restore before resetting the knobs.
  restoreFetch?.()
  restoreFetch = undefined
  participationMode = "ok"
  contactsMode = "ok"
  identityMode = "ok"
  storedPath = { home: HOME, directory: HOME }
  calendarWrites = 0
  localStorage.clear()
})

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

/**
 * The raw-fetch routes (`utils/instance-fetch.ts`). A rejecting fetch is the transport outage — the
 * exact shape an older instance without `/api/community/*` produces, which is the reported case.
 */
function stubFetch() {
  const original = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input))
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    if (url.includes("api/community/participation")) {
      if (participationMode === "fail") throw new TypeError("Failed to fetch")
      if (participationMode === "empty")
        return json({ ...JOINED, participating: false, enabled: false, refusals: ["switched_off"] })
      return json(JOINED)
    }
    if (url.includes("api/community/contact")) {
      if (contactsMode === "fail") throw new TypeError("Failed to fetch")
      return json(contactsMode === "empty" ? [] : CONTACTS)
    }
    if (url.includes("global/health")) {
      if (identityMode === "fail") throw new TypeError("Failed to fetch")
      return json({ healthy: true, networkID: "nid_this_instance" })
    }
    // ⚠️ A DELEGATING default, not a blanket `{}`: every route this file did not think about still
    // gets a well-formed 200 rather than a parse error that reads like the regression under test.
    if (url.includes("api/community/transport")) return json({ kind: "online", peers: 2 })
    // ⚠️ Shaped, not `[]`. The channel reads return OBJECTS, and a default array here made the panel
    // dereference `undefined.length` — a fixture fault that looks exactly like the crash under test.
    if (url.includes("/history")) return json({ messages: [], hidden: 0, held: 0 })
    if (url.includes("/sync")) return json({ peers: 0, fetched: 0 })
    if (url.includes("api/calendar/schedule")) {
      if (method !== "GET") calendarWrites += 1
      return json(method === "GET" ? [] : {})
    }
    if (url.includes("api/calendar/fire")) return json([])
    if (url.includes("api/community/offer/mine")) return json({ servable: true })
    return json([])
  }) as typeof fetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = original
  }
}

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
const has = (selector: string) => document.querySelector(selector) !== null

describe("an unreadable community names itself and never claims you joined", () => {
  test("🔴 FAILED — it says it could not ask, and offers no 'Turn off' for what was never joined", async () => {
    participationMode = "fail"
    mount(() => <CommunityNetwork />)
    await settle()

    expect(has('[data-slot="community-network-unreadable"]')).toBe(true)
    expect(bodyText()).toContain("did not answer when asked whether it has joined")
    expect(bodyText()).toContain("Nothing has been joined, switched on, or announced on your behalf")

    // 🔴 THE CLAIM ITSELF. The joined panel is what carries "Turn off" and the key box; neither may
    // exist, because both assert this instance is a member.
    expect(has('[data-slot="community-network-joined"]')).toBe(false)
    expect(bodyText()).not.toContain(en["community.turnOff"]!)
    expect(bodyText()).not.toContain("People you know")

    // ⚠️ Nor does it fall through to the consent screen: "you have not joined" is the same size of
    // claim as "you have", and we established neither.
    expect(bodyText()).not.toContain(en["community.consent.accept"]!)

    // The original defect: a rejected community read must not reach the root boundary.
    expect(boundaryFired()).toBe(false)
    expect(appAlive()).toBe(true)
  })

  test("CONTROL — an instance that really has NOT joined still gets the ordinary switched-off screen", async () => {
    participationMode = "empty"
    mount(() => <CommunityNetwork />)
    await settle()

    expect(bodyText()).toContain(en["community.off.turnOn"]!)
    expect(has('[data-slot="community-network-unreadable"]')).toBe(false)
    expect(bodyText()).not.toContain("did not answer when asked whether it has joined")
    expect(has('[data-slot="community-network-joined"]')).toBe(false)
    expect(boundaryFired()).toBe(false)
  })

  test("CONTROL — a joined instance still gets the whole panel, with the way back out", async () => {
    mount(() => <CommunityNetwork />)
    await settle()

    expect(has('[data-slot="community-network-joined"]')).toBe(true)
    expect(bodyText()).toContain(en["community.turnOff"]!)
    expect(has('[data-slot="community-network-unreadable"]')).toBe(false)
    expect(bodyText()).not.toContain("did not answer when asked whether it has joined")
    expect(boundaryFired()).toBe(false)
  })
})

describe("a peer list that failed is not a peer list of nobody", () => {
  test("🔴 FAILED — no count is printed, and the failure is named", async () => {
    contactsMode = "fail"
    mount(() => <CommunityNetwork />)
    await settle()

    expect(bodyText()).toContain("Could not read the people you know")
    // 🔴 The count is the lie in numerals — a number is the most believed thing on a screen.
    expect(bodyText()).not.toContain("People you know (0)")
    expect(bodyText()).not.toContain(en["community.contacts.empty"]!)
    expect(boundaryFired()).toBe(false)
    expect(appAlive()).toBe(true)
  })

  test("CONTROL — a genuinely empty peer list still says so, and still counts zero", async () => {
    contactsMode = "empty"
    mount(() => <CommunityNetwork />)
    await settle()

    expect(bodyText()).toContain("People you know (0)")
    expect(bodyText()).toContain(en["community.contacts.empty"]!)
    expect(bodyText()).not.toContain("Could not read the people you know")
  })

  test("CONTROL — a populated peer list lists the peers", async () => {
    mount(() => <CommunityNetwork />)
    await settle()

    expect(bodyText()).toContain("People you know (2)")
    expect(bodyText()).toContain("Alice")
    expect(bodyText()).toContain("Bob")
    expect(bodyText()).not.toContain("Could not read the people you know")
    expect(bodyText()).not.toContain(en["community.contacts.empty"]!)
  })
})

describe("the key box does not sit on an ellipsis for ever", () => {
  test("🔴 FAILED — it says the key could not be read, and warns against handing it out", async () => {
    identityMode = "fail"
    mount(() => <CommunityNetwork />)
    await settle()

    expect(has('[data-slot="community-key-unreadable"]')).toBe(true)
    expect(bodyText()).toContain("Do not hand out anything from this box")
    expect(bodyText()).not.toContain("nid_this_instance")
  })

  test("CONTROL — a readable key is still shown, with no warning", async () => {
    mount(() => <CommunityNetwork />)
    await settle()

    expect(bodyText()).toContain("nid_this_instance")
    expect(has('[data-slot="community-key-unreadable"]')).toBe(false)
  })
})

describe("Calendar explains a disabled Add task instead of greying out in silence", () => {
  test("🔴 UNRESOLVED DIRECTORY — the reason is on screen, beside both the form and the list", async () => {
    storedPath = undefined
    mount(() => <CalendarPage />)
    await settle()

    expect(has('[data-slot="calendar-directory-problem"]')).toBe(true)
    expect(has('[data-slot="calendar-directory-problem-form"]')).toBe(true)
    expect(bodyText()).toContain("Waiting for this instance to say which folder it works in")
    expect(bodyText()).toContain("Add task, Pause and Resume need it")

    // ⚠️ Still disabled — the write genuinely cannot be routed, and a button that submits into an
    // early return is the silent-failure half of the same ruling. What was missing was the sentence.
    const submit = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Add task"))
    expect(submit, "the Add task button must still be rendered").toBeTruthy()
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })

  test("CONTROL — with a resolvable directory there is no notice and Add task is live", async () => {
    mount(() => <CalendarPage />)
    await settle()

    expect(has('[data-slot="calendar-directory-problem"]')).toBe(false)
    expect(has('[data-slot="calendar-directory-problem-form"]')).toBe(false)
    expect(bodyText()).not.toContain("Waiting for this instance to say which folder it works in")

    const submit = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Add task"))
    expect(submit, "the Add task button must still be rendered").toBeTruthy()
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector('[data-component="control-scope"][data-scope="draft"]')?.textContent).toContain(
      "saved when you confirm",
    )
  })
})

describe("Calendar refuses impossible monthly days before sending a schedule", () => {
  const chooseRepeat = async (value: string) => {
    const repeat = document.querySelector<HTMLElement>("#calendar-repeat")!
    repeat.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
    )
    await Promise.resolve()
    repeat.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
    )
    await settle()
    const option = document.querySelector<HTMLElement>(`[role="option"][data-key="${value}"]`)!
    expect(option).not.toBeNull()
    option.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
    )
    await Promise.resolve()
    option.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
    )
    await settle()
  }

  test("empty, fractional, below-minimum and above-maximum days stay drafts and name the valid range", async () => {
    mount(() => <CalendarPage />)
    await settle()

    await chooseRepeat("monthly")
    const prompt = document.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement
    prompt.value = "send the report"
    prompt.dispatchEvent(new Event("input", { bubbles: true }))
    for (const day of ["", "1.5", "0", "32"]) {
      const dayBox = document.querySelector(`input[aria-label="${en["calendar.page.dayOfMonth"]}"]`) as HTMLInputElement
      dayBox.value = day
      dayBox.dispatchEvent(new Event("input", { bubbles: true }))
      ;[...document.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Add task"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await settle()
      expect(calendarWrites).toBe(0)
      expect(bodyText()).toContain("Choose a whole day from 1 to 31")
      expect(dayBox.value).toBe(day)
    }
  })

  test("CONTROL — a real monthly day is sent unchanged", async () => {
    mount(() => <CalendarPage />)
    await settle()
    await chooseRepeat("monthly")
    const prompt = document.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement
    prompt.value = "send the report"
    prompt.dispatchEvent(new Event("input", { bubbles: true }))
    const dayBox = document.querySelector(`input[aria-label="${en["calendar.page.dayOfMonth"]}"]`) as HTMLInputElement
    dayBox.value = "31"
    dayBox.dispatchEvent(new Event("input", { bubbles: true }))
    ;[...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Add task"))!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle()
    expect(calendarWrites).toBe(1)
  })
})
