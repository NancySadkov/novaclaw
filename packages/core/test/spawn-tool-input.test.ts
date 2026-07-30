import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { PermissionV2 } from "@novaclaw/core/permission"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { EFFECTIVE_CONFIG_DEFAULTS, MODE_RULES, resolveSessionConfig } from "@novaclaw/core/session/config-resolve"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionExecutionLocal } from "@novaclaw/core/session/execution/local"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionRunner } from "@novaclaw/core/session/runner"
import * as SessionRunnerLLM from "@novaclaw/core/session/runner/llm"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionTable } from "@novaclaw/core/session/sql"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"

// The `spawn` TOOL surface (v0.2.0 PREP Wave 2, 2026-07-28). Two separate claims live here, and
// they are separate on purpose:
//
//   1. WIDENING. The kernel's `SpawnInput` has always accepted model / type / permissionMode and
//      `createSessionRecord` has always persisted them; the tool exposed only prompt / agent /
//      systemPromptOverride, so a supervisor could not put a sub-task on a cheaper model or hand a
//      child a tighter posture. An Effect `Schema.Struct` STRIPS unknown keys rather than rejecting
//      them, so before the widening a model that sent `permissionMode` got silence and a default
//      child — the failure mode this file's first test exists to keep out.
//
//   2. NARROWING — the invariant the widening is allowed to rest on. architecture.md calls a fork
//      that comes back LESS restricted than its source a defect, not a preference, and the clamp is
//      `moreRestrictive` inside `resolveConfig`'s fold (session/config-resolve.ts). That algebra is
//      already unit-tested there; what is NOT tested there is the path this change opens — a MODEL
//      choosing its child's mode, through the real tool, the real spawner and the real database. So
//      the assertions below run end to end and finish at `resolveSessionConfig`, which is the exact
//      call the permission evaluator itself makes (`permission.ts` → `sessionConfig`).

const PROMPT = "do the delegated sub-task"

/**
 * A deliberately PERMISSIVE fixture, so the tests below measure input plumbing rather than consent.
 * A bare test graph has no agents at all, and `configured` maps a missing agent onto deny-all — so a
 * test that did NOT set this would be measuring "no agent" and every `settleSpawn` would fail.
 *
 * ⚠️ It is no longer a reproduction of the shipped baseline, and the comment that said it was is
 * gone. v0.2.0 B4c replaced `plugin/agent.ts`'s opening catch-all with an ambient-safe allowlist
 * (`PermissionV2.AMBIENT_SAFE_BASELINE`), which does NOT contain `spawn` — see the may-spawn gate
 * block at the bottom of this file, which measures the real baseline instead of this fixture.
 */
const ALLOW_ALL: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]

/** Stands in for `runner/llm.ts`, which a unit test can never execute. Nothing here depends on the
 *  child's TURN — only on its record — so this does the minimum that keeps the wake from exploding. */
const fakeRunner = makeLocationNode({
  service: SessionRunner.Service,
  layer: Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({ run: () => Effect.void })),
  deps: [],
})

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
)

// The production node shape, same as `spawn-wakes-child.test.ts`: the instance graph with
// `SessionExecutionLocal` bound over the unbound `SessionExecution` node.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionScheduler.node,
      LocationServiceMap.node,
      SessionV2.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecutionLocal.node],
      [SessionRunnerLLM.node, fakeRunner],
    ],
  ),
)

const workspace = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
).pipe(Effect.map((tmp) => Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })))

/** Give the tool-calling agent (`toolIdentity.agent`) an explicit ruleset in this location. */
const setAgentRules = (location: Location.Ref, rules: PermissionV2.Ruleset) =>
  LocationServiceMap.Service.use((locations) =>
    AgentV2.Service.use((agents) =>
      agents.transform((editor) =>
        editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = [...rules]
        }),
      ),
    ).pipe(Effect.provide(locations.get(location))),
  ).pipe(Effect.orDie)

/** Drive the REAL registered tool, exactly as the drain does — schema decode included. */
const settleSpawn = (location: Location.Ref, parentID: SessionV2.ID, input: Record<string, unknown>) =>
  LocationServiceMap.Service.use((locations) =>
    ToolRegistry.Service.use((registry) =>
      settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-spawn", name: "spawn", input },
      }),
    ).pipe(Effect.provide(locations.get(location))),
  ).pipe(Effect.orDie)

/** The one child of `parentID`, read back as the kernel's own session record. */
const childOf = (parentID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const store = yield* SessionStore.Service
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.parent_id, parentID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return yield* store.get(SessionV2.ID.make(row.id))
  })

/** A parent session in a real directory (the Location graph does config discovery on boot). */
const parentSession = (permissionMode?: "plan" | "ask" | "surgical" | "bypass" | "yolo") =>
  Effect.gen(function* () {
    const location = yield* workspace
    const session = yield* SessionV2.Service
    const parent = yield* session.create({ location, ...(permissionMode ? { permissionMode } : {}) })
    yield* setAgentRules(location, ALLOW_ALL)
    return { location, parent }
  })

