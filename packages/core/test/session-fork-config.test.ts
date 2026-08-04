// Ruling 8 — "`fork` copies the source's chain-RESOLVED config, never its raw row", and "a fork
// returning LESS restricted than its source is a defect, not a preference" (architecture.md's
// narrowing keystone).
//
// ⚠️ Everything here reads the field list off `SESSION_CONFIG_FIELDS` instead of repeating it, so
// this file is a RATCHET rather than a snapshot: a new `SessionConfig` field fails the descriptor
// annotation at compile time, then fails "the fixture must configure every carried field" here,
// then fails the round-trip until `fork` actually carries it. That is the cheap half of Wave 3's
// B2 — B2 makes the descriptor GENERATE the mappings; this makes forgetting one impossible.

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { ModelV2 } from "@novaclaw/core/model"
import { ProjectV2 } from "@novaclaw/core/project"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  forkOverrides,
  resolveSessionConfig,
  SESSION_CONFIG_FIELD_KEYS,
  SESSION_CONFIG_FIELDS,
  SESSION_CONFIG_FORK_FIELDS,
  sessionToConfig,
  type SessionConfig,
  type SessionLike,
} from "@novaclaw/core/session/config-resolve"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionStore } from "@novaclaw/core/session/store"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

/** The effective config a TURN would run this session under — the thing that must be preserved. */
const resolveFor = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    return yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, sessionID, (id) =>
      store.get(SessionSchema.ID.make(id)),
    )
  })

/** Field-named equality — a plain `toEqual` on two objects hides WHICH field regressed. */
const expectField = (label: string, actual: unknown, expected: unknown) =>
  expect(`${label}=${JSON.stringify(actual)}`).toBe(`${label}=${JSON.stringify(expected)}`)

/**
 * A session declaring EVERY `"resolved"` field, each at a NON-default value. The `permission`
 * ruleset rides along even though it is `absent-from-row` for the fold (see the descriptor).
 */
const createFullyConfigured = (session: SessionV2.Interface, parentID?: SessionSchema.ID) =>
  Effect.gen(function* () {
    const created = yield* session.create({
      location,
      parentID,
      agent: AgentV2.ID.make("plan"),
      model: ModelV2.Ref.make({ id: ModelV2.ID.make("qwen"), providerID: ProviderV2.ID.make("dgx-spark") }),
      systemPromptOverride: "You are Neo.",
      type: "goal-oriented",
      priority: 7,
      permissionMode: "plan",
      strict: { enabled: true, attempts: 3 },
      introspection: true,
      quality: true,
      affective: true,
      permission: [{ permission: "bash", pattern: "*", action: "deny" }],
    })
    yield* session.switchResponder({ sessionID: created.id, responder: "operator" })
    yield* session.switchFeature({ sessionID: created.id, feature: "thinkingBudget", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "surgicalEdits", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "askBeforeChanges", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "safeMode", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "contextBudget", enabled: true })
    return yield* session.get(created.id)
  })

