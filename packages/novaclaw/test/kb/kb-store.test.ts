// KB-A — the in-house PoC fact store. CRUD round-trip, provenance survival,
// audit rows on update/retract (dated moves, never destructive), populate/
// backup/clear. Runs on the in-memory DB (preload sets NOVACLAW_DB=:memory:).
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Kb } from "@novaclaw/core/kb"
import { Database } from "@novaclaw/core/database/database"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Kb.defaultLayer, Database.defaultLayer))

const use = <A>(run: (kb: Kb.Interface) => Effect.Effect<A, unknown>) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    const kb = yield* Kb.Service
    return yield* run(kb)
  })

describe("Kb store (KB-A)", () => {
  it.live("add -> query round-trip with provenance", () =>
    use((kb) =>
      Effect.gen(function* () {
        const fact = yield* kb.add({
          subject: "novaclaw",
          predicate: "runs-on",
          object: "dgx-spark",
          source: "test",
          agent: "ses_test",
          confidence: 0.9,
        })
        expect(fact.id.startsWith("fct_")).toBe(true)
        expect(fact.relation).toBe("staged") // agent-written stays distinguishable by default
        const hits = yield* kb.query({ subject: "novaclaw" })
        expect(hits).toHaveLength(1)
        expect(hits[0]).toMatchObject({ predicate: "runs-on", object: "dgx-spark", source: "test", confidence: 0.9 })
      }),
    ),
  )

  it.live("update is a dated move: old row stamped valid_to + superseded_by, provenance carried", () =>
    use((kb) =>
      Effect.gen(function* () {
        const original = yield* kb.add({ subject: "s", predicate: "p", object: "v1", agent: "agent-a", relation: "core" })
        const replaced = yield* kb.update(original.id, { object: "v2" })
        expect(replaced.object).toBe("v2")
        expect(replaced.agent).toBe("agent-a") // provenance survives update
        expect(replaced.relation).toBe("core")
        // active view shows only the replacement
        const active = yield* kb.query({ subject: "s" })
        expect(active).toHaveLength(1)
        expect(active[0]!.id).toBe(replaced.id)
        // the audit chain is intact
        const old = yield* kb.get(original.id)
        expect(old?.validTo).toBeDefined()
        expect(old?.supersededBy).toBe(replaced.id)
      }),
    ),
  )

  it.live("retract stamps valid_to; includeRetracted still sees it; a second retract 404s", () =>
    use((kb) =>
      Effect.gen(function* () {
        const fact = yield* kb.add({ subject: "s", predicate: "p", object: "o" })
        const retracted = yield* kb.retract(fact.id)
        expect(retracted.validTo).toBeDefined()
        expect(yield* kb.query({ subject: "s" })).toHaveLength(0)
        expect(yield* kb.query({ subject: "s", includeRetracted: true })).toHaveLength(1)
        const second = yield* kb.retract(fact.id).pipe(Effect.flip)
        expect(second).toBeInstanceOf(Kb.NotFoundError)
      }),
    ),
  )

  it.live("populate -> stats -> backup -> clear round-trip; backup includes the audit trail", () =>
    use((kb) =>
      Effect.gen(function* () {
        yield* kb.populate([
          { subject: "a", predicate: "is", object: "1", relation: "core" },
          { subject: "b", predicate: "is", object: "2", relation: "core" },
          { subject: "c", predicate: "is", object: "3" },
        ])
        const one = (yield* kb.query({ subject: "a" }))[0]!
        yield* kb.retract(one.id)
        const stats = yield* kb.stats()
        expect(stats).toMatchObject({ total: 3, active: 2, retracted: 1, core: 2, staged: 1, backend: "builtin-sqlite" })
        const backup = yield* kb.backup()
        expect(backup).toHaveLength(3) // retracted rows INCLUDED — that is the point of backup
        const cleared = yield* kb.clear()
        expect(cleared.deleted).toBe(3)
        expect((yield* kb.stats()).total).toBe(0)
      }),
    ),
  )

  it.live("relation filter separates curated core from agent-staged facts", () =>
    use((kb) =>
      Effect.gen(function* () {
        yield* kb.populate([
          { subject: "x", predicate: "p", object: "curated", relation: "core" },
          { subject: "x", predicate: "p", object: "proposed" },
        ])
        expect(yield* kb.query({ subject: "x", relation: "core" })).toHaveLength(1)
        expect(yield* kb.query({ subject: "x", relation: "staged" })).toHaveLength(1)
        expect(yield* kb.query({ subject: "x" })).toHaveLength(2)
      }),
    ),
  )
})
