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

// The memory `kb` tool end to end: decode → MemoryClient → linearized text. Backed by the in-memory
// `stub` (the WASM engine itself is covered by kb-graph-wasm-engine.smoke.ts). The repair-loop
// contract from KB-E carries over: a fruitless query settles as readable result TEXT the model can act
// on — never a ToolFailure (reserved for infra). Tests use distinct query terms so the shared stub
// doesn't cross-contaminate.

const sessionID = SessionV2.ID.make("ses_kb_tool_test")

// One shared in-memory memory client behind MemoryClient.Service (seed + tool ops hit the same store).
const stub = MemoryClient.stub()

// `ingest` reads a real file through LocationMutation, so the tool now needs a Location to resolve
// relative paths against.
const workdir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "kb-tool-"))
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(workdir) })),
)

// Ingest reads a real file, so it must ride the permission gate like any other read. Record the
// assertions so the test can PROVE the gate fires rather than assuming it.
const permissionAsserts: { action: string; resources?: readonly string[] }[] = []
const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => void permissionAsserts.push(input as never)),
    ask: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, KbTool.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Memory.serviceNode, MemoryClient.layerWith(stub)],
    [Location.node, locationLayer],
    [PermissionV2.node, permissionLayer],
  ]),
)

const call = (input: unknown, id = "call-kb") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: KbTool.name, input },
})

const text = (result: { type: string; value: unknown }): string => {
  expect(result.type).toBe("text")
  return String(result.value)
}

