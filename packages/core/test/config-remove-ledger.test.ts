import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { testEffect } from "./lib/effect"

/**
 * **Every `Config.Info` key is removable, or the ledger says why not.** The twin of
 * `config-routing-ledger.test.ts`, for the deletion verb v0.2.0 item 4.3 added, and the same
 * todo.md ruling-1 shape: *an invariant whose violation compiles green ships with a mechanical
 * check, or the invariant does not exist.*
 *
 * A new `Config.Info` key with no removal route compiles green, typechecks green, and answers every
 * PATCH — it just cannot ever be un-set again, which is the property this whole item exists to
 * remove from the config surface. Nothing but a test can see that.
 *
 * ⚠️ **It asks the LIVE router, not the source.** Each key is actually removed against a real
 * (empty) SQLite store and the refusal is read back. A source-reading version would assert that
 * some table mentions the key, which is a different claim — `config-store-write.ts`'s own routing
 * ledger records the same lesson: a row whose `key` disagrees with its reader routes the wrong
 * thing just as quietly.
 */

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      AgentConfigStore.node,
      CatalogStore.node,
      CommandConfigStore.node,
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
    ]),
  ),
)

/** The substring `removeOne` emits for a declared key that reached no removal arm at all. */
const NO_ROUTE = "has no removal route"

describe("the config removal ledger", () => {
  it.effect("every Config.Info key either routes for removal or is refused BY NAME", () =>
    Effect.gen(function* () {
      const unroutable: string[] = []
      for (const key of Object.keys(Config.Info.fields)) {
        // The store is empty, so a key that DOES route answers "missing" (or, for a layered key,
        // "name the entry"). Only a key with no arm at all can produce NO_ROUTE.
        const refused = yield* Effect.flip(ConfigStoreWrite.remove([[key]]))
        if (refused.refusals.some((refusal) => refusal.reason.includes(NO_ROUTE))) unroutable.push(key)
      }
      expect(
        unroutable,
        `these Config.Info keys cannot be removed through any surface. Give each a removal arm in ` +
          `config-store-write.ts (settings keys and layered stores route automatically), or add it to ` +
          `REMOVE_REFUSED_KEYS with the operation that DOES work — a bare "you cannot delete this" is ` +
          `the self-healing law failing quietly.`,
      ).toEqual([])
    }),
  )

  /** The ratchet's other direction: a ledger entry for a key that no longer exists is a lie that
   *  outlives its subject, exactly like a stale `NOT_ROUTED_KEYS` row. */
  it.effect("every REMOVE_REFUSED_KEYS entry still names a live Config.Info key", () =>
    Effect.gen(function* () {
      const declared = new Set(Object.keys(Config.Info.fields))
      const stale = [...ConfigStoreWrite.REMOVE_REFUSED_KEYS.keys()].filter((key) => !declared.has(key))
      expect(stale, "drop these ledger entries — the keys are gone").toEqual([])
      return yield* Effect.void
    }),
  )

  /**
   * ⚠️ A refusal with no next step is the failure mode this ledger is most likely to rot into. Each
   * reason has to hand the caller the operation that works, so the check is that it names one.
   */
  it.effect("every refusal reason names an alternative rather than shrugging", () =>
    Effect.gen(function* () {
      for (const [key, reason] of ConfigStoreWrite.REMOVE_REFUSED_KEYS) {
        const redirects =
          reason.includes("PATCH /config") || reason.includes('["providers"') || reason.includes("nothing to remove")
        expect(redirects, `REMOVE_REFUSED_KEYS["${key}"] refuses without naming what to do instead`).toBe(true)
      }
      return yield* Effect.void
    }),
  )
})
