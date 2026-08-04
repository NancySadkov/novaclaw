import { SessionWorkerEntrypoint } from "../../src/session-worker/entrypoint"
import { DateTime, Effect } from "effect"
import { SessionMessage } from "@novaclaw/core/session/message"

const mode = process.argv[2] ?? "settle"

await SessionWorkerEntrypoint.run({
  heartbeatIntervalMs: 50,
  drain: async (context) => {
    if (mode === "publish") {
      await context.capabilities.publishEvent("session.next.synthetic", {
        sessionID: context.lease.sessionID,
        source: "entrypoint-fixture",
      })
      return
    }
    if (mode === "interrupt") {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }))
      return
    }
    if (mode === "execution") {
      await Effect.runPromise(
        context.capabilities.execution.toolDispatched({
          callID: "call_fixture",
          name: "write",
          sideEffect: "idempotent-write",
        }),
      )
      await Effect.runPromise(context.capabilities.execution.toolSettled("call_fixture"))
      await Effect.runPromise(context.capabilities.execution.advance("provider", "mark"))
      await Effect.runPromise(
        context.capabilities.execution.contextUpdated!({
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(1234),
          text: "context changed",
          snapshot: {},
        }),
      )
      await Bun.sleep(120)
      return
    }
    if (mode === "log") {
      console.log("worker diagnostic must not enter the protocol")
      return
    }
    if (mode === "fail") throw new Error("entrypoint fixture failed")
  },
})
