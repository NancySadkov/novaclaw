// A NEW-SESSION DRAFT'S PER-CHAT SWITCHES MUST SURVIVE `session.create` — all eight of them.
//
// The defect this pins (fixed 2026-07-31): the composer's Tuning panel lets a user set per-chat
// switches on a DRAFT — a chat that does not exist yet — and on create only three of the then-seven
// travelled. `thinkingBudget`, `surgicalEdits`, `askBeforeChanges` and `safeMode` were accepted by
// the UI and dropped. Three of those four are RESTRICTIONS: they narrow what the agent may do. A
// user who ticks *Ask before changes* on a new chat and then watches the agent change files has
// been lied to by the product, which is ruling 2 (*a failed mutation never reports success*) on the
// surface where it matters most.
//
// ⚠️ There were THREE drop points and they had to be fixed together, which is why this file exists
// rather than a unit test on either half:
//   1. `packages/protocol/src/groups/session.ts` — the payload schema listed only the first three,
//      and it is `additionalProperties: false`, so an unlisted field is REJECTED at the edge, not
//      quietly forwarded. The client could not have worked around it.
//   2. `packages/server/src/handlers/session.ts` — the handler forwarded only those same three into
//      `session.create(...)`.
//   3. `packages/app/src/components/prompt-input/submit.ts` — the create call spread only three of
//      the draft's staged stances. (Pinned separately, in that package, by
//      `prompt-input/submit-draft-features.test.ts`; it cannot be reached from here.)
// And there was no post-create catch-up loop to rescue it: `session-composer-controls.ts` calls
// `switchFeature` only when a session `id` already exists, which a draft does not have.
//
// The kernel was NOT the problem — `SessionV2.CreateInput` accepted all seven original switches since 2026-07-29
// (`safeMode` since 2026-07-31), and `packages/core/test/session-safe-mode.test.ts` already pins
// the column's create → row → Info → resolve → fork behaviour. What was missing was the WIRE, so
// this file drives the wire: a JSON body through the REAL protocol payload schema, into the REAL
// registered handler function, into a REAL kernel on an in-memory database.
//
// ⚠️ It is a RATCHET, not a snapshot: every case iterates `SessionFeature.Name.literals` rather
// than repeating the list, so an eighth kernel feature fails here BY NAME until the payload schema
// and the handler both carry it.
//
// ⚠️ The store layers are built against `Database.layerFromPath(":memory:")`, never `Database.node`
// — the global node resolves its path from `Flag.NOVACLAW_DB` at module load and `packages/server`
// has no test preload pinning it, so a node-based test would open the developer's real database.
// (Same reasoning as `config-remove.test.ts` in this directory.)

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionTags } from "@novaclaw/core/session/tags"
import { SessionFeature } from "@novaclaw/schema/session-feature"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { SessionLocationMiddleware } from "../middleware/session-location"
import { SessionHandler } from "./session"

const DIRECTORY = "C:/tmp/session-create-features"

/** Every per-chat switch, read off the kernel's own union so this file cannot fall behind it. */
const FEATURES = SessionFeature.Name.literals

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The environment: a real kernel on an in-memory database, plus the pass-through middleware the
// group declares. Middleware is faked because this file makes no claim about transport — it makes a
// claim about the payload → handler → row path — but it has to EXIST, because building a group
// layer runs `handlerToRoute`, which resolves every declared middleware out of the ambient context.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({ resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }) }),
)

const kernel = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    SessionProjector.node,
    SessionStore.node,
    SessionTags.node,
    SessionV2.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [ProjectV2.node, projects],
    [SessionExecution.node, SessionExecution.noopLayer],
  ],
)

const middleware = Layer.mergeAll(
  Layer.succeed(
    LocationMiddleware,
    LocationMiddleware.of((effect) => effect as never),
  ),
  // `session.create` itself declares no middleware — it has no `:sessionID` to resolve a location
  // from — but sibling endpoints in the same GROUP do, and building the group runs
  // `handlerToRoute` for every one of them.
  Layer.succeed(
    SessionLocationMiddleware,
    SessionLocationMiddleware.of((effect) => effect as never),
  ),
  Layer.succeed(
    Authorization,
    Authorization.of((effect) => effect as never),
  ),
  Layer.succeed(
    SchemaErrorMiddleware,
    SchemaErrorMiddleware.of((effect) => effect as never),
  ),
)

