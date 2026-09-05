import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { Cause, Effect, Exit, Layer } from "effect"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { ConfigStoreFactory } from "@novaclaw/core/config-store-factory"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { ProviderCapabilityStore } from "@novaclaw/core/provider-capability-store"
import { RuntimeSettingTable } from "@novaclaw/core/settings-config/sql"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { ModelRouteProfileStore } from "@novaclaw/core/session/runner/model-route-profile-store"
import { tmpdir } from "./fixture/tmpdir"

/**
 * ⚠️ `expect(Exit.isFailure(x)).toBe(true)` asserts at RUNTIME and narrows nothing for the
 * compiler, so the `.cause` read after one is a type error. This asserts and narrows in one step.
 */
function failureOf<A, E>(exit: Exit.Exit<A, E>): Cause.Cause<E> {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure, got a success")
  return exit.cause
}

/**
 * **A key/value row is one whole value, so every writer that changes PART of it is a
 * read-modify-write — and two of them lose one another's change with nothing failing.**
 *
 * Two stores keep a whole map under a single settings key: what an endpoint was measured to support
 * (`provider_capability`) and what a model route was calibrated to (`provider_route_profile`). The
 * loss is silent by construction — the surviving write is a perfectly valid map, just one entry
 * short — so the next turn re-probes at three completions' cost, or falls back to a channel nobody
 * measured and reports it as fact.
 *
 * ⚠️ **The interleaving here is DRIVEN, not hoped for**, and the control below proves the poison
 * bites: an ungated read-modify-write over the very same store ends with ONE entry where eight were
 * written. A test that only asserted the final total would pass under either implementation, because
 * a run that never suspends produces the same total as a run that is properly serialised.
 *
 * ⚠️ **And that is not a hypothetical suspension.** The real `SettingsConfigStore.all()` decrypts
 * envelopes, emits log events and writes plaintext back on the way through; `settings.set` goes
 * through `preserveSecrets`, which reads a row. Today every SQLite statement underneath resolves
 * synchronously and an uncontended Effect permit does not yield, so the current stack may in
 * practice never interleave — which makes the atomicity an accident of the driver rather than a
 * property either store states. These tests assert the property.
 */

/**
 * The seam both stores are written against, with ONE suspension inserted at the read.
 *
 * `Effect.yieldNow` is the smallest honest stand-in for anything the settings path does that is not
 * a synchronous SQLite call — and it is inserted at the read, which is where a read-modify-write
 * splits. The map is copied out, exactly as `SettingsConfigStore.all()` hands back a fresh object,
 * so a writer holding a stale snapshot really is holding a stale snapshot.
 */
const suspendingSettings = (values: Record<string, unknown>) =>
  Layer.succeed(
    SettingsConfigStore.Service,
    SettingsConfigStore.Service.of({
      all: () => Effect.yieldNow.pipe(Effect.as({ ...values })),
      set: (setting, value) => Effect.sync(() => void (values[setting] = value)),
      update: (setting, change) => Effect.sync(() => void (values[setting] = change(values[setting]))),
      remove: (setting) => Effect.sync(() => void delete values[setting]),
      serverPassword: () => Effect.succeed(undefined),
      unreadable: () => Effect.succeed([]),
      isEmpty: () => Effect.succeed(Object.keys(values).length === 0),
    }),
  )

const entry = (modelID: string) => ({
  choice: "prompted" as const,
  rationale: `measured ${modelID}`,
  measuredAt: 1_700_000_000_000,
  fingerprint: `fp-${modelID}`,
  endpoint: "http://h/v1",
})

const scope = (routeID: string) => ({
  providerID: "local",
  wireModelID: "model",
  serverKey: "http://127.0.0.1:8000/v1",
  routeID,
  protocolID: "openai",
})

const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]

