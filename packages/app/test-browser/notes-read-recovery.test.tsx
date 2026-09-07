import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { NotesPage } from "@/pages/notes"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { LanguageContext } from "@/context/language"
import { languageStub } from "./language-stub"

let dispose: (() => void) | undefined
const originalFetch = globalThis.fetch
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
  globalThis.fetch = originalFetch
  localStorage.removeItem("novaclaw.notes.last")
})
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
function mount(initial: "reject" | "missing" | "binary" | "empty") {
  let state = initial as string
  let writes = 0
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "PUT") writes++
    return Response.json({ ok: true })
  }) as typeof fetch
  const connection = { url: "http://notes.test", http: { url: "http://notes.test" } }
  const ctx = {
    sdk: {
      client: {
        path: { get: async () => ({ data: { data: "/tmp/notes-test" } }) },
        v2: {
          directory: {
            browse: async () => ({ data: [{ name: "record.md", type: "file" }] }),
          },
        },
        file: {
          read: async () => {
            if (state === "reject") throw new Error("read refused")
            return {
              data:
                state === "missing" || state === "binary"
                  ? { type: state }
                  : { type: "text", content: state === "empty" ? "" : "Original contents" },
            }
          },
        },
      },
    },
  }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <LanguageContext.Provider value={languageStub as never}>
        <GlobalContext.Provider value={{ servers: { list: () => [connection] }, ensureServerCtx: () => ctx } as never}>
          <ServerContext.Provider value={{ current: connection } as never}>
            <NotesPage />
          </ServerContext.Provider>
        </GlobalContext.Provider>
      </LanguageContext.Provider>
    ),
    host,
  )
  return {
    recover: () => {
      state = "ready"
    },
    writes: () => writes,
  }
}
for (const failure of ["reject", "missing", "binary"] as const)
  test(`an unreadable note (${failure}) blocks editing until a successful retry`, async () => {
    const rig = mount(failure)
    await settle()
    expect(document.querySelector("textarea")).toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not read this note")
    expect(document.body.textContent).not.toContain("Saved")
    expect(rig.writes()).toBe(0)
    rig.recover()
    ;[...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Try again")!.click()
    await settle()
    const editor = document.querySelector("textarea")!
    expect(editor.value).toBe("Original contents")
    expect(editor.readOnly).toBe(false)
    expect(editor.getAttribute("aria-label")).toBe("Notes: record.md")
    expect(rig.writes()).toBe(0)
  })
test("a successfully read empty note stays editable", async () => {
  mount("empty")
  await settle()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  const editor = document.querySelector("textarea")!
  expect(editor.value).toBe("")
  expect(editor.readOnly).toBe(false)
})