const environment = Layer.mergeAll(middleware, kernel)

type CreateHandler = (request: {
  readonly payload: unknown
}) => Effect.Effect<{ readonly data: SessionSchema.Info }, unknown, any>

/**
 * The `session.create` endpoint as `packages/protocol` declares it — payload schema included.
 *
 * ⚠️ `endpoint.payload` is a Map keyed by content type, not a schema, and each entry holds an
 * `encoding` plus a `schemas` ARRAY. Reaching in is deliberate and guarded: if effect changes that
 * shape, this fails with a named message instead of silently testing nothing.
 */
const createEndpoint = () => {
  // Via `unknown`: effect's real group type is far richer than the slice we read, so a direct
  // assertion is rejected as non-overlapping. The guarded lookups below are what make the
  // reach-in safe — the widening is not what carries the risk.
  const groups = Api.groups as unknown as Record<
    string,
    {
      readonly key: string
      readonly endpoints: Record<
        string,
        { readonly name: string; readonly payload?: Map<string, { readonly schemas?: readonly unknown[] }> }
      >
    }
  >
  const group = groups["server.session"]
  expect(group, "the api no longer declares a `server.session` group — re-aim this file").toBeDefined()
  const endpoint = Object.values(group!.endpoints).find((item) => item.name === "session.create")
  expect(endpoint, "`session.create` is no longer declared — re-aim this file").toBeDefined()
  const json = endpoint!.payload?.get("application/json")
  expect(json?.schemas?.[0], "`session.create` declares no application/json payload schema").toBeDefined()
  return { key: group!.key, payload: json!.schemas![0] as never }
}

/**
 * Decode a JSON body exactly as the HTTP layer would.
 *
 * ⚠️ This is the half a client cannot route around. The payload is `additionalProperties: false`,
 * so a field the schema does not list is not "passed through unread" — it never reaches the
 * handler. Test one below is therefore about `packages/protocol`, not about this package.
 */
const decodeCreatePayload = (body: Record<string, unknown>) =>
  Schema.decodeUnknownSync(createEndpoint().payload)(body) as Record<string, unknown>

/**
 * Build the group layer, pull the REAL registered `session.create` function out of it, and run
 * `body` against it inside the SAME scope — the database lives in that scope, so reading the
 * session back after it closed would prove nothing.
 *
 * A missing `.handle("session.create", …)` fails here by name instead of as a 404 nobody is
 * looking for: `HttpApiBuilder.group` enforces handler completeness only in the type system, and
 * `bun test` type-strips.
 */
const withCreate = <A>(body: (create: CreateHandler) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { key } = createEndpoint()
      const context = yield* Layer.build(SessionHandler as unknown as Layer.Layer<never, never, never>)
      const built = context.mapUnsafe.get(key) as {
        readonly handlers: Map<string, { readonly handler: CreateHandler }>
      }
      const item = built.handlers.get("session.create")
      expect(item, 'server.session registered no handler for "session.create" — the route would 404').toBeDefined()
      return yield* body(item!.handler)
    }).pipe(Effect.scoped, Effect.provide(environment)) as Effect.Effect<A>,
  )

/** POST a body and read the session back out of the store — the row, not the response echo. */
const createAndReload = (body: Record<string, unknown>) =>
  withCreate((create) =>
    Effect.gen(function* () {
      const response = yield* create({ payload: decodeCreatePayload({ location: { directory: DIRECTORY }, ...body }) })
      const store = yield* SessionStore.Service
      const reloaded = yield* store.get(response.data.id)
      expect(reloaded, "the handler returned a session that is not in the store").toBeDefined()
      return {
        echoed: response.data as unknown as Record<string, unknown>,
        stored: reloaded as Record<string, unknown>,
      }
    }),
  )

