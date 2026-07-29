import { describe, expect, test } from "bun:test"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import type { Config } from "@/config/config"
import { readConfigStores, routeConfig, tmpdir } from "./fixture"

/**
 * ─── the config plane's undo ───────────────────────────────────────────────────────────────────────
 *
 * `tmpdir({ config })` writes THROUGH the config stores (`ConfigStoreWrite.apply`, the same route
 * `PATCH /config` takes), and those stores are process-wide: `resetDatabase()` deliberately keeps its
 * sweep out of them (`PRESERVED_TABLES`), so `clearProvisioned()` is the ONLY thing that ever takes a
 * provisioned key back out. Every key the undo cannot reach is therefore a cross-test leak waiting to
 * happen — a write that does not fail the test that made it, but an unrelated test in a later file.
 *
 * That is why `routeConfig` refuses a key it cannot undo instead of writing it, and why the refusal
 * used to cover `providers`, `models`, `agents`, `commands`, `model` and `default_agent` — every one
 * of which has had a `remove*`/`clearDefault` op on its store all along. This file pins both halves:
 * the undo actually reaches SQLite, and the refusal still bites for the two keys that genuinely
 * cannot be undone.
 *
 * ⚠️ The assertions read the STORE (`readConfigStores`), never the in-memory `provisioned` ledger.
 * Emptying the ledger is exactly what a broken undo would still do — the bug class is a row that
 * outlives the bookkeeping, so only the store can answer.
 *
 * Each test carries its own negative control: the "visible while provisioned" leg proves the store
 * read is a live signal, so the "gone after teardown" leg can only be produced by a real delete and
 * never by a reader that returns nothing. (The out-of-band control is the harsher one and was run by
 * hand: deleting the `providers` arm of `clearProvisioned` fails the first two tests below.)
 */

const PROVIDER = "clear-provisioned-probe"
const OTHER_PROVIDER = "clear-provisioned-probe-second"
const AGENT = "clear-provisioned-agent"
const COMMAND = "clear-provisioned-command"
const REFERENCE = "clear-provisioned-reference"

/** Minimal valid literals — `ConfigProvider.Info`/`ConfigAgent.Info` are all-optional. */
const provider = (name: string) => ({ providers: { [name]: { name: "probe" } } })

describe("clearProvisioned", () => {
  test("undoes a provisioned provider, so a later fixture cannot see it", async () => {
    const tmp = await tmpdir({ config: provider(PROVIDER) })

    // NEGATIVE CONTROL (in-test): the store must SEE it first, or "gone" below proves nothing.
    expect((await readConfigStores()).providers).toContain(PROVIDER)

    await tmp[Symbol.asyncDispose]()

    expect((await readConfigStores()).providers).not.toContain(PROVIDER)

    // The invariant that actually matters: a second fixture in the SAME process starts clean. The
    // stores outlive both handles, so this is the leak the refusal existed to prevent.
    await using next = await tmpdir()
    expect(next.path.length).toBeGreaterThan(0)
    expect((await readConfigStores()).providers).not.toContain(PROVIDER)
  })

  test("undoes the previous provider at the head of the next provision, not only on dispose", async () => {
    // Two LIVE handles share one document (last write wins — see the `provisioned` comment), so the
    // undo has to run BEFORE the second write. Without it `collapseLayers` would fold the second
    // fragment onto the first's layers and both rows would stand.
    const first = await tmpdir({ config: provider(PROVIDER) })
    expect((await readConfigStores()).providers).toContain(PROVIDER)

    const second = await tmpdir({ config: provider(OTHER_PROVIDER) })
    const during = (await readConfigStores()).providers
    expect(during).toContain(OTHER_PROVIDER)
    expect(during).not.toContain(PROVIDER)

    await first[Symbol.asyncDispose]()
    await second[Symbol.asyncDispose]()
    expect((await readConfigStores()).providers).toHaveLength(0)
  })

  test("undoes the provider a flat `models` map expands into, under its DERIVED id", async () => {
    // Models-primary: the endpoint HOST is the provider group, so the row is named `127.0.0.1:9111`
    // and not `clear-provisioned-model`. An undo that guessed the model id would remove nothing and
    // say nothing — which is why the router calls `CatalogSeed.expandFlatModels` rather than
    // re-deriving the id.
    const tmp = await tmpdir({
      config: { models: { "clear-provisioned-model": { url: "http://127.0.0.1:9111/v1" } } },
    })

    expect((await readConfigStores()).providers).toContain("127.0.0.1:9111")

    await tmp[Symbol.asyncDispose]()

    expect((await readConfigStores()).providers).not.toContain("127.0.0.1:9111")
  })

  test("undoes agents, commands, references and both singleton default refs", async () => {
    const tmp = await tmpdir({
      config: {
        agents: { [AGENT]: { description: "probe" } },
        commands: { [COMMAND]: { template: "probe" } },
        references: { [REFERENCE]: "/tmp/probe" },
        model: `${PROVIDER}/probe-model`,
        default_agent: AGENT,
      },
    })

    const during = await readConfigStores()
    expect(during.agents).toContain(AGENT)
    expect(during.commands).toContain(COMMAND)
    expect(during.references).toContain(REFERENCE)
    expect(during.model).toBe(`${PROVIDER}/probe-model`)
    expect(during.default_agent).toBe(AGENT)

    await tmp[Symbol.asyncDispose]()

    const after = await readConfigStores()
    expect(after.agents).not.toContain(AGENT)
    expect(after.commands).not.toContain(COMMAND)
    expect(after.references).not.toContain(REFERENCE)
    // The defaults are single ROWS, not values — `clearDefault()` deletes them, so `undefined` here
    // (an empty string would still be a value and would block `setDefaultIfEmpty` forever).
    expect(after.model).toBeUndefined()
    expect(after.default_agent).toBeUndefined()
  })

  test("undoes a settings key too — the arm that already worked still does", async () => {
    const tmp = await tmpdir({ config: { username: "clear-provisioned-user" } })
    expect((await readConfigStores()).settings).toContain("username")

    await tmp[Symbol.asyncDispose]()

    expect((await readConfigStores()).settings).not.toContain("username")
  })
})

