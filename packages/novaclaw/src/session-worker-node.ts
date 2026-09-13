import { Effect, ManagedRuntime } from "effect"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionRunner } from "@novaclaw/core/session/runner"
import { SessionWorkerEntrypoint } from "./session-worker/entrypoint"
import { SessionWorkerRunnerLayer } from "./session-worker/runner-layer"
import { BashJobs } from "@novaclaw/core/tool/bash-jobs"

await SessionWorkerEntrypoint.run({
  drain: async (context) => {
    const runtime = ManagedRuntime.make(SessionWorkerRunnerLayer.make(context.capabilities, context.location))
    const unregisterCommandStop = context.registerCommandStop((callID, reason) =>
      runtime.runPromise(
        BashJobs.Service.use((jobs) => jobs.stopCall(callID, context.lease.sessionID, reason)).pipe(Effect.asVoid),
      ),
    )
    try {
      await runtime.runPromise(
        SessionRunner.Service.use((runner) =>
          runner.run({ sessionID: context.lease.sessionID, force: context.force }),
        ).pipe(Effect.provideService(SessionExecutionAttempt.Current, context.capabilities.execution)),
        { signal: context.signal },
      )
    } finally {
      unregisterCommandStop()
      await runtime.dispose()
    }
  },
})