describe("SESSION_CONFIG_FIELDS — the descriptor is honest about what a row carries", () => {
  // The classification cannot be dodged: `"absent-from-row"` is only legitimate while
  // `sessionToConfig` genuinely cannot produce the field. The moment the fold starts mapping one
  // (architecture.md Phase 1 step 4 for `permissionRules`; B2 for `device`), this test fails until
  // the entry flips to `"resolved"` — at which point the round-trip tests below demand the carry.
  it.effect("classifies a field `resolved` exactly when the resolve fold maps it", () =>
    Effect.sync(() => {
      const everything = {
        id: "ses_probe",
        model: { providerID: "p", id: "m", variant: "v" },
        agent: "a",
        systemPromptOverride: "s",
        type: "goal-oriented",
        priority: 1,
        responder: "operator",
        permissionMode: "plan",
        permissionRules: [{ action: "bash", resource: "*", effect: "deny" }],
        introspection: true,
        quality: true,
        affective: true,
        thinkingBudget: true,
        surgicalEdits: true,
        askBeforeChanges: true,
        safeMode: true,
        contextBudget: true,
        strict: { enabled: true },
        device: "spark",
        tools: ["bash"],
      } as unknown as SessionLike
      const mapped = sessionToConfig(everything) as Record<string, unknown>
      for (const key of SESSION_CONFIG_FIELD_KEYS)
        expectField(`sessionToConfig maps ${key}`, mapped[key] !== undefined, SESSION_CONFIG_FIELDS[key] === "resolved")
    }),
  )

  it.effect("covers every SessionConfig field (no field left unclassified)", () =>
    Effect.sync(() => {
      expect(SESSION_CONFIG_FIELD_KEYS.length).toBeGreaterThan(SESSION_CONFIG_FORK_FIELDS.length)
      for (const key of SESSION_CONFIG_FIELD_KEYS) expect(SESSION_CONFIG_FIELDS[key]).toBeDefined()
    }),
  )
})

describe("forkOverrides — the pure fold", () => {
  const parent: SessionConfig = { systemPromptOverride: "You are Neo.", permissionMode: "plan", type: "goal-oriented" }
  const child: SessionConfig = { permissionMode: "yolo", agent: "build" }

  it.effect("materialises what the CHAIN declared, not what the row declared", () =>
    Effect.sync(() => {
      const overrides = forkOverrides([parent, child])
      expectField("systemPromptOverride", overrides.systemPromptOverride, "You are Neo.")
      expectField("type", overrides.type, "goal-oriented")
      expectField("agent", overrides.agent, "build")
    }),
  )

  // ⚠️ NEGATIVE CONTROL, permanent: the raw row IS a different answer, and a WORSE one. If someone
  // "simplifies" `fork` back to copying the source row, this is the assertion that stops them —
  // it fails only if the raw row and the chain-resolved config have become the same thing.
  it.effect("the raw row would be strictly less restricted (why ruling 8 forbids it)", () =>
    Effect.sync(() => {
      const overrides = forkOverrides([parent, child])
      const rawRow = child
      expectField("chain-resolved permissionMode", overrides.permissionMode, "plan")
      expectField("raw-row permissionMode", rawRow.permissionMode, "yolo")
      expectField("raw-row systemPromptOverride", rawRow.systemPromptOverride, undefined)
      expect(overrides).not.toEqual(rawRow)
    }),
  )

  // The ECS lens (AGENTS.md): "only divergent values create rows". A fork of a session whose chain
  // declared nothing must NOT stamp `EFFECTIVE_CONFIG_DEFAULTS` into its row — that would produce a
  // session that stops tracking the defaults its source still tracks.
  it.effect("leaves undeclared fields ABSENT rather than stamping the defaults in", () =>
    Effect.sync(() => {
      expect(forkOverrides([{}, {}])).toEqual({})
      expect(forkOverrides([])).toEqual({})
      const only = forkOverrides([{ agent: "build" }])
      expect(Object.keys(only)).toEqual(["agent"])
      expectField("type not materialised", only.type, undefined)
      expectField("permissionMode not materialised", only.permissionMode, undefined)
    }),
  )
})

