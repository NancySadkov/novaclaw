import { beforeEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Location } from "@novaclaw/core/location"
import { LocationMutation } from "@novaclaw/core/location-mutation"
import { PermissionV2 } from "@novaclaw/core/permission"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { GlobTool } from "@novaclaw/core/tool/glob"
import { GrepTool } from "@novaclaw/core/tool/grep"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

// glob and grep were the ONE path-taking pair that never classified their search root: they asserted only
// the coarse `explore` action on the PATTERN, then `path.resolve`d the caller's path with no containment
// check. `input.path` is typed RelativePath, but that brand carries no validation, so an absolute path — or
// a `../..` escape — was resolved and searched silently. grep is the sharper end: it returns matching LINES,
// i.e. real content from outside the folder. It also meant the unattended confinement stance, which gates
// exactly `external_directory_read`, did not cover searching.
//
// The load-bearing assertion in here is the DENIED case: ripgrep must never be invoked at all. An assert
// that fires but does not stop the search would look correct in a permission log and leak anyway.

const HERE = AbsolutePath.make(process.cwd())
const OUTSIDE = path.resolve(process.cwd(), "..", "__outside_the_location__")

const assertions: PermissionV2.AssertInput[] = []
const globCalls: string[] = []
const grepCalls: string[] = []
let allow = true

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }).pipe(
        Effect.andThen(
          // Deny only the external-directory class, so the `explore` assert still passes and the test
          // isolates the new guard rather than blocking everything.
          !allow && input.action.startsWith("external_directory")
            ? Effect.fail(new PermissionV2.DeniedError({ rules: [] }))
            : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const ripgrep = Layer.succeed(
  Ripgrep.Service,
  Ripgrep.Service.of({
    find: () => Effect.succeed([]),
    glob: (input) =>
      Effect.sync(() => {
        globCalls.push(input.cwd)
        return []
      }),
    grep: (input) =>
      Effect.sync(() => {
        grepCalls.push(input.cwd)
        return []
      }),
  }),
)

const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory: HERE })))

// Mirrors the real classifier: anything not lexically inside the Location is external.
const mutation = Layer.succeed(
  LocationMutation.Service,
  LocationMutation.Service.of({
    resolve: (input) => {
      const canonical = path.resolve(process.cwd(), input.path)
      const external = !FSUtil.contains(process.cwd(), canonical)
      const directory = canonical
      const externalResource = path.join(directory, "*").replaceAll("\\", "/")
      return Effect.succeed({
        canonical,
        resource: external ? canonical.replaceAll("\\", "/") : path.relative(process.cwd(), canonical) || ".",
        externalDirectory: external
          ? { action: "external_directory" as const, directory, resource: externalResource, save: externalResource }
          : undefined,
      })
    },
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GlobTool.node, GrepTool.node]), [
    [PermissionV2.node, permission],
    [Ripgrep.node, ripgrep],
    [Location.node, locationLayer],
    [LocationMutation.node, mutation],
  ]),
)

const sessionID = SessionV2.ID.make("ses_search")
const externals = () => assertions.filter((a) => a.action.startsWith("external_directory"))

beforeEach(() => {
  assertions.length = 0
  globCalls.length = 0
  grepCalls.length = 0
  allow = true
})

describe.each([
  { tool: "glob", input: { pattern: "**/*.ts" }, calls: () => globCalls },
  { tool: "grep", input: { pattern: "secret" }, calls: () => grepCalls },
])("$tool — external search root is classified", ({ tool, input, calls }) => {
  it.effect("an in-Location search asserts NO external-directory permission and runs", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: `call-${tool}-inside`, name: tool, input: { ...input, path: "src" } },
      })
      expect(externals()).toEqual([])
      expect(calls()).toHaveLength(1)
      expect(FSUtil.contains(process.cwd(), calls()[0]!)).toBe(true)
    }),
  )

  it.effect("an ABSOLUTE outside path raises an external_directory read assert", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: `call-${tool}-outside`, name: tool, input: { ...input, path: OUTSIDE } },
      })
      const external = externals()
      expect(external).toHaveLength(1)
      expect(external[0]!.action).toBe("external_directory_read")
      expect(external[0]!.resources[0]).toContain("__outside_the_location__")
    }),
  )

  it.effect("a `../..` escape is classified too — the RelativePath brand does not validate", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: `call-${tool}-dotdot`,
          name: tool,
          input: { ...input, path: "../__outside_the_location__" },
        },
      })
      expect(externals()).toHaveLength(1)
      expect(externals()[0]!.action).toBe("external_directory_read")
    }),
  )

  // The one that matters: a denial must PREVENT the search, not merely record disapproval.
  it.effect("when the external read is DENIED, ripgrep is never invoked", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* ToolRegistry.Service
      const settlement = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: `call-${tool}-denied`, name: tool, input: { ...input, path: OUTSIDE } },
      })
      expect(externals()).toHaveLength(1)
      expect(calls()).toEqual([])
      expect(JSON.stringify(settlement.result)).toMatch(/denied|permission/i)
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ONE ACTION FOR THE PAIR — the horizon half of the `explore` collapse (2026-07-30).
//
// Both tools are registered through `Tool.withPermission(…, "explore")`, so
// `ToolRegistry.materialize`'s `whollyDisabled` resolves `explore` instead of the name each tool is
// registered under. This is the only place that asserts it END-TO-END against the shipped
// registrations: `permission-baseline.test.ts` reasons about the `explore` agent's ruleset and
// `tool-permission-identity.test.ts` reads the source, but neither materializes the real tools.
//
// Before the remap the two seams answered to different actions and every ruleset had to grant both:
// `explore: "deny"` refused every call while leaving both tools advertised (a horizon the model can
// see but cannot act on), and `glob: "deny"` withdrew glob while grep went on working.
// ─────────────────────────────────────────────────────────────────────────────
describe("one permission action governs the whole search pair", () => {
  const advertised = (rules?: PermissionV2.Ruleset) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      return (yield* toolDefinitions(registry, rules)).map((one) => one.name)
    })

  it.effect("with nothing denied, both tools are on the horizon", () =>
    Effect.gen(function* () {
      // Not decoration — it is what keeps the two assertions below from being vacuously green.
      const names = yield* advertised()
      expect(names).toContain("glob")
      expect(names).toContain("grep")
    }),
  )

  it.effect("`deny explore/*` withdraws BOTH tools — one rule, one grant class", () =>
    Effect.gen(function* () {
      const names = yield* advertised([{ action: "explore", resource: "*", effect: "deny" }])
      expect({ glob: names.includes("glob"), grep: names.includes("grep") }).toEqual({ glob: false, grep: false })
    }),
  )

  it.effect("a rule naming a REGISTERED tool name now withdraws neither — the behaviour change itself", () =>
    Effect.gen(function* () {
      // The registered name is no longer the action this filter resolves, so a config key naming it
      // is inert. That is why `src/config/permission.ts` retired `glob`/`grep` from its known keys,
      // and it is the half of the change that WIDENS what an agent may do — hence the release note
      // recorded at that site rather than an on-read translation to `explore`.
      for (const action of ["glob", "grep"]) {
        const names = yield* advertised([{ action, resource: "*", effect: "deny" }])
        expect({ action, glob: names.includes("glob"), grep: names.includes("grep") }).toEqual({
          action,
          glob: true,
          grep: true,
        })
      }
    }),
  )
})
