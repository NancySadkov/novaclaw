import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { SessionV2 } from "@novaclaw/core/session"
import { KbTool } from "@novaclaw/core/tool/kb"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { Effect, Layer } from "effect"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

// 🔴 Ruling 2, in the tool the whole KB surface runs through: *a failed mutation never reports
// success*, and *an unavailable subsystem names itself instead of rendering empty*.
//
// `ingest` discarded every passage write (`Effect.ignore`) and degraded BOTH `stats()` calls to
// `{total: 0}`, so a store that was down produced the same `stored === 0` as a document that was
// genuinely already there — and answered ok:true *"already in memory (N passages, nothing new)"*
// about a document it had never written. The model's next `search` then reported "No memories
// match", leaving it holding two contradictory statements about its own memory.
//
// The claim is only proved by BOTH directions, so every case here is paired: engine down must
// report the failure, and a healthy engine holding the document must still say "already in memory".
// The same collapse lived in `search`, `history` and `neighbors`, which folded their error channel
// into the very empty value an honest miss produces; those are pinned here too.

const sessionID = SessionV2.ID.make("ses_kb_engine_down")

const workdir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "kb-engine-down-"))
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(workdir) })),
)
const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({ assert: () => Effect.sync(() => {}), ask: () => Effect.die("unused") }),
)

const graph = (client: MemoryClient.Interface) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, KbTool.node]), [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Memory.serviceNode, MemoryClient.layerWith(client)],
      [Location.node, locationLayer],
      [PermissionV2.node, permissionLayer],
    ]),
  )

// The exact production shape of "the engine is down": `Memory.client` substitutes
// `MemoryClient.disabled(reason)` whenever the lazy capability failed to acquire, so every op fails
// with a named MemoryError. Not a hand-rolled throw — the thing that actually ships.
const DOWN_REASON = "wasm engine failed to start"
const down = MemoryClient.disabled(DOWN_REASON)
const itDown = graph(down)

// The id-based probes need a valid model reference before the operation can reach the failing
// engine. This seam lets `search` mint one while every subsequent graph operation still fails with
// the production disabled-client error.
const itDownWithReference = graph({
  ...down,
  search: () =>
    Effect.succeed([
      {
        id: "mem_seed",
        kind: "entity" as const,
        text: "seed memory",
        name: null,
        scope: "global",
        source: null,
        confidence: null,
        relation: "staged" as const,
        status: "active" as const,
        subject: null,
        predicate: null,
        conflictKey: null,
        supersededBy: null,
        evidence: null,
        evidenceKind: null,
        score: 1,
      },
    ]),
})

// The control: a healthy in-memory store, the same one the rest of the kb-tool suite uses.
const itUp = graph(MemoryClient.stub())
const itUpWithReference = graph({
  ...MemoryClient.stub(),
  search: () =>
    Effect.succeed([
      {
        id: "mem_missing",
        kind: "entity" as const,
        text: "missing search seed",
        name: null,
        scope: "global",
        source: null,
        confidence: null,
        relation: "staged" as const,
        status: "active" as const,
        subject: null,
        predicate: null,
        conflictKey: null,
        supersededBy: null,
        evidence: null,
        evidenceKind: null,
        score: 1,
      },
    ]),
})

// A store that accepts most writes and refuses one — the partial ingest, which is neither "it
// worked" nor "it's down" and must not be rendered as either.
const healthy = MemoryClient.stub()
const itPartial = graph({
  ...healthy,
  addMemory: (input) =>
    input.text.includes("POISON")
      ? Effect.fail(new MemoryClient.MemoryError({ reason: "disk full" }))
      : healthy.addMemory(input),
})

const call = (input: unknown, id = "call-kb-down") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: KbTool.name, input },
})

const text = (result: { type: string; value: unknown }): string => {
  // Still readable TEXT, never a ToolFailure: infra faults are the one thing this surface refuses to
  // raise, so an honest failure has to be honest INSIDE a normal result.
  expect(result.type).toBe("text")
  return String(result.value)
}

const manual = [
  "D20 ATTACK",
  "1. Miss and actor gains Disadvantage",
  "",
  "BRACED",
  "Spend 10 XP to gain BRACED.",
].join(String.fromCharCode(10))