describe("SessionV2.fork — the fork carries the source's resolved config", () => {
  it.effect("carries every carried field of a fully-configured ROOT, through a real DB", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const source = yield* createFullyConfigured(session)

      // Fixture coverage: a new `"resolved"` field fails HERE, naming itself, before anything else.
      for (const key of SESSION_CONFIG_FORK_FIELDS)
        expectField(`fixture configures ${key}`, (source as Record<string, unknown>)[key] !== undefined, true)

      const forked = yield* session.fork({ sessionID: source.id })
      const stored = yield* session.get(forked.id)

      // (a) The fork's OWN row carries each field — materialised, not accidentally equal.
      for (const key of SESSION_CONFIG_FORK_FIELDS)
        expectField(`fork row carries ${key}`, (stored as Record<string, unknown>)[key] !== undefined, true)

      // (b) And a turn resolves the fork to exactly what it resolved the source to.
      const sourceConfig = yield* resolveFor(source.id)
      const forkConfig = yield* resolveFor(forked.id)
      for (const key of SESSION_CONFIG_FIELD_KEYS) expectField(`resolved ${key}`, forkConfig[key], sourceConfig[key])

      // (c) The saved ruleset is not part of the fold, so it is carried verbatim off the row.
      expectField("permission ruleset", stored.permission, source.permission)
      expectField("fork is a root", stored.parentID, undefined)
    }),
  )

  // THE BUG'S CORE. A child's row holds almost nothing — everything comes from the parent via the
  // walk. Copying the row therefore loses the whole configuration, and a fork (a ROOT) has no
  // parent left to recover it from.
  it.effect("carries the PARENT's config when forking a child that declares none of its own", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const parent = yield* createFullyConfigured(session)
      const child = yield* session.create({ location, parentID: parent.id })

      const forked = yield* session.fork({ sessionID: child.id })
      const stored = yield* session.get(forked.id)

      for (const key of SESSION_CONFIG_FORK_FIELDS)
        expectField(`fork of a child carries ${key}`, (stored as Record<string, unknown>)[key] !== undefined, true)
      const childConfig = yield* resolveFor(child.id)
      const forkConfig = yield* resolveFor(forked.id)
      for (const key of SESSION_CONFIG_FIELD_KEYS) expectField(`resolved ${key}`, forkConfig[key], childConfig[key])
    }),
  )

  // The narrowing keystone, end to end: the child ASKED for `yolo`, the chain clamped it to the
  // parent's `plan`, and the fork must inherit the clamp — not the child's raw request.
  it.effect("never returns less restricted than its source (narrowing survives the fork)", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const parent = yield* session.create({
        location,
        permissionMode: "plan",
        type: "goal-oriented",
      })
      yield* session.switchFeature({ sessionID: parent.id, feature: "askBeforeChanges", enabled: true })
      yield* session.switchFeature({ sessionID: parent.id, feature: "surgicalEdits", enabled: true })
      yield* session.switchFeature({ sessionID: parent.id, feature: "safeMode", enabled: true })
      const child = yield* session.create({ location, parentID: parent.id, permissionMode: "yolo" })
      const childRow = yield* session.get(child.id)
      expectField("the child's RAW row asks for", childRow.permissionMode, "yolo")

      const forked = yield* session.fork({ sessionID: child.id })
      const stored = yield* session.get(forked.id)

      expectField("fork row permissionMode", stored.permissionMode, "plan")
      expectField("fork row type (attendance)", stored.type, "goal-oriented")
      expectField("fork row askBeforeChanges", stored.askBeforeChanges, true)
      expectField("fork row surgicalEdits", stored.surgicalEdits, true)
      // Ruling 8's named case: safe mode is a RESTRICTION, and the child never declared it — it
      // reaches the fork only through the chain walk. A fork that came back with it absent would be
      // "less restricted than its source", i.e. the defect the ruling exists to forbid.
      expectField("fork row safeMode", stored.safeMode, true)
      expectField("fork resolves to", (yield* resolveFor(forked.id)).permissionMode, "plan")
    }),
  )

  // The other half of the sparse-override discipline, live: an unconfigured session forks to an
  // unconfigured row — the fork keeps inheriting the global defaults exactly as its source does.
  it.effect("does not materialise defaults for a session whose chain declared nothing", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const source = yield* session.create({ location })

      const forked = yield* session.fork({ sessionID: source.id })
      const stored = yield* session.get(forked.id)

      for (const key of SESSION_CONFIG_FORK_FIELDS)
        expectField(`bare fork leaves ${key} absent`, (stored as Record<string, unknown>)[key], undefined)
    }),
  )
})
