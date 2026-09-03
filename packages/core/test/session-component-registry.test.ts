import { describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { Database } from "@novaclaw/core/database/database"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionComponentTable, SessionTable } from "@novaclaw/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"

const Goal = SessionComponentRegistry.kernelDefinition({
  kind: "goal",
  description: "The durable objective",
  cardinality: "singleton",
  lifetime: "entity",
  version: 1,
  codec: Schema.Struct({ text: Schema.NonEmptyString }),
})
const AttemptStep = SessionComponentRegistry.toolDefinition("planner", {
  name: "step",
  description: "One attempt-owned step",
  cardinality: "set",
  lifetime: "attempt",
  version: 1,
  codec: Schema.Struct({ text: Schema.NonEmptyString, done: Schema.Boolean }),
})
const Lease = SessionComponentRegistry.toolDefinition("controller", {
  name: "lease",
  description: "A bounded controller lease",
  cardinality: "singleton",
  lifetime: "bounded",
  version: 1,
  codec: Schema.Struct({ surface: Schema.NonEmptyString }),
})

const withRegistry = async <A>(
  kernel: ReadonlyArray<SessionComponentRegistry.Definition>,
  run: (input: {
    readonly databasePath: string
    readonly directory: string
    readonly sessionID: SessionSchema.ID
  }) => Effect.Effect<A, unknown, Database.Service | SessionComponentRegistry.Service>,
) => {
  await using tmp = await tmpdir()
  const directory = tmp.path
  const databasePath = path.join(directory, "instance.db")
  const sessionID = SessionSchema.ID.make(`ses_component_${crypto.randomUUID().replaceAll("-", "")}`)
  const database = Database.layerFromPath(databasePath)
  const registry = SessionComponentRegistry.layerWith(kernel).pipe(Layer.provide(database))
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, slug: String(sessionID), directory, title: "components", version: "test" })
        .run()
        .pipe(Effect.orDie)
      return yield* run({ databasePath, directory, sessionID })
    }).pipe(Effect.provide(Layer.merge(database, registry)), Effect.scoped),
  )
}