describe("KbTool — an engine fault is never rendered as an empty result", () => {
  itDown.effect("🔴 ingest: every passage write failed, so it says so instead of 'already in memory'", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      fs.writeFileSync(nodePath.join(workdir, "down.txt"), manual)
      const message = text(yield* executeTool(registry, call({ op: "ingest", path: "down.txt" })))

      // The defect verbatim: this sentence claimed a fact the tool never checked.
      expect(message).not.toContain("already in memory")
      expect(message).not.toContain("Ingested")
      // It names the subsystem, its own reason, and the one action that repairs it.
      expect(message).toContain("long-term memory isn't answering")
      expect(message).toContain(DOWN_REASON)
      expect(message).toContain('{"op":"retry","capability":"memory"}')
      // And it says how much landed, because "some of it" is the answer the model has to plan around.
      expect(message).toContain("None of its 2 passages were stored")
    }),
  )

  itUp.effect("NEGATIVE CONTROL — a healthy engine that really has it still says 'already in memory'", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      fs.writeFileSync(nodePath.join(workdir, "up.txt"), manual)
      const first = text(yield* executeTool(registry, call({ op: "ingest", path: "up.txt" })))
      expect(first).toContain("Ingested")

      const second = text(yield* executeTool(registry, call({ op: "ingest", path: "up.txt" })))
      expect(second).toContain("already in memory")
      // The fix must not have turned idempotent re-ingest into a reported failure — that is the
      // mirror defect, and a test that only pinned the failure direction would have shipped it.
      expect(second).not.toContain("long-term memory isn't answering")
      expect(second).not.toContain("were stored")
    }),
  )

  itPartial.effect("ingest: a PARTIAL write is reported as partial, not as a clean success", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      fs.writeFileSync(
        nodePath.join(workdir, "partial.txt"),
        ["ALPHA", "the first section is fine", "", "BETA", "this section is POISON", "", "GAMMA", "and a third"].join(
          String.fromCharCode(10),
        ),
      )
      const message = text(yield* executeTool(registry, call({ op: "ingest", path: "partial.txt" })))
      expect(message).toContain("Only 2 of 3 passages")
      expect(message).toContain("disk full")
      expect(message).toContain("INCOMPLETE")
      expect(message).not.toContain("already in memory")
    }),
  )

  // --- the siblings the same collapse lived in ---------------------------------------------------

  itDown.effect("search: a down engine is not a fruitless query", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const message = text(yield* executeTool(registry, call({ op: "search", query: "brace" })))
      // `searchRepair` tells the model to rephrase — which it would do forever against a store it
      // never reached.
      expect(message).not.toContain("No memories match")
      expect(message).toContain("long-term memory isn't answering")
      expect(message).toContain(DOWN_REASON)
    }),
  )

  itUp.effect("NEGATIVE CONTROL — a healthy engine with no hits still returns the repair text", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const message = text(yield* executeTool(registry, call({ op: "search", query: "chromodynamics" })))
      expect(message).toContain("No memories match")
      expect(message).not.toContain("long-term memory isn't answering")
    }),
  )

  itDownWithReference.effect("neighbors: a down engine is not 'nothing is linked to it yet'", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const seeded = text(yield* executeTool(registry, call({ op: "search", query: "seed" })))
      const reference = seeded.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      const message = text(yield* executeTool(registry, call({ op: "neighbors", id: reference })))
      expect(message).not.toContain("No memories linked")
      expect(message).toContain("long-term memory isn't answering")
    }),
  )

  itDownWithReference.effect("history: a down engine is not 'no memory you can see'", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const seeded = text(yield* executeTool(registry, call({ op: "search", query: "seed" })))
      const reference = seeded.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      const message = text(yield* executeTool(registry, call({ op: "history", id: reference })))
      expect(message).not.toContain("you can see")
      expect(message).toContain("long-term memory isn't answering")
    }),
  )

  itUpWithReference.effect("NEGATIVE CONTROL — a healthy engine still reports a genuine miss for neighbors/history", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const seeded = text(yield* executeTool(registry, call({ op: "search", query: "missing" })))
      const reference = seeded.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      const nb = text(yield* executeTool(registry, call({ op: "neighbors", id: reference })))
      expect(nb).toContain("No memories linked")
      expect(nb).not.toContain("long-term memory isn't answering")
      const hist = text(yield* executeTool(registry, call({ op: "history", id: reference })))
      expect(hist).toContain("you can see")
      expect(hist).not.toContain("long-term memory isn't answering")
    }),
  )
})
