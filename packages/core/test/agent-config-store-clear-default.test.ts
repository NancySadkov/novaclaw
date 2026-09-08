import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

// `AgentConfigStore.clearDefault` (2026-07-28), added with the `agent.remove` route. The gap it
// closes: `default_agent` was WRITE-ONLY through the config surface — `PATCH /config` routes it
// through `mergePatch`, which has no null-deletion, and `Config.Info.default_agent` is a plain
// optional string — so a ref left pointing at a deleted agent could never be unset by an agent
// repairing its own instance (AGENTS.md → *We promote self-healing*).
//
// The subtle half is the same one `catalog-store-remove.test.ts:48` pins for the default MODEL
// ref: clearing must delete the ROW. An empty-string default is still a value, and would block
// `setDefaultIfEmpty` from ever seeding again.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, AgentConfigStore.node])))
const decodeAgent = Schema.decodeUnknownSync(ConfigAgent.Info)

const defaultAgentRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const row = (yield* db
    .get(sql`SELECT count(*) AS count FROM agent_setting WHERE key = 'default_agent'`)
    .pipe(Effect.orDie)) as { count: number }
  return row.count
})

describe("AgentConfigStore.clearDefault", () => {
  it.effect("removes the ref AND its row, so setDefaultIfEmpty seeds again afterwards", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      yield* store.setLayers("reviewer", [decodeAgent({ description: "review things" })])
      yield* store.setDefault("reviewer")
      yield* store.removeAgent("reviewer")
      expect(yield* store.isEmpty()).toBe(true)

      // Removing the agent does not itself prune the ref — the store does not guess, the route
      // decides (`server/src/handlers/agent.ts`). THIS is the dangling state that reads as
      // configured and resolves to nothing.
      expect(yield* store.getDefault()).toBe("reviewer")
      expect(yield* defaultAgentRows).toBe(1)

      yield* store.clearDefault()
      expect(yield* store.getDefault()).toBeUndefined()
      expect(yield* defaultAgentRows).toBe(0)

      yield* store.setDefaultIfEmpty("build")
      expect(yield* store.getDefault()).toBe("build")
      expect(yield* defaultAgentRows).toBe(1)
    }),
  )

  it.effect("clearing when nothing is set is a no-op, and leaves other agent settings alone", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      const { db } = yield* Database.Service
      // A second agent_setting key stands in for the "future agent settings need no migration"
      // shape the table was built for — a clear that took the whole table would pass every
      // assertion above and still be wrong.
      yield* db
        .run(
          sql`INSERT INTO agent_setting (key, value, time_created, time_updated)
                 VALUES ('unrelated', '"keep me"', 0, 0)`,
        )
        .pipe(Effect.orDie)

      yield* store.clearDefault()
      expect(yield* store.getDefault()).toBeUndefined()

      const survivor = (yield* db
        .get(sql`SELECT count(*) AS count FROM agent_setting WHERE key = 'unrelated'`)
        .pipe(Effect.orDie)) as { count: number }
      expect(survivor.count).toBe(1)
    }),
  )
})
