import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 THE USER'S MEMORY SWITCH MUST GATE THE WORKER SPAWN, NOT JUST THE WORK.
 *
 * The history, because it is why this file exists. RAG was made OPT-IN on 2026-09-27 precisely
 * because it leaked: the engine is LadybugDB compiled to Wasm, `WasmMemory.open` costs ~1.3 GB
 * resident for a store holding ZERO memories — a fixed arena, not a function of the data — and Wasm
 * linear memory cannot shrink, so `close()` returns none of it and only process exit does. A live
 * instance sat at 2.8 GB idle and reached 15.6 GB after work, taking a 32 GB box to 100 %.
 *
 * The opt-in was the FIX for that leak, and it did not work.
 *
 * Measured 2026-09-29 on a live instance: `runtime_setting['memory']` had NO ROW, so under the
 * opt-in rule memory was correctly OFF. A `__memory-worker` spawned anyway, passed 5 GB of commit and
 * was killed — repeatedly — while the only gate that noticed was a retention loop running INSIDE an
 * engine that had already been opened. `cfg.enabled` is the CAPABILITY flag (`NOVACLAW_WORLD_MEMORY`),
 * on by default, which says nothing about the user's choice; `layerFromConfig` consulted it alone and
 * built a fully live engine closure regardless.
 *
 * The class, stated once: **a mitigation applied to the work but not to the cost.** The setting gated
 * what memory DID — recall, extraction, retention — and never gated what memory COST. A privacy
 * switch checked after a 1.3 GB arena exists is not a privacy switch, it is a comment.
 *
 * These cases hold the WIRE. The behavioural claim — that no worker spawns while memory is off — is
 * not provable by reading source, and is asserted in `world-memory-does-not-spawn.test.ts` against the
 * real layer with a real spy for the engine factory.
 */

const ROOT = join(import.meta.dir, "..", "..", "..")
const read = (relative: string) => {
  const raw = readFileSync(join(ROOT, relative), "utf8")
  expect(raw.length, `${relative} must be readable — a moved file must fail LOUDLY`).toBeGreaterThan(500)
  return raw
}

describe("the world-memory layer consults the USER's switch before it can open anything", () => {
  test("🔴 the privacy switch is read at layer construction, before the engine is reachable", () => {
    const source = read("packages/core/src/kb-graph/world-memory.ts")
    // The gate must sit inside `layerFromConfig`, BEFORE the `open` closure is defined — a check after
    // that point would still have built the thing it forbids.
    const layer = source.slice(source.indexOf("export const layerFromConfig"))
    expect(layer, "layerFromConfig must remain findable — a rename must fail here").not.toBe("")
    const gate = layer.indexOf("MemorySetting.memoryEnabled()")
    expect(gate, "the layer must read the user's switch").toBeGreaterThan(-1)
    const engine = layer.indexOf("const open = () =>")
    expect(engine, "the engine factory must remain findable").toBeGreaterThan(-1)
    expect(gate, "the gate must come BEFORE the engine factory can be reached").toBeLessThan(engine)
  })

  test("a disabled setting returns the DISABLED client rather than a live engine", () => {
    const layer = read("packages/core/src/kb-graph/world-memory.ts").slice(
      read("packages/core/src/kb-graph/world-memory.ts").indexOf("export const layerFromConfig"),
    )
    // The management surface must survive: a person can still see and clear stored memories. So this
    // is a disabled CLIENT, not an error and not a throw.
    expect(layer).toMatch(/MemorySetting\.memoryEnabled\(\)[\s\S]{0,400}?MemoryClient\.disabled\(/)
  })

  test("the gate is not satisfied by the CAPABILITY flag alone", () => {
    // `cfg.enabled` is `NOVACLAW_WORLD_MEMORY`, on by default. If that is the only thing consulted,
    // the opt-in means nothing — which is exactly the bug. Both must be present in the same layer.
    const source = read("packages/core/src/kb-graph/world-memory.ts")
    const layer = source.slice(source.indexOf("export const layerFromConfig"))
    expect(layer).toContain("if (!cfg.enabled)")
    expect(layer).toContain("MemorySetting.memoryEnabled()")
  })

  test("the gate reads the INSTANCE database, not a graph directory", () => {
    // `Config` has `dbDir` (the graph's folder) and no `dbFile`. Passing one would have read a
    // different database and quietly answered a question nobody asked.
    const layer = read("packages/core/src/kb-graph/world-memory.ts").slice(
      read("packages/core/src/kb-graph/world-memory.ts").indexOf("export const layerFromConfig"),
    )
    expect(layer).not.toMatch(/MemorySetting\.memoryEnabled\((?!)\S/)
  })
})

describe("there is exactly one place that can spawn the memory worker, and it is gated", () => {
  test("no other module opens the graph without passing the same gate", () => {
    // The sweep behind the claim. `IsolatedMemory.open` is the ONLY thing that spawns
    // `__memory-worker`, so a second call site is a second door into a 1.3 GB arena.
    const files = [
      "packages/core/src/kb-graph/world-memory.ts",
      "packages/novaclaw/src/memory-worker-node.ts",
      "packages/novaclaw/src/server/routes/instance/httpapi/server.ts",
    ]
    const openers = files.filter((file) => {
      const raw = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
      return /\bIsolatedMemory\.open\b|\bopenEngine\s*\(/.test(raw)
    })
    // The worker node is the CHILD; it must not open a second engine. Only the gated layer may.
    expect(openers).toEqual(["packages/core/src/kb-graph/world-memory.ts"])
  })
})
