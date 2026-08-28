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
  isRowCarried,
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

/**
 * 🔴 NC-SEC-020 — a ROOT names the agent it runs as; there is no anonymous chat. `build` records the
 * POSTURE this chat runs in, which is the ordinary production case and keeps these tests' semantics
 * unchanged: a posture is excluded from the canonical `ses_<agent>` id and from the one-chat guard.
 */
const rootAgent = AgentV2.ID.make("build")

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
 * A session declaring EVERY row-carried field, each at a NON-default value. The `permission`
 * ruleset rides along even though it is NOT a `SessionConfig` field at all — its config twin
 * (`permissionRules`) was deleted as a phantom in B2, while the COLUMN survives for now.
 */
const createFullyConfigured = (session: SessionV2.Interface, parentID?: SessionSchema.ID) =>
  Effect.gen(function* () {
    const created = yield* session.create({
      location,
      parentID,
      agent: AgentV2.ID.make("plan"),
      model: ModelV2.Ref.make({ id: ModelV2.ID.make("qwen"), providerID: ProviderV2.ID.make("dgx-spark") }),
      // Device affinity: re-added WITH its column in B2's third step, so it is row-carried and the
      // loop below requires a fork to carry it — a fork that silently moved to another backend would
      // be scheduled against capacity its source never claimed.
      device: "spark",
      controlBinding: ":99",
      systemPromptOverride: "You are Neo.",
      type: "goal-oriented",
      priority: 7,
      permissionMode: "plan",
      strict: { enabled: true, attempts: 3 },
      introspection: true,
      quality: true,
      affective: true,
    })
    yield* session.switchResponder({ sessionID: created.id, responder: "operator" })
    yield* session.switchFeature({ sessionID: created.id, feature: "thinkingBudget", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "surgicalEdits", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "askBeforeChanges", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "safeMode", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "contextBudget", enabled: true })
    yield* session.switchFeature({ sessionID: created.id, feature: "memory", enabled: false })
    yield* session.switchFeature({ sessionID: created.id, feature: "shortChat", enabled: true })
    return yield* session.get(created.id)
  })

