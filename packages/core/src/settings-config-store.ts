export * as SettingsConfigStore from "./settings-config-store"

import { randomBytes } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { RuntimeSettingTable } from "./settings-config/sql"
import { CredentialCipher } from "./credential-cipher"
import { LogSettings } from "./observability/log-settings"
import { Log } from "@novaclaw/schema/log"

// Config→SQLite step 6: the instance-wide, SQLite-backed source of truth for runtime settings.
// Global so every directory — including the shared scratch dir — resolves the same settings.
// Readers stay untouched: the Config layer appends ONE synthetic document holding these values to
// `entries()`, so every `Config.latest(entries, key)` reader picks them up (findLast = most
// specific wins). jsonc becomes import/export only: the Config layer seeds this store from the
// location's config documents on first boot (transitional — removed in migration step 8).
//
// `runtime_setting` is one of the three byte-identical `(key text primary key, value text json)`
// tables — the other two are `catalog_setting` and `agent_setting`, which back the default-model
// and default-agent refs. All three are served by `ConfigStoreFactory.makeKeyValueStore`. ⚠️ That
// is the TYPESCRIPT collapse only: the three tables are still three tables, because merging them
// physically is a schema change and needs a migration.
export interface Interface {
  /** Every stored setting, keyed by the top-level config key. */
  readonly all: () => Effect.Effect<Record<string, unknown>>
  /** Insert or replace one setting's whole value (latest() semantics — no layers). */
  readonly set: (key: string, value: unknown) => Effect.Effect<void>
  /** Remove one stored setting (the key falls back to config documents until step 8). */
  readonly remove: (key: string) => Effect.Effect<void>
  /** True when no settings are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SettingsConfigStore") {}

/**
 * The stand-in for a secret that could not be decrypted (NC-REL-030).
 *
 * Random per call, never a constant: a fixed sentinel would be a password published in this file,
 * and it could collide with somebody's real one. 32 bytes so no comparison against it can succeed.
 */
const unreadableSecret = () => randomBytes(32).toString("base64url")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const cipher = yield* CredentialCipher.Service
    const settings = ConfigStoreFactory.makeKeyValueStore({
      db,
      table: RuntimeSettingTable,
      keyColumn: RuntimeSettingTable.key,
    })

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
    const secretAad = (path: string) => `novaclaw:runtime-setting:${path}`
    const protectSecret = (value: unknown, path: string): unknown =>
      typeof value === "string" ? CredentialCipher.encryptJson(cipher, value, secretAad(path)) : value
    /**
     * 🔴 NC-REL-030 — a secret that will not decrypt must not take the INSTANCE down with it.
     *
     * This used to fail, and `all()` turned that into a defect with `Effect.orDie` while the layer
     * graph was still being built — so an unreadable `server.password` meant the HTTP server, the
     * HTML UI, the config-removal route and the Recovery surface could not come into existence at
     * all. SQLite was healthy the whole time. Losing one file (`credential.key` in a partial
     * restore, an antivirus quarantine, a copy that missed the state directory) bricked an
     * otherwise fine instance, and left the user nothing to repair it WITH.
     *
     * ⚠️ It fails CLOSED, which is the entire difficulty. Omitting the value would be the obvious
     * "degrade gracefully" move and it is a security hole: an instance that HAD a password would
     * boot without one. The value is replaced with per-boot random bytes instead — a string, so
     * every consumer keeps its type, and unguessable, so every comparison against it fails. The
     * instance boots into a state where nothing authenticates rather than one where everything does.
     *
     * ⚠️ Not a fixed sentinel. Any constant would be a published password the moment this file is
     * read, and someone's real secret could equal it.
     */
    const revealSecret = Effect.fn("SettingsConfigStore.revealSecret")(function* (value: unknown, path: string) {
      if (typeof value === "string") return { value, legacy: true, damaged: false }
      const opened = yield* CredentialCipher.decryptJson(cipher, value, secretAad(path)).pipe(
        // `catchCause`, not `catchAll`: Effect 4 has no `catchAll`, and the cause is what the log
        // entry wants anyway — a DecryptError alone does not say whether the key was missing,
        // replaced or unreadable.
        Effect.catchCause((cause) =>
          Log.event("credential.setting.undecryptable", {
            "credential.path": path,
            "credential.cause": Log.fault(cause),
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (opened === undefined) return { value: unreadableSecret(), legacy: false, damaged: true }
      return { value: opened.value, legacy: false, damaged: false }
    })

    const protect = (key: string, value: unknown): unknown => {
      if (key === "server" && isRecord(value) && value.password !== undefined)
        return { ...value, password: protectSecret(value.password, "server.password") }
      if (key === "instances" && Array.isArray(value))
        return value.map((entry, index) =>
          isRecord(entry) && entry.token !== undefined
            ? {
                ...entry,
                token: protectSecret(entry.token, `instances.${String(entry.name ?? index)}.token`),
              }
            : entry,
        )
      return value
    }

    const reveal = Effect.fn("SettingsConfigStore.reveal")(function* (key: string, value: unknown) {
      if (key === "server" && isRecord(value) && value.password !== undefined) {
        const password = yield* revealSecret(value.password, "server.password")
        return { value: { ...value, password: password.value }, legacy: password.legacy, damaged: password.damaged }
      }
      if (key === "instances" && Array.isArray(value)) {
        let legacy = false
        let damaged = false
        const entries = yield* Effect.forEach(value, (entry, index) =>
          Effect.gen(function* () {
            if (!isRecord(entry) || entry.token === undefined) return entry
            const token = yield* revealSecret(entry.token, `instances.${String(entry.name ?? index)}.token`)
            legacy ||= token.legacy
            damaged ||= token.damaged
            return { ...entry, token: token.value }
          }),
        )
        return { value: entries, legacy, damaged }
      }
      return { value, legacy: false, damaged: false }
    })

    const service = Service.of({
      all: Effect.fn("SettingsConfigStore.all")(function* () {
        const stored = yield* settings.all()
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(stored)) {
          const opened = yield* reveal(key, value)
          result[key] = opened.value
          // ⚠️ NEVER write back a damaged value. `legacy` is already false on that path, but the
          // consequence is worth naming where the write is: `protect` would encrypt the random
          // stand-in under the CURRENT key and store it over the ciphertext, destroying the only
          // copy of the real secret — the one thing that makes this recoverable when the original
          // key is restored. Repair must stay possible after a boot in the damaged state.
          if (opened.legacy && !opened.damaged) yield* settings.set(key, protect(key, opened.value))
        }
        LogSettings.apply(result.log)
        return result
      }),
      set: Effect.fn("SettingsConfigStore.set")(function* (key, value) {
        yield* settings.set(key, protect(key, value))
      }),
      remove: Effect.fn("SettingsConfigStore.remove")(function* (key) {
        yield* settings.remove(key)
      }),
      isEmpty: Effect.fn("SettingsConfigStore.isEmpty")(function* () {
        return yield* settings.isEmpty()
      }),
    })
    // Hydrate synchronous consumers (currently the logger hot path) as soon as the instance store
    // exists. Observability opens before SQLite by design, so this is the earliest safe point at
    // which a persisted level can replace the environment/default policy.
    yield* service.all()
    return service
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(CredentialCipher.defaultLayer),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, CredentialCipher.node] })
