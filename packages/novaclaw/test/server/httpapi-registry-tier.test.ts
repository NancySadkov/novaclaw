import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * **The `/registry` HTTP routes must act at the AGENT's tier unless the instance is in Developer
 * mode — on reads as well as writes.**
 *
 * 🔴 The defect. `DbRegistry` has two writers: the `registry` TOOL passes `writer: "agent"` (which
 * refuses the permission-kernel and config-backed tables) and redacts every stored credential out of
 * a page; the HTTP handler passed NOTHING, so the `"developer"` default applied and `rows` answered
 * with the raw column. The gate therefore sat on the tool rather than on the resource, and both
 * halves were one `curl` from an agent's own shell away — a write that rewrites `runtime_setting`
 * around ruling 4's per-key privilege model, and a read that hands back `credential.value` and every
 * provider `Authorization` header. Round 1 closed the tool half; this is its HTTP twin.
 *
 * ⚠️ **The tier is decided by the instance's `expertise` setting, NOT by the request**, because HTTP
 * carries no caller attribution — the app, the SDK and `curl` are one anonymous caller behind one
 * credential. `expertise` is the same gate the Registry app tile is behind, and a consequential-tier
 * config key, so an agent cannot widen its own reach without a consent card. The two Developer-mode
 * cases below are the CONTROLS: a fix that redacts unconditionally, or refuses unconditionally, has
 * broken the Registry app instead of the bypass, and every assertion here would still pass without
 * them.
 */

const it = testEffectShared(Layer.mergeAll(Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

interface Page {
  readonly rowCount: number
  readonly rows: ReadonlyArray<{ readonly rowid: number; readonly values: Record<string, unknown> }>
}

const readRows = (directory: string, table: string) =>
  Effect.gen(function* () {
    const res = yield* requestInDirectory(`/registry/rows?table=${table}&limit=500`, directory)
    const body = yield* res.text
    return { status: res.status, body, page: JSON.parse(body) as Page }
  })

const insert = (directory: string, table: string, values: Record<string, unknown>) =>
  Effect.gen(function* () {
    const res = yield* requestInDirectory("/registry/row/insert", directory, json("POST", { table, values }))
    return { status: res.status, body: yield* res.text }
  })

/** A credential row is the plainest secret-bearing shape: `value` is declared secret by column. */
const SECRET = "sk-live-registry-tier-probe"
const credentialRow = {
  id: "cred_registry_tier_probe",
  label: "registry-tier-probe",
  value: SECRET,
  time_created: 1,
  time_updated: 1,
}

const enterDeveloperMode = (directory: string) =>
  Effect.gen(function* () {
    const res = yield* requestInDirectory("/config", directory, json("PATCH", { expertise: "developer" }))
    // Asserted, not assumed: if the write ever stopped landing, every Developer-mode control below
    // would silently become a second copy of the agent-tier case and pass for the wrong reason.
    expect(res.status).toBe(200)
    expect(JSON.parse(yield* res.text).expertise).toBe("developer")
  })

describe("the /registry routes act at the agent tier by default", () => {
  it.instance(
    "an insert naming the permission kernel is REFUSED, and the table is unchanged",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const before = yield* readRows(test.directory, "permission")
        expect(before.status).toBe(200)

        // Every column is a real one, so `insertRow`'s "no known columns" arm cannot be what
        // refuses this — the row is perfectly well-formed and the guard is the only thing in its way.
        const res = yield* insert(test.directory, "permission", {
          id: "perm_registry_tier_probe",
          origin: "probe",
          action: "*",
          resource: "*",
          effect: "allow",
          time_created: 1,
          time_updated: 1,
        })

        expect(res.status).toBe(400)
        const body: Record<string, unknown> = JSON.parse(res.body)
        expect(body._tag).toBe("InvalidRequestError")
        // The KERNEL refusal specifically. A generic 400 would also satisfy a status check while
        // meaning "your payload was malformed", which is the opposite of what is being proven.
        expect(String(body.message)).toContain("permission kernel")

        const after = yield* readRows(test.directory, "permission")
        expect(after.page.rowCount).toBe(before.page.rowCount)
        expect(after.page.rows.map((row) => row.values.id)).not.toContain("perm_registry_tier_probe")
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "GET /registry/rows redacts a stored credential",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // `credential` is neither kernel nor config-backed, so the agent tier may write it — which is
        // what makes it a clean probe: the row lands, and only the READ path is under test.
        expect((yield* insert(test.directory, "credential", credentialRow)).status).toBe(200)

        const page = (yield* readRows(test.directory, "credential")).page
        const row = page.rows.find((entry) => entry.values.id === credentialRow.id)
        expect(row).toBeDefined()

        expect(row!.values.value).not.toBe(SECRET)
        expect(String(row!.values.value)).toContain("redacted")
        // The row is still USABLE — only the secret column moved. A redactor that blanked the whole
        // row would pass the assertion above and make the surface useless for repair.
        expect(row!.values.label).toBe(credentialRow.label)
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "CONTROL: an ordinary, non-kernel table still accepts an agent-tier write",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // `data_migration` tracks data backfills and is deliberately editable. If this ever fails,
        // the tier has become a blanket refusal and the self-healing law lost its repair surface.
        const res = yield* insert(test.directory, "data_migration", {
          name: "registry-tier-probe",
          time_completed: 1,
        })
        expect(res.status).toBe(200)

        const page = (yield* readRows(test.directory, "data_migration")).page
        expect(page.rows.map((row) => row.values.name)).toContain("registry-tier-probe")
      }),
    { git: true, config: { formatter: false } },
  )
})

describe("CONTROL: Developer mode keeps the Registry app's full reach", () => {
  it.instance(
    "the same credential row comes back with its real value",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect((yield* insert(test.directory, "credential", credentialRow)).status).toBe(200)

        yield* enterDeveloperMode(test.directory)

        const page = (yield* readRows(test.directory, "credential")).page
        const row = page.rows.find((entry) => entry.values.id === credentialRow.id)
        expect(row?.values.value).toBe(SECRET)
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "a human may still repair their own saved grants by hand",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* enterDeveloperMode(test.directory)

        const res = yield* insert(test.directory, "permission", {
          id: "perm_registry_tier_probe",
          origin: "probe",
          action: "*",
          resource: "*",
          effect: "allow",
          time_created: 1,
          time_updated: 1,
        })
        expect(res.status).toBe(200)

        const page = (yield* readRows(test.directory, "permission")).page
        expect(page.rows.map((row) => row.values.id)).toContain("perm_registry_tier_probe")
      }),
    { git: true, config: { formatter: false } },
  )
})
