import { describe, expect, test } from "bun:test"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"

/**
 * **The reload registry's two claims that a comment cannot keep true: the DOMAIN ORDER, and the list
 * of keys this instance admits it cannot apply live.** (v0.2.0-prep B7 tier-3; todo.md ruling 1.)
 *
 * ⚠️ Why either needs a test rather than prose.
 *
 * **① Order.** `ConfigStoreWrite.apply` fans a committed write out to every stale domain.
 * `instance_config` re-derives the novaclaw-side merged instance document; `formatter` and `mcp`
 * then read that document to decide what changed. If they run first — or concurrently, which is what
 * the registry did before tier-3 landed — they reconcile against the value they were already
 * holding, conclude nothing changed, and report a reload that did nothing. That failure is INVISIBLE
 * from the outside: `reloadsDispatched` counts it as done, no log fires, and the user's edit simply
 * does not take effect. Reordering `RELOAD_DOMAINS` is a one-line edit that compiles green, so the
 * order is pinned here.
 *
 * **② `RESTART_REQUIRED_KEYS`.** v0.2.0 ruling 2 — *a fault is never described falsely.* A key on
 * that list is stored durably and served back by `GET /config` while NOT being in force, which is a
 * real partial failure the instance must state rather than imply. The ratchet runs both ways: an
 * entry that is not a `Config.Info` key fails, and an entry that has ACQUIRED a reload trigger fails
 * with "drop it" — so the moment a key becomes live the confession has to go, and the list can only
 * shrink.
 *
 * ⚠️ This file asserts through the exported `staleDomains`, never against the `RELOAD_TRIGGERS`
 * table directly. The table is not the contract — what `apply` actually dispatches is — and a test
 * that re-read the table would pass while a bug in the filter shipped.
 */

const CONFIG_INFO_KEYS = new Set(Object.keys(Config.Info.fields))

/** The domains one key's write leaves stale, in dispatch order. */
const domainsFor = (key: string) => ConfigStoreWrite.staleDomains(new Set([key]))

describe("reload domain order", () => {
  test("`instance_config` is FIRST — the document every other novaclaw-side domain reads", () => {
    expect(ConfigStoreWrite.RELOAD_DOMAINS[0]).toBe("instance_config")
  })

  test("a write that stales both `instance_config` and a reader dispatches the document first", () => {
    // The two keys whose cure spans both halves: the merged document AND a derived cache built from
    // it. Written out as full expected arrays rather than an `indexOf` comparison, so a domain
    // silently dropped from a trigger list fails here too.
    expect(domainsFor("mcp")).toEqual(["instance_config", "mcp"])
    expect(domainsFor("formatter")).toEqual(["instance_config", "formatter"])
  })

  test("`snapshots` needs the document and nothing else", () => {
    // `snapshot/index.ts` re-reads `config.get().snapshots` on EVERY call, so it looked read-through
    // already — it was stale only because the document it reads from was. There is no derived
    // snapshot cache to refresh, and adding one to the trigger list would be a reload for nothing.
    expect(domainsFor("snapshots")).toEqual(["instance_config"])
  })

  test("staleDomains preserves RELOAD_DOMAINS order for a multi-key write", () => {
    const domains = ConfigStoreWrite.staleDomains(new Set(["mcp", "agents", "formatter", "providers"]))
    expect(domains).toEqual(
      [...domains].sort(
        (a, b) => ConfigStoreWrite.RELOAD_DOMAINS.indexOf(a) - ConfigStoreWrite.RELOAD_DOMAINS.indexOf(b),
      ),
    )
    expect(domains[0]).toBe("instance_config")
  })

  test("the tier-2 domains are untouched by tier-3", () => {
    // Tier-3 added domains and an ordering rule; it must not have moved anything that already
    // worked. These four are the domains the 2026-07-31 tier-2 commit wired.
    expect(domainsFor("agents")).toContain("agents")
    expect(domainsFor("commands")).toEqual(["commands"])
    expect(domainsFor("references")).toEqual(["references"])
    expect(domainsFor("skills")).toEqual(["skills"])
    expect(domainsFor("providers")).toEqual(["catalog"])
  })

  test("an unrelated key stales nothing", () => {
    // The per-key discipline the registry documents: a reload is not free, so a key with no stale
    // domain must dispatch none. `username` is a settings key no materialised domain derives from.
    expect(domainsFor("username")).toEqual([])
  })
})

describe("RESTART_REQUIRED_KEYS — the keys this instance admits it cannot apply live", () => {
  test("every entry is a real Config.Info key", () => {
    for (const key of ConfigStoreWrite.RESTART_REQUIRED_KEYS.keys()) {
      expect(CONFIG_INFO_KEYS.has(key), `"${key}" is on the restart ledger but is not a Config.Info key`).toBe(true)
    }
  })

  test("every entry carries a reason that names a mechanism", () => {
    for (const [key, reason] of ConfigStoreWrite.RESTART_REQUIRED_KEYS) {
      // A one-word "not supported" is the shape this ledger exists to prevent: the entry is a
      // confession, and the next person has to be able to tell whether it is still true.
      expect(reason.length, `"${key}" needs a reason that survives being read`).toBeGreaterThan(120)
    }
  })

  test("RATCHET — a key that acquired a reload trigger must be dropped from the ledger", () => {
    for (const key of ConfigStoreWrite.RESTART_REQUIRED_KEYS.keys()) {
      expect(
        domainsFor(key),
        `"${key}" now has a reload domain, so it CAN apply live — delete its RESTART_REQUIRED_KEYS entry`,
      ).toEqual([])
    }
  })

  test("`plugins` is the only one, and `apply` can name it", () => {
    // Recorded as a count so shrinking it is a deliberate edit here too. `plugins` is on the list
    // because `config/plugin/external.ts` brings third-party modules in with `import()`, and ESM
    // caches a module URL forever: there is no re-read and no unregister. Ruling 5 has already
    // scheduled that loader and this key for deletion, which is what makes "restart" the honest
    // answer rather than a missing feature.
    expect([...ConfigStoreWrite.RESTART_REQUIRED_KEYS.keys()]).toEqual(["plugins"])
    expect(ConfigStoreWrite.restartRequired(new Set(["plugins", "username"]))).toEqual(["plugins"])
    expect(ConfigStoreWrite.restartRequired(new Set(["username"]))).toEqual([])
  })
})
