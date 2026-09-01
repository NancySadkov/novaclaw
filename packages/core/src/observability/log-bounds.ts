export * as LogBounds from "./log-bounds"

/**
 * **The three log bounds a PRODUCT SURFACE is allowed to name — and nothing else.**
 *
 * There is a line here that this module makes structural. Retention is a **preference**:
 * how much history an instance keeps is a thing a user may reasonably want to know and, eventually,
 * to set. Segment size, the flush window, the compression level and the filename grammar are
 * **correctness parameters** — *"they are correctness parameters, not preferences… a knob whose
 * wrong setting is never right"* — and they stay in `log-file.ts`, where nothing outside the writer
 * can reach them.
 *
 * ⚠️ **The mechanical reason this file exists at all is a boundary, not tidiness.** `log-file.ts`
 * imports `node:fs` and `node:zlib` at module scope, so a Settings panel that wanted to say *"kept
 * for at least 30 days"* had exactly two options: import a Node module into the browser bundle, or
 * retype the number. The second is the one-description-twice defect this repo has found roughly a
 * dozen times, and it is worse here than usual — the copy lives in a **user-facing sentence**, so
 * when the writer's bound changes the product starts telling people something false and no test
 * anywhere is about it. This module has no imports at all and is safe in every runtime.
 *
 * ── ⚠️ what these numbers actually promise, MEASURED 2026-08-08 ─────────────────────────────────
 *
 * {@link MAX_AGE_MS} is an approximate history window, not a deadline or an unconditional floor:
 * age deletion only considers sealed segments, so quiet history can survive for roughly twice the
 * window; the independent byte ceiling may remove even a newer sealed segment under heavy traffic.
 * A surface may promise only *"about 30 days when space allows"* plus the hard byte ceiling.
 *
 * 🔴 **And until 2026-08-08 there was no ceiling at all, which the measurement found.**
 * `LogRead.usage` over this machine's two real log directories: **83 KB/day** (3 089 922 B / 872.8 h)
 * and **32 KB/day** (968 034 B / 718.9 h) — and **`segments: 0` for both**. Rotation was size-only,
 * so at 83 KB/day an 8 MB segment takes ~99 days to fill and at 32 KB/day ~256; neither directory
 * had ever rotated, so the sweep had nothing to sweep and every retention rule in the writer was
 * inert. `log-file.ts` now rotates on AGE as well as size — a rate-independent trigger, because the
 * rate is exactly what the measurement showed to be unstable — which bounds the oldest surviving
 * line at about **2 × {@link MAX_AGE_MS}** and, more importantly, makes the floor real.
 *
 * {@link TOTAL_BYTES} is a genuine ceiling — the sweep totals the whole directory including the
 * active segment, and the active segment is independently hard-capped at
 * `SEGMENT_BYTES * ROTATION_STUCK_MULTIPLE`.
 */

/** The whole log directory's byte ceiling, active segment included. A real ceiling. */
export const TOTAL_BYTES = 256 * 1024 * 1024

/**
 * How long history is kept. ⚠️ A FLOOR — see this module's header. Matches Trash's decided
 * retention, so the product tells the user ONE number. Approximate window; see the header.
 */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** {@link MAX_AGE_MS} in days, because every surface that names it wants days. */
export const MAX_AGE_DAYS = MAX_AGE_MS / (24 * 60 * 60 * 1000)
