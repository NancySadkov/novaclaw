import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { RuntimeSettingTable } from "@novaclaw/core/settings-config/sql"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { testEffect } from "./lib/effect"

// Two invariants of the config write path, both about the instance's own incoming API token:
//
//  1. a write that ROLLS BACK must not change what the HTTP authorization path authenticates
//     against — and specifically must never leave it with nothing, which is an OPEN API;
//  2. a write must never overwrite a password envelope this instance could not open, because that
//     ciphertext is the only thing a restored `credential.key` can still recover.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      AgentConfigStore.node,
      CatalogStore.node,
      CommandConfigStore.node,
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
      SkillConfigStore.node,
    ]),
  ),
)

const decodeInfo = Schema.decodeUnknownSync(Config.Info)

const COMMITTED = "the-committed-password"

/** The envelope field the cipher writes, and a value shaped like one that opens under no key. */
const ENVELOPE_FIELD = "$novaclawEncrypted"
const UNOPENABLE = "nc1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:CCCCCCCCCCCCCCCCCCCCCCCCCC"

/** The stored `server` row exactly as it sits on disk — no reveal, no stand-in. */
const storedServer = Effect.fn("storedServer")(function* () {
  const { db } = yield* Database.Service
  const row = yield* db.select().from(RuntimeSettingTable).where(eq(RuntimeSettingTable.key, "server")).get()
  return row?.value as { port?: number; password?: unknown } | undefined
})

/**
 * Put an unopenable envelope where the password is, the way a partial restore or an AV quarantine
 * of `credential.key` leaves an instance that HAD been running.
 */
const damageThePasswordEnvelope = Effect.fn("damageThePasswordEnvelope")(function* () {
  const { db } = yield* Database.Service
  yield* db
    .update(RuntimeSettingTable)
    .set({ value: { port: 4096, password: { [ENVELOPE_FIELD]: UNOPENABLE } } })
    .where(eq(RuntimeSettingTable.key, "server"))
    .run()
})

describe("a config write that fails must not change what the API authenticates against", () => {
  /**
   * 🔴 The mirror case: the process accepts a password that was never stored.
   *
   * The failure is injected into `skills`, the LAST arm `applyToStores` runs, so every earlier
   * store — the settings loop that writes `server` — has already written when it lands. ⚠️ If a new
   * list arm is ever appended after `skills`, move the injection onto it (same note as
   * `config-store-write.test.ts`) or this stops testing "last".
   *
   * A/B: restore `if (key === "server") serverPassword = passwordOf(value)` in
   * `SettingsConfigStore.set` and the last assertion reads `"never-stored"`.
   */
  it.effect("🔴 a rolled-back apply leaves the live incoming password on the COMMITTED value", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const skills = yield* SkillConfigStore.Service
      yield* store.set("server", { port: 4096, password: COMMITTED })
      expect(yield* store.serverPassword()).toBe(COMMITTED)

      const failingSkills = SkillConfigStore.Service.of({
        sources: () => skills.sources(),
        removeSource: (source) => skills.removeSource(source),
        isEmpty: () => skills.isEmpty(),
        addSource: () => Effect.die(new Error("skill store write failed")),
      })

      const exit = yield* ConfigStoreWrite.apply(
        decodeInfo({ server: { password: "never-stored" }, skills: ["/replacement/skills"] }),
      ).pipe(Effect.provideService(SkillConfigStore.Service, failingSkills), Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      // SQLite rolled back, so the row still holds the committed password…
      expect(yield* storedServer()).toEqual({ port: 4096, password: COMMITTED })
      // …and so does the value handed to the authorization path on the next request. It used to
      // hold `"never-stored"`, i.e. the instance authenticated against a password no client had
      // been given and no surface could show them.
      expect(yield* store.serverPassword()).toBe(COMMITTED)
    }),
  )

  /**
   * 🔴 THE defect: a refused remove leaves the API OPEN until restart.
   *
   * `remove` executes each path in turn and only fails after the loop, so path 1 has already
   * written when path 2 is refused. The transaction rolls back; a cached live password did not.
   *
   * The consequence is not "the password is stale". `ServerAuth.resolve`
   * (`packages/server/src/auth.ts`) takes this value as its `stored` argument and, when it is
   * absent and no `NOVACLAW_SERVER_PASSWORD` is in the environment — the ordinary desktop and
   * `novaclaw serve` shape — returns `source: "open"`, at which point `required(config)` is false
   * and the middleware accepts EVERY request unauthenticated, LAN included, while `GET /config`
   * still shows a password. Core cannot import `@novaclaw/server` (the dependency runs the other
   * way), so the assertion is on the input that decides it: absent here IS `source: "open"` there.
   *
   * A/B: restore `if (key === "server") serverPassword = undefined` in `SettingsConfigStore.remove`
   * and `live` comes back `undefined`.
   */
  it.effect("🔴 a refused remove does not leave the instance OPEN", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("server", { port: 4096, password: COMMITTED })

      const exit = yield* ConfigStoreWrite.remove([
        ["server", "password"],
        // Never set, so this path is refused — and a refused path refuses the WHOLE remove.
        ["shell"],
      ]).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      expect(yield* storedServer()).toEqual({ port: 4096, password: COMMITTED })
      const live = yield* store.serverPassword()
      expect(live).not.toBeUndefined()
      expect(live).toBe(COMMITTED)
    }),
  )
})

