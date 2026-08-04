import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@novaclaw/core/flag/flag"
// THE one tree-kill, in its leaf spelling (`Shell.killTreeSync` is the same function). The leaf
// imports `node:` builtins only, which keeps it off the CLI's startup cost.
import { killTreeSync } from "@novaclaw/core/util/kill-tree"
import { CommandSpec } from "../command-spec"
import { ServeChildCommand } from "../serve-child-command"
import { ServeLiveness } from "../serve-liveness"

// Dependability P4 (uix-dependability-plan): `novaclaw serve` is SUPERVISED BY DEFAULT — the
// managed-by-default stance. The parent process is a tiny restart loop; the actual server runs as a
// child process (same CLI, `--no-supervise`), so a crashed instance heals itself instead of handing
// the user a dead port. `--no-supervise` opts out (and is how the child itself runs). The restart
// policy itself lives in ../supervise.ts (pure, unit-tested).
import { FAST_CRASH_GIVEUP, FAST_CRASH_MS, initialSuperviseState, superviseDecision } from "../supervise"

/**
 * Stop the supervised child AND the layers under it.
 *
 * ⚠️ This is the shape AGENTS.md pitfall #8 warns about most directly: the supervisor's child
 * re-execs itself and spawns MCP node servers, so a kill that reaches only the root orphans two more
 * layers. It used to be win32-only (an inline `Bun.spawnSync` taskkill) with a bare `proc.kill()` on
 * POSIX, which orphaned the whole tree there. It now routes through the ONE tree-kill.
 *
 * The SYNC twin is required, not a shortcut: every caller is either a signal handler that calls
 * `process.exit` on the next line or the `process.on("exit")` hook, and an async `taskkill` spawned
 * from those is not guaranteed to outlive us — it would look like a kill and do nothing.
 */
const treeKill = (proc: ReturnType<typeof Bun.spawn> | undefined) => {
  if (!proc || proc.killed) return
  killTreeSync(proc.pid)
}

const superviseLoop = async (): Promise<"clean" | "giveup"> => {
  let current: ReturnType<typeof Bun.spawn> | undefined
  let stopping = false
  let state = initialSuperviseState
  let monitorAbort: AbortController | undefined
  let unresponsive = false
  const stopMonitor = () => {
    monitorAbort?.abort()
    monitorAbort = undefined
  }
  const shutdown = () => {
    if (stopping) return
    stopping = true
    stopMonitor()
    treeKill(current)
  }
  process.on("SIGINT", () => {
    shutdown()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    shutdown()
    process.exit(0)
  })
  process.on("exit", shutdown) // best-effort — a hard parent death still orphans (OS territory)

  const cmd = ServeChildCommand.current()
  for (;;) {
    const startedAt = Date.now()
    unresponsive = false
    monitorAbort = undefined
    const child = Bun.spawn(cmd, {
      stdin: "inherit",
      // Pipe only to discover the ACTUAL address when `--port 0` is used; every byte is immediately
      // forwarded, so supervised serve has the same visible stdout contract as the bare child.
      stdout: "pipe",
      stderr: "inherit",
      env: process.env as Record<string, string>,
    })
    current = child
    void forwardStdout(child.stdout, (line) => {
      if (monitorAbort) return
      const healthURL = ServeLiveness.probeURLFromListenLine(line)
      if (!healthURL) return
      monitorAbort = new AbortController()
      void ServeLiveness.monitor({
        signal: monitorAbort.signal,
        check: () => ServeLiveness.probe(healthURL, Flag.NOVACLAW_SERVER_PASSWORD),
        onUnresponsive: (failures) => {
          if (stopping || child !== current) return
          unresponsive = true
          console.error(`[supervise] server missed ${failures} health checks — terminating the hung process`)
          treeKill(child)
        },
      })
    }).catch((error) => console.error(`[supervise] failed to read server stdout: ${String(error)}`))
    console.log(`[supervise] server child started (pid ${current.pid})`)
    const code = await current.exited
    stopMonitor()
    current = undefined
    if (stopping) return "clean"
    // A child that held the port through TIME_WAIT or a foreign holder exits fast — the backoff
    // ladder IS the bind-retry (≈1+2+4+8+16s across 5 attempts) and the giveup IS the "refuse to
    // fight a foreign process" stop.
    // Reaching the decision while `stopping === false` means the parent did not request shutdown.
    // Treat even exit 0 as a fault; intentional signals took the early return above.
    const decision = superviseDecision(state, {
      code: unresponsive || code === 0 ? 1 : code,
      aliveMs: Date.now() - startedAt,
    })
    if (decision.action === "stop-clean") {
      console.log("[supervise] server exited cleanly — not restarting")
      return "clean"
    }
    if (decision.action === "giveup") {
      console.error(
        `[supervise] crash loop: ${FAST_CRASH_GIVEUP} consecutive exits within ${FAST_CRASH_MS / 1000}s — giving up. ` +
          `Check the log above for the cause (an occupied port stays occupied), then run \`nova-cli serve\` again.`,
      )
      return "giveup"
    }
    console.error(`[supervise] server exited (code ${code}) — restarting in ${decision.delayMs / 1000}s`)
    await new Promise((resolve) => setTimeout(resolve, decision.delayMs))
    state = decision.next
  }
}

async function forwardStdout(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  for (;;) {
    const item = await reader.read()
    if (item.done) break
    process.stdout.write(item.value)
    pending += decoder.decode(item.value, { stream: true })
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  }
  pending += decoder.decode()
  if (pending) onLine(pending)
}

export const ServeCommand = effectCmd({
  ...CommandSpec.serve,
  builder: (yargs) =>
    withNetworkOptions(yargs).option("supervise", {
      type: "boolean",
      default: true,
      describe: "restart the server automatically if it crashes (--no-supervise runs it bare)",
    }),
  // Server loads instances per-request via x-novaclaw-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (args.supervise) {
      const outcome = yield* Effect.promise(superviseLoop)
      if (outcome === "giveup") return yield* fail("server crash loop — supervision gave up", 1)
      return
    }
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.NOVACLAW_SERVER_PASSWORD) {
      console.log("Warning: NOVACLAW_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`novaclaw server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
