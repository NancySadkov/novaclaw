import { DbRegistryView } from "@novaclaw/core/db-registry-view"
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { ConfigProjection } from "@novaclaw/core/config-projection"
import { Database } from "@novaclaw/core/database/database"
import { DbRegistry } from "@novaclaw/core/db-registry"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { DbRegistryTool } from "@novaclaw/core/tool/db-registry"
import { testEffect } from "./lib/effect"

/**
 * The `registry` TOOL — the agent-facing half of the Registry, and the two guards the app half does
 * not need. `db-registry.test.ts` covers the shared module; this covers what changes when the writer
 * is a model.
 *
 * Two invariants, and each is a hole that was open:
 *
 *  1. **The permission kernel's own table is not writable by an agent.** `CONFIG_BACKED_TABLES`
 *     protects the tiers `configure` enforces; `session_auto_grant` holds a VERDICT the evaluator
 *     reads, is config-backed by nothing, and was freely insertable. One row widens the Auto-mode
 *     ceiling from the next turn. (Its sibling `permission`, the saved-grant table, is gone —
 *     migration `20260918045440_drop_permission_table`.)
 *  2. **A read of a table is redacted.** The write refusal's own message ends *"Browsing it is
 *     fine"*, and `DbRegistry.rows` only ever called `assertTable`, so
 *     `{op:"rows",table:"runtime_setting"}` returned `server.password` and every peer token in
 *     plaintext one layer under the redaction `configure`'s `read` op applies — whose header states
 *     the invariant verbatim: *"read is ungated precisely BECAUSE it is redacted."*
 *
 * ⚠️ Every redaction claim below is asserted in BOTH directions. A test that only checked the
 * secret's absence would pass just as happily against a tool that returned nothing at all, or one
 * that blanked the whole row — and blanking the whole row destroys the repair the self-healing law
 * exists for. So each case names a NON-secret sibling that must survive.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SettingsConfigStore.node])))

const SERVER_PASSWORD = "s3cr3t-incoming-token"
const PEER_TOKEN = "PEER-TOKEN-account-equivalent"
const CREDENTIAL_VALUE = "cred-plaintext-value-do-not-leak"
const IDENTITY_SECRET = "ident-secret-signing-key"
const PROVIDER_HEADER = "Bearer prov-authorization-secret"

const stamps = { time_created: 1, time_updated: 1 }

/** The text the model actually reads, for one op. */
const message = (input: Parameters<typeof DbRegistryTool.run>[0]) =>
  DbRegistryTool.run(input).pipe(Effect.map((output) => output.message))

describe("registry tool: the permission kernel is not writable by an agent", () => {
  it.effect("refuses insert/update/delete on `session_auto_grant`, and writes nothing", () =>
    Effect.gen(function* () {
      const before = yield* DbRegistry.rows({ table: "session_auto_grant", limit: 500 })
      expect(before.rowCount).toBe(0)

      // The escalation itself: one row widens the Auto-mode ceiling for every later turn.
      const refusals = {
        insert: message({
          op: "insert",
          table: "session_auto_grant",
          values: { session_id: "ses_forged", mode: "yolo", justification: "agent-authored", at: 1 },
        }),
        update: message({ op: "update", table: "session_auto_grant", rowid: 1, values: { mode: "yolo" } }),
        delete: message({ op: "delete", table: "session_auto_grant", rowid: 1 }),
      }
      for (const [what, attempt] of Object.entries(refusals)) {
        const error = yield* attempt.pipe(Effect.flip)
        expect(`${what}:${error._tag}`).toBe(`${what}:DbRegistry.RegistryError`)
        expect(`${what}:${error.message.includes("permission kernel")}`).toBe(`${what}:true`)
      }

      // Ruling 2 in its storage form: a refused mutation changed nothing and half-wrote nothing.
      expect((yield* DbRegistry.rows({ table: "session_auto_grant", limit: 500 })).rowCount).toBe(0)

      // NEGATIVE CONTROL: the gate is per-table, not "agents may no longer write". An ordinary
      // table stays writable through the very same tool call shape that was refused above.
      yield* message({ op: "insert", table: "data_migration", values: { name: "kernel-probe", time_completed: 1 } })
      expect((yield* DbRegistry.rows({ table: "data_migration" })).rowCount).toBe(1)
    }),
  )

  it.effect("the kernel set names tables that exist, and does not name the dropped tables", () =>
    Effect.gen(function* () {
      // ⚠️ A LEDGER, not a restatement. A guard naming a table that is not there protects nothing
      // and reads as protection — which is exactly what a `permission_pending` entry would have
      // been (migration `20260901051852_crazy_sheva_callister` DROPS it), and now `permission` too
      // (`20260918045440_drop_permission_table`).
      const existing = new Set((yield* DbRegistry.tables()).map((table) => table.name))
      const declared = DbRegistry.permissionKernelTables()
      for (const table of declared) expect(`${table}:${existing.has(table)}`).toBe(`${table}:true`)
      expect([...declared].sort()).toEqual(["session_auto_grant"])
      expect(existing.has("permission_pending")).toBe(false)
      expect(existing.has("permission")).toBe(false)
      // And the two sets are disjoint, so neither refusal is silently doing the other's job.
      for (const table of declared) expect(DbRegistry.configBackedTables().has(table)).toBe(false)
    }),
  )
})