describe("a write must never overwrite a password envelope this instance cannot open", () => {
  /**
   * 🔴 The destruction path. The instance is in the damaged state, is TELLING the operator so
   * through `unreadable()`, and is asking them to restore `credential.key`. They change the port
   * instead — and every config write reads `all()`, merges the patch onto that snapshot and writes
   * it back, so the per-boot random stand-in that `all()` returns for the unreadable password went
   * straight over the ciphertext. Restoring the key afterwards recovered nothing.
   *
   * A/B: drop the `preserveSecrets` call from `SettingsConfigStore.set` and the stored password
   * comes back as the stand-in string instead of the envelope.
   */
  it.effect("🔴 a `server` patch applied while DAMAGED leaves the ciphertext byte-identical", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("server", { port: 4096, password: "placeholder" })
      yield* damageThePasswordEnvelope()

      // Boot the damaged state, and capture the exact bytes this instance hands out in place of the
      // password — the thing that used to land on top of the envelope.
      const standIn = ((yield* store.all()).server as { password: string }).password
      expect(standIn).not.toBe("placeholder")
      expect(standIn.length).toBeGreaterThanOrEqual(32)
      expect(yield* store.unreadable()).toEqual([{ path: "server.password" }])

      yield* ConfigStoreWrite.apply(decodeInfo({ server: { port: 4097 } }))

      const value = yield* storedServer()
      // ⚠️ Half a control otherwise: a test that passed because the patch never landed would prove
      // nothing at all. The port really moved, in the same write.
      expect(value?.port).toBe(4097)
      expect((value?.password as Record<string, string>)[ENVELOPE_FIELD]).toBe(UNOPENABLE)
      expect(JSON.stringify(value)).not.toContain(standIn)
      // Still damaged, still recoverable, still saying so.
      expect(yield* store.unreadable()).toEqual([{ path: "server.password" }])
    }),
  )

  /** The second chokepoint: `removeOne`'s nested prune is read → prune → write back, same hole. */
  it.effect("🔴 a nested `server` REMOVE while damaged leaves the ciphertext byte-identical", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("server", { port: 4096, password: "placeholder" })
      yield* damageThePasswordEnvelope()
      const standIn = ((yield* store.all()).server as { password: string }).password

      yield* ConfigStoreWrite.remove([["server", "port"]])

      const value = yield* storedServer()
      expect(value?.port).toBeUndefined() // the removal really happened
      expect((value?.password as Record<string, string>)[ENVELOPE_FIELD]).toBe(UNOPENABLE)
      expect(JSON.stringify(value)).not.toContain(standIn)
    }),
  )

  /**
   * 🔴 The guard is RECOGNITION, not refusal — the half that makes it safe to have.
   *
   * Setting a new password while damaged IS the repair an operator (or the agent repairing the
   * instance for them) reaches for. A guard that refused every write to a damaged path would brick
   * exactly the person it is protecting.
   */
  it.effect("🔴 a NEW password still lands while damaged, and clears the damage", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("server", { port: 4096, password: "placeholder" })
      yield* damageThePasswordEnvelope()
      yield* store.all()

      yield* ConfigStoreWrite.apply(decodeInfo({ server: { password: "repaired-by-the-operator" } }))

      expect((yield* storedServer())?.password).toBe("repaired-by-the-operator")
      expect(yield* store.serverPassword()).toBe("repaired-by-the-operator")
      expect(yield* store.unreadable()).toEqual([])
    }),
  )
})
