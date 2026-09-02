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
import { isRecord } from "@novaclaw/schema/record"

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
  /**
   * 🔴 NC-REL-030(b) — every protected setting whose envelope will not open.
   *
   * ⚠️ It lives on this store rather than in the scanner, because the store owns the per-path AADs
   * (`server.password`, `instances.<name>.token`) and the shape they are nested in. A scanner that
   * re-derived those would be a second copy that goes stale silently — and its only symptom would
   * be every setting reported unreadable, which reads as catastrophic damage rather than a wrong
   * constant.
   *
   * ⚠️ Reads through the same `reveal` the ordinary path uses, so it cannot disagree with what the
   * instance actually managed to load.
   */
  readonly unreadable: () => Effect.Effect<ReadonlyArray<{ readonly path: string }>>
  /** Every stored setting, keyed by the top-level config key. */
  readonly all: () => Effect.Effect<Record<string, unknown>>
  /** The live incoming API token, already decoded by this store; undefined means use the launcher default. */
  readonly serverPassword: () => Effect.Effect<string | undefined>
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
 * Random, never a constant: a fixed sentinel would be a password published in this file, and it
 * could collide with somebody's real one. 32 bytes so no comparison against it can succeed.
 *
 * ⚠️ Minted once per PATH for the life of the layer (`standInFor` below), not once per read — and
 * that is a correctness property rather than a cache. A stand-in travels back IN through the
 * recursive merge every config write performs, so this store has to RECOGNISE its own stand-in at
 * the write chokepoint and put the ciphertext back (`preserveSecrets`). A value regenerated per
 * read cannot be recognised, and it is no more unguessable than one minted per boot.
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

    const passwordOf = (value: unknown): string | undefined =>
      isRecord(value) && typeof value.password === "string" && value.password.length > 0 ? value.password : undefined
    const secretAad = (path: string) => `novaclaw:runtime-setting:${path}`
    /**
     * The ONE derivation of an instance token's protected path — `protect`, `reveal` and
     * `preserveSecrets` all key on it. A second hand-kept copy drifts the day the naming changes,
     * and its only symptom would be a secret written under the wrong AAD, i.e. unopenable.
     */
    const tokenPath = (entry: Record<string, unknown>, index: number) =>
      `instances.${String(entry.name ?? index)}.token`
    /** Every stand-in this boot has issued, by protected path. */
    const standIns = new Map<string, string>()
    const standInFor = (path: string) => {
      const issued = standIns.get(path)
      if (issued !== undefined) return issued
      const minted = unreadableSecret()
      standIns.set(path, minted)
      return minted
    }
    /**
     * The path a value is the stand-in FOR, or undefined if it is somebody's real secret.
     *
     * ⚠️ A reverse lookup rather than a per-path comparison, because the ciphertext has to follow
     * the stand-in and not its position: a write that reorders `instances[]` moves an entry's token
     * to a new index, and matching by index would either skip the substitution (writing the
     * stand-in — the defect) or attach one entry's ciphertext to another's row.
     */
    const standInPath = (value: unknown) => {
      if (typeof value !== "string") return undefined
      for (const [path, issued] of standIns) if (issued === value) return path
      return undefined
    }
    /**
     * One `credential.setting.undecryptable` per path per boot.
     *
     * ⚠️ Load-bearing since `serverPassword()` reads through: that runs on the HTTP authorization
     * path, i.e. once per REQUEST, so an undeduped notice would turn one damaged envelope into a
     * log flood that buries the very entry telling the operator to restore their key. Same window
     * and same reason as `warnUnreadable` in `config-store-factory.ts`.
     */
    const reportedUnreadable = new Set<string>()
    /**
     * 🔴 The unwind of app-managed encryption, step 2.
     *
     * Storing a secret is storing it. Decision §5 of `decisions-v0.2.0.md` — recorded 2026-08-07,
     * six days AFTER the cipher landed with a one-line commit and no rationale — says secrets stay
     * plaintext under OS account protection with no app-managed encryption, because no keyring
     * exists in every run mode NovaClaw ships and a partial one strands `novaclaw serve`, the CLI
     * and backup/restore.
     *
     * ⚠️ What shipped was not a keyring but a key FILE beside the database, which is the worst of
     * both: anything running as this user reads the key and the rows it protects, so the security
     * was never there — while the stranding was, and NC-REL-030 is it, observed.
     *
     * ⚠️ Reading still decrypts, deliberately. Existing envelopes must keep opening while the key
     * is present, and `all()` writes the opened value back as plaintext, so the ciphertext drains
     * away instead of becoming unreadable the moment this stopped encrypting.
     */
    const protectSecret = (value: unknown, _path: string): unknown => value
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
      // A plaintext string is already where this is going; rewriting it is a no-op that keeps the
      // one write path honest.
      if (typeof value === "string") return { value, migrated: true, damaged: [] as string[] }
      const opened = yield* CredentialCipher.decryptJson(cipher, value, secretAad(path)).pipe(
        // `catchCause`, not `catchAll`: Effect 4 has no `catchAll`, and the cause is what the log
        // entry wants anyway — a DecryptError alone does not say whether the key was missing,
        // replaced or unreadable.
        Effect.catchCause((cause) =>
          Effect.suspend(() => {
            if (reportedUnreadable.has(path)) return Effect.void
            reportedUnreadable.add(path)
            return Log.event("credential.setting.undecryptable", {
              "credential.path": path,
              "credential.cause": Log.fault(cause),
            })
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (opened === undefined) return { value: standInFor(path), migrated: false, damaged: [path] }
      // `encrypted` distinguishes "this was an envelope and it opened" from "this was never
      // encrypted at all", and only the former needs draining back to plaintext.
      return { value: opened.value, migrated: opened.encrypted === true, damaged: [] as string[] }
    })

    const protect = (key: string, value: unknown): unknown => {
      if (key === "server" && isRecord(value) && value.password !== undefined)
        return { ...value, password: protectSecret(value.password, "server.password") }
      if (key === "instances" && Array.isArray(value))
        return value.map((entry, index) =>
          isRecord(entry) && entry.token !== undefined
            ? {
                ...entry,
                token: protectSecret(entry.token, tokenPath(entry, index)),
              }
            : entry,
        )
      return value
    }

    const reveal = Effect.fn("SettingsConfigStore.reveal")(function* (key: string, value: unknown) {
      if (key === "server" && isRecord(value) && value.password !== undefined) {
        const password = yield* revealSecret(value.password, "server.password")
        return { value: { ...value, password: password.value }, migrated: password.migrated, damaged: password.damaged }
      }
      if (key === "instances" && Array.isArray(value)) {
        let migrated = false
        const damaged: string[] = []
        const entries = yield* Effect.forEach(value, (entry, index) =>
          Effect.gen(function* () {
            if (!isRecord(entry) || entry.token === undefined) return entry
            const token = yield* revealSecret(entry.token, tokenPath(entry, index))
            migrated ||= token.migrated
            damaged.push(...token.damaged)
            return { ...entry, token: token.value }
          }),
        )
        return { value: entries, migrated, damaged }
      }
      return { value, migrated: false, damaged: [] as string[] }
    })

    /**
     * 🔴 Never write a stand-in over the ciphertext it stands FOR.
     *
     * `all()` states this rule for its own drain write — *"NEVER write back a damaged value … it
     * would destroy the only copy of the real secret"* — and enforces it there. It could not
     * enforce it HERE, and here is where the destruction happened: every config write reads
     * `all()`, merges the caller's patch onto that snapshot and writes the result back. The merge
     * is recursive, so a patch touching ANY other field of `server` — a port change — carries
     * `password: <this boot's stand-in>` into the write and replaces the envelope with 32 random
     * bytes. Restoring `credential.key` afterwards recovers nothing. The instance is meanwhile
     * TELLING the operator it is damaged and asking for that key (`unreadable()`), so the
     * destruction lands precisely on the person following our own repair instructions.
     *
     * ⚠️ That is the self-healing law failing at its own chokepoint: an operator whose envelope is
     * gone cannot be talked back into their instance by an agent, which is the one repair path we
     * promise always exists.
     *
     * ⚠️ The guard is RECOGNITION, not refusal. Setting a NEW password while damaged IS the repair
     * and must go through. Only the exact bytes this store handed out for that path are swapped
     * back for the stored ciphertext; every other value is the caller's own and is written.
     *
     * ⚠️ And it belongs on the store, not at the two call sites, because the store is the only
     * thing that can tell a stand-in from a password — it minted it. A guard at a caller would
     * also be a second copy of the per-path naming, which is what `tokenPath` exists to prevent.
     */
    const preserveSecrets = Effect.fn("SettingsConfigStore.preserveSecrets")(function* (key: string, value: unknown) {
      // A healthy instance has issued no stand-in and never will, so it pays no read for this.
      if (standIns.size === 0) return value
      if (key === "server") {
        if (!isRecord(value) || standInPath(value.password) !== "server.password") return value
        const stored = yield* settings.get(key)
        // Unreachable — a stand-in is only ever minted while reading a stored envelope. Passes the
        // value through rather than dying: failing a config write because our own bookkeeping
        // disagreed with the row would be a worse outcome than the state it is guarding against.
        if (!isRecord(stored) || stored.password === undefined) return value
        return { ...value, password: stored.password }
      }
      if (key === "instances" && Array.isArray(value)) {
        const stored = yield* settings.get(key)
        if (!Array.isArray(stored)) return value
        const kept = new Map<string, unknown>()
        stored.forEach((entry, index) => {
          if (isRecord(entry) && entry.token !== undefined) kept.set(tokenPath(entry, index), entry.token)
        })
        return value.map((entry) => {
          if (!isRecord(entry)) return entry
          const path = standInPath(entry.token)
          const raw = path === undefined ? undefined : kept.get(path)
          return raw === undefined ? entry : { ...entry, token: raw }
        })
      }
      return value
    })

    const service = Service.of({
      all: Effect.fn("SettingsConfigStore.all")(function* () {
        const stored = yield* settings.all()
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(stored)) {
          const opened = yield* reveal(key, value)
          result[key] = opened.value
          // ⚠️ NEVER write back a damaged value. The write would store the random stand-in over the
          // ciphertext and destroy the only copy of the real secret — the one thing that makes this
          // recoverable when the original key is restored. Repair must stay possible after a boot
          // in the damaged state.
          //
          // ⚠️ `opened.migrated` now covers BOTH directions, and that is the unwind's whole safety
          // property: it is true for a legacy plaintext value (which used to be re-encrypted, and
          // is now simply rewritten unchanged) and true for an envelope this read successfully
          // OPENED. The second is what drains the ciphertext while the key is still present. A
          // value that could not be opened sets `damaged` instead and is never touched.
          // ⚠️ `.length === 0`, not `!opened.damaged` — `damaged` is now the LIST of unreadable
          // paths (NC-REL-030(b)), and an empty array is truthy. The negation would have been false
          // forever, silently stopping the drain that removes ciphertext while the key still exists.
          if (opened.migrated && opened.damaged.length === 0) yield* settings.set(key, protect(key, opened.value))
        }
        LogSettings.apply(result.log)
        return result
      }),
      /**
       * 🔴 Read THROUGH the row, never a cached copy.
       *
       * This was a closure variable that `set` and `remove` mutated eagerly — and both of them run
       * INSIDE `db.transaction` on the config write path. A write that rolls back (one refused path
       * in a multi-path remove, a router arm that dies) rolled SQLite back and left the variable
       * holding a value that was never stored. With no launcher password in the environment — the
       * ordinary desktop and `novaclaw serve` shape — the resolver then saw `undefined` and reported
       * `source: "open"`, so the instance accepted EVERY request unauthenticated until restart, LAN
       * included, while `/config` still showed a password. Two surfaces, one fact, opposite answers.
       *
       * `apply` already states the rule for the logger's projection: *"Refresh only AFTER commit:
       * doing it in SettingsConfigStore.set would let a later router fault roll SQLite back while
       * the live logger kept the rejected value."* The fix is not a better-placed refresh, though —
       * it is no cached copy at all. A rolled-back transaction cannot leave behind a row it did not
       * commit, so reading the row is correct on every path, including the ones nobody remembers to
       * add a refresh to.
       *
       * ⚠️ One point read of one row per request. After the encryption unwind above the stored
       * value is a plain string, so `revealSecret` short-circuits without touching the cipher.
       */
      serverPassword: Effect.fn("SettingsConfigStore.serverPassword")(function* () {
        const stored = yield* settings.get("server")
        if (!isRecord(stored) || stored.password === undefined) return undefined
        const opened = yield* revealSecret(stored.password, "server.password")
        // A damaged envelope yields the stand-in, so the instance authenticates against 32 bytes
        // nobody can produce: locked, never open. That is the fail-closed rule above reaching the
        // one consumer that decides whether a request is let in.
        return passwordOf({ password: opened.value })
      }),
      unreadable: Effect.fn("SettingsConfigStore.unreadable")(function* () {
        const stored = yield* settings.all()
        const found: { path: string }[] = []
        for (const [key, value] of Object.entries(stored)) {
          const opened = yield* reveal(key, value)
          for (const path of opened.damaged) found.push({ path })
        }
        return found
      }),
      set: Effect.fn("SettingsConfigStore.set")(function* (key, value) {
        yield* settings.set(key, protect(key, yield* preserveSecrets(key, value)))
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
