import { describe, expect, test } from "bun:test"
import { fetchInstanceDiagnostics } from "./diagnostic-export"

const server = {
  url: "https://remote.example/instance/",
  username: "nova",
  password: "secret",
}

describe("fetchInstanceDiagnostics", () => {
  test("asks the authenticated instance for its fixed source without sending a path", async () => {
    let request: Request | undefined
    const text = await fetchInstanceDiagnostics(server, {
      fetch: (input, init) => {
        request = new Request(input, init)
        return Promise.resolve(new Response("bounded server diagnostics"))
      },
    })

    expect(text).toBe("bounded server diagnostics")
    expect(request?.url).toBe("https://remote.example/instance/api/log/export")
    expect(request?.method).toBe("POST")
    expect(request?.headers.get("authorization")).toStartWith("Basic ")
    expect(await request?.text()).toBe("")
    for (const word of ["path", "directory", "root", "source"]) expect(request?.url).not.toContain(word)
  })

  test("cancels a response that crosses the byte budget", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(
      fetchInstanceDiagnostics(server, { fetch: () => Promise.resolve(new Response(body)), maxBytes: 8 }),
    ).rejects.toThrow("8-byte response budget")
    expect(cancelled).toBe(true)
  })

  test("aborts a slow source at the wall-clock budget", async () => {
    const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    await expect(fetchInstanceDiagnostics(server, { fetch, timeoutMs: 5 })).rejects.toMatchObject({
      name: "TimeoutError",
    })
  })
})
