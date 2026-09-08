import { afterEach, describe, expect, test } from "bun:test"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { toasterV2 } from "@novaclaw/ui/v2/toast-v2"
import { GlobalContext } from "@/context/global"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { ServerContext } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { useExpertise } from "@/context/expertise"
import { InstancesAccess } from "@/components/settings-v2/instances-access"
import { SettingsPoliciesSection } from "@/components/settings-v2/policies"
import { SettingsToolsV2 } from "@/components/settings-v2/tools"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

/**
 * **A SAVE THAT DID NOT HAPPEN MUST NOT LOOK LIKE ONE — on three settings panels at once.**
 *
 * 🔴 Ruling 2, first half. Each panel below used to answer a rejected `updateConfig` by carrying on
 * as though it had landed, and each lost something a person had typed and could not get back:
 *
 * - **Tools** closed the editor, taking an up-to-8 KB manual with it, and — separately — let a
 *   rename onto an existing name DELETE that other tool, because the duplicate guard ran only while
 *   adding.
 * - **Instances** cleared the name, address and pasted bearer token beside the call, before the
 *   write could settle, and reported nothing at all in either direction.
 * - **Policies** reported a refused toggle to `console.error`, so the switch simply sprang back.
 *
 * ⚠️ **Every claim here is read out of the DOM or out of the store, never out of a return value.**
 * A panel that swallows a rejection returns exactly what a successful one returns — that is the
 * whole defect — so the evidence has to be the editor that is still open, the token still in the
 * box, the OTHER tool still in the config, and a sentence a person can actually read.
 *
 * ⚠️ **Each failing case is paired with the same gesture succeeding.** A panel that refused to
 * close, clear or write *at all* would satisfy every failure assertion and be worse than the bug.
 */

const t = (key: string) => (en as Record<string, string>)[key] ?? key


let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined
/**
 * ⚠️ Captured when THIS file stubs, never at module scope. A module-scope snapshot restores whatever
 * was installed when this file loaded, which — if a sibling had already stubbed and not yet
 * restored — reinstalls that sibling's stub permanently.
 */
let realFetch: typeof globalThis.fetch | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
  // ⚠️ All THREE of these are PROCESS-WIDE, and the gate runs this whole directory in one process.
  // A stubbed `fetch` left installed, or an expertise level left raised in the persisted store, is
  // a sibling file's mysterious failure — the affective write-count file counts the rows a panel
  // renders, and rows are gated on exactly this level.
  //
  // 🔴 The toaster is the one that actually bit, and it is worth stating precisely because
  // `document.body.innerHTML = ""` looks like it covers it and does not. Kobalte's toaster is a
  // module-level QUEUE: every failure this file provokes fires a real toast that nothing here ever
  // renders, so wiping the DOM leaves the entries queued, and the next file to mount a ToastRegion
  // shows them all. Measured: five of this file's toasts appeared inside another file's
  // `document.body.textContent` assertion, which failed naming a string it had itself produced.
  toasterV2.clear()
  if (realFetch) globalThis.fetch = realFetch
  realFetch = undefined
  try {
    localStorage.removeItem("settings.v3")
  } catch {
    // A storage-less runtime has nothing to clean up.
  }
})

/** Raise the persisted level for the one panel gated at `advanced`; afterEach puts it back. */
const Elevate = () => {
  useExpertise().setLevel("advanced")
  return null
}

interface Harness {
  /** Turn every subsequent write into a rejection, the way an instance mid-restart answers. */
  readonly setFail: (value: boolean) => void
  readonly writes: () => number
  readonly config: () => Record<string, unknown>
}

function mount(panel: () => JSX.Element, initial: Record<string, unknown>): Harness {
  const state = { fail: false, writes: 0 }
  const [store, setStore] = createStore<{ config: Record<string, unknown>; path: unknown }>({
    config: initial,
    path: { directory: "/tmp/u49", home: "/home/tester" },
  })

  const sync = () => ({
    data: store,
    updateConfig: async (patch: Record<string, unknown>, options?: { onAccepted?: () => void }) => {
      state.writes += 1
      if (state.fail) throw new Error("instance is restarting")
      options?.onAccepted?.()
      setStore("config", (prev) => ({ ...prev, ...patch }))
      return {}
    },
    refetchConfig: async () => ({}),
  })

  const sdk = { client: { v2: { config: { remove: async () => ({}) } } } }
  const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
  const globalStub = {
    servers: { list: () => [connection], health: {} },
    ensureServerCtx: () => ({ sdk }),
  }
  const serverStub = { current: connection, key: "srv", setIncomingToken: () => {} }

  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={globalStub as never}>
              <ServerContext.Provider value={serverStub as never}>
                <ServerSDKProvider>
                  <ServerSyncContext.Provider value={sync as never}>
                    <DialogProvider>
                      <Elevate />
                      {panel()}
                    </DialogProvider>
                  </ServerSyncContext.Provider>
                </ServerSDKProvider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  return { setFail: (value) => (state.fail = value), writes: () => state.writes, config: () => store.config }
}

