import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// KB-V P4 (notes/kb-vector-plan.md): the triple world dies — kb_fact was the RDF-modeled fact
// store the owner dead-ended on 2026-07-18. No in-place data conversion by design: there is no
// production database (pre-release doctrine), and the only real kb_fact content (the synthetic
// rockfacts tier) regenerates into DOCUMENTS via script/kb/generate-rockfacts.ts +
// packages/core/script/kb-vec-seed.ts. Any future corpus enters through the same seed path.
export default {
  id: "20260718150000_drop_kb_fact",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE IF EXISTS \`kb_fact\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
