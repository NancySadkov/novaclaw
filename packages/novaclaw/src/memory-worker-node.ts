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
    const response = JSON.stringify({ id, ok: true, value, publishBlocked: engine?.publishBlocked }) + "\n"
    if (Buffer.byteLength(response) > MAX_FRAME_BYTES) throw new Error("memory worker result is too large")
    process.stdout.write(response)
    if (request.method === "close") break
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String(error).slice(0, 500) }) + "\n")
  }
}
await engine?.close()
