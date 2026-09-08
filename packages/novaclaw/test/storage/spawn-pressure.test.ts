import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SpawnAdmission } from "@novaclaw/core/session/spawn-admission"
import { HostPressure } from "@/storage/host-pressure"
import { Pressure } from "@/storage/pressure"
import * as SpawnPressure from "@/storage/spawn-pressure"
import { testEffect } from "../lib/effect"

const state: { level: Pressure.Level } = { level: "ok" }

const report = (): Pressure.Report => ({
  memory: { known: false, reason: "test measurement" },
  disks: [],
  thresholds: Pressure.DEFAULT_THRESHOLDS,
  thresholdsSource: "default",
  level: state.level,
  unavailable: ["test measurement"],
})

const layer = LayerNode.compile(SpawnPressure.node, [
  [
    HostPressure.node,
    Layer.succeed(HostPressure.Service, HostPressure.Service.of({ pressure: () => Effect.sync(report) })),
  ],
])

const it = testEffect(layer)

describe("SpawnPressure", () => {
  it.live("uses the live HostPressure verdict and refuses only at the floor", () =>
    Effect.gen(function* () {
      state.level = "warning"
      expect((yield* SpawnAdmission.check()).refuse).toBeUndefined()

      state.level = "floor"
      expect((yield* SpawnAdmission.check()).refuse).toBe("host resources are at the floor")
    }),
  )
})