/**
 * The router is the gate: a key it accepts is a key `clearProvisioned` must be able to reach, and a
 * key it refuses must say something a reader can act on. `routeConfig` only inspects `Object.keys`
 * and the container values, so a bare `{ [key]: undefined }` probe is enough to enumerate the whole
 * schema without writing anything.
 */
describe("routeConfig", () => {
  const route = (key: string) => routeConfig({ [key]: undefined } as Partial<Config.Info>)

  /** `""` when the key is accepted, otherwise the refusal message — asserted on directly, because
   *  `expect(fn).not.toThrow(/x/)` also passes for a function that throws something ELSE, which is
   *  the one outcome these assertions must be able to tell apart. */
  const refusal = (key: string) => {
    try {
      route(key)
      return ""
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** The two array-shaped keys whose write REPLACES the store's list — see `REFUSED` in fixture.ts. */
  const REFUSED = ["plugins", "skills"]

  test("every Config.Info key is either routed or refused BY NAME", () => {
    // The ratchet. A new top-level config key added to `Config.Info` lands here first: it is either
    // wired into the undo, or it must be added to `REFUSED` with a reason — the same choice
    // `config-store-write.ts` already forces for the write side ("an unrouted key is a silent
    // data-loss bug, not a no-op").
    const keys = Object.keys(ConfigV2.Info.fields)
    expect(keys.length).toBeGreaterThan(30) // the enumeration is real, not an empty loop
    expect(keys).toContain("providers") // ...and it reaches the key this unit was opened for

    expect(keys.filter((key) => refusal(key) !== "").sort()).toEqual(REFUSED)
  })

  test("refuses skills and plugins with the reason, not with generic advice", () => {
    for (const key of REFUSED) {
      // Names the key, states WHY (replace-wholesale), and points somewhere useful. It must NOT
      // tell the reader to teach `clearProvisioned` a remove op: both stores already have one, and
      // using it would leave the store missing whatever the write wiped.
      const message = refusal(key)
      expect(message).toContain(`"${key}"`)
      expect(message).toContain("REPLACES the whole")
      expect(message).toContain("no such snapshot")
      expect(message).not.toContain("teach clearProvisioned")
    }
  })

  test("refuses an unknown key with the generic, actionable message", () => {
    const message = refusal("not_a_config_key")
    expect(message).toContain(`"not_a_config_key"`)
    expect(message).toContain("teach clearProvisioned")
  })

  test("routes each key to the destination clearProvisioned removes it from", () => {
    expect(routeConfig({ providers: { a: {} } }).providers).toEqual(["a"])
    expect(routeConfig({ agents: { a: {} } }).agents).toEqual(["a"])
    expect(routeConfig({ commands: { a: { template: "t" } } }).commands).toEqual(["a"])
    expect(routeConfig({ references: { a: "/tmp/a" } }).references).toEqual(["a"])
    expect(routeConfig({ username: "u" }).settings).toEqual(["username"])
    expect(routeConfig({ model: "p/m" }).defaults).toEqual(["model"])
    expect(routeConfig({ default_agent: "a" }).defaults).toEqual(["default_agent"])
    // `$schema` is authoring metadata that routes nowhere and must not be recorded as provisioned.
    expect(routeConfig({ $schema: "https://example.com/s.json" })).toEqual({
      settings: [],
      references: [],
      providers: [],
      agents: [],
      commands: [],
      defaults: [],
    })
  })

  test("routes `models` to the DERIVED provider id, and never to a default", () => {
    const routed = routeConfig({ models: { "a-model": { url: "http://localhost:4321/v1" } } })
    expect(routed.providers).toEqual(["localhost:4321"])
    // `models` writes providers only; the default ref is written by `model` alone
    // (config-store-write.ts), so recording a default here would clear a row nobody wrote.
    expect(routed.defaults).toEqual([])
    // A url-less model is its own singleton provider, keyed by the model id (`providerIdForUrl`).
    expect(routeConfig({ models: { lonely: {} } }).providers).toEqual(["lonely"])
  })
})