/** Pull the string constants a JSON-Schema node admits, whichever shape the encoder chose. */
const enumOf = (schema: unknown, property: string): string[] => {
  const collect = (value: unknown): string[] => {
    if (value === null || typeof value !== "object") return []
    const record = value as Record<string, unknown>
    if (Array.isArray(record["enum"])) return record["enum"].filter((item): item is string => typeof item === "string")
    if (typeof record["const"] === "string") return [record["const"]]
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branch = record[key]
      if (Array.isArray(branch)) return branch.flatMap(collect)
    }
    return []
  }
  return collect((schema as { properties?: Record<string, unknown> } | undefined)?.properties?.[property])
}

describe("the spawn tool carries the kernel's whole child-config surface", () => {
  it.live("model, type and permissionMode reach the child's session record", () =>
    Effect.gen(function* () {
      const { location, parent } = yield* parentSession()

      yield* settleSpawn(location, parent.id, {
        prompt: PROMPT,
        agent: "plan",
        model: "dgx-spark/qwen3.6-35b",
        systemPromptOverride: "answer in one line",
        type: "auto-prompting",
        permissionMode: "plan",
      })

      const child = yield* childOf(parent.id)
      expect(child).toBeDefined()
      // The three fields that were unreachable before the widening…
      // ⚠️ `String(...)` because these are BRANDED ids (`Provider.ID`, `Model.ID`) and bun's `toBe`
      // infers its parameter from the receiver, so a raw literal is TS2769. Comparing the string
      // value is what this test means anyway — it is asserting the value arrived, not its brand.
      expect(String(child?.model?.providerID)).toBe("dgx-spark")
      expect(String(child?.model?.id)).toBe("qwen3.6-35b")
      expect(child?.type).toBe("auto-prompting")
      expect(child?.permissionMode).toBe("plan")
      // …and the two that already were, so a regression that drops the OLD forwarding also bites.
      expect(String(child?.agent)).toBe("plan")
      expect(child?.systemPromptOverride).toBe("answer in one line")
    }),
  )

  it.live("an omitted field stays undefined on the row — inherit, not a baked default", () =>
    Effect.gen(function* () {
      const { location, parent } = yield* parentSession()

      yield* settleSpawn(location, parent.id, { prompt: PROMPT })

      const child = yield* childOf(parent.id)
      // The ECS sparse-override discipline: only a DIVERGENT value creates a stored fact. A tool
      // that "helpfully" defaulted these would freeze the child's config at spawn time and break
      // inheritance for every later change to the parent.
      expect(child?.model).toBeUndefined()
      expect(child?.permissionMode).toBeUndefined()
      expect(child?.systemPromptOverride).toBeUndefined()
      // `type` is the one deliberate exception, and it is the SEAM's default, not the tool's.
      expect(child?.type).toBe("sub-agent")
    }),
  )

  it.live("the advertised permissionMode set is exactly the kernel's mode set", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const definitions = yield* LocationServiceMap.Service.use((locations) =>
        ToolRegistry.Service.use((registry) => toolDefinitions(registry)).pipe(Effect.provide(locations.get(location))),
      )
      const spawn = definitions.find((definition) => definition.name === "spawn")
      expect(spawn).toBeDefined()

      // Ruling 1: the tool's literal list is a claim about a type declared in ANOTHER file, and it
      // compiles green the day a sixth mode is added. `MODE_RULES` is `Record<PermissionMode, …>`,
      // so the compiler forces a new mode to appear there — which makes this comparison the ratchet.
      expect(enumOf(spawn?.inputSchema, "permissionMode").sort()).toEqual(Object.keys(MODE_RULES).sort())
      // Same shape for the thread type, which the tool imports from `@novaclaw/schema/session-type`
      // rather than retyping — so this one can only fail if the import stops being used.
      expect(enumOf(spawn?.inputSchema, "type").sort()).toEqual(
        ["auto-prompting", "goal-oriented", "interactive", "sub-agent"].sort(),
      )
    }),
  )

  it.live("a model id without its provider is refused BEFORE a child exists", () =>
    Effect.gen(function* () {
      const { location, parent } = yield* parentSession()

      const settlement = yield* settleSpawn(location, parent.id, { prompt: PROMPT, model: "qwen3.6-35b" })

      // `ModelV2.parse` would happily yield a ref with an EMPTY model id, and the fault would then
      // surface inside the CHILD's first turn, reading as the child's failure (ruling 2).
      expect(settlement.result.type).toBe("error")
      expect(JSON.stringify(settlement.result)).toContain("provider/model-id")
      expect(yield* childOf(parent.id)).toBeUndefined()
    }),
  )
})

