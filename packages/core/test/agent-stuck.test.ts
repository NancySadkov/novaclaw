import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AgentStuck } from "@novaclaw/core/agent-stuck"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.mergeAll(database, AgentStuck.layer.pipe(Layer.provide(database))))

const agent = "daedalus"
const T0 = 1_790_000_000_000

describe("the officer stuck counter", () => {
  it.effect("counts each detection and forgets a window that is an hour old", () =>
    Effect.gen(function* () {
      const stuck = yield* AgentStuck.Service
      expect(yield* stuck.record(agent, { threshold: 10, now: T0 })).toEqual({ count: 1, escalated: false })
      expect(yield* stuck.record(agent, { threshold: 10, now: T0 + 1_000 })).toEqual({ count: 2, escalated: false })
      expect(yield* stuck.count(agent, T0 + 1_000)).toBe(2)
      // An hour of quiet starts the count over rather than accumulating a day-long streak.
      expect(yield* stuck.record(agent, { threshold: 10, now: T0 + AgentStuck.WINDOW_MS })).toEqual({
        count: 1,
        escalated: false,
      })
    }),
  )

  it.effect("escalates exactly on the threshold and rescues to zero", () =>
    Effect.gen(function* () {
      const stuck = yield* AgentStuck.Service
      expect(yield* stuck.record(agent, { threshold: 3, now: T0 })).toEqual({ count: 1, escalated: false })
      expect(yield* stuck.record(agent, { threshold: 3, now: T0 + 1 })).toEqual({ count: 2, escalated: false })
      expect(yield* stuck.record(agent, { threshold: 3, now: T0 + 2 })).toEqual({ count: 3, escalated: true })
      // The crossing resets the counter, so the next loop gets a fresh budget.
      expect(yield* stuck.count(agent, T0 + 2)).toBe(0)
    }),
  )

  it.effect("keeps one window per officer", () =>
    Effect.gen(function* () {
      const stuck = yield* AgentStuck.Service
      yield* stuck.record(agent, { threshold: 10, now: T0 })
      yield* stuck.record("geryon", { threshold: 10, now: T0 })
      expect(yield* stuck.record("geryon", { threshold: 10, now: T0 + 1 })).toEqual({ count: 2, escalated: false })
      expect(yield* stuck.count(agent, T0 + 1)).toBe(1)
    }),
  )
})
