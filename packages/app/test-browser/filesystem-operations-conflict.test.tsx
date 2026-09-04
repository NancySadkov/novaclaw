import { afterEach, describe, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { useFilesystemOperations } from "@/components/filesystem-operations"
import { LanguageContext } from "@/context/language"

let dispose: (() => void) | undefined
let originalFetch: typeof globalThis.fetch | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function Harness(props: { changed: () => void }) {
  const operations = useFilesystemOperations({
    server: () => ({ url: "http://localhost:4096" }) as never,
    changed: props.changed,
  })
  onMount(() => void operations.createFolder("C:/project"))
  return null
}

describe("filesystem operation conflicts", () => {
  test("keeps an existing-folder conflict inside the naming dialog", async () => {
    originalFetch = globalThis.fetch
    const requests: RequestInfo[] = []
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      requests.push(request as RequestInfo)
      return new Response(JSON.stringify({ message: 'Path already exists: "project/.claude/"' }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    let changes = 0
    const host = document.createElement("div")
    document.body.appendChild(host)
    const language = {
      t: (key: string) => key,
      plural: (key: string) => key,
      locale: () => "en",
      setLocale: () => undefined,
    }
    dispose = render(
      () => (
        <LanguageContext.Provider value={language as never}>
          <DialogProvider>
            <Harness changed={() => changes++} />
          </DialogProvider>
        </LanguageContext.Provider>
      ),
      host,
    )

    await settle()
    const input = document.querySelector("input") as HTMLInputElement
    input.value = ".claude"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const submit = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("files.createFolder"),
    ) as HTMLButtonElement
    submit.click()
    await settle()

    expect(requests).toHaveLength(1)
    expect(changes).toBe(0)
    expect(document.body.textContent).toContain("files.nameError.exists")
    expect((document.querySelector("input") as HTMLInputElement).value).toBe(".claude")
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
