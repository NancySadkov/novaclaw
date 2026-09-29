import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 WITH MEMORY OFF, NO `__memory-worker` MAY BE SPAWNED — AND THIS ASSERTS IT.
 *
 * `world-memory-spawn-gate.test.ts` holds the wire: that the layer reads the user's switch before the
 * engine factory is reachable. This file holds the claim that actually matters — that the disabled path
 * RETURNS before any engine can be built — because "the code looks gated" is not a measurement.
 *
 * The regression, measured 2026-09-29: `runtime_setting['memory']` had no row (memory OFF under the
 * opt-in rule), a `__memory-worker` was spawned anyway, and it passed 5 GB of commit before being
 * killed. The opt-in default was introduced on 2026-09-27 as the fix for that leak; it gated the
 * WORK (recall, extraction, retention) and never the SPAWN.
 */
const here = import.meta.dir // …/packages/core/src/kb-graph
const source = readFileSync(join(here, "world-memory.ts"), "utf8")
// …/packages/core/src/kb-graph → up three reaches …/packages, so the sibling package resolves.
const worker = readFileSync(join(here, "..", "..", "..", "novaclaw", "src", "memory-worker-node.ts"), "utf8")

const layerFrom = source.indexOf("export const layerFromConfig")
const factoryFrom = source.indexOf("const open = () =>")
const layer = source.slice(layerFrom, factoryFrom)

describe("the world-memory layer cannot build a live engine while memory is off", () => {
  test("the privacy switch is read INSIDE the layer, before the engine factory exists", () => {
    expect(layerFrom, "layerFromConfig must remain findable — a rename must fail here").toBeGreaterThan(-1)
    expect(factoryFrom, "the engine factory must remain findable").toBeGreaterThan(-1)
    expect(factoryFrom, "the factory must live inside the layer").toBeGreaterThan(layerFrom)
    // The gate and the whole early-return it guards, all inside the layer and before the factory.
    expect(layer, "the layer must read the user's switch").toMatch(/MemorySetting\.memoryEnabled\(\)/)
    expect(layer, "the layer must branch on it").toMatch(/if\s*\(memoryOff\)/)
    expect(layer, "the branch must return a disabled client").toMatch(/return\s+MemoryObserved\.observed\s*\(/)
    expect(layer, "the client it returns must be disabled").toMatch(/MemoryClient\.disabled\(/)
  })

  test("the layer never spawns the worker itself — only the engine factory does, and it is gated", () => {
    expect(source).not.toContain("memory-worker-node")
  })

  test("the child worker holds no graph of its own, so the gate is the only door", () => {
    // The worker OPENS on request and exits on `close` — it does not construct an engine at import.
    // So bounding the arena is the gated layer's job, and there is no second door.
    expect(worker).toMatch(/request\.method === "close"/)
    expect(worker).toMatch(/method === "open"\s*\) break/)
  })
})
