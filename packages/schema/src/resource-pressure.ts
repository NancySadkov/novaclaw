export * as ResourcePressure from "./resource-pressure"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

/**
 * The `resource_pressure` config field: the two lines the Storage subsystem draws across memory and
 * disk headroom. `todo/resource-pressure.md`.
 *
 * WHY IT IS A CONFIG FIELD AND NOT A CONSTANT. The host running NovaClaw *will* run out of memory or
 * disk — twice already on the owner's own box (AGENTS.md pitfalls #1 and #8b) — and the right line is
 * host-specific: a 15.7 GB laptop with a 44.7 GB commit limit and a 128 GB Spark do not want the same
 * number. The defaults live beside the probe (`storage/pressure.ts` `DEFAULT_THRESHOLDS`) so a
 * consumer that never reads config still gets a real line; this schema only describes the override.
 *
 * ⚠️ **PRIVILEGE TIER: CONSEQUENTIAL at minimum, never operational** (todo.md ruling 4). An agent that
 * can lower its own floor to keep working has exempted itself from the guard — that is a self-DoS
 * vector wearing a repair's clothes, and the guard exists precisely for the case where the agent's own
 * judgement is what filled the disk. Raising a floor is harmless; lowering one disarms the mechanism,
 * and a tier is per-key, not per-direction. The per-key tier table itself is `core/config-tier.ts` —
 * this comment states what the key NEEDS, it does not classify it.
 *
 * SHAPE. Two keys — `warning` and `floor` — each carrying one line per resource, rather than four flat
 * keys, so "which line am I setting" is one word and the two lines cannot drift into different shapes.
 * Every field is optional and falls back to `DEFAULT_THRESHOLDS` per-field: a user who only cares about
 * disk writes `{floor: {disk_free_bytes: …}}` and keeps the shipped memory line.
 */

/** A fraction of a measured limit. Excludes 0 — a floor of 0 is not a strict setting, it is a disabled one. */
const Fraction = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))

export const Level = Schema.Struct({
  /**
   * Memory line, as a fraction of the host's COMMIT limit that is already committed.
   *
   * ⚠️ Commit charge, never working set or free RAM (AGENTS.md pitfall #8b): a Windows box reports a
   * healthy-looking working set while commit is exhausted, and "the box works at 99% commit for a day
   * before dying" is a measured fact here, not a caution.
   */
  memory_used_fraction: Fraction.pipe(Schema.optional),
  /**
   * Disk line, as free bytes remaining on the volume holding an instance path. Absolute rather than a
   * fraction because what a download needs is bytes: "you have 400 MB" is actionable, "you have 3%" is not.
   */
  disk_free_bytes: NonNegativeInt.pipe(Schema.optional),
})
export type Level = typeof Level.Type

export const Info = Schema.Struct({
  /** Crossed: say so. Nothing is refused. */
  warning: Level.pipe(Schema.optional),
  /** Crossed: stop admitting new work and say why. Never silently. */
  floor: Level.pipe(Schema.optional),
}).annotate({ identifier: "ResourcePressure" })
export type Info = typeof Info.Type
