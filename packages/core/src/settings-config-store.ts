export * as SettingsConfigStore from "./settings-config-store"

import { randomBytes } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { isRecord } from "@novaclaw/schema/record"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { RuntimeSettingTable } from "./settings-config/sql"
import { LogSettings } from "./observability/log-settings"
import { TrashSettings } from "./trash-settings"

export interface Interface {
  readonly unreadable: () => Effect.Effect<ReadonlyArray<{ readonly path: string }>>
  readonly all: () => Effect.Effect<Record<string, unknown>>
  /** Read the committed incoming API token; undefined means use the launcher default. */
  readonly serverPassword: () => Effect.Effect<string | undefined>
  readonly set: (key: string, value: unknown) => Effect.Effect<void>
  readonly update: (
    key: "provider_capability" | "provider_route_profile",
    change: (current: unknown) => unknown,
  ) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SettingsConfigStore") {}

/** One traversal owns the paths used for validation, status and write preservation. */
function mapSecrets(key: string, value: unknown, map: (path: string, value: unknown) => unknown): unknown {
  if (key === "server" && isRecord(value) && value.password !== undefined)
    return { ...value, password: map("server.password", value.password) }
  if (key === "instances" && Array.isArray(value))
    return value.map((entry, index) =>
      isRecord(entry) && entry.token !== undefined
        ? { ...entry, token: map(`instances.${String(entry.name ?? index)}.token`, entry.token) }
        : entry,
    )
  return value
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const settings = ConfigStoreFactory.makeKeyValueStore({
      db,
      table: RuntimeSettingTable,
      keyColumn: RuntimeSettingTable.key,
    })
    // Malformed stored secrets must keep authentication closed, never turn a password into an open
    // instance. Reads issue a stable random stand-in without mutating SQLite. Unrelated writes keep
    // the malformed value, so the health report cannot mistake a stand-in for a repaired password.
    const standIns = new Map<string, string>()
    const readSecret = (path: string, value: unknown) => {
      if (typeof value === "string") return value
      let standIn = standIns.get(path)
      if (standIn === undefined) {
        standIn = randomBytes(32).toString("base64url")
        standIns.set(path, standIn)
      }
      return standIn
    }
    const service = Service.of({
      all: Effect.fn("SettingsConfigStore.all")(function* () {
        const stored = yield* settings.all()
        const result = Object.fromEntries(
          Object.entries(stored).map(([key, value]) => [key, mapSecrets(key, value, readSecret)]),
        )
        LogSettings.apply(result.log)
        TrashSettings.apply(result.trash)
        return result
      }),
      serverPassword: Effect.fn("SettingsConfigStore.serverPassword")(function* () {
        // Read through SQLite so a rolled-back config write cannot change the live auth policy.
        const stored = yield* settings.get("server")
        if (!isRecord(stored) || stored.password === undefined) return undefined
        return readSecret("server.password", stored.password) || undefined
      }),
      unreadable: Effect.fn("SettingsConfigStore.unreadable")(function* () {
        const stored = yield* settings.all()
        const found: { path: string }[] = []
        for (const [key, value] of Object.entries(stored))
          mapSecrets(key, value, (path, secret) => {
            if (typeof secret !== "string") found.push({ path })
            return secret
          })
        return found
      }),
      set: Effect.fn("SettingsConfigStore.set")(function* (key, value) {
        if (standIns.size === 0) return yield* settings.set(key, value)
        const stored = yield* settings.get(key)
        const originals = new Map<string, unknown>()
        mapSecrets(key, stored, (path, secret) => {
          originals.set(path, secret)
          return secret
        })
        const preserved = mapSecrets(key, value, (_path, secret) => {
          for (const [issuedPath, standIn] of standIns)
            if (secret === standIn && originals.has(issuedPath)) return originals.get(issuedPath)
          return secret
        })
        yield* settings.set(key, preserved)
      }),
      update: settings.update,
      remove: settings.remove,
      isEmpty: settings.isEmpty,
    })
    // Logging starts before SQLite. Hydrate its synchronous projection once the store exists.
    yield* service.all()
    return service
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
