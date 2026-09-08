import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { NudgeService } from "@novaclaw/core/nudge-service"
import { Nudge } from "@novaclaw/core/nudge"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SettingsConfigStore.node, NudgeService.node])),
)

describe("NudgeService", () => {
  it.effect("reads shipped defaults live and claims one occurrence once", () =>
    Effect.gen(function* () {
      const service = yield* NudgeService.Service
      const event = {
        type: "tool" as const,
        id: "call-1",
        name: "write",
        input: { content: "const elapsed = endedAt - startedAt" },
      }
      expect((yield* service.claim({ sessionID: "ses_a", agentID: "nova", event })).map((item) => item.id)).toEqual([
        Nudge.JAVASCRIPT_TIME_ID,
      ])
      expect(yield* service.claim({ sessionID: "ses_a", agentID: "nova", event })).toEqual([])
      expect(
        yield* service.claim({ sessionID: "ses_a", agentID: "nova", event: { ...event, id: "call-2" } }),
      ).toHaveLength(1)

      const raced = yield* Effect.all(
        Array.from({ length: 8 }, () => service.claim({ sessionID: "ses_race", agentID: "nova", event })),
        { concurrency: "unbounded" },
      )
      expect(raced.reduce((count, batch) => count + batch.length, 0)).toBe(1)
    }),
  )

  it.effect("a stored list replaces defaults and an edit applies without rebuilding the layer", () =>
    Effect.gen(function* () {
      const service = yield* NudgeService.Service
      const settings = yield* SettingsConfigStore.Service
      const event = { type: "tool" as const, id: "call-1", name: "bash", input: {} }
      yield* settings.set("nudges", [])
      expect(yield* service.claim({ sessionID: "ses_b", agentID: "nova", event })).toEqual([])

      yield* settings.set("nudges", [
        {
          id: "bash-check",
          name: "Bash check",
          enabled: true,
          agents: ["writer"],
          hook: { type: "tool-call", tool: "bash" },
          text: "Check the command.",
        },
      ])
      expect(yield* service.claim({ sessionID: "ses_b", agentID: "nova", event })).toEqual([])
      expect((yield* service.claim({ sessionID: "ses_b", agentID: "writer", event })).map((item) => item.id)).toEqual([
        "bash-check",
      ])
    }),
  )
})
