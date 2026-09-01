import { InstanceState } from "@/effect/instance-state"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { AbsolutePath } from "@novaclaw/core/schema"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

/**
 * What pre-action policies are installed, and what the routed folder asks for.
 *
 * ⚠️ **Everything is read INSIDE the provided location scope, deliberately.** `ToolPolicyGate` and
 * `ProjectFileCache` are the very instances the kernel screens tool calls through; reaching for a
 * fresh layer here would compile, run, and answer about a graph nobody consults — which is a silent
 * wrong answer rather than a failure. (`experimental.ts` records the measurement that taught this:
 * hoisting one line out of the scope failed 7 route tests with "Service not found" while `tsgo -b`
 * stayed green.)
 *
 * ⚠️ `enabled` is NOT recomputed here from the config. `ToolPolicyGate.list()` owns that answer,
 * because it is a statement about what the gate will do on the next tool call — and a route that
 * re-derived it would be a second answer to "is this guard running".
 */
export const policyHandlers = HttpApiBuilder.group(InstanceHttpApi, "policy", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service

    const list = Effect.fn("PolicyHttpApi.list")(function* () {
      const directory = (yield* InstanceState.context).directory
      return yield* Effect.gen(function* () {
        const gate = yield* ToolPolicyGate.Service
        const projects = yield* ProjectFileCache.Service
        const installed = yield* gate.list()
        const project = yield* projects.read(directory, directory)
        const requested = project.policies
        const byID = new Map(installed.map((entry) => [entry.id, entry] as const))
        return {
          installed,
          requested,
          // The same two questions the gate asks before it screens anything, answered in the same
          // order and with the same predicates — so the screen a user reads and the refusal their
          // model reads cannot disagree about which case they are in.
          missing: requested.filter((id) => !byID.has(id)).toSorted(),
          disabledButRequested: requested.filter((id) => byID.get(id)?.enabled === false).toSorted(),
          ...(project.file === undefined ? {} : { file: project.file }),
        }
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
      // `orDie` on the whole handler: the gate's `list` and the project cache's `read` both absorb
      // every expected failure (an unreadable file means no project), so anything surviving to here
      // is a defect in this process and calling it a client error would tell the caller to fix a
      // request that was fine.
    }, Effect.orDie)

    return handlers.handle("list", list)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