describe("registry tool: a read never hands the model a stored credential", () => {
  it.effect("redacts `runtime_setting` — server password and peer tokens — and keeps the rest", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("server", { port: 4096, hostname: "127.0.0.1", password: SERVER_PASSWORD })
      yield* store.set("instances", [{ name: "spark", url: "http://127.0.0.1:4097", token: PEER_TOKEN }])
      yield* store.set("username", "nancy")

      // The stored bytes really do carry the secrets — otherwise everything below is vacuous.
      const raw = yield* DbRegistry.rows({ table: "runtime_setting", limit: 500 })
      expect(JSON.stringify(raw.rows)).toContain(SERVER_PASSWORD)
      expect(JSON.stringify(raw.rows)).toContain(PEER_TOKEN)

      const text = yield* message({ op: "rows", table: "runtime_setting", limit: 500 })
      expect(text).not.toContain(SERVER_PASSWORD)
      expect(text).not.toContain(PEER_TOKEN)
      expect(text).toContain(ConfigProjection.REDACTED)
      // BOTH DIRECTIONS: the row is still a repair target. Blanking `server` whole would hide the
      // port and hostname an agent repairs, which is the over-redaction `configure`'s own history
      // measured and rejected.
      expect(text).toContain("4096")
      expect(text).toContain("127.0.0.1:4097")
      expect(text).toContain("nancy")
    }),
  )

  it.effect("redacts the column-secret class: credential, instance_identity, catalog_provider", () =>
    Effect.gen(function* () {
      yield* DbRegistry.insertRow({
        table: "credential",
        values: { id: "cred_probe", label: "probe-label", value: CREDENTIAL_VALUE, ...stamps },
      })
      yield* DbRegistry.insertRow({
        table: "instance_identity",
        values: { id: "ident_probe", public_key: "ident-public-key", secret_key: IDENTITY_SECRET, ...stamps },
      })
      yield* DbRegistry.insertRow({
        table: "catalog_provider",
        values: {
          id: "probe-provider",
          layers: JSON.stringify([
            { name: "Probe Provider", request: { headers: { Authorization: PROVIDER_HEADER } } },
          ]),
          ...stamps,
        },
      })

      const credential = yield* message({ op: "rows", table: "credential" })
      expect(credential).not.toContain(CREDENTIAL_VALUE)
      expect(credential).toContain(DbRegistryView.SECRET_CELL)
      expect(credential).toContain("probe-label")

      const identity = yield* message({ op: "rows", table: "instance_identity" })
      expect(identity).not.toContain(IDENTITY_SECRET)
      expect(identity).toContain(DbRegistryView.SECRET_CELL)
      // The PUBLIC key is published by design and must survive — the ledger of what is secret is a
      // decision per column, not "this table is dangerous".
      expect(identity).toContain("ident-public-key")

      // The layered config tables are the half a `runtime_setting`-only redactor misses:
      // `providers.<id>.request.headers` is where an Authorization token lives.
      const provider = yield* message({ op: "rows", table: "catalog_provider" })
      expect(provider).not.toContain(PROVIDER_HEADER)
      expect(provider).toContain(ConfigProjection.REDACTED)
      expect(provider).toContain("Probe Provider")
    }),
  )

  it.effect("every config-backed table has a redaction route, and every credential column is declared", () =>
    Effect.gen(function* () {
      // ⚠️ A LEDGER over the LIVE schema, because a hand-kept subset of a schema goes stale silently
      // and its only symptom is a leak nobody sees. Two ratchets:
      //
      //  · a config store added to `config-store-write.ts` (and so to `CONFIG_BACKED_TABLES`) with
      //    no redaction route here. The tool FAILS CLOSED on such a table, so the cost of missing it
      //    is a refusal rather than a leak — but a refusal is still a repair path removed.
      //  · a new column anywhere in the schema whose NAME reads as a credential.
      const routes = DbRegistryView.configRoutes()
      const backed = DbRegistry.configBackedTables()
      for (const table of backed) expect(`${table}:${routes.has(table)}`).toBe(`${table}:true`)
      // …and no route for a table that is not config-backed, so the map can only track that set.
      for (const table of routes.keys()) expect(`${table}:${backed.has(table)}`).toBe(`${table}:true`)

      const { db } = yield* Database.Service
      const declared = DbRegistryView.secretColumns()
      const names = (yield* DbRegistry.tables()).map((table) => table.name)
      // The sweep has something to look at: an empty schema would make the scan below vacuous.
      expect(names.length).toBeGreaterThan(30)
      const undeclared: string[] = []
      for (const table of names) {
        const columns = (yield* db
          .all(sql`SELECT name FROM pragma_table_info(${table})`)
          .pipe(Effect.orDie)) as { name: string }[]
        for (const { name } of columns)
          if (DbRegistryView.SECRET_COLUMN_PATTERN.test(name) && declared.get(table)?.has(name) !== true)
            undeclared.push(`${table}.${name}`)
      }
      expect(undeclared).toEqual([])

      // POSITIVE CONTROL for the scan itself: "the answer is []" is also what a broken detector says.
      // These four are in the live schema and the pattern must find every one of them.
      const found: string[] = []
      for (const table of names) {
        const columns = (yield* db
          .all(sql`SELECT name FROM pragma_table_info(${table})`)
          .pipe(Effect.orDie)) as { name: string }[]
        for (const { name } of columns)
          if (DbRegistryView.SECRET_COLUMN_PATTERN.test(name)) found.push(`${table}.${name}`)
      }
      expect(found.sort()).toEqual([
        "account.access_token",
        "account.refresh_token",
        "control_account.access_token",
        "control_account.refresh_token",
        "instance_identity.sealing_secret_key",
        "instance_identity.secret_key",
      ])
      // And the entry the pattern CANNOT find, which is why the declaration exists as well as the scan.
      expect(declared.get("credential")?.has("value")).toBe(true)
    }),
  )
})
