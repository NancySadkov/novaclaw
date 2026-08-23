import { Effect, Layer } from "effect"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { SpawnAdmission } from "@novaclaw/core/session/spawn-admission"
import { Pressure } from "./pressure"

/**
 * The instance's answer to *"can this host afford another sub-agent?"*, registered into the kernel's
 * spawn guard.
 *
 * 🔴 **This node is the whole feature.** `spawner.ts` asks `SpawnAdmission.check()` and admits when
 * nobody answers, so without this registration the guard is inert — the exact shape that left the
 * reassignment notice doing nothing for a day (`agent-removal-wiring.test.ts`, and the comments
 * beside `AgentReassignment.node` in `httpapi/server.ts`). It is listed there for the same reason.
 *
 * ⚠️ **The verdict is `memoryLevel`'s, not a threshold restated here.** `pressure.ts` owns what
 * "strained" means, configurably, and a second definition on this side is how a guard and the thing
 * it guards drift apart. Refusing at **`floor`** and not at `warning` is the one judgement this file
 * makes, and it is the conservative half: `warning` is the level the product already shows a person
 * without stopping anything, so refusing there would turn an advisory into an outage.
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
      yield* SpawnAdmission.register(() =>
        Effect.gen(function* () {
          const reading = yield* Effect.promise(() => Pressure.memory())
          const level = Pressure.memoryLevel(reading, Pressure.DEFAULT_THRESHOLDS)
          return { refuse: level === "floor" ? "host memory is at the floor" : undefined }
        }),
      )
    }),
  ),
  deps: [],
})
