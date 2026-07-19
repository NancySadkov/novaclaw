// Node test for the sidecar HTTP face — in-process (open store + server, fetch loopback). Runs
// under node:test, never the Bun suite (native addon). Verifies routing, token auth, and that the
// endpoints round-trip through the real MemoryStore.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { MemoryStore } from "./store.ts"
import { createMemoryServer } from "./server.ts"

const DIM = 8
const vec = (i: number): number[] => {
  const v = new Array(DIM).fill(0)
  v[i % DIM] = 1
  return v
}
const TOKEN = "test-token-123"

let dir: string
let store: MemoryStore
let server: ReturnType<typeof createMemoryServer>
let base: string

const call = (path: string, body?: unknown, token: string | null = TOKEN) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  })

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-sidecar-srv-"))
  store = await MemoryStore.open(join(dir, "mem"), { dim: DIM })
  server = createMemoryServer(store, { token: TOKEN })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

test("/health needs no auth", async () => {
  const res = await fetch(base + "/health")
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

test("missing/wrong token is rejected", async () => {
  assert.equal((await call("/stats", {}, null)).status, 401)
  assert.equal((await call("/stats", {}, "nope")).status, 401)
})

test("add → search round-trips through the store over HTTP", async () => {
  assert.equal(
    (await call("/add", { id: "a1", kind: "entity", name: "Alice", text: "Alice in Berlin", scope: "global", embedding: vec(0) })).status,
    200,
  )
  await call("/add", { id: "a2", kind: "entity", name: "Acme", text: "Acme in Berlin", scope: "global", embedding: vec(1) })
  const res = await call("/search", { query: "Berlin", k: 5 })
  assert.equal(res.status, 200)
  const { hits } = (await res.json()) as { hits: { id: string }[] }
  const ids = new Set(hits.map((h) => h.id))
  assert.ok(ids.has("a1") && ids.has("a2"), "both Berlin memories returned")
})

test("edges + path over HTTP", async () => {
  await call("/addEdge", { from: "a1", to: "a2", type: "colocated_with", scope: "global" })
  const nb = (await (await call("/neighbors", { id: "a1" })).json()) as { neighbors: { id: string }[] }
  assert.deepEqual(nb.neighbors.map((n) => n.id), ["a2"])
  const p = (await (await call("/path", { from: "a1", to: "a2", maxHops: 3 })).json()) as { path: { hops: number } | null }
  assert.equal(p.path?.hops, 1)
})

test("invalidate + purge + stats over HTTP", async () => {
  await call("/add", { id: "temp", kind: "episode", text: "Zorblatt fact", scope: "global", embedding: vec(2) })
  await call("/invalidate", { id: "temp" })
  const gone = (await (await call("/search", { query: "Zorblatt", k: 5 })).json()) as { hits: { id: string }[] }
  assert.ok(!gone.hits.some((h) => h.id === "temp"), "invalidated memory not returned")
  const stats = (await (await call("/stats", {})).json()) as { stats: { total: number; valid: number } }
  assert.ok(stats.stats.total > stats.stats.valid, "history preserved after invalidate")

  await call("/add", { id: "sec", kind: "entity", text: "secret hunter2", scope: "session:x", embedding: vec(3) })
  await call("/purge", { id: "sec" })
  const purged = (await (await call("/search", { query: "hunter2", k: 5 })).json()) as { hits: { id: string }[] }
  assert.ok(!purged.hits.some((h) => h.id === "sec"), "purged secret gone")
})

test("unknown route → 404", async () => {
  assert.equal((await call("/nope", {})).status, 404)
})