describe("SESSION_CONFIG_FIELDS — the descriptor is honest about what a row carries", () => {
  // The classification cannot be dodged: `"absent-from-row"` is only legitimate while
  // `sessionToConfig` genuinely cannot produce the field, and `"resolved"` only while it can.
  // Both directions are checked, so neither a field parked out of the fork nor one silently
  // dropped from the fold can pass.
  //
  // ⚠️ The probe deliberately carries TWO keys that are no longer `SessionConfig` fields —
  // `permissionRules` and `tools`, two thirds of the phantom trio deleted in B2. They are here as
  // the negative half of the second assertion below: if either ever reappears in the fold's output
  // without a descriptor entry, that assertion names it. Keeping them costs nothing and makes the
  // deletion mechanical rather than remembered.
  // ⚠️ `device` was the third, and it is now a POSITIVE case: it came back in B2's third step with a
  // column, a migration, a store and a consumer, which is the only way a field is allowed back.
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
        memory: true,
        shortChat: true,
        strict: { enabled: true },
        device: "spark",
        controlBinding: ":99",
        tools: ["bash"],
      } as unknown as SessionLike
      const mapped = sessionToConfig(everything) as Record<string, unknown>
      for (const key of SESSION_CONFIG_FIELD_KEYS)
        expectField(`sessionToConfig maps ${key}`, mapped[key] !== undefined, isRowCarried(key))
      // The other direction: the fold may not produce a key the descriptor never declared.
      expect(Object.keys(mapped).filter((key) => !(key in SESSION_CONFIG_FIELDS))).toEqual([])
    }),
  )

  it.effect("covers every SessionConfig field (no field left unclassified)", () =>
    Effect.sync(() => {
      for (const key of SESSION_CONFIG_FIELD_KEYS) expect(SESSION_CONFIG_FIELDS[key]).toBeDefined()
    }),
  )

  // ⚠️ Written because a NEGATIVE CONTROL exposed the gap. Pointing `safeMode` at
  // `context_budget` — a real column, so the compile-time existence check in `config-columns.ts`
  // is happy — went red in SEVEN places across three files, none of which said "two fields claim
  // one column". A collision is a corruption (whichever field is written second wins the row and
  // the other reads its neighbour's value), so it deserves an assertion that NAMES it rather than
  // a scatter of downstream behaviour failures.
  it.effect("no two config fields claim the same session column", () =>
    Effect.sync(() => {
      const byColumn = new Map<string, string[]>()
      for (const key of SESSION_CONFIG_FIELD_KEYS) {
        const column = SESSION_CONFIG_FIELDS[key].column
        if (column === undefined) continue
        byColumn.set(column, [...(byColumn.get(column) ?? []), key])
      }
      expect([...byColumn].filter(([, keys]) => keys.length > 1)).toEqual([])
      // Non-vacuity: an empty descriptor would satisfy the line above trivially.
      expect(byColumn.size).toBe(SESSION_CONFIG_FORK_FIELDS.length)
      expect(byColumn.size).toBeGreaterThan(0)
    }),
  )

  // 🔴 A ratchet AT ZERO, which is the state the phantom-trio deletion left it in (v0.2.0 B2).
  //
  // This used to read `expect(KEYS.length).toBeGreaterThan(FORK_FIELDS.length)` — an assertion that
  // REQUIRED at least one unresolved field, i.e. it encoded the phantoms as the intended state and
  // would have gone red on the day they were removed. That is the wrong direction for a ledger.
  //
  // Zero is the honest floor: a `SessionConfig` field with no column resolves for nobody, which is
  // exactly what the deleted trio was. Adding one now fails HERE, by name, which forces the column
  // and its migration into the same commit rather than leaving a field to age into a phantom.
  it.effect("no SessionConfig field is parked outside the row (the absent-from-row set is empty)", () =>
    Effect.sync(() => {
      expect(SESSION_CONFIG_FIELD_KEYS.filter((key) => !isRowCarried(key))).toEqual([])
      expect(SESSION_CONFIG_FORK_FIELDS.length).toBe(SESSION_CONFIG_FIELD_KEYS.length)
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

      // ⚠️ The saved `permission` ruleset used to be carried verbatim here. It is GONE (2026-08-23):
      // it was written by create/`setPermission` and read by nobody — `permission.ts` resolves the
      // AGENT's ruleset and never consulted the session row — and it was typed in the LEGACY
      // `{permission, pattern, action}` shape the evaluator does not even take. Nothing replaces it;
      // one authority for permissions is the decision.
      /**
       * 🔴 **SUPERSEDED: a fork is a BRANCH of its source, not a root** (owner, 2026-08-28 — "no
       * ghosthouse architecture", resolved against the ECS lens).
       *
       * It was a root so that it would not carry the source's agent, because a second ROOT bearing a
       * colleague's id is a second chat for that colleague. That bought the exemption with a row
       * belonging to nobody. As a child it carries the owner AND breaks nothing: one-chat-per-colleague
       * governs roots, and the reason it exists — "the roster is the only door to a colleague's chat"
       * — does not reach a branch, which is opened through the chat it came from.
       */
      expectField("fork hangs off its source", stored.parentID, source.id)
      expectField("fork carries the source's owner", stored.agent, source.agent)
    }),
  )

  // THE BUG'S CORE. A child's row holds almost nothing — everything comes from the parent via the
  // walk. Copying the row therefore loses the whole configuration, and a fork (a ROOT) has no
  // parent left to recover it from.
  it.effect("carries the PARENT's config when forking a child that declares none of its own", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const parent = yield* createFullyConfigured(session)
      const child = yield* session.create({ location, agent: rootAgent, parentID: parent.id })

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
        agent: rootAgent,
        permissionMode: "plan",
        type: "goal-oriented",
      })
      yield* session.switchFeature({ sessionID: parent.id, feature: "askBeforeChanges", enabled: true })
      yield* session.switchFeature({ sessionID: parent.id, feature: "surgicalEdits", enabled: true })
      yield* session.switchFeature({ sessionID: parent.id, feature: "safeMode", enabled: true })
      const child = yield* session.create({ location, agent: rootAgent, parentID: parent.id, permissionMode: "yolo" })
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
      const source = yield* session.create({ location, agent: rootAgent })

      const forked = yield* session.fork({ sessionID: source.id })
      const stored = yield* session.get(forked.id)

      for (const key of SESSION_CONFIG_FORK_FIELDS) {
        /**
         * ⚠️ `agent` is EXCLUDED since NC-SEC-020, and the exclusion is the point rather than an
         * exemption: a root must name the agent it runs as, so "a chain that declared nothing" can
         * no longer include this field. The source above declares `build`, the fork carries it, and
         * a fork that DROPPED it would be recreating the anonymous root this suite's sibling now
         * refuses. Every other field still has to stay absent — that is what this test is for.
         */
        if (key === "agent") {
          expectField("a fork carries its source's agent", (stored as Record<string, unknown>)[key], rootAgent)
          continue
        }
        expectField(`bare fork leaves ${key} absent`, (stored as Record<string, unknown>)[key], undefined)
      }
    }),
  )
})
