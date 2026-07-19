import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Exit } from "effect"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"

// Bun-side unit test for the memory client — runs under the Bun suite (no @ladybugdb/core, which
// segfaults under Bun). A tiny stub HTTP server captures each request and returns canned bodies, so
// we assert the client hits the right route, sends the right JSON, unwraps the right field, enforces
// the bearer token, and collapses non-2xx into a tagged MemoryError. The REAL engine contract is
// covered separately by the live spawn smoke (memory-client-live.smoke.ts).

const TOKEN = "unit-token"

interface Captured {
  path: string
  method: string
  auth: string | undefined
  body: unknown
}

let server: Server
let base: string
let last: Captured | undefined
// Per-route canned response ({ status, body }); default 200 {ok:true}.
const canned = new Map<string, { status: number; body: unknown }>()

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}))
  })

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0]
      const body = await readBody(req)
      last = { path, method: req.method ?? "", auth: req.headers.authorization, body }
      if (path === "/health") {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ ok: true }))
      }
      const reply = canned.get(path) ?? { status: 200, body: { ok: true } }
      res.writeHead(reply.status, { "content-type": "application/json" })
      res.end(JSON.stringify(reply.body))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const client = () => MemoryClient.make({ url: base + "/", token: TOKEN })
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe("MemoryClient", () => {
  test("health probes /health and needs no token", async () => {
    expect(await run(client().health())).toBe(true)
    expect(last?.path).toBe("/health")
  })

  test("addMemory POSTs /add with the payload and the bearer token", async () => {
    canned.set("/add", { status: 200, body: { ok: true } })
    await run(client().addMemory({ id: "m1", kind: "entity", text: "hi", scope: "global" }))
    expect(last?.method).toBe("POST")
    expect(last?.path).toBe("/add")
    expect(last?.auth).toBe(`Bearer ${TOKEN}`)
    expect(last?.body).toMatchObject({ id: "m1", kind: "entity", text: "hi", scope: "global" })
  })

  test("search unwraps { hits }", async () => {
    const hits = [{ id: "m1", kind: "entity", text: "hi", name: null, scope: "global", source: null, confidence: null, relation: "staged", score: 0.9 }]
    canned.set("/search", { status: 200, body: { hits } })
    const out = await run(client().search({ query: "hi", k: 5 }))
    expect(out).toEqual(hits as never)
    expect(last?.body).toMatchObject({ query: "hi", k: 5 })
  })

  test("neighbors sends id + opts and unwraps { neighbors }", async () => {
    canned.set("/neighbors", { status: 200, body: { neighbors: [{ id: "n1", type: "rel", text: "t" }] } })
    const out = await run(client().neighbors("m1", { scopes: ["global"], k: 3 }))
    expect(out).toEqual([{ id: "n1", type: "rel", text: "t" }])
    expect(last?.body).toMatchObject({ id: "m1", scopes: ["global"], k: 3 })
  })

  test("path unwraps { path } (may be null)", async () => {
    canned.set("/path", { status: 200, body: { path: { ids: ["a", "b"], hops: 1 } } })
    expect(await run(client().path("a", "b", 4))).toEqual({ ids: ["a", "b"], hops: 1 })
    expect(last?.body).toMatchObject({ from: "a", to: "b", maxHops: 4 })
    canned.set("/path", { status: 200, body: { path: null } })
    expect(await run(client().path("a", "z"))).toBeNull()
  })

  test("stats unwraps { stats }", async () => {
    canned.set("/stats", { status: 200, body: { stats: { total: 3, valid: 2 } } })
    expect(await run(client().stats())).toEqual({ total: 3, valid: 2 })
  })

  test("invalidate / purge / clearScope round-trip", async () => {
    await run(client().invalidate("m1", "2026-01-01T00:00:00Z"))
    expect(last?.path).toBe("/invalidate")
    expect(last?.body).toMatchObject({ id: "m1", at: "2026-01-01T00:00:00Z" })
    await run(client().purge("m1"))
    expect(last?.path).toBe("/purge")
    await run(client().clearScope("session:x"))
    expect(last?.path).toBe("/clearScope")
    expect(last?.body).toMatchObject({ scope: "session:x" })
  })

  test("a non-2xx collapses to a MemoryError carrying the sidecar's error detail", async () => {
    canned.set("/add", { status: 400, body: { error: "bad input" } })
    // Effect.flip turns the expected failure into a success so we can read the error value directly.
    const err = await run(client().addMemory({ id: "x", kind: "entity", text: "", scope: "global" }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(MemoryClient.MemoryError)
    expect(err.reason).toContain("400")
    expect(err.reason).toContain("bad input")
  })

  test("an unreachable sidecar → health false, ops fail as MemoryError", async () => {
    const dead = MemoryClient.make({ url: "http://127.0.0.1:1", token: TOKEN, timeoutMs: 500 })
    expect(await run(dead.health())).toBe(false)
    const exit = await Effect.runPromiseExit(dead.stats())
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
