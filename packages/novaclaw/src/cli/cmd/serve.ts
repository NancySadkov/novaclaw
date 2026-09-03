import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@novaclaw/core/flag/flag"
import { memoMap } from "@novaclaw/core/effect/memo-map"
// THE one tree-kill, in its leaf spelling (`Shell.killTreeSync` is the same function). The leaf
// imports `node:` builtins only, which keeps it off the CLI's startup cost.
import { killTreeSync } from "@novaclaw/core/util/kill-tree"
import { CommandSpec } from "../command-spec"
import { ServeChildCommand } from "../serve-child-command"
import { Shutdown } from "@novaclaw/core/shutdown"
import { disposeAllInstances } from "@/project/instance-runtime"

/** What a person will wait for a quit. Long enough for a database flush, short enough to feel
 *  like the app closed rather than hung. */
const SHUTDOWN_DEADLINE = "5 seconds"
import { ServeLiveness } from "../serve-liveness"

// Dependability P4 (uix-dependability-plan): `novaclaw serve` is SUPERVISED BY DEFAULT — the
// managed-by-default stance. The parent process is a tiny restart loop; the actual server runs as a
// child process (same CLI, `--no-supervise`), so a crashed instance heals itself instead of handing
// the user a dead port. `--no-supervise` opts out (and is how the child itself runs). The restart
// policy itself lives in ../supervise.ts (pure, unit-tested).
import { FAST_CRASH_GIVEUP, FAST_CRASH_MS, initialSuperviseState, superviseDecision } from "../supervise"
import { ExitIntent } from "../exit-intent"

/**
 * Stop the supervised child AND the layers under it.
 *
 * ⚠️ This is the shape AGENTS.md pitfall #8 warns about most directly: the supervisor's child
 * re-execs itself and spawns MCP node servers, so a kill that reaches only the root orphans two more
 * layers. It must route through the ONE tree-kill on EVERY platform — a bare `proc.kill()` on POSIX
 * orphans the tree exactly as a missing `taskkill` does on win32.
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
  /**
   * The child's loopback URL, hoisted OUT of the stdout closure that discovers it.
   *
   * It is the address the supervisor needs at exactly the moment the closure is no longer running,
   * so keeping it local made the graceful stop below impossible to write.
   */
  let childURL: URL | undefined
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
  /**
   * Ask, wait, then kill.
   *
   * 🔴 The kill is `TerminateProcess` on Windows, so the child's own `Shutdown.settleAll` never ran
   * on a supervised stop and anything mid-flush was lost silently. Asking over HTTP needs no signal,
   * which is the whole reason it works there.
   *
   * ⚠️ The kill still happens, unconditionally, on every path — a child that refuses to let go must
   * not be able to keep the supervisor alive. `requestStop` is bounded and never throws, so the only
   * cost of an unreachable child is the timeout.
   */
  const gracefulShutdown = async () => {
    if (stopping) return
    stopMonitor() // stop probing something we are deliberately taking down; a miss here is not a fault
    if (childURL && current && !current.killed) {
      const released = await ServeLiveness.requestStop(childURL, Flag.NOVACLAW_SERVER_PASSWORD)
      if (!released) console.error("[supervise] child did not confirm release before the deadline — killing anyway")
    }
    shutdown()
  }
  // ⚠️ SIGINT/SIGTERM are async now; `exit` cannot be — nothing async survives it, so it keeps the
  // synchronous kill. That asymmetry is the point: the graceful path is for an ordinary stop, and
  // the sync one is the backstop for every other way this process can end.
  /**
   * 🔴 **A DELIBERATE STOP MUST NOT LOOK LIKE A CRASH TO THE WATCHDOG.**
   *
   * `packages/watchdog` restarts anything that exits without a valid intent, which is the right
   * default — silence means the work vanished. But a Ctrl-C is not silence, it is a decision, and
   * without this the watchdog would faithfully restart the instance the operator just stopped,
   * forever.
   *
   * ⚠️ `ExitIntent.settle` returns the code to use and writes the document in one call, so the two
   * halves of the protocol cannot disagree. **Unsupervised it returns 0** — the status this path has
   * always exited with — so a bare `novaclaw serve` behaves exactly as before for every shell, script
   * and CI job that reads it.
   */
  const stopWith = (intent: ExitIntent.Intent) =>
    void gracefulShutdown().finally(() => process.exit(ExitIntent.settle(intent, 0)))
  process.on("SIGINT", () => stopWith({ kind: "shutdown" }))
  process.on("SIGTERM", () => stopWith({ kind: "shutdown" }))
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
      // 🔴 SCRUBBED, not inherited. This process is a supervisor under a watchdog; the child must not
      // be able to answer the watchdog's question about US. See `ExitIntent.childEnv`.
      env: ExitIntent.childEnv(process.env),
    })
    current = child
    void forwardStdout(child.stdout, (line) => {
      if (monitorAbort) return
      const healthURL = ServeLiveness.probeURLFromListenLine(line)
      if (!healthURL) return
      childURL = healthURL // hoisted: the graceful stop needs this after this closure has finished
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
    // Clear the address with the child that owned it. A restart re-announces its own listen line —
    // and with `--port 0` that is a DIFFERENT port, so a stale URL would send the graceful stop to
    // whatever now holds the old one.
    childURL = undefined
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
    // ONE instance graph: this command runs under `AppRuntime`, whose `AppLayer` is already alive in
    // the shared memo map, so the listener's routes must be built in the same map or the process
    // carries two graphs (two database clients, two MCP managers, two buses). `ListenOptions.memoMap`.
    const server = yield* Effect.promise(() => Server.listen({ ...opts, memoMap }))
    console.log(`novaclaw server listening on http://${server.hostname}:${server.port}`)

    /**
     * Settle on the way out, inside a deadline, and SAY what was forced.
     *
     * This process had no signal handling at all: SIGTERM simply killed it, so anything mid-flight
     * was lost without a word. `Shutdown.settleAll` gives the two subsystems this process owns a
     * bounded chance to finish and names whichever did not — a failing one cannot cancel the other,
     * which matters here because instance disposal is the half holding unflushed session state.
     *
     * ⚠️ The deadline is a promise about TOTAL wait, so it covers both tasks together rather than
     * each. A quit that takes twice as long as advertised is the reason people reach for kill -9.
     */
    let settling = false
    const settle = (signal: string) => {
      if (settling) return
      settling = true
      void Effect.runPromise(
        Shutdown.settleAll(
          [
            { name: "http", settle: Effect.promise(() => server.stop(true)) },
            { name: "instances", settle: Effect.promise(() => disposeAllInstances()) },
          ],
          SHUTDOWN_DEADLINE,
        ),
      )
        .then((report) => {
          console.log(`novaclaw server stopping (${signal}). ${Shutdown.describe(report)}`)
          process.exit(ExitIntent.settle({ kind: "shutdown" }, 0))
        })
        // Never let the reporting itself hold the process: an exit that hangs is worse than one
        // that says less. The intent is still recorded — the operator asked to stop either way, and
        // a failure to DESCRIBE the shutdown is not a reason to let the watchdog call it a crash.
        .catch(() => process.exit(ExitIntent.settle({ kind: "shutdown" }, 0)))
    }
    process.on("SIGINT", () => settle("SIGINT"))
    process.on("SIGTERM", () => settle("SIGTERM"))

    yield* Effect.never
  }),
})
