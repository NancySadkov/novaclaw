// The lay-user address table, driven through the REAL probe transport with a canned client.
//
// `probeDiscovery` normalizes the line a person typed into at most two base URLs and keeps the one
// that actually answers as an OpenAI-compatible endpoint. The competing-harness caveats behind the
// normalization live in `core/src/config/endpoint-url.ts`; this file pins the SELECTION rules, which
// are the half a socket is not needed to get wrong.
//
// ⚠️ NO REAL NETWORK. Every client is `HttpClient.make` over a canned `Response`; the only URLs that
// appear are strings. Nothing here opens a socket, loopback included.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Offline } from "@novaclaw/core/offline"
import { probeDiscovery } from "../../src/server/routes/instance/httpapi/handlers/provider"

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

/** A transport that answers per URL and records what reached it. Unlisted URLs 404. */
const clientFor = (answer: (url: string) => Response) => {
  const seen: string[] = []
  const client = HttpClient.make((request) => {
    seen.push(request.url)
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(request.url)))
  })
  return { seen, client }
}

const run = (client: HttpClient.HttpClient, requestedURL: string) =>
  Effect.runPromise(probeDiscovery(client, { requestedURL, headers: {} }))

describe("probeDiscovery — normalization picks the answering base", () => {
  test("a schemeless host with no version is probed at the canonical /v1/ base", async () => {
    const { seen, client } = clientFor((url) =>
      url === "https://example.com/path/v1/models" ? json({ data: [{ id: "qwen3" }] }) : new Response("no", { status: 404 }),
    )
    const result = await run(client, "example.com/path/")
    expect(result.kind).toBe("probed")
    if (result.kind !== "probed") return
    expect(result.selected.baseURL).toBe("https://example.com/path/v1/")
    expect(result.attempts).toHaveLength(1)
    expect(seen).toEqual(["https://example.com/path/v1/models"])
  })

  test("a pasted `/v1/chat/completions` endpoint is probed at its base, not its operation", async () => {
    const { seen, client } = clientFor((url) =>
      url === "https://example.com/path/v1/models" ? json({ data: [{ id: "m" }] }) : new Response("no", { status: 404 }),
    )
    const result = await run(client, "https://example.com/path/v1/chat/completions")
    expect(result.kind).toBe("probed")
    if (result.kind !== "probed") return
    expect(result.selected.baseURL).toBe("https://example.com/path/v1/")
    expect(seen).toEqual(["https://example.com/path/v1/models"])
  })

  test("falls back to the version-less root when the /v1/ base has nothing", async () => {
    const { seen, client } = clientFor((url) =>
      url === "https://example.com/path/models" ? json({ data: [{ id: "m" }] }) : new Response("no", { status: 404 }),
    )
    const result = await run(client, "example.com/path/")
    expect(result.kind).toBe("probed")
    if (result.kind !== "probed") return
    expect(result.selected.baseURL).toBe("https://example.com/path/")
    expect(seen).toEqual(["https://example.com/path/v1/models", "https://example.com/path/models"])
  })

  test("loopback defaults to http and keeps the /v1/ path", async () => {
    const { seen, client } = clientFor((url) =>
      url === "http://localhost:8000/v1/models" ? json({ data: [{ id: "local" }] }) : new Response("no", { status: 404 }),
    )
    const result = await run(client, "localhost:8000")
    expect(result.kind).toBe("probed")
    if (result.kind !== "probed") return
    expect(result.selected.baseURL).toBe("http://localhost:8000/v1/")
    expect(seen).toEqual(["http://localhost:8000/v1/models"])
  })
})

describe("probeDiscovery — only a real access point is accepted", () => {
  test("a 200 that is not an OpenAI model list does not win over a real list at the fallback", async () => {
    const { client } = clientFor((url) =>
      url === "https://example.com/path/v1/models"
        ? json({ message: "this is not a model server" })
        : json({ data: [{ id: "m" }] }),
    )
    const result = await run(client, "example.com/path/")
    expect(result.kind).toBe("probed")
    if (result.kind !== "probed") return
    expect(result.selected.baseURL).toBe("https://example.com/path/")
  })

  test("an auth challenge at the convention is kept when the fallback has nothing", async () => {
    const { seen, client } = clientFor((url) =>
      url === "https://example.com/path/v1/models" ? new Response("no", { status: 401 }) : new Response("no", { status: 404 }),
    )
    const result = await run(client, "example.com/path/")
    expect(result.kind).toBe("probed")
    if (result.kind !== "probed") return
    expect(result.selected.baseURL).toBe("https://example.com/path/v1/")
    expect(result.selected.transport.kind).toBe("auth")
    expect(seen).toEqual(["https://example.com/path/v1/models", "https://example.com/path/models"])
  })

  test("🔴 a real model list at the fallback BEATS an auth challenge at the convention", async () => {
    // An auth challenge proves a route wants a key; a model list proves an access point. The list wins,
    // or a keyed first guess would hide the open endpoint the user actually has.
    const { client } = clientFor((url) =>
      url === "https://example.com/path/v1/models"
        ? new Response("no", { status: 401 })
        : json({ data: [{ id: "m" }] }),
    )
    const result = await run(client, "example.com/path/")
    expect(result.kind).toBe("probed")
    if (result.kind !== "probed") return
    expect(result.selected.baseURL).toBe("https://example.com/path/")
    expect(result.selected.transport.kind).toBe("ok")
  })

  test("an unreadable address is refused before any request is made", async () => {
    const { seen, client } = clientFor(() => json({ data: [{ id: "m" }] }))
    const result = await run(client, "not a url")
    expect(result.kind).toBe("invalid")
    expect(seen).toEqual([])
  })
})

describe("probeDiscovery — a refusal is a decision, not an outage", () => {
  test("airgap ON: the refusal is kept and the loop does not retry the fallback", async () => {
    const policy: Offline.Policy = { enabled: true, allowedHosts: new Set<string>() }
    const offline: Offline.Interface = {
      policy,
      check: (url: string) => Offline.checkUrl(url, policy),
      egressEnv: () => Offline.egressEnv(policy),
      manifest: () => Offline.layerManifest(policy),
    }
    let requests = 0
    const guarded = Offline.guard(
      HttpClient.make((request) => {
        requests += 1
        return Effect.succeed(HttpClientResponse.fromWeb(request, json({ data: [{ id: "m" }] })))
      }),
      offline,
    )
    const result = await run(guarded, "https://api.example.com/v1")
    expect(result.kind).toBe("probed")
    if (result.kind !== "probed") return
    expect(result.attempts).toHaveLength(1)
    expect(result.selected.transport.kind).toBe("blocked")
    // The socket was never opened: the guard refused before the transport.
    expect(requests).toBe(0)
  })
})
