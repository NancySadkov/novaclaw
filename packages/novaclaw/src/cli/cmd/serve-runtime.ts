import { Effect } from "effect"
import { resolveNetworkOptions } from "../network"
import type { NetworkOptions } from "../network-options"
import { ServerLaunchCredential } from "@novaclaw/core/server-launch-credential"
import { memoMap } from "@novaclaw/core/effect/memo-map"
import { Shutdown } from "@novaclaw/core/shutdown"
import { OwnedProcesses } from "@novaclaw/core/util/owned-processes"
import { disposeAllInstances } from "@/project/instance-runtime"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceJob } from "@/util/instance-job"
import { ExitIntent } from "../exit-intent"

const SHUTDOWN_DEADLINE = "5 seconds"

export const run = (args: NetworkOptions) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      /**
       * Adopt the OS-level process containment FIRST, before this process can spawn anything.
       * `OwnedProcesses.killAll` below is cooperative and cannot run when Windows stops the server
       * with `TerminateProcess`; the Job Object is the guarantee that outlives every exit path. A
       * degraded answer is reported, never fatal — see `util/instance-job.ts`.
       */
      const containment = yield* Effect.promise(() => InstanceJob.adopt())
      if (containment !== "adopted")
        console.error(
          `[instance-job] OS process containment is ${containment}: ancestors will still be reaped, ` +
            `but a hard stop relies on cooperative teardown. See util/instance-job.ts.`,
        )
      const { Server } = yield* Effect.promise(() => import("../../server/server"))
      // Phrased as the choice it is. The old sentence named an environment variable nobody is asked to
      // set, which read as an instruction to go export one — the opposite of the fix.
      if (!ServerLaunchCredential.isSet()) {
        console.log(
          "note: no --password given and no stored token, so this instance accepts unauthenticated " +
            "requests on its bind address. Pass --password, or set one in Settings → Instances.",
        )
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
       *
       * The `commands` task reaps every agent-launched OS process still registered as owned (bash jobs,
       * terminals, js sandboxes, the DHT sidecar) through the ONE tree-kill. Instance disposal already
       * releases the location scopes those children belong to, but a scope release only reaches a live
       * root — and nothing else on this path names the raw children at all. Without this a server quit
       * strands running commands as strays. It runs FIRST so the trees get the full deadline, and a
       * listener replacement never passes through here — only a real shutdown does.
       */
      let settling = false
      const settle = (signal: string) => {
        if (settling) return
        settling = true
        void Effect.runPromise(
          Shutdown.settleAll(
            [
              { name: "commands", settle: Effect.promise(() => OwnedProcesses.killAll()) },
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
  )
