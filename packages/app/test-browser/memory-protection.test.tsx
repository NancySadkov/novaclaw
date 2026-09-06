import { afterEach, expect, test } from "bun:test"
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
  for (let i = 0; i < 16; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const control = () => document.querySelector<HTMLButtonElement>('[data-slot="memory-row-vouch"]')!

function fixture(initial: boolean) {
  let stored = initial
  let readFails = false
  let writeFails = false
  const writes: boolean[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.includes("/api/memory/protection"))
      return readFails
        ? Response.json({ message: "unavailable" }, { status: 503 })
        : Response.json([{ id: "one", protected: stored }])
    if (url.includes("/api/memory/feedback")) {
      const next = JSON.parse(String(init?.body)).useful
      writes.push(next)
      if (!writeFails) stored = next
      return Response.json(!writeFails)
    }
    if (url.includes("/memory/list"))
      return Response.json([{ id: "one", scope: "global", kind: "entity", text: "One fact", status: "active" }])
    if (url.includes("/memory/stats")) return Response.json({ total: 1, valid: 1 })
    return Response.json({ signals: [{ id: "memory", status: "ok" }] })
  }) as typeof fetch
  const cn = { url: "http://memory.test", http: { url: "http://memory.test" } }
  const mount = () => {
    dispose?.()
    document.body.innerHTML = ""
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(
      () => (
        <LanguageContext.Provider value={languageStub as never}>
          <GlobalContext.Provider value={{ servers: { list: () => [cn] } } as never}>
            <ServerContext.Provider value={{ current: cn } as never}>
              <ServerSyncContext.Provider value={(() => ({ data: { path: { directory: "/tmp/test" } } })) as never}>
                <DialogProvider>
                  <MemoryRemembered />
                </DialogProvider>
              </ServerSyncContext.Provider>
            </ServerContext.Provider>
          </GlobalContext.Provider>
        </LanguageContext.Provider>
      ),
      host,
    )
  }
  return {
    mount,
    writes,
    stored: () => stored,
    failReads: (value: boolean) => {
      readFails = value
    },
    failWrites: () => {
      writeFails = true
    },
  }
}

test("protection comes from the store and both transitions survive remount", async () => {
  const rig = fixture(true)
  rig.mount()
  await settle()
  expect(control().textContent).toBe("Kept ✓")
  expect(control().getAttribute("aria-pressed")).toBe("true")
  control().click()
  await settle()
  expect(rig.stored()).toBe(false)
  rig.mount()
  await settle()
  expect(control().textContent).toBe("Keep this")
  control().click()
  await settle()
  expect(rig.stored()).toBe(true)
  rig.mount()
  await settle()
  expect(control().textContent).toBe("Kept ✓")
  expect(rig.writes).toEqual([false, true])
})

test("failed protection reads offer retry without guessing a toggle value", async () => {
  const rig = fixture(true)
  rig.failReads(true)
  rig.mount()
  await settle()
  expect(control().textContent).toBe("Retry protection status")
  expect(control().hasAttribute("aria-pressed")).toBe(false)
  rig.failReads(false)
  control().click()
  await settle()
  expect(control().textContent).toBe("Kept ✓")
  expect(rig.writes).toEqual([])
})

test("a refused feedback write retains the authoritative state", async () => {
  const rig = fixture(false)
  rig.failWrites()
  rig.mount()
  await settle()
  control().click()
  await settle()
  expect(rig.stored()).toBe(false)
  expect(control().textContent).toBe("Keep this")
  expect(control().getAttribute("aria-pressed")).toBe("false")
})
