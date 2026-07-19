// LIVE end-to-end smoke for the Ladybug memory sidecar (notes/kb-graph-plan.md §2.1, P1 gate).
// This is the contract test for the WHOLE Bun↔Node boundary: the Bun supervisor (../src/kb-graph/
// sidecar.ts) spawns the REAL Node sidecar (packages/kb-sidecar, the real @ladybugdb/core engine),
// waits for its readiness line, and round-trips memory ops through the Bun-side MemoryClient. It also
// proves the two properties the supervised-sidecar architecture is FOR: crash → auto-restart (a new
// port, the client recovers) and durability across the restart (memories written before the crash
// survive on the ACID disk graph).
//
// ⚠️ NOT hermetic — spawns `node`, writes a real Ladybug DB, and (on a clean host) the sidecar's
// first LOAD needs the vector/fts extensions in ~/.lbdb (present after P1a/P1b; airgap builds vendor
// them — the separate P1 vendoring item). So this is a `.smoke.ts` (excluded from `bun run test`,
// which globs *.test.ts) and runs UNDER BUN (safe: Bun only spawns node; the addon lives in the child):
//     cd packages/core && bun test test/kb-graph-sidecar-live.smoke.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { Sidecar } from "@novaclaw/core/kb-graph/sidecar"

const ENTRY = resolve(import.meta.dir, "../../kb-sidecar/src/main.ts")
const DIM = 8
const TOKEN = "smoke-token"
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

let dir: string
let sup: Sidecar.Supervisor

const waitFor = async (pred: () => boolean, ms: number, label: string): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-sidecar-live-"))
  sup = Sidecar.superviseSidecar({
    entry: ENTRY,
    dbPath: join(dir, "mem"),
    dim: DIM,
    token: TOKEN,
    onLog: (l) => l && console.log(`[sidecar] ${l}`),
  })
  await sup.ready
})

afterAll(async () => {
  await sup?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe("kb-sidecar live (Bun supervises the real Node engine)", () => {
  test("becomes ready with a loopback url + a live pid", () => {
    expect(sup.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(sup.pid()).toBeGreaterThan(0)
  })

  test("health round-trips over HTTP", async () => {
    expect(await run(sup.client.health())).toBe(true)
  })

  test("add → FTS search round-trips through the real graph", async () => {
    await run(sup.client.addMemory({ id: "alice", kind: "entity", name: "Alice", text: "Alice lives in Berlin", scope: "global" }))
    await run(sup.client.addMemory({ id: "acme", kind: "entity", name: "Acme", text: "Acme is based in Berlin", scope: "global" }))
    const hits = await run(sup.client.search({ query: "Berlin", k: 5 }))
    const ids = new Set(hits.map((h) => h.id))
    expect(ids.has("alice") && ids.has("acme")).toBe(true)
  })

  test("edges: neighbors + shortest path", async () => {
    await run(sup.client.addEdge({ from: "alice", to: "acme", type: "works_at", scope: "global" }))
    const nb = await run(sup.client.neighbors("alice"))
    expect(nb.map((n) => n.id)).toEqual(["acme"])
    expect((await run(sup.client.path("alice", "acme", 3)))?.hops).toBe(1)
  })

  test("bitemporal invalidate drops from search but keeps history in stats", async () => {
    await run(sup.client.addMemory({ id: "temp", kind: "episode", text: "Zorblatt happened", scope: "global" }))
    await run(sup.client.invalidate("temp"))
    const hits = await run(sup.client.search({ query: "Zorblatt", k: 5 }))
    expect(hits.some((h) => h.id === "temp")).toBe(false)
    const stats = await run(sup.client.stats())
    expect(stats.total).toBeGreaterThan(stats.valid)
  })

  test("secret purge hard-deletes; scope-filtered search isolates sessions", async () => {
    await run(sup.client.addMemory({ id: "sec", kind: "entity", text: "password hunter2", scope: "session:x" }))
    // session-scoped memory must NOT surface in a global-only search (isolation, §4.2).
    const globalOnly = await run(sup.client.search({ query: "hunter2", scopes: ["global"] }))
    expect(globalOnly.some((h) => h.id === "sec")).toBe(false)
    await run(sup.client.purge("sec"))
    const gone = await run(sup.client.search({ query: "hunter2" }))
    expect(gone.some((h) => h.id === "sec")).toBe(false)
  })

  // Kill + backoff + respawn + reopen takes several seconds — well past Bun's 5s default.
  test("crash → auto-restart on a NEW port, and the disk graph survives (durability)", async () => {
    const url1 = sup.url()
    const pid1 = sup.pid()!
    // Simulate a hard crash of the engine child (tree-kill — the way it dies in the wild).
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(pid1), "/f", "/t"], { stdout: "ignore", stderr: "ignore" })
    else process.kill(pid1, "SIGKILL")

    // The supervisor's backoff ladder respawns it; port 0 → a fresh port.
    await waitFor(() => sup.url() !== "" && sup.url() !== url1, 20_000, "sidecar restart on a new port")
    expect(sup.url()).not.toBe(url1)
    expect(await run(sup.client.health())).toBe(true)

    // Memories written before the crash are still there — the ACID disk graph reopened cleanly.
    const hits = await run(sup.client.search({ query: "Berlin", k: 5 }))
    expect(new Set(hits.map((h) => h.id)).has("alice")).toBe(true)
  }, 30_000)
})
