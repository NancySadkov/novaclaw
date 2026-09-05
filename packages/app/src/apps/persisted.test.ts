import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { deletePersistedApp, loadPersistedApps, persistedManifests, type AppManifest } from "./persisted"

/**
 * **`apps/persisted.ts` was the app's last raw `fetch`** (). It is now the seam's client, and
 * these tests exist because the conversion changed WHERE four decisions are made — the base-URL
 * join, the `Authorization` header, the non-2xx decode and the not-a-list guard — while it must not
 * change WHAT the module does with any of them.
 *
 * ⚠️ Every expectation below was read off the PRE-conversion source (the `fetch(...).then(res =>
 * res.ok ? res.json() : undefined).catch(() => undefined)` form), not off the new code. Both
 * implementations were then imported side by side and driven over the SAME fourteen answers —
 * 200/array, 200/[], 200/object, 200/null, 200/string, 401, 500-HTML, transport throw for the load;
 * 204, 200-empty, 200-JSON, 404, 500, transport throw for the delete — comparing the URL, the
 * `Authorization` header and the resulting signal on each. They agree on all fourteen. The first
 * draft did NOT: it disagreed on `200` with an empty body, which is the case pinned below.
 *
 * The module holds a MODULE-level signal, so these tests share state and run in order: the "keeps
 * the last good list" cases depend on a successful load having happened.
 */

const server: ServerConnection.HttpBase = {
  url: "http://instance.test:4096",
  username: "novaclaw",
  password: "hunter2",
}
const auth = `Basic ${btoa("novaclaw:hunter2")}`

const manifest = (id: string): AppManifest => ({
  id,
  title: id,
  open: { type: "route", value: "contacts" },
  createdAt: 1,
  updatedAt: 1,
})

/** Stubs the GLOBAL fetch — which is what the seam calls — and always restores it. */
async function wire<T>(
  answer: { status?: number; body?: unknown; throws?: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; url?: string; method: string; headers: Record<string, string>; calls: number }> {
  const seen: { url?: string; init?: RequestInit } = {}
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = ((url: URL | RequestInfo, init?: RequestInit) => {
    calls += 1
    seen.url = String(url)
    seen.init = init
    if (answer.throws !== undefined) return Promise.reject(answer.throws)
    const status = answer.status ?? 200
    return Promise.resolve(
      answer.body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(answer.body), { status }),
    )
  }) as unknown as typeof globalThis.fetch
  try {
    const result = await run()
    return {
      result,
      url: seen.url,
      method: seen.init?.method ?? "GET",
      headers: (seen.init?.headers ?? {}) as Record<string, string>,
      calls,
    }
  } finally {
    globalThis.fetch = original
  }
}

describe("loadPersistedApps still puts the same request on the wire", () => {
  test("GET /app, joined onto a base with no trailing slash, with the Basic header", async () => {
    const sent = await wire({ body: [manifest("a")] }, () => loadPersistedApps(server))
    expect(sent.url).toBe("http://instance.test:4096/app")
    expect(sent.method).toBe("GET")
    expect(sent.headers.Authorization).toBe(auth)
    expect(persistedManifests().map((m) => m.id)).toEqual(["a"])
  })

  test("a base URL that already ends in a slash does not double it", async () => {
    const sent = await wire({ body: [] }, () => loadPersistedApps({ ...server, url: "http://instance.test:4096/" }))
    expect(sent.url).toBe("http://instance.test:4096/app")
  })

  test("no password means no Authorization header at all", async () => {
    const sent = await wire({ body: [] }, () => loadPersistedApps({ url: "http://instance.test:4096" }))
    expect(sent.headers.Authorization).toBeUndefined()
  })

  test("separate server buckets survive reversed response order", async () => {
    const first: ServerConnection.HttpBase = { url: "http://first.test:4096" }
    const second: ServerConnection.HttpBase = { url: "http://second.test:4096" }
    let resolveFirst!: (response: Response) => void
    let resolveSecond!: (response: Response) => void
    const original = globalThis.fetch
    globalThis.fetch = ((url: URL | RequestInfo) => {
      const target = String(url)
      const pending = target.startsWith(first.url)
        ? new Promise<Response>((resolve) => (resolveFirst = resolve))
        : new Promise<Response>((resolve) => (resolveSecond = resolve))
      return pending
    }) as unknown as typeof globalThis.fetch
    try {
      const loadingFirst = loadPersistedApps(first, "first")
      const loadingSecond = loadPersistedApps(second, "second")
      resolveSecond(new Response(JSON.stringify([manifest("second-tile")]), { status: 200 }))
      await loadingSecond
      resolveFirst(new Response(JSON.stringify([manifest("first-tile")]), { status: 200 }))
      await loadingFirst
    } finally {
      globalThis.fetch = original
    }
    expect(persistedManifests("first").map((m) => m.id)).toEqual(["first-tile"])
    expect(persistedManifests("second").map((m) => m.id)).toEqual(["second-tile"])
  })
})

