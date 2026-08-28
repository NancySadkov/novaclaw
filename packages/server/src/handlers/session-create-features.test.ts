// A NEW-SESSION DRAFT'S PER-CHAT SWITCHES MUST SURVIVE `session.create` — all nine of them.
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
//      and an unlisted field is DROPPED at the edge rather than quietly forwarded: it never reaches
//      the handler, so the client could not have worked around it.
//      ⚠️ **DROPPED, not REJECTED — this line said "REJECTED" until 2026-08-26 and that was wrong.**
//      The OpenAPI projection does say `additionalProperties: false`, which is where the belief came
//      from, but the projection is not the enforcement: effect 4.0.0-beta.83 decodes an object with
//      `onExcessProperty: "ignore"` by DEFAULT and `unstable/httpapi` never overrides it (measured —
//      the option name appears nowhere under `effect/dist/unstable/`). So an unknown property is
//      stripped and the request SUCCEEDS. That is fine for a field the client merely mistyped and
//      NOT fine for one that asks for a restriction; see the NC-SEC-012 test at the bottom of this
//      file, which pins the measured behaviour rather than the documented one.
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
// than repeating the list, so a new kernel feature fails here BY NAME until the payload schema
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
import { SessionExecution } from "@novaclaw/core/session/execution"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionFeature } from "@novaclaw/schema/session-feature"
import { SESSION_HANDLER_NODES } from "./session-nodes"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { SessionLocationMiddleware } from "../middleware/session-location"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
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
    // ⚠️ These are listed because the HANDLER reads them out of the ambient context
    // (`handlers/session.ts` yields each before returning), not because the kernel needs them —
    // a node that is only replaced is provided INWARD, and the handler is outside that graph.
    //
    // 🔴 **This list used to be restated here by hand, and that bit three times** — `SessionReceipt`,
    // then `SessionEffectiveConfig`, then `SessionPresence` (2026-08-19, 14 red tests across two
    // files, none of them about what either file tests). It is now ONE value shared with the other
    // test kernel and with production `routes.ts`, so adding a `yield*` to a handler group is a
    // single line in `session-nodes.ts` rather than three that must be kept in agreement.
    ...SESSION_HANDLER_NODES,
    // The config view resolves the layer the TURN uses — the session folder's tune folded in — so
    // its project-file cache (and the filesystem behind it) come with it.
    FSUtil.node,
    ProjectFileCache.node,
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
  // ⚠️ `session.create` DOES declare middleware now — `locationMiddleware` since 2026-08-07, because
  // without it the handler had no request location and filed sessions under `process.cwd()`. Sibling
  // endpoints in the same GROUP declare `sessionLocationMiddleware`, and building the group runs
  // `handlerToRoute` for every one of them, so all of them must be satisfiable here.
  Layer.succeed(
    SessionLocationMiddleware,
    SessionLocationMiddleware.of((effect) => effect as never),
  ),
  // Group-level on the session group since 2026-08-07: it routes a request to the instance that owns
  // its session. Faked pass-through like its neighbours — this file makes no claim about transport,
  // and `session.create`'s handler does not read `WorkspaceRouteContext`.
  Layer.succeed(
    WorkspaceRoutingMiddleware,
    WorkspaceRoutingMiddleware.of((effect) => effect as never),
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
  const group = groups["server.session.catalog"]
  expect(group, "the api no longer declares a `server.session.catalog` group — re-aim this file").toBeDefined()
  const endpoint = Object.values(group!.endpoints).find((item) => item.name === "session.create")
  expect(endpoint, "`session.create` is no longer declared — re-aim this file").toBeDefined()
  const json = endpoint!.payload?.get("application/json")
  expect(json?.schemas?.[0], "`session.create` declares no application/json payload schema").toBeDefined()
  return { key: group!.key, payload: json!.schemas![0] as never }
}