describe("session.create carries every per-chat switch a draft can stage", () => {
  // The premise of everything below. If this drops to three again, the rest of the file would still
  // pass while testing nothing that matters.
  test("the kernel declares the eight switches this file is about", () => {
    expect(
      [...FEATURES].map(String).sort(),
      "SessionFeature.Name changed. Every case below iterates it, so they will keep passing over the NEW set — but a switch is only real once the payload schema (packages/protocol), the handler (./session.ts) AND the composer's create body (packages/app/.../prompt-input/submit.ts) all carry it. Check those three, then update this list.",
    ).toEqual(
      [
        "affective",
        "askBeforeChanges",
        "contextBudget",
        "introspection",
        "quality",
        "safeMode",
        "surgicalEdits",
        "thinkingBudget",
      ].sort(),
    )
  })

  // DROP POINT 1 — `packages/protocol`. Not a formality: the payload rejects what it does not list,
  // so this is the gate that made the bug unfixable from the client.
  test("the protocol payload accepts every kernel feature name", () => {
    const missing: string[] = []
    for (const feature of FEATURES) {
      let decoded: Record<string, unknown> | undefined
      try {
        decoded = decodeCreatePayload({ location: { directory: DIRECTORY }, [feature]: true })
      } catch {
        missing.push(`${feature} (rejected by the payload schema)`)
        continue
      }
      if (decoded[feature] !== true) missing.push(`${feature} (stripped by the payload schema)`)
    }
    expect(
      missing.join(", "),
      "packages/protocol/src/groups/session.ts does not list these on the session.create payload — a draft that sets one is silently discarded",
    ).toBe("")
  })

  // DROP POINT 2 — the handler, end to end. This is the test that would have caught the defect.
  test("a create setting all eight persists all eight", async () => {
    const { echoed, stored } = await createAndReload(Object.fromEntries(FEATURES.map((name) => [name, true])))
    const lost = FEATURES.filter((name) => stored[name] !== true)
    expect(
      lost.join(", "),
      "these switches were set on the create and are NOT on the persisted session — three of them are RESTRICTIONS, so the product accepted a narrowing the agent never got (ruling 2)",
    ).toBe("")
    // The response is what the UI renders the new chat's controls from, so a row that carries the
    // stance while the echo does not would still show the user an untouched switch.
    const unechoed = FEATURES.filter((name) => echoed[name] !== true)
    expect(unechoed.join(", "), "the created session's response omits switches the row carries").toBe("")
  })

  // ⚠️ THE DIRECTION THAT WOULD BE WORSE THAN THE BUG. These are tri-states: absent means INHERIT
  // (the parent chain, then the global config block) — the ECS sparse-override discipline, where
  // only a divergent value creates a row value. A mapping written as `safeMode: ctx.payload.safeMode
  // ?? false` would pass the test above and stamp a stance into every new session, which for the
  // three narrowing switches hands a fork of a restricted parent LESS restriction than its source
  // (ruling 8: that is a defect, not a preference).
  test("a create that sets nothing persists nothing — omission is inherit, never off", async () => {
    const { stored } = await createAndReload({})
    const invented = FEATURES.filter((name) => stored[name] !== undefined)
    expect(
      invented.join(", "),
      "the create INVENTED a stance for switches the user never touched — that is a default stamped into every new session, and it defeats inheritance",
    ).toBe("")
  })

  // The other half of the tri-state: an explicit OFF is a stance too, and a truthiness-shaped
  // mapping (`if (value) …`) would silently drop it back to inherit.
  test("an explicit `false` survives as false, not as absent", async () => {
    const { stored } = await createAndReload(Object.fromEntries(FEATURES.map((name) => [name, false])))
    const lost = FEATURES.filter((name) => stored[name] !== false)
    expect(lost.join(", "), "an explicit OFF was dropped back to inherit — the user's stance was lost").toBe("")
  })

  // A restriction set on a draft has to be there for the FIRST turn, not from the second one on.
  // There is no post-create `switchFeature` catch-up (see the header), so create is the only chance.
  test("safe mode ticked on a draft is on the session the moment it exists", async () => {
    const { stored } = await createAndReload({ safeMode: true })
    expect(
      stored["safeMode"],
      "safe mode did not survive create — `agent-jail.ts` tells the user to turn this off in Tuning, so it has to be possible to turn it ON there",
    ).toBe(true)
    expect(stored["askBeforeChanges"], "setting one switch invented a stance for another").toBeUndefined()
  })
})