describe("concurrent writers of one settings row", () => {
  test("🔴 the CONTROL on the control: an ungated read-modify-write over this seam loses seven of eight", async () => {
    // The exact shape both stores used to have, inline, so a green arm below cannot be a green
    // arm because nothing ever interleaved.
    const values: Record<string, unknown> = {}
    await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsConfigStore.Service
        yield* Effect.all(
          MODELS.map((modelID) =>
            Effect.gen(function* () {
              const stored = (yield* settings.all())["provider_capability"] as Record<string, unknown> | undefined
              yield* settings.set("provider_capability", { ...stored, [modelID]: entry(modelID) })
            }),
          ),
          { concurrency: "unbounded" },
        )
      }).pipe(Effect.provide(suspendingSettings(values))),
    )
    // ONE survivor out of eight. Which one wins depends on the scheduler; that seven are gone does not.
    expect(Object.keys(values["provider_capability"] as Record<string, unknown>).length).toBe(1)
  })

  test("provider capability: eight concurrent puts keep eight verdicts", async () => {
    const values: Record<string, unknown> = {}
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ProviderCapabilityStore.Service
        yield* Effect.all(
          MODELS.map((modelID) => store.put("local", modelID, entry(modelID))),
          { concurrency: "unbounded" },
        )
        return yield* store.all()
      }).pipe(Effect.provide(ProviderCapabilityStore.layer.pipe(Layer.provide(suspendingSettings(values))))),
    )
    expect(Object.keys(stored).sort()).toEqual(MODELS.map((modelID) => `local/${modelID}`).sort())
    for (const modelID of MODELS) expect(stored[`local/${modelID}`]?.rationale).toBe(`measured ${modelID}`)
  })

  test("provider capability: the SEQUENTIAL control is unchanged, and a second key is untouched", async () => {
    const values: Record<string, unknown> = { provider_route_profile: { untouched: { promptRatios: [1.5] } } }
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ProviderCapabilityStore.Service
        for (const modelID of MODELS) yield* store.put("local", modelID, entry(modelID))
        return yield* store.all()
      }).pipe(Effect.provide(ProviderCapabilityStore.layer.pipe(Layer.provide(suspendingSettings(values))))),
    )
    expect(Object.keys(stored).sort()).toEqual(MODELS.map((modelID) => `local/${modelID}`).sort())
    // The store rewrites its OWN key whole; nothing else in the settings row set may move.
    expect(values["provider_route_profile"]).toEqual({ untouched: { promptRatios: [1.5] } })
  })

  test("model route profile: eight concurrent observations keep eight calibrations", async () => {
    const values: Record<string, unknown> = { provider_capability: { "local/keep": entry("keep") } }
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ModelRouteProfileStore.Service
        yield* Effect.all(
          MODELS.map((routeID) =>
            store.observe(scope(routeID), { estimatedTokens: 100, reportedTokens: 110 }, undefined),
          ),
          { concurrency: "unbounded" },
        )
        return yield* Effect.all(MODELS.map((routeID) => store.read(scope(routeID))))
      }).pipe(Effect.provide(ModelRouteProfileStore.layer.pipe(Layer.provide(suspendingSettings(values))))),
    )
    expect(stored.filter((profile) => profile !== undefined).length).toBe(MODELS.length)
    // …and the other store's key rode through untouched.
    expect(values["provider_capability"]).toEqual({ "local/keep": entry("keep") })
  })

  test("model route profile: the SEQUENTIAL control is unchanged", async () => {
    const values: Record<string, unknown> = {}
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ModelRouteProfileStore.Service
        for (const routeID of MODELS)
          yield* store.observe(scope(routeID), { estimatedTokens: 100, reportedTokens: 110 }, undefined)
        return yield* Effect.all(MODELS.map((routeID) => store.read(scope(routeID))))
      }).pipe(Effect.provide(ModelRouteProfileStore.layer.pipe(Layer.provide(suspendingSettings(values))))),
    )
    expect(stored.filter((profile) => profile !== undefined).length).toBe(MODELS.length)
  })
})

// ── the primitive that made every caller invent the same defect ─────────────────────────────────
//
// Both stores above had to hand-roll a read-modify-write because `KeyValueStore` offered `set` and
// nothing else — a missing operation on a shared primitive is what makes two independent authors
// write the same bug. `update` is that operation, and it runs the change inside `BEGIN IMMEDIATE`,
// which is the only lock that also holds across processes.
const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()

const onStore = <A, E>(
  filename: string,
  busyTimeoutMs: number,
  body: (store: ConfigStoreFactory.KeyValueStore<Record<string, number>>) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL").pipe(Effect.ignore)
      yield* db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
      yield* DatabaseMigration.apply(db).pipe(Effect.ignore)
      return yield* body(
        ConfigStoreFactory.makeKeyValueStore<Record<string, number>>({
          db,
          table: RuntimeSettingTable,
          keyColumn: RuntimeSettingTable.key,
        }),
      )
    }).pipe(Effect.provide(sqliteLayer({ filename })), Effect.scoped),
  )