describe("a spawned child can never come back LESS restricted than its parent", () => {
  it.live("a yolo request under a plan parent resolves to plan", () =>
    Effect.gen(function* () {
      const { location, parent } = yield* parentSession("plan")
      const store = yield* SessionStore.Service

      yield* settleSpawn(location, parent.id, { prompt: PROMPT, permissionMode: "yolo" })

      const child = yield* childOf(parent.id)
      // THE NEGATIVE CONTROL, and it is the row itself: the child's stored request really IS `yolo`,
      // so a resolver that simply read the row — the naive implementation, and the one a reader
      // assumes — answers "yolo" here. The assertion below is therefore measuring the clamp and
      // nothing else.
      expect(child?.permissionMode).toBe("yolo")

      const resolved = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, child!.id, (id) =>
        store.get(id as SessionV2.ID),
      )
      expect(resolved.permissionMode).toBe("plan")
    }),
  )

  it.live("the clamp is one-directional — a child asking for LESS capability gets it", () =>
    Effect.gen(function* () {
      const { location, parent } = yield* parentSession("bypass")
      const store = yield* SessionStore.Service

      yield* settleSpawn(location, parent.id, { prompt: PROMPT, permissionMode: "plan" })

      const child = yield* childOf(parent.id)
      const resolved = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, child!.id, (id) =>
        store.get(id as SessionV2.ID),
      )
      // Without this, "the resolved mode is always the parent's" would pass the test above just as
      // well as a real clamp does — and privilege self-revocation (Vision) would be dead.
      expect(resolved.permissionMode).toBe("plan")
    }),
  )
})

describe("the may-spawn gate", () => {
  it.live("is LIVE on a default install: B4c took the baseline's catch-all away, so spawn ASKS", () =>
    Effect.gen(function* () {
      // ⚠️ This test used to assert the opposite — "INERT on a default install", deliberately
      // pinned green — and `tool/spawn.ts` said in so many words that whoever landed v0.2.0 B4c had
      // to come back here and decide on purpose. The decision: **`spawn` is not ambient-safe.** It
      // creates a session that carries capability of its own, which fails the "cannot change what a
      // later turn runs" test above `AMBIENT_SAFE_BASELINE`, and ruling 4's *unclassified ⇒
      // privileged* settles the remainder. So it is absent from the baseline and consent-gated.
      //
      // ⚠️ Asserted on the RULESET rather than by driving the tool, on purpose: an `ask` parks a
      // card, and a test with nobody to answer it would block until the per-test timeout — the
      // exact hang the deny-fast stance exists to describe. The full-stack half is the two tests
      // below (a real deny reaches the model; the permissive fixture still spawns).
      expect(
        PermissionV2.evaluate("spawn", "general", [
          ...PermissionV2.AMBIENT_SAFE_BASELINE,
          ...MODE_RULES[EFFECTIVE_CONFIG_DEFAULTS.permissionMode],
        ]).effect,
      ).toBe("ask")
      // NEGATIVE CONTROL: the one line B4c removed, put back — the gate grants itself again, which
      // is what "INERT" meant and why the inversion was the prerequisite rather than the polish.
      expect(
        PermissionV2.evaluate("spawn", "general", [
          { action: "*", resource: "*", effect: "allow" },
          ...PermissionV2.AMBIENT_SAFE_BASELINE,
        ]).effect,
      ).toBe("allow")

      // And the plumbing still works once spawning IS granted (the permissive fixture, above).
      const { location, parent } = yield* parentSession()
      const settlement = yield* settleSpawn(location, parent.id, { prompt: PROMPT })
      expect(settlement.result.type).not.toBe("error")
      expect(yield* childOf(parent.id)).toBeDefined()
    }),
  )

  it.live("bites: a spawn deny reaches the model as the DENIAL, and no child is created", () =>
    Effect.gen(function* () {
      const { location, parent } = yield* parentSession()
      yield* setAgentRules(location, [...ALLOW_ALL, { action: "spawn", resource: "*", effect: "deny" }])

      const settlement = yield* settleSpawn(location, parent.id, { prompt: PROMPT })

      // The counterpart to the test above: the assert is genuinely wired, not decoration. And the
      // message must be the DENIAL, never the generic "Unable to spawn child session" — an
      // unattended run told "unable" retries, while a denial tells it to stop asking.
      expect(settlement.result.type).toBe("error")
      expect(JSON.stringify(settlement.result)).toContain("Permission denied")
      expect(JSON.stringify(settlement.result)).not.toContain("Unable to spawn child session")
      expect(yield* childOf(parent.id)).toBeUndefined()
    }),
  )

  it.live("a spawn deny also withdraws the tool from the model's horizon", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const advertised = (permissions?: PermissionV2.Ruleset) =>
        LocationServiceMap.Service.use((locations) =>
          ToolRegistry.Service.use((registry) => toolDefinitions(registry, permissions)).pipe(
            Effect.provide(locations.get(location)),
          ),
        ).pipe(Effect.map((definitions) => definitions.map((definition) => definition.name)))

      // ⚠️ This half is PRE-EXISTING, not something the gate added, and that is the whole argument
      // for adding the gate at all: `Tool.permission` falls back to the registered tool NAME, so
      // `whollyDisabled` has always resolved `spawn` against the ruleset. The assert is what adds
      // the granularities this seam cannot express — an `ask`, and a deny scoped to one resource
      // rather than to `*`.
      expect(yield* advertised()).toContain("spawn")
      expect(yield* advertised([{ action: "spawn", resource: "*", effect: "deny" }])).not.toContain("spawn")
    }),
  )
})
