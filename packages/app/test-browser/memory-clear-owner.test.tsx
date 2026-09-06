import { afterEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { MemoryRemembered } from "@/components/memory-remembered"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { LanguageContext } from "@/context/language"
import { languageStub } from "./language-stub"

const originalFetch = globalThis.fetch
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
  globalThis.fetch = originalFetch
})
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const button = (name: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === name)!

function mount(accept = true, scoped = true) {
  const scopes = new Set(["global", "agent:daedalus", "agent:myron"])
  const clears: string[] = []
  const queries: string[][] = []
  const [owner, setOwner] = createSignal(scoped ? { label: "Daedalus", scopes: ["agent:daedalus"] } : undefined)
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname.endsWith("memory/clearScope")) {
      const { scope } = JSON.parse(String(init?.body))
      clears.push(scope)
      if (accept) scopes.delete(scope)
      return Response.json(accept)
    }
    if (url.pathname.endsWith("memory/list")) {
      const asked = url.searchParams.get("scopes")?.split(",") ?? [...scopes]
      queries.push(asked)
      return Response.json(asked.filter((scope) => scopes.has(scope)).map((scope) => ({
        id: scope, scope, kind: "entity", text: `${scope} record`, status: "active", relation: "staged",
      })))
    }
    if (url.pathname.endsWith("memory/stats")) return Response.json({ total: scopes.size, valid: scopes.size })
    return Response.json({ signals: [{ id: "memory", status: "ok" }] })
  }) as typeof fetch
  const cn = { url: "http://memory.test", http: { url: "http://memory.test" } }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => (
    <LanguageContext.Provider value={languageStub as never}>
      <GlobalContext.Provider value={{ servers: { list: () => [cn] } } as never}>
        <ServerContext.Provider value={{ current: cn } as never}>
          <ServerSyncContext.Provider value={(() => ({ data: { path: { directory: "/tmp/test" } } })) as never}>
            <DialogProvider><MemoryRemembered owner={owner()} /></DialogProvider>
          </ServerSyncContext.Provider>
        </ServerContext.Provider>
      </GlobalContext.Provider>
    </LanguageContext.Provider>
  ), host)
  return { scopes, clears, queries, setOwner }
}

test("a cabinet's read, label and confirmed clear share one owner, even if selection changes", async () => {
  const rig = mount()
  await settle()
  expect(rig.queries.at(-1)).toEqual(["agent:daedalus"])
  button("Clear memory: Daedalus").click()
  await settle()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain("Clear memory for Daedalus?")
  expect(dialog.textContent).not.toContain("backup")
  rig.setOwner({ label: "Myron", scopes: ["agent:myron"] })
  button("Forget them").click()
  await settle()
  expect(rig.clears).toEqual(["agent:daedalus"])
  expect([...rig.scopes]).toEqual(["global", "agent:myron"])
  expect(rig.queries.at(-1)).toEqual(["agent:myron"])
})

test("cancel and a refused scoped clear keep the cabinet intact", async () => {
  const rig = mount(false)
  await settle()
  button("Clear memory: Daedalus").click()
  await settle()
  button("Cancel").click()
  await settle()
  expect(rig.clears).toEqual([])
  button("Clear memory: Daedalus").click()
  await settle()
  button("Forget them").click()
  await settle()
  expect(rig.clears).toEqual(["agent:daedalus"])
  expect(rig.scopes.size).toBe(3)
  expect(document.body.textContent).toContain("agent:daedalus record")
})

test("the unscoped settings list names its shared-memory action explicitly", async () => {
  const rig = mount(true, false)
  await settle()
  button("Clear memory: Shared with everyone").click()
  await settle()
  button("Forget them").click()
  await settle()
  expect(rig.clears).toEqual(["global"])
  expect([...rig.scopes]).toEqual(["agent:daedalus", "agent:myron"])
})
