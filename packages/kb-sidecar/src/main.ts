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

let shuttingDown = false
const shutdown = (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`kb-sidecar: ${signal} — shutting down`)
  server.close(() => {
    void store.close().finally(() => process.exit(0))
  })
  // Hard-exit backstop if a connection wedges close().
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

// Orphan guard: the supervisor spawns us with a piped stdin it holds open. If the parent instance
// dies ABRUPTLY (SIGKILL/crash/power-loss) — where no signal reaches us — the OS closes that pipe,
// so an stdin 'end'/'close' means "the instance is gone; don't linger holding the single-writer
// lock" (a lingering orphan would brick memory on the next boot, esp. on a cheap device that
// restarts often). We shut down cleanly (checkpointed WAL → the next boot reopens fine).
process.stdin.on("end", () => shutdown("stdin-closed (parent gone)"))
process.stdin.on("close", () => shutdown("stdin-closed (parent gone)"))
process.stdin.resume()

server.listen(port, "127.0.0.1", () => {
  const addr = server.address()
  const boundPort = typeof addr === "object" && addr ? addr.port : port
  // The parent watches for this line (readiness + the actual port).
  console.log(`KB_SIDECAR_LISTENING ${boundPort}`)
})
