import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { LLMClient, Model, type LLMClientShape } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { LayerNodePlatform } from "@novaclaw/core/effect/app-node-platform"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { EventTable } from "@novaclaw/core/event/sql"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMaintenance } from "@novaclaw/core/session/runner/maintenance"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionTable } from "@novaclaw/core/session/sql"
import { Snapshot } from "@novaclaw/core/snapshot"
import { runBounded } from "./fixture/bounded"

/**
 * 🔴 **WHY THIS FILE EXISTS.** `SessionMaintenance` is a service layer holding per-instance state
 * (the auto-title in-flight guard) and writing through a `Database` handle. Effect's `MemoMap` keys
 * on the layer's OBJECT IDENTITY, and **only `Layer.effect` is ever a key** — `provide`,
 * `catchCause` and `unwrap` are pass-throughs. A sibling subsystem in this repo made its service
 * layer a *function of a parameter*, minting a fresh key per call, and got **two instances and two
 * `:memory:` databases**: every read through one missed every write through the other. It was
 * invisible to nineteen of that subsystem's own tests and to a live smoke, because **every one of
 * them built exactly ONE composition** — one instance is always self-consistent.
 *
 * So the property cannot be stated by a single consumer. This file builds TWO consumers and asks
 * three questions, the third of which is the one that makes the first two evidence:
 *
 *   1. two consumers under ONE memo map resolve to the SAME service object;
 *   2. a WRITE through one is visible through the other's database handle;
 *   3. **the control** — separate memo maps must NOT share, or (1) and (2) would pass against a
 *      graph that shares nothing and the test would be measuring `Layer.provide`'s wrapper shape
 *      instead of the memo map.
 */

const MAINTENANCE_SESSION = SessionV2.ID.make("ses_maintenance_identity")

const model = Model.make({ id: "identity-model", provider: "harness", route: OpenAIChat.route })

/** No pass in this file reaches the provider; a stream that answers nothing is the honest stub. */
const clientLayer = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (() => Stream.fromIterable([])) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

/**
 * The graph under test. Built fresh per call so each test owns its own `:memory:` database — but
 * note the LAYER OBJECTS inside are module-level, which is precisely why memo-map sharing (and not
 * this function) is what decides instance identity.
 */
const graph = () =>
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionMaintenance.node]), [
    [LayerNodePlatform.llmClient, clientLayer],
    [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
    [Snapshot.node, Snapshot.noopLayer],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  ]) as Layer.Layer<Database.Service | EventV2.Service | SessionMaintenance.Service, unknown, never>

interface Probe {
  readonly maintenance: SessionMaintenance.Interface
  readonly db: Database.Interface["db"]
}

/**
 * One consumer: a distinct `Layer.effectDiscard` (so it is its own memo key and always builds) that
 * records the service objects the graph handed IT. Delegating rather than stubbing is the point —
 * a stub would answer a different question.
 */
const consumer = (record: Probe[], provided: Layer.Layer<any, any, never>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const maintenance = yield* SessionMaintenance.Service
      const { db } = yield* Database.Service
      record.push({ maintenance, db })
    }),
  ).pipe(Layer.provide(provided)) as Layer.Layer<never, unknown, never>

const seed = (db: Database.Interface["db"], id: SessionV2.ID) =>
  db
    .insert(SessionTable)
    .values({ id, slug: id, directory: "/project", title: "test", version: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

const sessionRow = (db: Database.Interface["db"], id: SessionV2.ID) =>
  db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)

const eventCount = (db: Database.Interface["db"], id: SessionV2.ID) =>
  db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, id))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    )

/**
 * Build two consumers over the same compiled graph and hand both probes to `body`.
 *
 * `fresh: true` wraps the SECOND consumer's copy in `Layer.fresh`, which is
 * `self.build(makeMemoMapUnsafe(), scope)` — a brand-new ROOT memo map, i.e. exactly the shape a
 * per-call layer factory produces. That is the negative control, and nothing else in this file
 * differs between the two arms.
 */
const withTwoConsumers = <A, E>(
  options: { readonly fresh: boolean },
  body: (a: Probe, b: Probe) => Effect.Effect<A, E, never>,
  label: string,
) => {
  const probes: Probe[] = []
  const built = graph()
  const both = Layer.merge(consumer(probes, built), consumer(probes, options.fresh ? Layer.fresh(built) : built))
  return runBounded(
    Effect.suspend(() => {
      expect(probes).toHaveLength(2)
      return body(probes[0]!, probes[1]!)
    }).pipe(Effect.scoped, Effect.provide(both)) as Effect.Effect<A, E, never>,
    { ms: 60_000, label },
  )
}

describe("SessionMaintenance — one layer object, one instance", () => {
  test("two consumers under one memo map get the SAME service object", async () => {
    await withTwoConsumers(
      { fresh: false },
      (a, b) =>
        Effect.sync(() => {
          expect(a.maintenance).toBe(b.maintenance)
          // The `Database` handle is what the sibling's defect actually split. Assert it directly:
          // identical services could still, in principle, close over different handles.
          expect(a.db).toBe(b.db)
        }),
      "maintenance identity — shared",
    )
  }, 60_000)

  test("a WRITE through one consumer is visible through the other", async () => {
    await withTwoConsumers(
      { fresh: false },
      (a, b) =>
        Effect.gen(function* () {
          yield* seed(a.db, MAINTENANCE_SESSION)
          // Non-vacuity: without the seed `patchSessionRecord` returns false and publishes nothing,
          // so the assertion below would be about an empty table rather than about sharing.
          expect(yield* sessionRow(b.db, MAINTENANCE_SESSION)).toBeDefined()
          expect(yield* eventCount(b.db, MAINTENANCE_SESSION)).toBe(0)

          yield* a.maintenance.markChangesIncomplete(MAINTENANCE_SESSION)

          // The write lands as a `session.updated` record event; read it back through B's handle.
          expect(yield* eventCount(b.db, MAINTENANCE_SESSION)).toBeGreaterThan(0)
        }),
      "maintenance identity — write visible",
    )
  }, 60_000)

  // NEGATIVE CONTROL. `Layer.fresh` is the violating shape: a build with a brand-new root memo map,
  // which is what a genuinely different layer object (or a layer minted per call) would produce.
  // Both assertions above must INVERT here, or they are not measuring the memo map.
  test("separate memo maps do NOT share — two instances, two databases (negative control)", async () => {
    await withTwoConsumers(
      { fresh: true },
      (a, b) =>
        Effect.gen(function* () {
          expect(a.maintenance).not.toBe(b.maintenance)
          expect(a.db).not.toBe(b.db)
          yield* seed(a.db, MAINTENANCE_SESSION)
          // The symptom the sibling shipped: a row written through one handle simply is not there
          // through the other, because `:memory:` means one database per connection.
          expect(yield* sessionRow(a.db, MAINTENANCE_SESSION)).toBeDefined()
          expect(yield* sessionRow(b.db, MAINTENANCE_SESSION)).toBeUndefined()
          yield* a.maintenance.markChangesIncomplete(MAINTENANCE_SESSION)
          expect(yield* eventCount(b.db, MAINTENANCE_SESSION)).toBe(0)
        }),
      "maintenance identity — control",
    )
  }, 60_000)
})
