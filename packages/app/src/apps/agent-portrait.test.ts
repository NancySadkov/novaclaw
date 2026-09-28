import { describe, expect, test } from "bun:test"
import { agentInitials, fetchAgentPortrait, isAgentPortraitURL, loadAgentPortrait } from "./agent-portrait"
import { instanceUrl } from "@/utils/instance-fetch"

describe("instance-owned agent portraits", () => {
  test("compact identities keep two initials and never split a Unicode character", () => {
    expect(agentInitials("  Iris   Vale ")).toBe("IV")
    expect(agentInitials("Nova")).toBe("N")
    expect(agentInitials("𐐀ster Vale")).toBe("𐐀V")
    expect(agentInitials(" ")).toBe("?")
  })
  test("only a server avatar route is image media", () => {
    expect(isAgentPortraitURL("/api/agent/nova/avatar?v=abc")).toBe(true)
    expect(isAgentPortraitURL("🦊")).toBe(false)
    expect(isAgentPortraitURL("/assets/agents/portraits/nova.svg")).toBe(false)
  })

  test("resolves the route against the selected instance, not the UI origin", () => {
    expect(instanceUrl({ url: "https://remote.example:4096" }, "/api/agent/theron/avatar?v=hash").toString()).toBe(
      "https://remote.example:4096/api/agent/theron/avatar?v=hash",
    )
  })

  test("🔴 reads protected portraits with the selected instance credential", async () => {
    const seen: { url?: string; authorization?: string } = {}
    const fetch = ((url: URL, init: RequestInit) => {
      seen.url = String(url)
      seen.authorization = new Headers(init.headers).get("authorization") ?? undefined
      return Promise.resolve(new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "image/png" } }))
    }) as unknown as typeof globalThis.fetch

    const blob = await fetchAgentPortrait(
      { url: "https://remote.example:4096", username: "nova", password: "secret" },
      "/api/agent/theron/avatar?v=hash",
      fetch,
    )

    expect(seen).toEqual({
      url: "https://remote.example:4096/api/agent/theron/avatar?v=hash",
      authorization: `Basic ${btoa("nova:secret")}`,
    })
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3])

    await expect(
      fetchAgentPortrait({ url: "https://remote.example:4096" }, "/api/agent/theron/avatar", (() =>
        Promise.resolve(
          new Response(undefined, { headers: { "content-type": "image/png" } }),
        )) as unknown as typeof fetch),
    ).rejects.toThrow("Agent portrait response was empty")
  })

  test("a mounted portrait stays available to a newly opened roster during an outage", async () => {
    const server = { url: "https://portrait-cache.example:4096", password: "one" }
    const route = "/api/agent/myron/avatar?v=first"
    let reads = 0
    const fetch = (() => {
      reads++
      return Promise.resolve(new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "image/png" } }))
    }) as unknown as typeof globalThis.fetch
    const original = await loadAgentPortrait(server, route, fetch)
    const unavailable = (() => {
      throw new Error("server unavailable")
    }) as unknown as typeof globalThis.fetch
    expect(await loadAgentPortrait(server, route, unavailable)).toBe(original)
    expect(reads).toBe(1)
    await expect(loadAgentPortrait({ ...server, password: "two" }, route, unavailable)).rejects.toThrow("server unavailable")
    await expect(loadAgentPortrait(server, "/api/agent/myron/avatar?v=changed", unavailable)).rejects.toThrow(
      "server unavailable",
    )
  })
})
