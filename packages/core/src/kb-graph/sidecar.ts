export * as Sidecar from "./sidecar"

import { Effect, Scope } from "effect"
import { MemoryClient } from "./memory-client"
import { superviseDecision, initialSuperviseState, FAST_CRASH_GIVEUP, FAST_CRASH_MS } from "../process/supervise"

// The Bun-side supervisor for the Ladybug graph-memory sidecar (notes/kb-graph-plan.md §2.1). The
// engine runs as a NODE child (the native @ladybugdb/core addon segfaults under Bun — P0); this
// spawns it, watches its stdout for the readiness line to learn the OS-assigned port, and restarts
// it on crash with the shared backoff/giveup ladder (../process/supervise). One process owning the
// graph IS the instance-wide single-writer (§4.1); a crash can't take down the Bun kernel (the
// "never breaks" vision) — the client just reports memory unavailable until the restart lands.
//
// Shape mirrors serve.ts's superviseLoop: a plain-async restart loop (imperative Bun.spawn +
// stream reading), exposed as a Supervisor handle. `acquire` wraps it as a scoped Effect resource
// for the instance/location lifecycle; the release hard-stops the child (OS frees Ladybug's file
// lock on process death — ACID rolls back any half-write, §4.9).

/** The readiness line the sidecar prints once its HTTP server is listening (main.ts). */
const READY_RE = /^KB_SIDECAR_LISTENING (\d+)$/

export interface SpawnOptions {
  /** Absolute path to the sidecar's Node entry (packages/kb-sidecar/src/main.ts). The caller
   *  resolves it — core does not depend on @novaclaw/kb-sidecar (importing it would load the addon
   *  under Bun → segfault). */
  readonly entry: string
  /** Directory for the memory graph DB (KB_SIDECAR_DB). */
  readonly dbPath: string
  /** Embedding dimension (must match the embedding device). Default 1024. */
  readonly dim?: number
  /** Shared bearer token the kernel generates + the sidecar enforces. Strongly recommended. */
  readonly token?: string
  /** Node executable. Default "node" (on PATH — a NovaClaw requirement). Node ≥22 for
   *  --experimental-strip-types (dev/Windows); the Spark's Node 18 needs pre-compiled JS + a `.js`
   *  entry (P1 remaining: the compile-first path). */
  readonly node?: string
  /** Extra args before the entry (e.g. drop --experimental-strip-types for a compiled `.js` entry). */
  readonly nodeArgs?: readonly string[]
  /** Per-request client budget (ms). */
  readonly timeoutMs?: number
  /** Line sink for the child's stdout/stderr (diagnostics). */
  readonly onLog?: (line: string) => void
}

export interface Supervisor {
  /** The memory client, pointed at whatever port the current child is listening on. */
  readonly client: MemoryClient.Interface
  /** The current loopback base URL, or "" while the sidecar is down/restarting. */
  readonly url: () => string
  /** The current child's pid, or undefined while down/restarting (diagnostics + crash simulation). */
  readonly pid: () => number | undefined
  /** Resolves when the sidecar first becomes ready; rejects if it crash-loops before ever listening. */
  readonly ready: Promise<void>
  /** Graceful stop — no more restarts, hard-kill the child, await its exit. Idempotent. */
  readonly stop: () => Promise<void>
}

const isWin = process.platform === "win32"

type Child = ReturnType<typeof Bun.spawn>

const treeKill = (proc: Child | undefined): void => {
  if (!proc || proc.killed) return
  try {
    if (isWin)
      // Windows signal delivery is unreliable under Bun — taskkill the whole tree (serve.ts precedent).
      Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/f", "/t"], { stdout: "ignore", stderr: "ignore" })
    else proc.kill()
  } catch {
    /* already gone */
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Spawn + supervise the sidecar. Returns immediately; await `.ready` before using `.client`. */
export const superviseSidecar = (opts: SpawnOptions): Supervisor => {
  let currentUrl = ""
  let stopping = false
  let everReady = false
  let proc: Child | undefined
  let state = initialSuperviseState

  let readyResolve!: () => void
  let readyReject!: (err: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  const client = MemoryClient.make({
    url: () => currentUrl,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  })

  // Read a child stream line-by-line; the stdout reader also detects the readiness line.
  const pump = async (stream: ReadableStream<Uint8Array> | undefined, onReadyLine: boolean): Promise<void> => {
    if (!stream) return
    const decoder = new TextDecoder()
    let buf = ""
    try {
      // @ts-expect-error — Bun's ReadableStream is async-iterable.
      for await (const chunk of stream) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "")
          buf = buf.slice(nl + 1)
          if (onReadyLine) {
            const m = READY_RE.exec(line.trim())
            if (m) {
              currentUrl = `http://127.0.0.1:${m[1]}`
              everReady = true
              readyResolve()
            }
          }
          opts.onLog?.(line)
        }
      }
    } catch {
      /* stream closed on child exit */
    }
  }

  const cmd = [opts.node ?? "node", ...(opts.nodeArgs ?? ["--experimental-strip-types"]), opts.entry]
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KB_SIDECAR_DB: opts.dbPath,
    KB_SIDECAR_PORT: "0",
    KB_SIDECAR_DIM: String(opts.dim ?? 1024),
    ...(opts.token ? { KB_SIDECAR_TOKEN: opts.token } : {}),
  }

  const loop = async (): Promise<void> => {
    for (;;) {
      const startedAt = Date.now()
      proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env })
      void pump(proc.stdout as ReadableStream<Uint8Array>, true)
      void pump(proc.stderr as ReadableStream<Uint8Array>, false)
      const code = await proc.exited
      proc = undefined
      currentUrl = "" // down — client calls fail fast (degrade) until the next child lists
      if (stopping) return
      const decision = superviseDecision(state, { code: code ?? 1, aliveMs: Date.now() - startedAt })
      if (decision.action === "stop-clean") return
      if (decision.action === "giveup") {
        const msg = `kb-sidecar crash loop: ${FAST_CRASH_GIVEUP} exits within ${FAST_CRASH_MS / 1000}s — giving up`
        opts.onLog?.(msg)
        if (!everReady) readyReject(new Error(msg))
        return
      }
      opts.onLog?.(`kb-sidecar exited (code ${code}) — restarting in ${decision.delayMs}ms`)
      await delay(decision.delayMs)
      state = decision.next
    }
  }
  void loop()

  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    const p = proc
    treeKill(p)
    if (p) await p.exited.catch(() => {})
  }

  return { client, url: () => currentUrl, pid: () => proc?.pid, ready, stop }
}

/** Scoped-Effect wrapper for the instance/location lifecycle: acquires a ready sidecar, releases by
 *  stopping the child. `readyTimeoutMs` bounds the initial open (schema + extension load takes a
 *  beat). */
export const acquire = (opts: SpawnOptions & { readyTimeoutMs?: number }): Effect.Effect<Supervisor, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const sup = superviseSidecar(opts)
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("kb-sidecar did not become ready in time")), opts.readyTimeoutMs ?? 30_000)
        })
        try {
          await Promise.race([sup.ready, timeout])
        } catch (err) {
          // acquireRelease's release only runs on a SUCCESSFUL acquire — clean up the child ourselves.
          await sup.stop()
          throw err
        } finally {
          if (timer) clearTimeout(timer)
        }
        return sup
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
    (sup) => Effect.promise(() => sup.stop()),
  )
