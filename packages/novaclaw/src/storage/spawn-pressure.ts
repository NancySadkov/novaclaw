import { Effect, Layer } from "effect"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { SpawnAdmission } from "@novaclaw/core/session/spawn-admission"
import { HostPressure } from "./host-pressure"

/**
 * The instance's answer to *"can this host afford another sub-agent?"*, registered into the kernel's
 * spawn guard.
 *
 * 🔴 **This node is the whole feature.** `spawner.ts` asks `SpawnAdmission.check()` and admits when
 * nobody answers, so without this registration the guard is inert — the exact shape that left the
 * reassignment notice doing nothing for a day (`agent-removal-wiring.test.ts`, and the comments
 * beside `AgentReassignment.node` in `httpapi/server.ts`). It is listed there for the same reason.
 *
 * ⚠️ **The verdict is HostPressure's complete report, not a threshold restated here.** That service
 * reads the live settings store and owns the memory-plus-disk measurement. A second definition on
 * this side is how a guard and the thing it guards drift apart. Refusing at **`floor`** and not at
 * `warning` is the one judgement this file makes, and it is the conservative half: `warning` is the
 * level the product already shows a person without stopping anything, so refusing there would turn
 * an advisory into an outage.
 *
 * ⚠️ **`unknown` ADMITS.** A host that cannot be measured is not a host known to be full, and
 * `pressure.ts` is emphatic that an unmeasurable host must never read as a healthy one — the mirror
 * of that is that it must not read as a failing one either. Denying on `unknown` would make every
 * platform without a probe unable to spawn at all.
 */
export const node = makeGlobalNode({
  name: "storage/spawn-pressure",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const pressure = yield* HostPressure.Service
      yield* SpawnAdmission.register(() =>
        Effect.gen(function* () {
          // 🔴 FRESH, not a copied threshold check. HostPressure reads the live settings store and
          // measures every instance volume, so spawn admission cannot drift from the Storage page or
          // from resource_status when an operator changes resource_pressure without a restart.
          const report = yield* pressure.pressure()
          return { refuse: report.level === "floor" ? "host resources are at the floor" : undefined }
        }),
      )
    }),
  ),
  deps: [HostPressure.node],
})
