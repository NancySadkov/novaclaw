// The memory sidecar entry point — the Node process the Bun kernel spawns + supervises
// (notes/kb-graph-plan.md §2.1). Config via env so the parent doesn't leak secrets on argv:
//   KB_SIDECAR_DB     database directory (required)
//   KB_SIDECAR_PORT   loopback port, 0 = OS-assigned (default 0)
//   KB_SIDECAR_DIM    embedding dimension (default 1024)
//   KB_SIDECAR_TOKEN  shared bearer token gating every request (recommended)
//   KB_SIDECAR_EXT_DIR  vendored vector/fts extensions root (airgap/OFF-C — LOAD by path, no network)
// On listen it prints `KB_SIDECAR_LISTENING <port>` to stdout so the parent learns the chosen port
// and knows the store finished opening (schema + extension load can take a beat).

import { MemoryStore } from "./store.ts"
import { createMemoryServer } from "./server.ts"

const dbPath = process.env.KB_SIDECAR_DB
if (!dbPath) {
  console.error("KB_SIDECAR_DB is required")
  process.exit(2)
}
const port = Number(process.env.KB_SIDECAR_PORT ?? 0)
const dim = Number(process.env.KB_SIDECAR_DIM ?? 1024)
const token = process.env.KB_SIDECAR_TOKEN || undefined
const extDir = process.env.KB_SIDECAR_EXT_DIR || undefined

const store = await MemoryStore.open(dbPath, { dim, ...(extDir ? { extDir } : {}) })
const server = createMemoryServer(store, { token })

const shutdown = (signal: string) => {
  console.error(`kb-sidecar: ${signal} — shutting down`)
  server.close(() => {
    void store.close().finally(() => process.exit(0))
  })
  // Hard-exit backstop if a connection wedges close().
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

server.listen(port, "127.0.0.1", () => {
  const addr = server.address()
  const boundPort = typeof addr === "object" && addr ? addr.port : port
  // The parent watches for this line (readiness + the actual port).
  console.log(`KB_SIDECAR_LISTENING ${boundPort}`)
})