describe("SessionComponentRegistry", () => {
  test("keeps kernel names closed and tool names owned", () =>
    withRegistry([Goal], ({ sessionID }) =>
      Effect.gen(function* () {
        const registry = yield* SessionComponentRegistry.Service
        yield* registry.registerTool(AttemptStep)
        expect(registry.definitions().map((item) => item.kind)).toEqual(["goal", "tool/planner/step"])
        expect(registry.definitions()[0]?.schema).toBeDefined()

        const duplicate = yield* registry.registerTool(AttemptStep).pipe(Effect.flip)
        expect(duplicate).toBeInstanceOf(SessionComponentRegistry.RegistryError)

        const stolen = yield* registry
          .registerTool({ ...AttemptStep, kind: "goal", owner: "tool/planner" } as never)
          .pipe(Effect.flip)
        expect(stolen).toBeInstanceOf(SessionComponentRegistry.RegistryError)
        const malformed = yield* registry
          .registerTool({ ...AttemptStep, kind: "tool/Planner/step" } as never)
          .pipe(Effect.flip)
        expect(malformed).toBeInstanceOf(SessionComponentRegistry.RegistryError)
        const unversioned = yield* registry
          .registerTool({ ...AttemptStep, kind: "tool/planner/unversioned", version: 0 } as never)
          .pipe(Effect.flip)
        expect(unversioned).toBeInstanceOf(SessionComponentRegistry.RegistryError)

        const absent = yield* registry.get({ sessionID, kind: Goal.kind })
        expect(absent).toBeUndefined()
        const unknown = yield* registry.get({ sessionID, kind: "tool/missing/kind" }).pipe(Effect.flip)
        expect(unknown).toBeInstanceOf(SessionComponentRegistry.UnknownKindError)
      }),
    ))

  test("🔴 a write with an unknown key is REFUSED, not silently dropped", () =>
    withRegistry([Goal], ({ sessionID }) =>
      Effect.gen(function* () {
        const registry = yield* SessionComponentRegistry.Service
        // Effect Schema's default is `onExcessProperty: "ignore"`, so this used to decode to
        // `{text: "ship"}`, store it, and hand back an Entry the caller reads as confirmation of
        // the whole write. On `tuning` — ten switches an agent sets BY NAME — one transposed letter
        // was a no-op reported as success, and the agent's next read looks like a broken instance
        // rather than a typo. Both entry points must refuse it.
        const typo = { text: "ship", tetx: "ship" }
        const written = yield* registry.put({ sessionID, kind: Goal.kind, value: typo }).pipe(Effect.flip)
        expect(written).toBeInstanceOf(SessionComponentRegistry.InvalidValueError)
        const validated = yield* registry.validate({ sessionID, kind: Goal.kind, value: typo }).pipe(Effect.flip)
        expect(validated).toBeInstanceOf(SessionComponentRegistry.InvalidValueError)
        // And nothing landed — a refusal that half-wrote would be worse than the silent drop.
        expect(yield* registry.get({ sessionID, kind: Goal.kind })).toBeUndefined()

        // The negative control: the same value WITHOUT the stray key still writes. Otherwise this
        // test would pass just as well against a decode that refuses everything.
        const clean = yield* registry.put({ sessionID, kind: Goal.kind, value: { text: "ship" } })
        expect(clean.value).toEqual({ text: "ship" })
      }),
    ))

  test("🔴 replaceSet validates every item before writing any, and swaps the whole set at once", () =>
    withRegistry([SessionComponentRegistry.PlanDefinition], ({ sessionID }) =>
      Effect.gen(function* () {
        const registry = yield* SessionComponentRegistry.Service
        const step = (position: number, text: string) => ({
          id: SessionComponentRegistry.planComponentID(position),
          value: { position, text, status: "pending", verdict: null },
        })
        yield* registry.replaceSet({ sessionID, kind: "plan", items: [step(0, "read"), step(1, "edit")] })
        expect(
          (yield* registry.list({ sessionID, kind: "plan" })).map((e) => (e.value as { text: string }).text),
        ).toEqual(["read", "edit"])
        // One bad item (a step under the wrong id) refuses the WHOLE replacement — the raw SQL this
        // replaced would have written it, and the read would have refused it later, far from here.
        const refused = yield* registry
          .replaceSet({ sessionID, kind: "plan", items: [step(0, "read"), { ...step(1, "edit"), id: "step-9" }] })
          .pipe(Effect.flip)
        expect(refused).toBeInstanceOf(SessionComponentRegistry.RegistryError)
        expect(
          (yield* registry.list({ sessionID, kind: "plan" })).map((e) => (e.value as { text: string }).text),
        ).toEqual(["read", "edit"])
        // A stray key is refused exactly as `put` refuses it.
        const typo = yield* registry
          .replaceSet({
            sessionID,
            kind: "plan",
            items: [{ ...step(0, "read"), value: { ...step(0, "read").value, tetx: 1 } }],
          })
          .pipe(Effect.flip)
        expect(typo).toBeInstanceOf(SessionComponentRegistry.InvalidValueError)
        // The empty set clears it.
        yield* registry.replaceSet({ sessionID, kind: "plan", items: [] })
        expect(yield* registry.list({ sessionID, kind: "plan" })).toEqual([])
      }),
    ))

  test("replaceSet refuses a singleton kind — that is what put is for", () =>
    withRegistry([Goal], ({ sessionID }) =>
      Effect.gen(function* () {
        const registry = yield* SessionComponentRegistry.Service
        const refused = yield* registry
          .replaceSet({ sessionID, kind: Goal.kind, items: [{ id: "", value: { text: "x" } }] })
          .pipe(Effect.flip)
        expect(refused).toBeInstanceOf(SessionComponentRegistry.RegistryError)
      }),
    ))

  test("decodes singleton values on both sides of storage and cascades with the session", () =>
    withRegistry([Goal], ({ sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const registry = yield* SessionComponentRegistry.Service

        const invalid = yield* registry.put({ sessionID, kind: Goal.kind, value: { text: "" } }).pipe(Effect.flip)
        expect(invalid).toBeInstanceOf(SessionComponentRegistry.InvalidValueError)
        const withID = yield* registry
          .put({ sessionID, kind: Goal.kind, id: "extra", value: { text: "x" } })
          .pipe(Effect.flip)
        expect(withID).toBeInstanceOf(SessionComponentRegistry.RegistryError)

        const written = yield* registry.put({ sessionID, kind: Goal.kind, value: { text: "ship C3" } })
        expect(written).toMatchObject({ value: { text: "ship C3" }, stale: false, lifetime: "entity" })
        expect(yield* registry.get({ sessionID, kind: Goal.kind })).toMatchObject({ value: { text: "ship C3" } })

        yield* db.delete(SessionTable).run().pipe(Effect.orDie)
        const rows = yield* db.select().from(SessionComponentTable).all().pipe(Effect.orDie)
        expect(rows).toEqual([])
      }),
    ))

  test("enforces set ids and reports attempt and bounded staleness without deleting evidence", () =>
    withRegistry([], ({ sessionID }) =>
      Effect.gen(function* () {
        const registry = yield* SessionComponentRegistry.Service
        yield* registry.registerTool(AttemptStep)
        yield* registry.registerTool(Lease)
        const attempt = { attemptID: "att_live", generation: 2 }

        const missingID = yield* registry
          .put({ sessionID, kind: AttemptStep.kind, value: { text: "one", done: false }, attempt })
          .pipe(Effect.flip)
        expect(missingID).toBeInstanceOf(SessionComponentRegistry.RegistryError)
        const missingFence = yield* registry
          .put({ sessionID, kind: AttemptStep.kind, id: "b", value: { text: "two", done: false } })
          .pipe(Effect.flip)
        expect(missingFence).toBeInstanceOf(SessionComponentRegistry.RegistryError)

        yield* registry.put({
          sessionID,
          kind: AttemptStep.kind,
          id: "b",
          value: { text: "two", done: false },
          attempt,
        })
        yield* registry.put({
          sessionID,
          kind: AttemptStep.kind,
          id: "a",
          value: { text: "one", done: true },
          attempt,
        })
        const current = yield* registry.list({ sessionID, kind: AttemptStep.kind, attempt })
        expect(current.map((entry) => String(entry.id))).toEqual(["a", "b"])
        expect(current.every((entry) => !entry.stale)).toBe(true)
        const stale = yield* registry.get({
          sessionID,
          kind: AttemptStep.kind,
          id: "a",
          attempt: { attemptID: "att_live", generation: 3 },
        })
        expect(stale).toMatchObject({ stale: true, staleReason: "attempt-mismatch" })

        yield* registry.put({
          sessionID,
          kind: Lease.kind,
          value: { surface: ":99" },
          expiresAt: 100,
        })
        expect(yield* registry.get({ sessionID, kind: Lease.kind, now: 99 })).toMatchObject({ stale: false })
        expect(yield* registry.get({ sessionID, kind: Lease.kind, now: 100 })).toMatchObject({
          stale: true,
          staleReason: "expired",
        })
        expect(yield* registry.remove({ sessionID, kind: AttemptStep.kind, id: "a" })).toBe(true)
        expect(yield* registry.remove({ sessionID, kind: AttemptStep.kind, id: "a" })).toBe(false)
      }),
    ))

  test("fences the latest screen observation to the execution attempt", () =>
    withRegistry([SessionComponentRegistry.ObservationDefinition], ({ sessionID }) =>
      Effect.gen(function* () {
        const registry = yield* SessionComponentRegistry.Service
        const value = {
          handle: "/tmp/frame.png",
          capturedAt: 123,
          digest: "a".repeat(64),
          region: { x: 1200, y: 760, width: 80, height: 40 },
        }
        const missingFence = yield* registry.put({ sessionID, kind: "observation", value }).pipe(Effect.flip)
        expect(missingFence).toBeInstanceOf(SessionComponentRegistry.RegistryError)
        const badDigest = yield* registry
          .put({
            sessionID,
            kind: "observation",
            value: { ...value, digest: "not-a-sha256" },
            attempt: { attemptID: "exe_capture", generation: 4 },
          })
          .pipe(Effect.flip)
        expect(badDigest).toBeInstanceOf(SessionComponentRegistry.InvalidValueError)

        const attempt = { attemptID: "exe_capture", generation: 4 }
        const written = yield* registry.put({ sessionID, kind: "observation", value, attempt })
        expect(written).toMatchObject({ value, attempt, lifetime: "attempt", stale: false })
        expect(yield* registry.get({ sessionID, kind: "observation" })).toMatchObject({
          stale: true,
          staleReason: "attempt-missing",
        })
        expect(
          yield* registry.get({
            sessionID,
            kind: "observation",
            attempt: { attemptID: "exe_capture", generation: 5 },
          }),
        ).toMatchObject({ stale: true, staleReason: "attempt-mismatch" })
      }),
    ))

  test("keeps goal durable and makes plan verification kernel-owned", () =>
    withRegistry([SessionComponentRegistry.GoalDefinition, SessionComponentRegistry.PlanDefinition], ({ sessionID }) =>
      Effect.gen(function* () {
        const registry = yield* SessionComponentRegistry.Service
        yield* registry.put({ sessionID, kind: "goal", value: { text: "Ship the verified milestone" } })
        expect(yield* registry.get({ sessionID, kind: "goal" })).toMatchObject({
          value: { text: "Ship the verified milestone" },
          lifetime: "entity",
        })

        const draft = { position: 0, text: "Run the focused tests", status: "in_progress" as const, verdict: null }
        yield* registry.put({ sessionID, kind: "plan", id: "step-00000000", value: draft })
        const forged = yield* registry
          .put({
            sessionID,
            kind: "plan",
            id: "step-00000000",
            value: {
              ...draft,
              status: "completed",
              verdict: { check: "bun test", passedAt: 123, evidence: "trust me" },
            },
          })
          .pipe(Effect.flip)
        expect(forged).toBeInstanceOf(SessionComponentRegistry.RegistryError)

        yield* registry.put({
          sessionID,
          kind: "plan",
          id: "step-00000000",
          system: true,
          value: {
            ...draft,
            status: "completed",
            verdict: { check: "bun test", passedAt: 123, evidence: "exit 0" },
          },
        })
        expect(yield* registry.list({ sessionID, kind: "plan" })).toMatchObject([
          {
            id: "step-00000000",
            value: { status: "completed", verdict: { check: "bun test", passedAt: 123, evidence: "exit 0" } },
          },
        ])
      }),
    ))

  test("names undecodable and unmigrated stored versions instead of rendering them empty", () =>
    withRegistry([Goal], ({ sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const registry = yield* SessionComponentRegistry.Service
        const now = Date.now()
        yield* db
          .insert(SessionComponentTable)
          .values({
            session_id: sessionID,
            kind: Goal.kind,
            component_id: "",
            schema_version: 0,
            lifetime: "entity",
            value: { text: "old" },
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.orDie)
        const error = yield* registry.get({ sessionID, kind: Goal.kind }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(SessionComponentRegistry.StoredValueError)
        expect((error as SessionComponentRegistry.StoredValueError).message).toContain("No migration")

        yield* db
          .update(SessionComponentTable)
          .set({ schema_version: 1, value: { text: 42 } })
          .where(
            and(
              eq(SessionComponentTable.session_id, sessionID),
              eq(SessionComponentTable.kind, Goal.kind),
              eq(SessionComponentTable.component_id, ""),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        const corrupt = yield* registry.get({ sessionID, kind: Goal.kind }).pipe(Effect.flip)
        expect(corrupt).toBeInstanceOf(SessionComponentRegistry.StoredValueError)
      }),
    ))

  test("runs an explicit schema migration and revalidates its output", () => {
    const GoalV2 = SessionComponentRegistry.kernelDefinition({
      ...Goal,
      version: 2,
      codec: Schema.Struct({ text: Schema.NonEmptyString, source: Schema.Literal("migrated") }),
      migrate: ({ version, value }) =>
        version === 1 && typeof value === "object" && value !== null && "label" in value
          ? Effect.succeed({ text: String(value.label), source: "migrated" as const })
          : Effect.die("unsupported fixture version"),
    })
    return withRegistry([GoalV2], ({ sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const registry = yield* SessionComponentRegistry.Service
        const now = Date.now()
        yield* db
          .insert(SessionComponentTable)
          .values({
            session_id: sessionID,
            kind: GoalV2.kind,
            component_id: "",
            schema_version: 1,
            lifetime: "entity",
            value: { label: "old goal" },
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.orDie)
        expect(yield* registry.get({ sessionID, kind: GoalV2.kind })).toMatchObject({
          version: 1,
          value: { text: "old goal", source: "migrated" },
        })
      }),
    )
  })

  test("a component written by a disposable OS process is visible to the host", () =>
    withRegistry([], ({ databasePath, sessionID }) =>
      Effect.gen(function* () {
        const registry = yield* SessionComponentRegistry.Service
        const Marker = SessionComponentRegistry.toolDefinition("fixture", {
          name: "marker",
          description: "Cross-process marker",
          cardinality: "singleton",
          lifetime: "entity",
          version: 1,
          codec: Schema.Struct({ text: Schema.NonEmptyString }),
        })
        yield* registry.registerTool(Marker)
        expect(yield* registry.get({ sessionID, kind: Marker.kind })).toBeUndefined()

        const fixture = path.join(import.meta.dir, "fixtures/session-component-worker.ts")
        const worker = Bun.spawn([process.execPath, fixture, databasePath, sessionID], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NOVACLAW_DB: databasePath },
        })
        const [exitCode, stderr] = yield* Effect.promise(() =>
          Promise.all([worker.exited, new Response(worker.stderr).text()]),
        )
        expect(exitCode, stderr).toBe(0)
        expect(yield* registry.get({ sessionID, kind: Marker.kind })).toMatchObject({
          value: { text: "written by the disposable worker" },
        })
      }),
    ))
})