/**
 * Decode a JSON body exactly as the HTTP layer would.
 *
 * ⚠️ This is the half a client cannot route around: a field the schema does not list is stripped
 * here and never reaches the handler. Test one below is therefore about `packages/protocol`, not
 * about this package. **Stripped is not refused** — the request still succeeds; see the banner at
 * the top of this file and the NC-SEC-012 test at the bottom.
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
      expect(
        item,
        'server.session.catalog registered no handler for "session.create" — the route would 404',
      ).toBeDefined()
      return yield* body(item!.handler)
    }).pipe(Effect.scoped, Effect.provide(environment)) as Effect.Effect<A>,
  )

/** POST a body and read the session back out of the store — the row, not the response echo. */
const createAndReload = (body: Record<string, unknown>) =>
  withCreate((create) =>
    Effect.gen(function* () {
      const response = yield* create({
        payload: decodeCreatePayload({ location: { directory: DIRECTORY }, agent: "build", ...body }),
      })
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
  test("the kernel declares the ten switches this file is about", () => {
    expect(
      [...FEATURES].map(String).sort(),
      "SessionFeature.Name changed. Every case below iterates it, so they will keep passing over the NEW set — but a switch is only real once the payload schema (packages/protocol), the handler (./session.ts) AND the composer's create body (packages/app/.../prompt-input/submit.ts) all carry it. Check those three, then update this list.",
    ).toEqual(
      [
        "affective",
        "askBeforeChanges",
        "contextBudget",
        "introspection",
        "memory",
        "shortChat",
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
  test("a create setting all nine persists all nine", async () => {
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

  // ── v0.2.0 B2: `session.device`, the same two drop points, and it is NOT a SessionFeature ──────
  //
  // It rides this file rather than a new one because the failure it guards is character-for-character
  // the one above: `additionalProperties: false` means an unlisted field is REJECTED at the edge, and
  // a handler that forwards every nearby field except the new one is exactly how `thinkingBudget`,
  // `surgicalEdits`, `askBeforeChanges` and `safeMode` were lost for a month. It cannot join the
  // `FEATURES` loop — those are the boolean Tuning switches read off `SessionFeature.Name`, and a
  // device affinity is a string naming a `DeviceRegistry` entry.
  //
  // ⭐ And it is this chain's INERT check at the wire: `session.device` has a column, a migration, a
  // descriptor entry and a consumer, and if nothing outside the kernel can WRITE it, all of that
  // ships doing nothing with every other test green.
  test("a device affinity set on create reaches the persisted session", async () => {
    const { echoed, stored } = await createAndReload({ device: "spark" })
    expect(
      stored["device"],
      "the device affinity did not survive create — check the payload schema (packages/protocol) and the handler's forward list",
    ).toBe("spark")
    // The echo matters for the same reason it does above: it is what the client reads back.
    expect(echoed["device"], "the created session's response omits the device the row carries").toBe("spark")
  })

  // The tri-state direction, and here it is sharper than for the switches: `undefined` means DERIVE
  // the device from the resolved model's endpoint. A handler that coalesced it to anything concrete
  // would pin every new session to one backend and, worse, freeze that pin into every child it
  // spawns — inheritance is the whole mechanism by which a sub-agent lands on its parent's device.
  test("a create that names no device stays absent, so the runner derives one", async () => {
    const { stored } = await createAndReload({})
    expect(
      stored["device"],
      "the create INVENTED a device affinity — absent must mean inherit-then-derive, never a stamped default",
    ).toBeUndefined()
  })

  test("a control binding set on create reaches the persisted session", async () => {
    const { echoed, stored } = await createAndReload({ controlBinding: ":99" })
    expect(stored["controlBinding"], "the create payload or handler discarded the control binding").toBe(":99")
    expect(echoed["controlBinding"], "the created session response omitted its control binding").toBe(":99")
  })

  test("a create with no control binding stays sparse for parent and instance fallback", async () => {
    const { stored } = await createAndReload({})
    expect(stored["controlBinding"]).toBeUndefined()
  })

  // C1a: `responder` already existed in the kernel CreateInput, row projection and switch route,
  // but the create payload omitted it. Effect's decoder stripped the unknown key and returned 200,
  // so only an edge-to-row check can distinguish a real create-time writer from an inert column.
  test("an operator responder set on create reaches the persisted session", async () => {
    const { echoed, stored } = await createAndReload({ responder: "operator" })
    expect(stored["responder"], "the create payload or handler discarded the responder").toBe("operator")
    expect(echoed["responder"], "the created session's response omits the responder the row carries").toBe("operator")
  })

  // Sparse override discipline: omission must remain inheritance. Stamping `nova` here would make
  // a child ignore an operator responder inherited from its parent.
  test("a create that names no responder stays absent", async () => {
    const { stored } = await createAndReload({})
    expect(stored["responder"], "the create invented a responder instead of inheriting one").toBeUndefined()
  })

  /**
   * 🔴 **NC-SEC-012 — a saved per-session permission ruleset is not a create field, and must not
   * come back as one.**
   *
   * `session.create` used to declare an optional `permission` member, document it on the wire as
   * *"the caller's explicit saved permission ruleset"*, and then drop it: ruling 16 had already
   * deleted the kernel writer, `Session.Info` member and every reader, but the PUBLIC contract was
   * left advertising it. A client sending `{permission:"bash", pattern:"*", action:"deny"}` got a
   * successful session with no such restriction, and the live evaluator saw only the agent's V2
   * rules. A restriction that receives 2xx and vanishes at the boundary is the security-contract
   * failure, not the dead column underneath it.
   *
   * ⚠️ **What this test can and cannot claim.** The property is gone from the payload, the OpenAPI
   * spec and the generated SDK, so nothing advertises it any more — that is what the first
   * assertion ratchets. It is NOT refused: effect decodes with `onExcessProperty: "ignore"` and
   * `unstable/httpapi` does not override it, so an old generated client that still sends the field
   * gets it stripped and the create still succeeds. Measured, not assumed — the last assertion
   * pins that residue deliberately so nobody re-derives "additionalProperties: false" from the
   * OpenAPI projection and believes the edge rejects it. Making the wire strict is a cross-cutting
   * decode-option change over EVERY endpoint and belongs to its own slice.
   */
  test("NC-SEC-012: `permission` is no longer a create field and cannot restrict anything", async () => {
    const ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]

    // The ratchet: re-declaring the member in `packages/protocol` makes this decode carry it again.
    const decoded = decodeCreatePayload({ title: "denied", permission: ruleset })
    expect(
      decoded["permission"],
      "`session.create` declares a `permission` payload member again — the handler does not read one, so the caller's deny would be accepted and discarded",
    ).toBeUndefined()

    // The NEGATIVE half. A decoder that dropped everything would satisfy the line above on its own,
    // so a supported field on the SAME body has to survive the SAME decode.
    expect(decoded["title"], "the payload decode dropped a field it does declare").toBe("denied")

    // End to end: no ruleset reaches the row, and the create still SUCCEEDS — the documented residue.
    const { echoed, stored } = await createAndReload({ title: "denied", permission: ruleset })
    expect(stored["permission"], "a permission ruleset reached the session row").toBeUndefined()
    expect(echoed["permission"], "the create response echoed a permission ruleset").toBeUndefined()
    expect(stored["title"], "the create that carried an obsolete field failed instead of ignoring it").toBe("denied")
  })
})