describe("loadPersistedApps survives every answer a peer can send", () => {
  test("an empty list publishes an empty list", async () => {
    await wire({ body: [manifest("a"), manifest("b")] }, () => loadPersistedApps(server))
    expect(persistedManifests().length).toBe(2)
    await wire({ body: [] }, () => loadPersistedApps(server))
    expect(persistedManifests()).toEqual([])
  })

  test("an OBJECT answer does not reach the signal — the shape that took the whole UI down", async () => {
    await wire({ body: [manifest("keep")] }, () => loadPersistedApps(server))
    await wire({ body: {} }, () => loadPersistedApps(server))
    // ⚠️ The pre-conversion code returned WITHOUT touching the signal here, and so does this one.
    // `instanceFetchList` would have coerced to `[]` — correct for its `createResource` clients,
    // wrong for a module signal, because it would delete tiles the user is already looking at.
    expect(persistedManifests().map((m) => m.id)).toEqual(["keep"])
    // It must still be an ARRAY afterwards: `manifest-apps.ts` maps it during a render.
    expect(Array.isArray(persistedManifests())).toBe(true)
  })

  test("a null answer is reported as null, not as an object", async () => {
    await wire({ body: [manifest("keep")] }, () => loadPersistedApps(server))
    await wire({ body: null }, () => loadPersistedApps(server))
    expect(persistedManifests().map((m) => m.id)).toEqual(["keep"])
  })

  test("malformed array members are skipped while valid siblings remain renderable", async () => {
    await wire(
      {
        body: [
          manifest("good"),
          null,
          42,
          { ...manifest("missing-open"), open: undefined },
          { ...manifest("bad-route"), open: { type: "route", value: "not-a-route" } },
          { ...manifest("bad-time"), updatedAt: "now" },
        ],
      },
      () => loadPersistedApps(server),
    )
    expect(persistedManifests().map((m) => m.id)).toEqual(["good"])
  })

  test("an array containing no valid manifests becomes an explicit empty list", async () => {
    await wire({ body: [manifest("keep")] }, () => loadPersistedApps(server))
    await wire({ body: [null, { title: "missing id" }] }, () => loadPersistedApps(server))
    expect(persistedManifests()).toEqual([])
  })

  test("a 401 keeps the last good list and does NOT reject", async () => {
    await wire({ body: [manifest("keep")] }, () => loadPersistedApps(server))
    // A rejection here would be unhandled: both call sites use `void loadPersistedApps(...)`.
    const sent = await wire({ status: 401, body: { message: "nope" } }, () => loadPersistedApps(server))
    expect(sent.result).toBeUndefined()
    expect(persistedManifests().map((m) => m.id)).toEqual(["keep"])
  })

  test("a transport failure keeps the last good list and does NOT reject", async () => {
    await wire({ body: [manifest("keep")] }, () => loadPersistedApps(server))
    await wire({ throws: new TypeError("Failed to fetch") }, () => loadPersistedApps(server))
    expect(persistedManifests().map((m) => m.id)).toEqual(["keep"])
  })
})

describe("deletePersistedApp", () => {
  test("DELETE api/app/:id on the modern contract, id percent-encoded", async () => {
    await wire({ body: [manifest("a b/c"), manifest("other")] }, () => loadPersistedApps(server))
    const sent = await wire({ status: 204 }, () => deletePersistedApp(server, "a b/c"))
    expect(sent.method).toBe("DELETE")
    expect(sent.url).toBe("http://instance.test:4096/api/app/a%20b%2Fc")
    expect(sent.headers.Authorization).toBe(auth)
    expect(sent.result).toBe(true)
    expect(persistedManifests().map((m) => m.id)).toEqual(["other"])
  })

  test("a 200 with an EMPTY body is still a success — the one A/B divergence, and why", async () => {
    // 🔴 This is the case that made the delete use `instanceFetchResponse` rather than
    // `instanceFetch<void>`. `instanceFetch` treats a 2xx that promised JSON and sent none as a
    // fault, so the first draft reported failure here and the tile came back. Our own server sends
    // 204 (the endpoint is declared `NoContent`), but instances are PEERS on different versions and
    // a proxy can normalise 204 to 200. The pre-seam code was `res.ok`; so is this.
    await wire({ body: [manifest("a")] }, () => loadPersistedApps(server))
    const sent = await wire({ status: 200 }, () => deletePersistedApp(server, "a"))
    expect(sent.result).toBe(true)
    expect(persistedManifests()).toEqual([])
  })

  test("a non-2xx returns false and leaves the tile in place", async () => {
    await wire({ body: [manifest("a")] }, () => loadPersistedApps(server))
    const sent = await wire({ status: 500, body: { message: "boom" } }, () => deletePersistedApp(server, "a"))
    expect(sent.result).toBe(false)
    expect(persistedManifests().map((m) => m.id)).toEqual(["a"])
  })

  test("a transport failure returns false rather than rejecting", async () => {
    await wire({ body: [manifest("a")] }, () => loadPersistedApps(server))
    const sent = await wire({ throws: new TypeError("Failed to fetch") }, () => deletePersistedApp(server, "a"))
    expect(sent.result).toBe(false)
    expect(persistedManifests().map((m) => m.id)).toEqual(["a"])
  })
})