const settle = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)

const click = (label: string) => {
  const node = button(label)
  if (!node) throw new Error(`no button labelled "${label}"`)
  node.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

const typeInto = (selector: string, value: string) => {
  const node = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null
  if (!node) throw new Error(`no field matching ${selector}`)
  node.value = value
  node.dispatchEvent(new Event("input", { bubbles: true }))
}

const valueOf = (selector: string) => (document.querySelector(selector) as HTMLInputElement | null)?.value
const text = (selector: string) => document.querySelector(selector)?.textContent ?? ""
const editorOpen = () => document.querySelector('[data-component="settings-tools-editor"]') !== null

const byLabel = (key: string) => `[aria-label="${t(key)}"]`
const NAME = byLabel("settings.tools.field.name")
const DESCRIPTION = byLabel("settings.tools.field.description")
const MANUAL = byLabel("settings.tools.field.manual")
const ERROR = '[data-component="settings-tools-editor"] .settings-v2-field-description'

const deploy = { name: "deploy", description: "ship it", manual: "ssh prod && ./deploy.sh" }
const backup = { name: "backup", description: "keep it", manual: "restic backup /srv --tag nightly" }

describe("Tools: a rename may not delete another tool", () => {
  test("🔴 renaming `deploy` onto `backup` is REFUSED, and `backup` is still there, intact", async () => {
    const { config, writes } = mount(() => <SettingsToolsV2 />, { adhoc_tools: [deploy, backup] })
    await settle()

    click(t("settings.tools.edit"))
    await settle()
    expect(valueOf(NAME)).toBe("deploy")

    typeInto(NAME, "backup")
    click(t("settings.tools.save"))
    await settle()

    // Refused, said, and NOT written: the save was the deletion, so no write at all is the proof.
    expect(text(ERROR)).toBe(t("settings.tools.error.duplicate"))
    expect(editorOpen()).toBe(true)
    expect(writes()).toBe(0)
    // Read the other tool BACK. A list of the right length carrying `deploy`'s manual under the
    // name `backup` is the exact bug, and a count passes on it.
    expect((config().adhoc_tools as (typeof backup)[]).find((r) => r.name === "backup")).toEqual(backup)
    expect((config().adhoc_tools as (typeof backup)[]).find((r) => r.name === "deploy")).toEqual(deploy)
  })

  test("CONTROL — the same edit under a free name saves, closes, and keeps both tools", async () => {
    const { config } = mount(() => <SettingsToolsV2 />, { adhoc_tools: [deploy, backup] })
    await settle()

    click(t("settings.tools.edit"))
    await settle()
    typeInto(NAME, "deploy-v2")
    click(t("settings.tools.save"))
    await settle()

    expect(editorOpen()).toBe(false)
    const saved = config().adhoc_tools as (typeof backup)[]
    expect(saved.find((r) => r.name === "backup")).toEqual(backup)
    expect(saved.find((r) => r.name === "deploy-v2")?.manual).toBe(deploy.manual)
  })
})

describe("Tools: a failed save keeps the editor and the draft", () => {
  const manual = "curl -s https://example.invalid/api | jq .items\n".repeat(40)

  test("🔴 the editor stays open, the manual is still in it, and the failure is named on screen", async () => {
    const { setFail, config } = mount(() => <SettingsToolsV2 />, { adhoc_tools: [] })
    await settle()
    setFail(true)

    click(t("settings.tools.add"))
    await settle()
    typeInto(NAME, "probe")
    typeInto(DESCRIPTION, "asks the probe endpoint")
    typeInto(MANUAL, manual)
    click(t("settings.tools.save"))
    await settle()

    expect(editorOpen()).toBe(true)
    expect(valueOf(MANUAL)).toBe(manual)
    expect(text(ERROR)).toContain(t("settings.tools.error.saveFailed"))
    // The server's own sentence rides along — "it failed" without why is the console line again.
    expect(text(ERROR)).toContain("instance is restarting")
    expect(config().adhoc_tools).toEqual([])
  })

  test("CONTROL — the same draft, with the write landing, closes the editor and persists", async () => {
    const { config } = mount(() => <SettingsToolsV2 />, { adhoc_tools: [] })
    await settle()

    click(t("settings.tools.add"))
    await settle()
    typeInto(NAME, "probe")
    typeInto(DESCRIPTION, "asks the probe endpoint")
    typeInto(MANUAL, manual)
    click(t("settings.tools.save"))
    await settle()

    expect(editorOpen()).toBe(false)
    // Stored trimmed — the editor keeps what was typed, the config keeps what it means.
    expect(config().adhoc_tools).toEqual([
      { name: "probe", description: "asks the probe endpoint", manual: manual.trim() },
    ])
  })
})

const PEER_NAME = `input[placeholder="${t("settings.instances.peers.name")}"]`
const PEER_URL = `input[placeholder="${t("settings.instances.peers.url")}"]`
const PEER_TOKEN = `input[placeholder="${t("settings.instances.peers.token")}"]`
const TOKEN_BOX = `input[placeholder="${t("settings.instances.access.placeholder")}"]`

describe("Instances: a failed save keeps the secret you pasted", () => {
  const secret = "nc_pat_9f2c41ab77e04c1d8a3b"

  test("🔴 the peer fields survive a rejection, and the panel says so", async () => {
    const { setFail, config } = mount(() => <InstancesAccess />, { instances: [], server: {} })
    await settle()
    setFail(true)

    typeInto(PEER_NAME, "atelier")
    typeInto(PEER_URL, "http://atelier.local:4096")
    typeInto(PEER_TOKEN, secret)
    click(t("settings.instances.peers.add"))
    await settle()

    // The token is the whole point: it was pasted from somewhere else, it is masked, and a person
    // who is not told it was dropped has no way to notice before the peer starts failing auth.
    expect(valueOf(PEER_TOKEN)).toBe(secret)
    expect(valueOf(PEER_NAME)).toBe("atelier")
    expect(text('[data-slot="instances-peer-error"]')).toContain(t("settings.instances.peers.saveFailed"))
    expect(config().instances).toEqual([])
  })

  test("CONTROL — the same Add, landing, clears the fields and stores the peer", async () => {
    const { config } = mount(() => <InstancesAccess />, { instances: [], server: {} })
    await settle()

    typeInto(PEER_NAME, "atelier")
    typeInto(PEER_URL, "http://atelier.local:4096")
    typeInto(PEER_TOKEN, secret)
    click(t("settings.instances.peers.add"))
    await settle()

    expect(valueOf(PEER_TOKEN)).toBe("")
    expect(document.querySelector('[data-slot="instances-peer-error"]')).toBeNull()
    expect(config().instances).toEqual([{ name: "atelier", url: "http://atelier.local:4096", token: secret }])
  })

  test("🔴 a failed access-token save is no longer silent, and the box still holds what was typed", async () => {
    const { setFail, config } = mount(() => <InstancesAccess />, { instances: [], server: {} })
    await settle()
    setFail(true)

    typeInto(TOKEN_BOX, "hunter2-rotated")
    click(t("common.save"))
    await settle()

    expect(text('[data-slot="instances-access-error"]')).toContain(t("settings.instances.access.saveFailed"))
    expect(valueOf(TOKEN_BOX)).toBe("hunter2-rotated")
    expect((config().server as { password?: string }).password).toBeUndefined()
  })

  test("CONTROL — the landing save says nothing and stores the token", async () => {
    const { config } = mount(() => <InstancesAccess />, { instances: [], server: {} })
    await settle()

    typeInto(TOKEN_BOX, "hunter2-rotated")
    click(t("common.save"))
    await settle()

    expect(document.querySelector('[data-slot="instances-access-error"]')).toBeNull()
    expect((config().server as { password?: string }).password).toBe("hunter2-rotated")
  })
})

const POLICY = {
  installed: [
    {
      id: "shell-guard",
      describe: "It reads a shell command before it runs.",
      alwaysOn: true,
      safetyCritical: true,
      enabled: true,
    },
  ],
  requested: [],
  missing: [],
  disabledButRequested: [],
}

/** `GET /api/policy` answers; everything else 404s, which both resources degrade on by design. */
const stubPolicyRoutes = () => {
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url)
    if (url.includes("api/policy")) return new Response(JSON.stringify(POLICY), { status: 200 })
    return new Response("", { status: 404 })
  }) as typeof globalThis.fetch
}

const policySwitch = () =>
  document.querySelector('[data-action="settings-policy-toggle"] [data-slot="switch-control"]') as HTMLElement | null

describe("Policies: a refused toggle is said, not logged", () => {
  test("🔴 the failure is on screen, and nothing about the check has moved", async () => {
    stubPolicyRoutes()
    const { setFail, config } = mount(() => <SettingsPoliciesSection />, {})
    await settle(12)
    const control = policySwitch()
    expect(control).not.toBeNull()

    setFail(true)
    control!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle(12)

    expect(text('[data-slot="settings-policy-toggle-error"]')).toContain("shell-guard")
    expect(text('[data-slot="settings-policy-toggle-error"]')).toContain("instance is restarting")
    expect(config().tool_policy).toBeUndefined()
  })

  test("CONTROL — the landing toggle writes the one id and shows no failure", async () => {
    stubPolicyRoutes()
    const { config } = mount(() => <SettingsPoliciesSection />, {})
    await settle(12)
    policySwitch()!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle(12)

    expect(document.querySelector('[data-slot="settings-policy-toggle-error"]')).toBeNull()
    expect(config().tool_policy).toEqual({ "shell-guard": { enabled: false } })
  })
})
