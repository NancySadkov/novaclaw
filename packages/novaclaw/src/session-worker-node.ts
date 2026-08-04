import { Effect, ManagedRuntime } from "effect"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionRunner } from "@novaclaw/core/session/runner"
import { SessionWorkerEntrypoint } from "./session-worker/entrypoint"
import { SessionWorkerRunnerLayer } from "./session-worker/runner-layer"

await SessionWorkerEntrypoint.run({
  drain: async (context) => {
    const runtime = ManagedRuntime.make(SessionWorkerRunnerLayer.make(context.capabilities, context.location))
    try {
      await runtime.runPromise(
        SessionRunner.Service.use((runner) =>
          runner.run({ sessionID: context.lease.sessionID, force: context.force }),
        ).pipe(Effect.provideService(SessionExecutionAttempt.Current, context.capabilities.execution)),
        { signal: context.signal },
      )
    } finally {
      await runtime.dispose()
    }
  },
})
