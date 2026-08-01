export * as SettingsConfigStore from "./settings-config-store"

import { Context, Effect, Layer } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { RuntimeSettingTable } from "./settings-config/sql"
import { CredentialCipher } from "./credential-cipher"

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
    const revealSecret = Effect.fn("SettingsConfigStore.revealSecret")(function* (value: unknown, path: string) {
      if (typeof value === "string") return { value, legacy: true }
      const opened = yield* CredentialCipher.decryptJson(cipher, value, secretAad(path))
      return { value: opened.value, legacy: false }
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
        return { value: { ...value, password: password.value }, legacy: password.legacy }
      }
      if (key === "instances" && Array.isArray(value)) {
        let legacy = false
        const entries = yield* Effect.forEach(value, (entry, index) =>
          Effect.gen(function* () {
            if (!isRecord(entry) || entry.token === undefined) return entry
            const token = yield* revealSecret(entry.token, `instances.${String(entry.name ?? index)}.token`)
            legacy ||= token.legacy
            return { ...entry, token: token.value }
          }),
        )
        return { value: entries, legacy }
      }
      return { value, legacy: false }
    })

    return Service.of({
      all: Effect.fn("SettingsConfigStore.all")(function* () {
        const stored = yield* settings.all()
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(stored)) {
          const opened = yield* reveal(key, value).pipe(Effect.orDie)
          result[key] = opened.value
          if (opened.legacy) yield* settings.set(key, protect(key, opened.value))
        }
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
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(CredentialCipher.defaultLayer),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, CredentialCipher.node] })
