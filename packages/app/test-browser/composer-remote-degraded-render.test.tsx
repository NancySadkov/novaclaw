import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { ErrorBoundary } from "solid-js"
import { render } from "solid-js/web"
import * as realLanguage from "@/context/language"
import * as realTabs from "@/context/tabs"
import * as realUseProviders from "@/hooks/use-providers"
import * as realGlobal from "@/context/global"
import * as realLayout from "@/context/layout"
import * as realLocal from "@/context/local"
import * as realServer from "@/context/server"
import * as realSdk from "@/context/sdk"
import * as realServerSdk from "@/context/server-sdk"
import * as realSync from "@/context/sync"
import * as realSessionView from "@/pages/session/use-session-view"
import * as realSettingsDialog from "@/components/settings-dialog"
import * as realDirectoryPicker from "@/components/directory-picker"
import * as realSolidQuery from "@tanstack/solid-query"
import { dict as en } from "@/i18n/en"

/**
 * **THE COMPOSER, MOUNTED AGAINST A MESSENGER ROUTE THAT WILL NOT ANSWER.**
 *
 * 🔴 The clause this file enforces is *"the UI never crashes to a dead-end"*. `GET
 * /api/messenger/account` feeds a `createResource` whose value the prompt controller reads from an
 * eager `createMemo` — one that runs OUTSIDE the transcript's ErrorBoundary. Solid's `.latest`
 * getter re-throws the fetcher's error, and it does so *even when an `initialValue` was supplied*
 * (the `initialValue` sets `resolved`, which is the branch that skips straight to the re-throw). So
 * a single refused messenger fetch replaced the entire application with the root error page — for a
 * section whose whole job is to say which chat, if any, drives this session.
 *
 * ⚠️ **Both halves are asserted, because either alone is satisfiable by the bug.** "The controls
 * rendered" is true of a page that is entirely the error screen if you only look for the throw not
 * happening; "the boundary did not fire" is true of a controller that never got built. The probe
 * therefore mounts a sibling marker standing in for the rest of the application and checks that the
 * marker is still there.
 *
 * ⚠️ **Four cases, and the fourth is what keeps the fix honest.** A guard that folds a rejection
 * into the value an empty answer produces would trade the white screen for a lie — the panel renders
 * an empty account list as *"No messenger accounts yet — add one in Settings"*, which is false when
 * the request never landed. So the successful-but-EMPTY case asserts the same empty list with a
 * DIFFERENT availability, and the failing case asserts the availability that says why.
 *
 * The controller under test is the real module; only the ambient contexts around it are stubbed,
 * and the messenger client (`utils/messenger-api.ts` → `utils/instance-fetch.ts`) is real, so the
 * rejection travels the path it travels in the product.
 *
 * ---
 *
 * 🔴 **EVERYTHING THIS FILE INSTALLS IS PROCESS-WIDE, AND IS THEREFORE GATED.**
 *
 * The gate runs this whole directory as ONE `bun test` process (`script/lib/run-units.ts` hands it
 * `"./test-browser"`), and a rendering harness reaches for two tools that do not respect file
 * boundaries:
 *
 * - **`mock.module` is registered per PROCESS, and the first registration for a specifier wins for
 *   every file in the run.** A stub that exports only the names one file uses silently deletes the
 *   others — `settings-degraded-instance-render` imports `LanguageContext` from `@/context/language`
 *   and asserts against the real `en` dictionary on purpose, so a key-echoing `t` and a missing
 *   `LanguageContext` both break it from another file.
 * - **`globalThis.fetch` assigned in `beforeAll` is never given back.** Every later file inherits
 *   this file's routing table, and a sibling that saves and restores `globalThis.fetch` around its
 *   own cases restores it to *this* stub.
 *
 * Measured: these five `.tsx` files run together were 22 pass / 46 fail with this file present and
 * 64 pass / 0 fail without it.
 *
 * **So both are scoped to this file's own cases rather than merely made politer.** Every mock
 * spreads the real module through (`...SNAP.x`) so no sibling loses an export, and every override
 * is wrapped in `gated`, which delegates to the real implementation whenever `active` is false —
 * and `active` is true only between `mount()` and the `afterEach` that disposes the tree. A sibling
 * therefore observes the unmocked module, whatever order the files run in. `fetch` is installed by
 * `mount()` and restored in the same `afterEach`.
 *
 * ⚠️ The real exports are snapshotted at module scope, BEFORE any `mock.module` call. Reading them
 * out of the live namespace inside a factory would read the replacement back and recurse.
 */

