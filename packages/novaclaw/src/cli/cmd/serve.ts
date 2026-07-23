import { Effect } from "effect"
import path from "node:path"
import { effectCmd, fail } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@novaclaw/core/flag/flag"

// Dependability P4 (uix-dependability-plan): `novaclaw serve` is SUPERVISED BY DEFAULT — the
// managed-by-default stance. The parent process is a tiny restart loop; the actual server runs as a
// child process (same CLI, `--no-supervise`), so a crashed instance heals itself instead of handing
// the user a dead port. `--no-supervise` opts out (and is how the child itself runs). The restart
// policy itself lives in ../supervise.ts (pure, unit-tested).
import { FAST_CRASH_GIVEUP, FAST_CRASH_MS, initialSuperviseState, superviseDecision } from "../supervise"

const treeKill = (proc: ReturnType<typeof Bun.spawn> | undefined) => {
  if (!proc || proc.killed) return
  try {
    if (process.platform === "win32")
      // Windows signal delivery is unreliable under Bun — taskkill the whole tree instead.
      Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/f", "/t"], { stdout: "ignore", stderr: "ignore" })
    else proc.kill()
  } catch {}
}

/** The child respawn recipe. `process.execArgv` carries the runtime flags (measured: bun preserves
 *  `--conditions=browser` there), argv[1..] the script + command line. A compiled single-binary can
 *  repeat the exe path as argv[1] — drop it rather than pass it as an argument. */
const childCommand = (): string[] => {
  const rest = process.argv.slice(1)
  if (rest[0] && path.resolve(rest[0]) === path.resolve(process.execPath)) rest.shift()
  return [process.execPath, ...process.execArgv, ...rest, "--no-supervise"]
}

const superviseLoop = async (): Promise<"clean" | "giveup"> => {
  let current: ReturnType<typeof Bun.spawn> | undefined
  let stopping = false
  let state = initialSuperviseState
  const shutdown = () => {
    if (stopping) return
    stopping = true
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

  const cmd = childCommand()
  for (;;) {
    const startedAt = Date.now()
    current = Bun.spawn(cmd, {
      stdin: "inherit",
      stdout: "inherit", // health/log parsing depends on pass-through
      stderr: "inherit",
      env: process.env as Record<string, string>,
    })
    console.log(`[supervise] server child started (pid ${current.pid})`)
    const code = await current.exited
    current = undefined
    if (stopping) return "clean"
    // A child that held the port through TIME_WAIT or a foreign holder exits fast — the backoff
    // ladder IS the bind-retry (≈1+2+4+8+16s across 5 attempts) and the giveup IS the "refuse to
    // fight a foreign process" stop.
    const decision = superviseDecision(state, { code, aliveMs: Date.now() - startedAt })
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
    console.error(
      `[supervise] server exited (code ${code}) — restarting in ${decision.delayMs / 1000}s`,
    )
    await new Promise((resolve) => setTimeout(resolve, decision.delayMs))
    state = decision.next
  }
}

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("supervise", {
      type: "boolean",
      default: true,
      describe: "restart the server automatically if it crashes (--no-supervise runs it bare)",
    }),
  describe: "starts a headless novaclaw server",
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
