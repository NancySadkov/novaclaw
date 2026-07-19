// Node test (node:test) for the memory store — runs under NODE, never the Bun suite (the native
// addon segfaults under Bun). `bun run test` does NOT pick this up; run `npm test` in this package
// (node --test) — on Windows and the aarch64 Spark (P0 platforms).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "./store.ts"

const DIM = 8
// Tiny deterministic embeddings — orthogonal-ish so cosine NN is unambiguous.
const vec = (i: number): number[] => {
  const v = new Array(DIM).fill(0)
  v[i % DIM] = 1
  v[(i + 1) % DIM] = 0.3
  return v
}

let dir: string
let store: MemoryStore

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-sidecar-"))
  store = await MemoryStore.open(join(dir, "mem"), { dim: DIM })
})

after(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

// ⚠️ Ladybug is single-writer with an on-disk file LOCK. Two consequences the sidecar must honour
// (verified here + in P0): (1) a SECOND concurrent handle on the same path is rejected — the reason
// the sidecar is ONE process (§4.1); (2) even after close()/closeSync(), an IMMEDIATE same-process
// REOPEN of the same path still can't re-acquire the lock. Neither bites the sidecar (it opens the
// DB once and holds it for its lifetime; a restart is always a NEW process, and P0 proved a fresh
// process reopens a prior process's on-disk DB fine). So there is NO in-process close+reopen test
// here by design — that scenario is unsupported AND never used. Restart-idempotence (the DDL
// swallow when a new process reopens an existing DB) is covered cross-process by P0 + `ddl()`.

test("add + hybrid search: scope filter and vector/FTS both contribute", async () => {
  await store.addMemory({ id: "m_alice", kind: "entity", name: "Alice", text: "Alice works at Acme in Berlin", scope: "global", source: "chat", embedding: vec(0) })
  await store.addMemory({ id: "m_acme", kind: "entity", name: "Acme", text: "Acme is headquartered in Berlin", scope: "global", source: "chat", embedding: vec(1) })
  await store.addMemory({ id: "m_bob", kind: "entity", name: "Bob", text: "Bob lives in Paris and likes jazz", scope: "session:s1", source: "chat", embedding: vec(4) })

  // FTS term "Berlin" → the two Berlin memories (both global).
  const berlin = await store.search({ query: "Berlin", k: 5 })
  const berlinIds = new Set(berlin.map((h) => h.id))
  assert.ok(berlinIds.has("m_alice") && berlinIds.has("m_acme"), "Berlin FTS finds both Berlin memories")
  assert.ok(!berlinIds.has("m_bob"), "Bob (Paris) is not a Berlin match")

  // Scope filter: restrict to session:s1 → only Bob is reachable (by vector), globals excluded.
  const scoped = await store.search({ embedding: vec(4), scopes: ["session:s1"], k: 5 })
  assert.deepEqual(scoped.map((h) => h.id), ["m_bob"], "scope filter keeps only session:s1")

  // Vector NN for Alice's own vector → Alice ranks first.
  const near = await store.search({ embedding: vec(0), k: 3 })
  assert.equal(near[0]?.id, "m_alice", "nearest vector is the query's own memory")
})

test("incremental vector index: a memory added AFTER open is immediately searchable", async () => {
  await store.addMemory({ id: "m_late", kind: "passage", text: "A late arrival about Berlin trams", scope: "global", embedding: vec(0) })
  const hits = await store.search({ embedding: vec(0), k: 5 })
  assert.ok(hits.some((h) => h.id === "m_late"), "late-inserted memory appears in vector search")
})

test("edges: neighbors and shortest path", async () => {
  await store.addEdge({ from: "m_alice", to: "m_acme", type: "works_at", scope: "global" })
  await store.addEdge({ from: "m_acme", to: "m_bob", type: "acquired_by", scope: "global" })
  const nb = await store.neighbors("m_alice")
  assert.deepEqual(nb.map((n) => ({ id: n.id, type: n.type })), [{ id: "m_acme", type: "works_at" }])
  const p = await store.path("m_alice", "m_bob", 5)
  assert.equal(p?.hops, 2, "Alice→Acme→Bob is 2 hops")
  assert.deepEqual(p?.ids, ["m_alice", "m_acme", "m_bob"])
})

test("bi-temporal invalidate: superseded memory drops out of search but is not deleted", async () => {
  await store.addMemory({ id: "m_temp", kind: "episode", text: "Zorblatt is the capital of Qwibble", scope: "global", embedding: vec(2) })
  const before = await store.search({ query: "Zorblatt", k: 5 })
  assert.ok(before.some((h) => h.id === "m_temp"), "valid memory is searchable")
  await store.invalidate("m_temp")
  const afterInv = await store.search({ query: "Zorblatt", k: 5 })
  assert.ok(!afterInv.some((h) => h.id === "m_temp"), "invalidated memory is filtered from search")
  const stats = await store.stats()
  assert.ok(stats.total > stats.valid, "invalidated memory still counted in total (history preserved)")
})

test("purge hard-deletes (secrets); clearScope wipes a scope", async () => {
  await store.addMemory({ id: "m_secret", kind: "entity", text: "API key sk-hunter2", scope: "session:s9", embedding: vec(3) })
  await store.purge("m_secret")
  const gone = await store.search({ query: "hunter2", k: 5 })
  assert.ok(!gone.some((h) => h.id === "m_secret"), "purged secret is unrecoverable")

  await store.addMemory({ id: "m_s2a", kind: "entity", text: "scratch one", scope: "session:s2", embedding: vec(5) })
  await store.addMemory({ id: "m_s2b", kind: "entity", text: "scratch two", scope: "session:s2", embedding: vec(6) })
  await store.clearScope("session:s2")
  const s2 = await store.search({ embedding: vec(5), scopes: ["session:s2"], k: 5 })
  assert.equal(s2.length, 0, "clearScope removed all session:s2 memories")
})