const SNAP = {
  language: { ...realLanguage },
  tabs: { ...realTabs },
  useProviders: { ...realUseProviders },
  global: { ...realGlobal },
  layout: { ...realLayout },
  local: { ...realLocal },
  server: { ...realServer },
  sdk: { ...realSdk },
  serverSdk: { ...realServerSdk },
  sync: { ...realSync },
  sessionView: { ...realSessionView },
  settingsDialog: { ...realSettingsDialog },
  directoryPicker: { ...realDirectoryPicker },
  solidQuery: { ...realSolidQuery },
}

/** True only while this file's probe is mounted. See the header: it is what keeps siblings clean. */
let active = false

/** Use `stub` for this file's own cases, and the real export for everyone else's. */
type AnyFn = (...args: never[]) => unknown
const gated = <F extends AnyFn>(stub: F, real: unknown): F =>
  ((...args: Parameters<F>) => (active ? stub(...args) : (real as F)(...args))) as F

const BASE = "http://localhost:4096"
const CONNECTION = { type: "http", url: BASE, http: { url: BASE } }

const ACCOUNTS = [
  {
    account: { id: "a1", driverID: "telegram", label: "Nancy Telegram", enabled: true, settings: {} },
    status: { state: "connected" },
  },
  {
    account: { id: "a2", driverID: "discord", label: "Studio Discord", enabled: true, settings: {} },
    status: { state: "connected" },
  },
]
const DRIVERS = [{ id: "telegram", name: "Telegram", icon: "", auth: "login", settings: [] }]

type Mode = "reject" | "http500" | "ok" | "empty"

let mode: Mode = "ok"
let controller: typeof import("@/pages/session/composer/session-composer-controls")

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

/**
 * The messenger routes. Only `account` takes the fault; the side routes stay healthy, so anything
 * that shows up in the DOM is what this case introduced.
 */
const probeFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : ((input as Request).url ?? String(input))
  if (url.includes("api/messenger/account")) {
    // A rejecting fetch is the TRANSPORT outage — `instance-fetch.ts` lets the runtime's own
    // `TypeError` travel unchanged, which is exactly what reaches the resource.
    if (mode === "reject") throw new TypeError("Failed to fetch")
    if (mode === "http500") return new Response("boom", { status: 500 })
    return json(mode === "empty" ? [] : ACCOUNTS)
  }
  if (url.includes("api/messenger/driver")) return json(DRIVERS)
  if (url.includes("api/messenger/binding")) return json([])
  return json({})
}) as typeof fetch

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
const LOCAL = {
  model: { current: () => undefined },
  agent: { current: () => ({ name: "build" }) },
  permissionMode: { current: () => "ask", set: () => {} },
  strict: { current: () => undefined, set: () => {} },
  features: { current: () => undefined, set: () => {} },
  mode: { current: () => undefined, set: () => {} },
}
const LAYOUT = { view: () => ({ reviewPanel: undefined }), tabs: () => [], projects: { list: () => [] } }
const GLOBAL = { ensureServerCtx: () => ({ agents: { list: () => [] }, projects: { list: () => [] } }) }
const SDK = () => ({
  directory: "/repo/main",
  scope: "local",
  client: { v2: { session: { config: async () => ({ error: undefined, data: { data: {} } }) } } },
})
const SERVER_SDK = () => ({ scope: "local", server: CONNECTION, event: { listen: () => () => undefined } })
const SYNC = () => ({ data: { config: {}, agent: [] } })

