import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { AgentPortrait } from "@/components/agent-portrait"
import { ServerContext } from "@/context/server"

const settle = async () => {
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test("🔴 a transient portrait failure retries and replaces the initials", async () => {
  const originalFetch = globalThis.fetch
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  let reads = 0
  globalThis.fetch = (async () => {
    reads++
    if (reads === 1) throw new TypeError("Failed to fetch")
    return new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "image/png" } })
  }) as unknown as typeof fetch
  URL.createObjectURL = () => `blob:portrait-${reads}`
  URL.revokeObjectURL = () => undefined
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <ServerContext.Provider
        value={
          {
            get current() {
              return { type: "http" as const, http: { url: "http://127.0.0.1:4196", password: "secret" } }
            },
          } as never
        }
      >
        <AgentPortrait id="nova" name="Nova" avatar="/api/agent/nova/avatar?v=1" retryDelayMs={() => 1} />
      </ServerContext.Provider>
    ),
    host,
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(host.querySelector("img")).not.toBeNull()
    expect(host.textContent).not.toContain("N")
  } finally {
    dispose()
    host.remove()
    globalThis.fetch = originalFetch
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  }
})

test("status and connection object updates retain decoded portraits; image and credential changes reload", async () => {  const [officer, setOfficer] = createSignal({ avatar: "/api/agent/nova/avatar?v=1", task: "First task" })
  const [connection, setConnection] = createSignal({
    type: "http" as const,
    http: { url: "http://127.0.0.1:4196", password: "first" },
  })
  const originalFetch = globalThis.fetch
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  let reads = 0
  let urls = 0
  const revoked: string[] = []
  globalThis.fetch = (async () => {
    reads++
    return new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "image/png" } })
  }) as unknown as typeof fetch
  URL.createObjectURL = () => `blob:portrait-${++urls}`
  URL.revokeObjectURL = (url) => {
    revoked.push(url)
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <ServerContext.Provider
        value={
          {
            get current() {
              return connection()
            },
          } as never
        }
      >
        <AgentPortrait id="nova" name="Nova" avatar={officer().avatar} />
      </ServerContext.Provider>
    ),
    host,
  )
  try {
    await settle()
    const image = host.querySelector("img")!
    expect(image).not.toBeNull()
    for (let index = 0; index < 20; index++) {
      setOfficer((value) => ({ ...value, task: `Task ${index}` }))
      setConnection((value) => ({ ...value, http: { ...value.http } }))
      expect(host.querySelector("img")).toBe(image)
    }
    await settle()
    expect(reads).toBe(1)
    expect(revoked).toEqual([])
    setOfficer((value) => ({ ...value, avatar: "/api/agent/nova/avatar?v=2" }))
    await settle()
    expect(reads).toBe(2)
    expect(revoked).toEqual(["blob:portrait-1"])
    setConnection((value) => ({ ...value, http: { ...value.http, password: "rotated" } }))
    await settle()
    expect(reads).toBe(3)
  } finally {
    dispose()
    host.remove()
    globalThis.fetch = originalFetch
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  }
  expect(revoked).toEqual(["blob:portrait-1", "blob:portrait-2", "blob:portrait-3"])
})
