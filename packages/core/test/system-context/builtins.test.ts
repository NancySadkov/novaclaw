import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { CapabilityRegistry } from "@novaclaw/core/effect/capability-registry"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SystemContext } from "@novaclaw/core/system-context"
import { Shell } from "@novaclaw/core/shell"
import { SystemContextBuiltIns } from "@novaclaw/core/system-context/builtins"
import { SystemContextRegistry } from "@novaclaw/core/system-context/registry"
import { McpHealthContext } from "@novaclaw/core/mcp-health-context"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const builtInsNode = LayerNode.group([SystemContextBuiltIns.node, SystemContextRegistry.node])
const it = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: "/global", data: "/data" })],
  ]),
)
let mcpLines: ReadonlyArray<string> = []
const mcpHealthNode = makeLocationNode({
  service: McpHealthContext.Service,
  layer: Layer.succeed(
    McpHealthContext.Service,
    McpHealthContext.Service.of({ lines: () => Effect.sync(() => mcpLines) }),
  ),
  deps: [],
})
const itWithMcpHealth = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: "/global", data: "/data" })],
    [McpHealthContext.node, mcpHealthNode],
  ]),
)
let memoryRefuses = true
let memoryBuilds = 0
const memoryInner = Layer.effect(
  WorldMemory.Service,
  Effect.sync(() => {
    memoryBuilds++
    if (memoryRefuses) throw new Error("forced ambient memory defect")
    return MemoryClient.stub()
  }),
)
const itWithCapability = testEffect(
  AppNodeBuilder.build(LayerNode.group([builtInsNode, WorldMemory.node, CapabilityRegistry.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: "/global", data: "/data" })],
    [WorldMemory.serviceNode, memoryInner],
  ]),
)

/**
 * The `<env>` baseline, derived from the SAME capability `builtins.ts` reads.
 *
 * The image line is not optional dressing: a shipped instance bundles ImageMagick, so a baseline
 * without it would only pass on a box where the tool is missing. Mirroring `Shell.imagemagick()` keeps
 * the assertion exact (it is what catches volatile wall-clock context) without hard-coding a machine.
 */
const envBaseline = () =>
  [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Platform: ${process.platform}`,
    `  Shell: ${Shell.agentDefault()}`,
    ...(Shell.imagemagick()
      ? [
          `  Images: \`magick\` (ImageMagick 7) is on your PATH — use it to inspect, convert,`,
          `    crop, resize, annotate and DRAW. Examples: \`magick in.png out.webp\` (convert),`,
          `    \`magick identify in.png\` (dimensions/format), \`magick in.png -crop 100x80+10+10 out.png\`,`,
          `    \`magick -size 64x48 xc:navy -stroke yellow -fill none -draw "rectangle 5,5 30,30" out.png\``,
          `    (primitives: point, line, rectangle, circle, ellipse, polygon, text),`,
          `    \`magick in.png -fill red -draw "point 2,3" out.png\` (set one pixel),`,
          `    \`magick in.png -format "%[pixel:p{2,3}]" info:\` (read one pixel).`,
        ]
      : []),
    "</env>",
  ].join("\n")

describe("SystemContextBuiltIns", () => {
  it.effect("loads location-scoped environment without volatile wall-clock context", () =>
    Effect.gen(function* () {
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toBe(envBaseline())
    }),
  )

  // 🔴 The exception-only contract of `McpHealthContext`, at the SPLICE point rather than only at the
  // derivation (`novaclaw/test/mcp/health-context.test.ts` covers the sentences). The first case is
  // what keeps this seam free: a healthy MCP set must leave the `<env>` block byte-identical to one
  // built with the seam deleted — which is exactly what the "loads location-scoped environment" case
  // above asserts, since it runs against the core default layer.
  itWithMcpHealth.effect("a healthy MCP set adds nothing at all to <env>", () =>
    Effect.gen(function* () {
      mcpLines = []
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toBe(envBaseline())
    }),
  )

  itWithMcpHealth.effect("an unusable MCP server names itself inside <env>, and clears when it recovers", () =>
    Effect.gen(function* () {
      mcpLines = []
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())
      expect(initialized.baseline).not.toContain("searxng")

      mcpLines = ['MCP server "searxng" is configured but unavailable this session: spawn npx ENOENT.']
      const broken = yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)
      expect(broken).toMatchObject({ _tag: "Updated" })
      if (broken._tag !== "Updated") return
      // Indented like every other `<env>` line — an un-indented line would read as a new section.
      expect(broken.text).toContain(
        '  MCP server "searxng" is configured but unavailable this session: spawn npx ENOENT.',
      )

      // Recovery must be reported too: a stale "unavailable" is a fault described falsely (ruling 2).
      mcpLines = []
      const recovered = yield* SystemContext.reconcile(yield* context.load(), broken.snapshot)
      expect(recovered).toMatchObject({ _tag: "Updated" })
      if (recovered._tag !== "Updated") return
      expect(recovered.text).toContain(
        '  No longer applies: MCP server "searxng" is configured but unavailable this session: spawn npx ENOENT.',
      )
    }),
  )

  itWithCapability.effect("lazy capability refusal is exception-only ambient context and clears after retry", () =>
    Effect.gen(function* () {
      memoryRefuses = true
      memoryBuilds = 0
      const contexts = yield* SystemContextRegistry.Service
      const capabilities = yield* CapabilityRegistry.Service
      const memory = WorldMemory.client(yield* WorldMemory.node.service)
      const initialized = yield* SystemContext.initialize(yield* contexts.load())

      expect(initialized.baseline).not.toContain('Capability "world-memory"')
      expect(memoryBuilds).toBe(0)

      expect(yield* memory.health()).toBe(false)
      const broken = yield* SystemContext.reconcile(yield* contexts.load(), initialized.snapshot)
      expect(broken).toMatchObject({ _tag: "Updated" })
      if (broken._tag !== "Updated") return
      expect(broken.text).toContain('  Capability "world-memory" is unavailable:')

      memoryRefuses = false
      expect(yield* capabilities.retry("world-memory")).toMatchObject({ state: "ready" })
      const recovered = yield* SystemContext.reconcile(yield* contexts.load(), broken.snapshot)
      expect(recovered).toMatchObject({ _tag: "Updated" })
      if (recovered._tag !== "Updated") return
      expect(recovered.text).toContain('  No longer applies: Capability "world-memory" is unavailable:')
      expect(memoryBuilds).toBe(2)
    }),
  )

})