beforeAll(async () => {
  mock.module("@tanstack/solid-query", () => ({
    ...SNAP.solidQuery,
    createQuery: gated(() => ({ isLoading: false, data: undefined }), SNAP.solidQuery.createQuery),
  }))
  mock.module("@/context/language", () => ({
    ...SNAP.language,
    useLanguage: gated(() => LANGUAGE, SNAP.language.useLanguage),
  }))
  mock.module("@/context/tabs", () => ({ ...SNAP.tabs, useTabs: gated(() => ({}), SNAP.tabs.useTabs) }))
  mock.module("@/hooks/use-providers", () => ({
    ...SNAP.useProviders,
    useProviders: gated(() => ({ paid: () => [] }), SNAP.useProviders.useProviders),
  }))
  mock.module("@/context/global", () => ({ ...SNAP.global, useGlobal: gated(() => GLOBAL, SNAP.global.useGlobal) }))
  mock.module("@/context/layout", () => ({ ...SNAP.layout, useLayout: gated(() => LAYOUT, SNAP.layout.useLayout) }))
  mock.module("@/context/local", () => ({ ...SNAP.local, useLocal: gated(() => LOCAL, SNAP.local.useLocal) }))
  mock.module("@/context/server", () => ({
    ...SNAP.server,
    useServer: gated(() => ({ current: CONNECTION, list: [CONNECTION] }), SNAP.server.useServer),
  }))
  mock.module("@/context/sdk", () => ({ ...SNAP.sdk, useSDK: gated(() => SDK, SNAP.sdk.useSDK) }))
  mock.module("@/context/server-sdk", () => ({
    ...SNAP.serverSdk,
    useServerSDK: gated(() => SERVER_SDK, SNAP.serverSdk.useServerSDK),
  }))
  mock.module("@/context/sync", () => ({ ...SNAP.sync, useSync: gated(() => SYNC, SNAP.sync.useSync) }))
  mock.module("@/components/settings-dialog", () => ({
    ...SNAP.settingsDialog,
    useSettingsDialog: gated(() => () => undefined, SNAP.settingsDialog.useSettingsDialog),
  }))
  mock.module("@/components/directory-picker", () => ({
    ...SNAP.directoryPicker,
    useDirectoryPicker: gated(() => () => undefined, SNAP.directoryPicker.useDirectoryPicker),
  }))
  mock.module("@/pages/session/use-session-view", () => ({
    ...SNAP.sessionView,
    useSessionView: gated(
      (sessionID: () => string | undefined) => ({
        sessionID,
        scope: () => "local",
        directory: () => "/repo/main",
        sessionKey: () => "key",
        record: () => undefined,
        working: () => false,
        persistTarget: (key: string) => key,
      }),
      SNAP.sessionView.useSessionView,
    ),
  }))

  controller = await import("@/pages/session/composer/session-composer-controls")
})

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined
let restoreFetch: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  // ⚠️ Both handed back before the next FILE runs, not merely before the next case.
  active = false
  restoreFetch?.()
  restoreFetch = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
})

/**
 * Mount the real controller inside an ErrorBoundary that stands in for the app's root one, beside a
 * marker that stands in for the rest of the application. If the controller throws, the boundary
 * takes the marker down with it — which IS the "replaces the whole application" symptom, made local
 * enough for a test to observe.
 */
function mount() {
  const originalFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = probeFetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  }
  active = true
  host = document.createElement("div")
  document.body.appendChild(host)
  const Panel = () => {
    const controls = controller.createPromptInputController({
      sessionID: () => "session-1",
      queryOptions: { agents: () => ({ queryKey: [] }), providers: () => ({ queryKey: [] }) } as never,
    })
    return (
      <div data-slot="composer">
        <span data-slot="remote-availability">
          {(controls().remote as { availability?: string }).availability ?? "absent"}
        </span>
        <span data-slot="remote-accounts">
          {controls()
            .remote.accounts.map((entry) => entry.label)
            .join(",")}
        </span>
      </div>
    )
  }
  dispose = render(
    () => (
      <ErrorBoundary
        fallback={(error: unknown) => (
          <div data-slot="probe-boundary">the whole application is gone: {String(error)}</div>
        )}
      >
        <div data-slot="probe-app">the rest of the application</div>
        <Panel />
      </ErrorBoundary>
    ),
    host,
  )
}

const settle = async (times = 8) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`)
const boundaryFired = () => slot("probe-boundary") !== null
const appAlive = () => slot("probe-app") !== null
const availability = () => slot("remote-availability")?.textContent ?? ""
const accounts = () => slot("remote-accounts")?.textContent ?? ""

describe("the composer survives a messenger account route that will not answer", () => {
  test("a rejected account fetch leaves the composer AND the surrounding app mounted", async () => {
    mode = "reject"
    mount()
    await settle()

    expect(boundaryFired()).toBe(false)
    expect(appAlive()).toBe(true)
    expect(slot("composer")).not.toBeNull()
    // The outage is CARRIED, not swallowed: "we could not ask" is a different fact from "there are
    // none", and the panel's empty copy is a false sentence in this case.
    expect(availability()).toBe("failed")
    expect(accounts()).toBe("")
  })

  test("a 500 from the account route is the same finding, not a crash", async () => {
    mode = "http500"
    mount()
    await settle()

    expect(boundaryFired()).toBe(false)
    expect(appAlive()).toBe(true)
    expect(availability()).toBe("failed")
  })

  test("a healthy account route lists the accounts, unchanged", async () => {
    mode = "ok"
    mount()
    await settle()

    expect(boundaryFired()).toBe(false)
    expect(accounts()).toBe("Nancy Telegram,Studio Discord")
    expect(availability()).toBe("ready")
  })

  test("a successful answer with NO accounts is EMPTY, never failed", async () => {
    // The other half of the fix. Without this case, swallowing the rejection into `[]` would pass
    // every assertion above and make the composer claim there are no messenger accounts when the
    // truth is that it never got an answer.
    mode = "empty"
    mount()
    await settle()

    expect(boundaryFired()).toBe(false)
    expect(accounts()).toBe("")
    expect(availability()).toBe("ready")
  })
})
