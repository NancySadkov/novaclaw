import { createInterface } from "node:readline"
import { WasmMemory } from "@novaclaw/core/kb-graph/wasm-engine"

const methods = new Set([
  "addMemory", "addEdge", "search", "neighbors", "get", "path", "invalidate", "purge", "addClaim",
  "claimHistory", "reviewEvidence", "setClaimStatus", "moveScope", "clearScope", "eraseAll",
  "discardLegacyGlobalExtracts", "stats", "list", "candidates", "byIds", "graph", "stagedCount", "stagedScopes",
])

let engine: WasmMemory | undefined
const MAX_FRAME_BYTES = 16 * 1024 * 1024
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let id = -1
  try {
    const request = JSON.parse(line) as { id: number; method: string; args: unknown[] }
    id = request.id
    let value: unknown
    if (request.method === "open") {
      if (engine) throw new Error("memory graph already opened")
      engine = await WasmMemory.open(request.args[0] as string, request.args[1] as { dim?: number })
      value = engine.recovery
    } else if (request.method === "close") {
      await engine?.close()
      engine = undefined
    } else {
      if (!engine || !methods.has(request.method)) throw new Error("memory graph method unavailable")
      value = await (engine[request.method as keyof WasmMemory] as (...args: unknown[]) => Promise<unknown>).apply(
        engine,
        request.args.map((arg) => arg === null ? undefined : arg),
      )
    }
    const response =
      JSON.stringify({
        id,
        ok: true,
        value,
        publishBlocked: engine?.publishBlocked,
        // 🔴 The worker reports its OWN footprint on every reply, because the supervisor cannot
        // measure it any other way and this is the number that decides the recycle.
        //
        // Measured 2026-09-27: `WasmMemory.open` costs ~1.3 GB resident for a store holding ZERO
        // memories (871 MB external, 433 MB of it ArrayBuffer) — a fixed arena inside the Wasm
        // module, not a function of the data. It never shrinks, `close()` does not release it, and
        // the only thing that returns it is process exit. A live idle worker measured 2.8 GB; one
        // that had been working reached 15.6 GB and starved the machine (it was holding ~10 GB of
        // commit by itself when it took the 2026-09-27 `core` gate to 100 % and reaped the user's
        // browser and editor).
        //
        // So the supervisor needs this to know when to recycle, and it is the only portable way for
        // a parent to learn a child's real cost: `process.memoryUsage()` inside the child.
        rssBytes: process.memoryUsage().rss,
      }) + "\n"
    if (Buffer.byteLength(response) > MAX_FRAME_BYTES) throw new Error("memory worker result is too large")
    process.stdout.write(response)
    if (request.method === "close") break
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String(error).slice(0, 500) }) + "\n")
  }
}
await engine?.close()