describe("KbTool (memory)", () => {
  it.effect("registers; remember → search finds it", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize()
      expect(materialized.definitions.map((tool) => tool.name)).not.toContain(KbTool.name)
      expect(materialized.deferred.map((source) => source.definition.name)).toContain(KbTool.name)

      const saved = text(
        yield* executeTool(registry, call({ op: "remember", text: "The user prefers strict typing", name: "prefs" })),
      )
      expect(saved).toMatch(/^Remembered \(ref_[A-Za-z0-9_-]+\)/)
      expect(saved).not.toMatch(/(?:mem|clm)_[A-Za-z0-9_]+/)

      const found = text(yield* executeTool(registry, call({ op: "search", query: "strict" })))
      expect(found).toContain("prefs")
      expect(found).toContain("strict typing")
    }),
  )

  it.effect("a fruitless search settles as repair text", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const repair = text(yield* executeTool(registry, call({ op: "search", query: "chromodynamics" })))
      expect(repair).toContain("No memories match")
      expect(repair).toContain("remember")
    }),
  )

  it.effect("session-scoped memory stays out of a global-only search", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, call({ op: "remember", text: "note about kangaroos", scope: "session" }))
      expect(text(yield* executeTool(registry, call({ op: "search", query: "kangaroos", scope: "global" })))).toContain(
        "No memories match",
      )
      expect(
        text(yield* executeTool(registry, call({ op: "search", query: "kangaroos", scope: "session" }))),
      ).toContain("kangaroos")
    }),
  )

  it.effect("forget invalidates so it stops surfacing in search", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const saved = text(yield* executeTool(registry, call({ op: "remember", text: "transient fact about zorblatt" })))
      const reference = saved.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      expect(reference).not.toBe("")
      expect(saved).not.toMatch(/(?:mem|clm)_[A-Za-z0-9_]+/)
      yield* executeTool(registry, call({ op: "forget", id: reference }))
      expect(text(yield* executeTool(registry, call({ op: "search", query: "zorblatt" })))).toContain(
        "No memories match",
      )
    }),
  )

  it.effect("relate links two remembered memories; neighbors then traverses the link", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const referenceOf = (out: string) => out.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      const a = referenceOf(text(yield* executeTool(registry, call({ op: "remember", text: "Ada Lovelace", name: "Ada" }))))
      const b = referenceOf(
        text(yield* executeTool(registry, call({ op: "remember", text: "the Analytical Engine notes", name: "Note" }))),
      )
      expect(a).not.toBe("")
      expect(b).not.toBe("")
      // The model-facing relationship is a closed engine-owned choice.
      const linked = text(yield* executeTool(registry, call({ op: "relate", from: a, to: b, type: "wrote_about" })))
      expect(linked).toContain("Linked")
      expect(linked).toContain("wrote_about")
      const nb = text(yield* executeTool(registry, call({ op: "neighbors", id: a })))
      expect(nb).toContain(b)
      expect(nb).toContain("wrote_about")
    }),
  )

  it.effect("resolve disambiguates duplicate labels and get reads an opaque reference", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const referenceOf = (out: string) => out.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      const first = referenceOf(
        text(yield* executeTool(registry, call({ op: "remember", text: "label twin one", name: "Twin label" }))),
      )
      const second = referenceOf(
        text(yield* executeTool(registry, call({ op: "remember", text: "label twin two", name: "Twin label" }))),
      )
      const resolved = text(yield* executeTool(registry, call({ op: "resolve", label: "Twin label" })))
      expect(resolved).toContain("ambiguous")
      expect(resolved).toContain(first)
      expect(resolved).toContain(second)
      expect(resolved).not.toMatch(/(?:mem|clm)_[A-Za-z0-9_]+/)
      const one = text(yield* executeTool(registry, call({ op: "get", id: first })))
      expect(one).toContain("label twin one")
      expect(one).not.toMatch(/(?:mem|clm)_[A-Za-z0-9_]+/)
    }),
  )

  it.effect("predicates exposes the closed relation vocabulary and path owns multi-hop traversal", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const referenceOf = (out: string) => out.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      const a = referenceOf(text(yield* executeTool(registry, call({ op: "remember", text: "path node A" }))))
      const b = referenceOf(text(yield* executeTool(registry, call({ op: "remember", text: "path node B" }))))
      const c = referenceOf(text(yield* executeTool(registry, call({ op: "remember", text: "path node C" }))))
      yield* executeTool(registry, call({ op: "relate", from: a, to: b, type: "related_to" }))
      yield* executeTool(registry, call({ op: "relate", from: b, to: c, type: "related_to" }))
      const path = text(yield* executeTool(registry, call({ op: "path", from: a, to: c })))
      expect(path).toContain("Path (2 hops)")
      expect(path).toContain(a)
      expect(path).toContain(b)
      expect(path).toContain(c)
      expect(path).not.toMatch(/(?:mem|clm)_[A-Za-z0-9_]+/)
      const predicates = text(yield* executeTool(registry, call({ op: "predicates", id: a })))
      expect(predicates).toContain("related_to")
      expect(predicates).not.toMatch(/(?:mem|clm)_[A-Za-z0-9_]+/)
    }),
  )

  it.effect("🔴 a correction through the TOOL leaves one answer, and `history` explains it", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const referenceOf = (out: string) => out.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      const old = referenceOf(
        text(
          yield* executeTool(
            registry,
            call({ op: "remember", text: "Priya works at Initech.", name: "Priya", predicate: "employer" }),
          ),
        ),
      )
      const corrected = text(
        yield* executeTool(
          registry,
          call({ op: "remember", text: "Priya works at Acme Robotics.", name: "Priya", predicate: "employer" }),
        ),
      )
      expect(old).not.toBe("")
      expect(corrected).toContain("This replaces")
      expect(corrected).toContain(old)
      const correctedReference = referenceOf(corrected)
      expect(correctedReference).not.toBe("")
      expect(corrected).not.toMatch(/(?:mem|clm)_[A-Za-z0-9_]+/)

      // ONE answer comes back, and it is the new one.
      const found = text(yield* executeTool(registry, call({ op: "search", query: "Priya works" })))
      expect(found).toContain("Acme Robotics")
      expect(found).not.toContain("Initech")

      // …and the old assertion is still explainable, which is the other half of the gate.
      const story = text(yield* executeTool(registry, call({ op: "history", id: correctedReference })))
      expect(story).toContain("Initech")
      expect(story).toContain("superseded")
    }),
  )

  it.effect("🔴 another chat cannot read a private claim's history by knowing its id", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const referenceOf = (out: string) => out.match(/ref_[A-Za-z0-9_-]+/)?.[0] ?? ""
      // Saved into THIS chat only, so it lives in `session:ses_kb_tool_test`.
      const mine = referenceOf(
        text(
          yield* executeTool(
            registry,
            call({
              op: "remember",
              text: "Tomas lives in Utrecht.",
              name: "Tomas",
              predicate: "location",
              scope: "session",
            }),
          ),
        ),
      )
      expect(mine).not.toBe("")
      // …and the owning chat can still read it. Proving refusal alone would not show the product works.
      expect(text(yield* executeTool(registry, call({ op: "history", id: mine })))).toContain("Utrecht")

      const stranger = {
        sessionID: SessionV2.ID.make("ses_kb_tool_other"),
        ...toolIdentity,
        call: {
          type: "tool-call" as const,
          id: "call-kb-other",
          name: KbTool.name,
          input: { op: "history", id: mine },
        },
      }
      const refused = text(yield* executeTool(registry, stranger))
      expect(refused).not.toContain("Utrecht")
      expect(refused).toContain("unknown or expired")
    }),
  )

  it.effect("an ACCUMULATING predicate keeps both, so nothing is silently retired", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* executeTool(
        registry,
        call({ op: "remember", text: "Rahul knows Rust.", name: "Rahul", predicate: "knows" }),
      )
      const second = text(
        yield* executeTool(
          registry,
          call({ op: "remember", text: "Rahul knows TypeScript.", name: "Rahul", predicate: "knows" }),
        ),
      )
      expect(second).not.toContain("This replaces")
      const found = text(yield* executeTool(registry, call({ op: "search", query: "Rahul knows" })))
      expect(found).toContain("Rust")
      expect(found).toContain("TypeScript")
    }),
  )

  it.effect("neighbors of an unlinked memory points at relate", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const lonely =
        text(yield* executeTool(registry, call({ op: "remember", text: "an unconnected note about narwhals" }))).match(
          /ref_[A-Za-z0-9_-]+/,
        )?.[0] ?? ""
      const nb = text(yield* executeTool(registry, call({ op: "neighbors", id: lonely })))
      expect(nb).toContain("relate")
    }),
  )

  it.effect("ingest: a document becomes searchable passages, without entering context", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      fs.writeFileSync(
        nodePath.join(workdir, "manual.txt"),
        [
          "D20 ATTACK",
          "1. Miss and actor gains Disadvantage",
          "",
          "BRACED",
          "Spend 10 XP (5 if CLEVER) to gain BRACED.",
        ].join(String.fromCharCode(10)),
      )
      permissionAsserts.length = 0
      const first = text(yield* executeTool(registry, call({ op: "ingest", path: "manual.txt" })))
      expect(first).toContain("Ingested")
      expect(first).toContain("manual.txt")
      // Reading a user's file into memory must be permission-gated, like any other read.
      expect(permissionAsserts.some((a) => a.action === KbTool.name)).toBe(true)

      // The point of ingest: the document never entered the model's context, yet is now retrievable.
      expect(text(yield* executeTool(registry, call({ op: "search", query: "BRACED" })))).toContain("BRACED")

      // Content-addressed passage ids ⇒ re-ingesting the same document must not DUPLICATE it...
      const before = (yield* stub.list({ limit: 1000 })).length
      const second = text(yield* executeTool(registry, call({ op: "ingest", path: "manual.txt" })))
      expect((yield* stub.list({ limit: 1000 })).length).toBe(before)
      // ...AND must not CLAIM it stored anything. Asserting only the row count let a false report
      // ship: the tool counted successful addMemory calls, but a duplicate id succeeds without
      // storing, so a re-ingest announced "Ingested N passages" after storing zero.
      expect(second).toContain("already in memory")
      expect(second).not.toContain("Ingested")
    }),
  )

  it.effect("ingest: a missing file settles as readable text, never a tool failure", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ op: "ingest", path: "definitely-not-here.txt" }))
      expect(result.type).toBe("text")
      expect(String(result.value).toLowerCase()).toMatch(/no readable file|couldn't ingest/)
    }),
  )

  it.effect("🔴 ingest: a project exclusion refuses in the SAME words every other tool uses", () =>
    Effect.gen(function* () {
      // ``: *"`kb.ts` inherits enforcement but not the legible refusal message."*
      // It inherited the ENFORCEMENT for free — the gate is in `LocationMutation.resolve` — but its
      // own absorber flattened the refusal to `Couldn't ingest "x" — ProjectExclusion.ExcludedError:
      // …`, i.e. an internal tag in front of the sentence, and it was the ONE path-taking tool that
      // did not route through `PermissionV2.denialMessage`. A refusal a user authored has to read
      // the same everywhere, or the model learns that `kb` is where the rules are different.
      //
      // The project file is NESTED on purpose: the declaration is looked up from the TARGET's
      // directory, so `vault/` governs itself and the suite's shared `workdir` stays project-free.
      const registry = yield* ToolRegistry.Service
      const vault = nodePath.join(workdir, "vault")
      fs.mkdirSync(vault, { recursive: true })
      fs.writeFileSync(
        nodePath.join(vault, "novaclaw.json"),
        JSON.stringify({ version: 1, exclude: ["*.env"] }, null, 2),
      )
      fs.writeFileSync(nodePath.join(vault, "prod.env"), "TOKEN=super-secret")

      const message = text(yield* executeTool(registry, call({ op: "ingest", path: "vault/prod.env" })))
      // The three things the shared refusal says, and the thing it must never do.
      expect(message).toContain("project exclusion")
      expect(message).toContain("`*.env`")
      expect(message).toContain("Excluded paths")
      expect(message).not.toContain("ExcludedError")
      expect(message).not.toContain("super-secret")
    }),
  )

  it.effect("schema-invalid input is the one error-typed result class", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ op: "teleport" }))
      expect(result.type).toBe("error")
      expect(String(result.value)).toContain("Invalid tool input")
    }),
  )
})
