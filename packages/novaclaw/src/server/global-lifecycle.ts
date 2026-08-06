import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Cause, Effect } from "effect"
import { Event } from "./event"
import { Log } from "@novaclaw/schema/log"

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store
            .disposeAll()
            .pipe(
              Effect.catchCause((cause) =>
                Log.event("instance.global.dispose.failed", { "instance.cause": Cause.pretty(cause) }),
              ),
            )
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

export * as GlobalLifecycle from "./global-lifecycle"
