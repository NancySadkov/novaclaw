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
import { EFFECTIVE_CONFIG_DEFAULTS, MODE_RULES } from "@novaclaw/core/session/config-resolve"
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

// The `spawn` TOOL surface (v0.2.0 PREP Wave 2, 2026-07-28).
//
// SURFACE MINIMALISM. `SessionSpawner` accepts the operator-side session configuration, but the model
// tool is a fork rather than a session-creation form: exactly one prompt. Agent/model/control/system
// prompt/type/permission inherit mechanically instead of becoming more JSON the model can repeat
// incorrectly. Effect strips unknown keys, so the test drives that boundary through the real decoder
// and proves the child row stayed sparse.

/**
 * 🔴 NC-SEC-020 — a ROOT names the agent it runs as; there is no anonymous chat. `build` records the
 * POSTURE this chat runs in, which is the ordinary production case and keeps these tests' semantics
 * unchanged: a posture is excluded from the canonical `ses_<agent>` id and from the one-chat guard.
 */
const rootAgent = AgentV2.ID.make("build")

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
const parentSession = () =>
  Effect.gen(function* () {
    const location = yield* workspace
    const session = yield* SessionV2.Service
    const parent = yield* session.create({ location, agent: rootAgent })
    yield* setAgentRules(location, ALLOW_ALL)
    return { location, parent }
  })

describe("the spawn tool keeps the model surface fork-shaped", () => {
  it.live("the model surface strips every operator-only session field", () =>
    Effect.gen(function* () {
      const { location, parent } = yield* parentSession()

      yield* settleSpawn(location, parent.id, {
        prompt: PROMPT,
        agent: "plan",
        model: "dgx-spark/qwen3.6-35b",
        controlBinding: ":100",
        systemPromptOverride: "answer in one line",
        type: "auto-prompting",
        permissionMode: "plan",
      })

      const child = yield* childOf(parent.id)
      expect(child?.agent).toBeUndefined()
      expect(child?.model).toBeUndefined()
      expect(child?.controlBinding).toBeUndefined()
      expect(child?.systemPromptOverride).toBeUndefined()
      expect(child?.type).toBe("sub-agent")
      expect(child?.permissionMode).toBeUndefined()
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
      expect(child?.controlBinding).toBeUndefined()
      // `type` is the one deliberate exception, and it is the SEAM's default, not the tool's.
      expect(child?.type).toBe("sub-agent")
    }),
  )

  it.live("advertises exactly one model argument", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const definitions = yield* LocationServiceMap.Service.use((locations) =>
        ToolRegistry.Service.use((registry) => toolDefinitions(registry)).pipe(Effect.provide(locations.get(location))),
      )
      const spawn = definitions.find((definition) => definition.name === "spawn")
      expect(spawn).toBeDefined()

      expect(Object.keys((spawn?.inputSchema as any)?.properties ?? {}).sort()).toEqual(["prompt"])
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
        PermissionV2.evaluate("spawn", "inherit", [
          ...PermissionV2.AMBIENT_SAFE_BASELINE,
          ...MODE_RULES[EFFECTIVE_CONFIG_DEFAULTS.permissionMode],
        ]).effect,
      ).toBe("ask")
      // NEGATIVE CONTROL: the one line B4c removed, put back — the gate grants itself again, which
      // is what "INERT" meant and why the inversion was the prerequisite rather than the polish.
      expect(
        PermissionV2.evaluate("spawn", "inherit", [
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
