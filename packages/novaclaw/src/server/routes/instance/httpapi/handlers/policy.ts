import { InstanceState } from "@/effect/instance-state"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { AbsolutePath } from "@novaclaw/core/schema"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

/**
 * What pre-action policies are installed, and which of them the user has switched off.
 *
 * ⚠️ **Everything is read INSIDE the provided location scope, deliberately.** `ToolPolicyGate` is the
 * very instance the kernel screens tool calls through; reaching for a fresh layer here would compile,
 * run, and answer about a graph nobody consults — which is a silent wrong answer rather than a failure.
 * (`experimental.ts` records the measurement that taught this: hoisting one line out of the scope
 * failed 7 route tests with "Service not found" while `tsgo -b` stayed green.)
 *
 * ⚠️ `enabled` is NOT recomputed here from the config. `ToolPolicyGate.list()` owns that answer,
 * because it is a statement about what the gate will do on the next tool call — and a route that
 * re-derived it would be a second answer to "is this guard running".
 *
 * 🗑️ The FOLDER half of this answer is gone with `novaclaw.json` (owner, 2026-09-16): a folder used to
 * be able to REQUEST policies, and this route reported which of those requests were missing or switched
 * off, plus the file that made them. Nothing can request a policy any more, so all three lists are
 * structurally empty and `file` is never present — the app-side pass that stops reading them goes with
 * the rest of the UI.
 */
export const policyHandlers = HttpApiBuilder.group(InstanceHttpApi, "policy", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service

    const list = Effect.fn("PolicyHttpApi.list")(function* () {
      const directory = (yield* InstanceState.context).directory
      return yield* Effect.gen(function* () {
        const gate = yield* ToolPolicyGate.Service
        const installed = yield* gate.list()
        return {
          installed,
          requested: [] as readonly string[],
          missing: [] as readonly string[],
          disabledButRequested: [] as readonly string[],
        }
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
    }, Effect.orDie)

    return handlers.handle("list", list)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
