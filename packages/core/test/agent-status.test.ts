import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentStatus } from "@novaclaw/core/agent-status"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, AgentStatus.node])))

describe("AgentStatus", () => {
  it.effect("round-trips a colleague's line and replaces it on the next sample", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      yield* status.set({ agent: "theron", task: "reviewing the P2P handshake", observed: 1_000 })
      expect(yield* status.get("theron")).toEqual({
        agent: "theron",
        task: "reviewing the P2P handshake",
        observed: 1_000,
      })

      // A sample REPLACES rather than appends — one line per colleague is the whole contract.
      yield* status.set({ agent: "theron", task: "writing the migration", observed: 2_000 })
      expect((yield* status.get("theron"))?.task).toBe("writing the migration")
      expect(yield* status.all()).toHaveLength(1)
    }),
  )

  it.effect("🔴 a retired colleague's line is REMOVABLE, so the next officer on that name inherits none", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      // Officer names come from a fixed pool, so a stale status must leave with the role.
      yield* status.set({ agent: "ghost", task: "reviewing the P2P handshake", observed: 1_000 })
      yield* status.set({ agent: "xenia", task: "drafting the migration", observed: 1_100 })

      yield* status.remove("ghost")

      expect(yield* status.get("ghost")).toBeUndefined()
      expect((yield* status.all()).map((info) => info.agent)).toEqual(["xenia"])
      // CONTROL — a retirement clears the retired id and nothing else.
      expect((yield* status.get("xenia"))?.task).toBe("drafting the migration")
      yield* status.remove("ghost")
      expect(yield* status.all()).toHaveLength(1)
    }),
  )

  it.effect("a colleague with no line at all reads as undefined, not as an empty one", () =>
    Effect.gen(function* () {
      const status = yield* AgentStatus.Service
      expect(yield* status.get("nobody")).toBeUndefined()
    }),
  )
})
