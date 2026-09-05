import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentUsage } from "@novaclaw/core/agent/usage"
import { Database } from "@novaclaw/core/database/database"
import { testEffect } from "./lib/effect"

// The roster's per-minute spend series (owner, 2026-08-21). Driven against a REAL SQLite store, not
// a re-implementation: the rule worth pinning is what the TABLE ends up holding, and the one that
// matters most is what it does NOT hold.

const it = testEffect(Database.layerFromPath(":memory:"))

const MINUTE = 60_000
const at = (minute: number, secondsIn = 0) => minute * MINUTE + secondsIn * 1000

describe("AgentUsage", () => {
  it.effect("a quiet minute is NEVER stored", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // A step that produced nothing — a pure tool call, a refusal, an interrupted turn.
      yield* AgentUsage.record(db, { agent: "theron", generated: 0, at: at(100) })
      yield* AgentUsage.record(db, { agent: "theron", generated: -5, at: at(101) })

      // Not "a row reading 0" — NO ROW. An absent minute means nothing happened; a stored zero would
      // turn an absence into a measurement, and a reader averaging the series would count a sleeping
      // instance as an observed idle one.
      expect(yield* AgentUsage.since(db, { agent: "theron", minute: 0 })).toEqual([])
    }),
  )

  it.effect("steps inside one minute ACCUMULATE rather than overwrite", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // Two steps 12 seconds apart, plus a sub-agent finishing concurrently — all one minute, all
      // this colleague's spend. A last-writer-wins update would under-report exactly when a
      // colleague is busiest.
      yield* AgentUsage.record(db, { agent: "theron", generated: 100, at: at(200, 1) })
      yield* AgentUsage.record(db, { agent: "theron", generated: 30, at: at(200, 13) })
      yield* AgentUsage.record(db, { agent: "theron", generated: 7, at: at(200, 59) })

      expect(yield* AgentUsage.since(db, { agent: "theron", minute: 0 })).toEqual([{ minute: 200, generated: 137 }])
    }),
  )

  it.effect("colleagues never share a bucket", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* AgentUsage.record(db, { agent: "theron", generated: 10, at: at(300) })
      yield* AgentUsage.record(db, { agent: "kallias", generated: 999, at: at(300) })

      // The roster's promise is that each number belongs to the name beside it.
      expect(yield* AgentUsage.since(db, { agent: "theron", minute: 0 })).toEqual([{ minute: 300, generated: 10 }])
    }),
  )

  it.effect("the series is sparse and newest-first, and `since` really cuts", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* AgentUsage.record(db, { agent: "theron", generated: 1, at: at(400) })
      // minute 401 is quiet — and therefore absent, not zero.
      yield* AgentUsage.record(db, { agent: "theron", generated: 2, at: at(402) })

      expect(yield* AgentUsage.since(db, { agent: "theron", minute: 0 })).toEqual([
        { minute: 402, generated: 2 },
        { minute: 400, generated: 1 },
      ])
      expect(yield* AgentUsage.since(db, { agent: "theron", minute: 402 })).toEqual([{ minute: 402, generated: 2 }])
    }),
  )

  it.effect("sinceMany returns every requested agent from one shared series", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* AgentUsage.record(db, { agent: "theron", generated: 4, at: at(700) })
      yield* AgentUsage.record(db, { agent: "kallias", generated: 8, at: at(701) })

      expect(yield* AgentUsage.sinceMany(db, { agents: ["theron", "kallias", "theron"], minute: 700 })).toEqual({
        theron: [{ minute: 700, generated: 4 }],
        kallias: [{ minute: 701, generated: 8 }],
      })
    }),
  )

  it.effect("retiring a colleague forgets its series, so a re-drawn name starts clean", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* AgentUsage.record(db, { agent: "theron", generated: 500, at: at(600) })
      yield* AgentUsage.record(db, { agent: "kallias", generated: 10, at: at(600) })

      yield* AgentUsage.forget(db, "theron")

      // The name goes back in the pool; the next colleague to draw it must not inherit a rate for
      // work it never did.
      expect(yield* AgentUsage.since(db, { agent: "theron", minute: 0 })).toEqual([])
      // And nobody else is touched.
      expect(yield* AgentUsage.since(db, { agent: "kallias", minute: 0 })).toHaveLength(1)
    }),
  )

  it.effect("an unnamed colleague records nothing rather than a blank bucket", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* AgentUsage.record(db, { agent: "", generated: 50, at: at(500) })
      expect(yield* AgentUsage.since(db, { agent: "", minute: 0 })).toEqual([])
    }),
  )
})

describe("the bucket rule", () => {
  it.effect("one definition of a minute, shared by writer and reader", () =>
    Effect.gen(function* () {
      expect(AgentUsage.minuteOf(0)).toBe(0)
      expect(AgentUsage.minuteOf(59_999)).toBe(0)
      expect(AgentUsage.minuteOf(60_000)).toBe(1)
      // Generated = what the model PRODUCED. Prompt ingestion is not work a person recognises.
      expect(AgentUsage.generatedOf({ output: 10, reasoning: 3 })).toBe(13)
      expect(AgentUsage.generatedOf({})).toBe(0)
    }),
  )
})