const withKeyValueStore = async <A>(
  body: (store: ConfigStoreFactory.KeyValueStore<Record<string, number>>) => Effect.Effect<A>,
): Promise<A> => {
  const exit = await onStore(":memory:", 5_000, body)
  if (!Exit.isSuccess(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

describe("the key/value primitive's atomic update", () => {
  test("`update` composes on what is stored, and a second key is unaffected", async () => {
    const [target, other] = await withKeyValueStore((store) =>
      Effect.gen(function* () {
        yield* store.set("other", { keep: 1 })
        for (const index of [0, 1, 2, 3, 4, 5, 6, 7])
          yield* store.update("counts", (current) => ({ ...current, [`k${index}`]: index }))
        return [yield* store.get("counts"), yield* store.get("other")] as const
      }),
    )
    expect(Object.keys(target ?? {}).sort()).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"])
    expect(other).toEqual({ keep: 1 })
  })

  test("concurrent `update`s on one key lose nothing", async () => {
    const stored = await withKeyValueStore((store) =>
      Effect.gen(function* () {
        yield* Effect.all(
          MODELS.map((name, index) => store.update("counts", (current) => ({ ...current, [name]: index }))),
          { concurrency: "unbounded" },
        )
        return yield* store.get("counts")
      }),
    )
    expect(Object.keys(stored ?? {}).sort()).toEqual([...MODELS].sort())
  })

  test("`setIfAbsent` still asks about the ROW, not the value — and now does so atomically", async () => {
    const [seeded, kept] = await withKeyValueStore((store) =>
      Effect.gen(function* () {
        // Concurrent seeds of one absent key: exactly one write survives, and it is a seed value.
        yield* Effect.all(
          [0, 1, 2, 3].map((index) => store.setIfAbsent("seed", { attempt: index })),
          { concurrency: "unbounded" },
        )
        const seeded = yield* store.get("seed")
        // An empty value is still a value the user chose; `setIfAbsent` must not overwrite it.
        yield* store.set("chosen", {})
        yield* store.setIfAbsent("chosen", { replaced: 1 })
        return [seeded, yield* store.get("chosen")] as const
      }),
    )
    expect(Object.keys(seeded ?? {})).toEqual(["attempt"])
    expect(kept).toEqual({})
  })

  test("🔴 `update` never runs its change on a snapshot ANOTHER PROCESS can move", async () => {
    // ⚠️ This is the arm that pins the transaction, and it is the only one that can. Measured
    // 2026-09-02: with `readModifyWrite`'s transaction removed entirely, every other test on this
    // page stays green — `bun:sqlite` resolves each statement synchronously and an uncontended
    // Effect permit does not yield, so a select+upsert pair in THIS process never suspends. The
    // atomicity would therefore be an accident of the driver rather than something the store
    // states, and a second NovaClaw on the same file is the case where the accident runs out.
    //
    // The observable is not the outcome — a blocked read and a blocked write both fail — it is
    // WHETHER THE DECISION WAS EVER MADE. Under `BEGIN IMMEDIATE` the lock is taken before
    // anything is read, so `change` is not called at all; without it, `change` runs on a snapshot
    // the lock holder is about to invalidate.
    await using dir = await tmpdir()
    const file = path.join(dir.path, "settings.db")
    expect(Exit.isSuccess(await onStore(file, 5_000, (store) => store.set("counts", { seeded: 1 })))).toBe(true)

    const holder = new BunSqlite(file)
    holder.run("PRAGMA busy_timeout = 0")
    holder.run("BEGIN IMMEDIATE")
    let decided = 0
    let exit: Exit.Exit<void, unknown>
    try {
      exit = await onStore(file, 50, (store) =>
        store.update("counts", (current) => {
          decided += 1
          return { ...current, added: 2 }
        }),
      )
    } finally {
      try {
        holder.run("ROLLBACK")
      } finally {
        holder.close()
      }
    }

    expect(Cause.pretty(failureOf(exit))).toMatch(/SQLITE_BUSY|database is locked/i)
    expect(decided).toBe(0)

    // The control: with nobody holding the lock the very same call goes through, and it composes
    // on what was already stored rather than replacing it.
    const after = await withKeyValueStoreOn(file, (store) =>
      Effect.gen(function* () {
        yield* store.update("counts", (current) => ({ ...current, added: 2 }))
        return yield* store.get("counts")
      }),
    )
    expect(after).toEqual({ seeded: 1, added: 2 })
  })
})

const withKeyValueStoreOn = async <A>(
  file: string,
  body: (store: ConfigStoreFactory.KeyValueStore<Record<string, number>>) => Effect.Effect<A>,
): Promise<A> => {
  const exit = await onStore(file, 5_000, body)
  if (!Exit.isSuccess(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}
