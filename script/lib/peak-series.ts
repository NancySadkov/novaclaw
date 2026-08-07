/**
 * The per-unit peak-vs-profile delta, kept as a SERIES instead of an anecdote.
 *
 * ─── why this exists ────────────────────────────────────────────────────────────────────────────
 *
 * `test.ts` already MEASURES this. Its `── peak memory (MB) ──` block compares each unit's sampled
 * peak against `test-baseline.json`'s hand-maintained `peaks` profile and prints a verdict — it once
 * printed `core 7755` against a 1 007 MB profile with *"that is a real jump, look at it"* beside it.
 * The detector is not the gap. The gap is that the print is **per-run and ephemeral**, so the only
 * question anybody actually wants answered — *does gate degradation accumulate across consecutive
 * runs?* — has never had more than one data point at a time to answer it with.
 *
 * So this module does not detect anything. It appends what the detector already found, one row per
 * unit per run, and the accumulation question becomes a `grep` over a file.
 *
 * ─── three decisions worth stating, because each one has a way of being got wrong ───────────────
 *
 *  1. **The verdict is imported, never re-derived.** `regressed` comes from `MemoryPlan.peakRegressed`
 *     — the same predicate the printed block uses. A series that disagreed with the line printed
 *     beside it would be two answers to one question, which is exactly the shape `ledger-drift.ts`
 *     exists to record as a mistake we have already made once.
 *  2. **Scope rides every row.** A `--only=schema` run and a full gate are not points on the same
 *     series: the unit ran with a different set of neighbours, and neighbours are the whole subject
 *     when the question is about accumulation. A reader who cannot tell them apart will average them.
 *  3. **A missing peak is `null`, not an absent row.** `test.ts` DISCARDS an implausible sample (a
 *     stray `bun` inflated `core` to 12 014 MB once), and a sharded or crashed unit can produce none
 *     at all. Dropping those rows would make a run with an unmeasurable unit look like a run where
 *     that unit was fine; a null says which.
 *
 * ⚠️ **Nothing here may fail the gate.** Writing a log is not the gate's job, and an instrument that
 * can take down the thing it measures is worse than no instrument. `append` reports its failure as a
 * value and `test.ts` prints it as a warning — the same rule the logging program states for the
 * instance ("logging must never take the instance down"), applied to the gate itself.
 *
 * ⚠️ **This module never writes `test-baseline.json`.** The profile stays hand-maintained on purpose:
 * an auto-updating baseline ratchets to whatever the machine did last, which is the opposite of a
 * profile. This is an observation log *beside* it.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { peakRegressed } from "./memory-plan"

/** One unit's outcome, as much of it as a series row needs. `test.ts`'s `Result` satisfies this. */
export interface Observation {
  readonly name: string
  readonly kind: "test" | "typecheck"
  readonly ok: boolean
  readonly ms: number
  /** Absent when the sampler caught nothing, or when the sample was discarded as implausible. */
  readonly peakMb?: number
  /** Absent unless memory pressure forced the degraded rung. */
  readonly shards?: number
}

export interface Row {
  /** The RUN stamp — identical across every row of one invocation, so a run is one `grep`. */
  readonly run: string
  /** `"default"` · `"full"` · `"only=<x>"`. Rows from different scopes are not comparable. */
  readonly scope: string
  readonly unit: string
  readonly kind: "test" | "typecheck"
  readonly ok: boolean
  readonly ms: number
  /** 1 for a whole run. A sharded peak is one shard's, which measures close to the whole. */
  readonly shards: number
  /** Observed peak, or null when nothing believable was sampled. */
  readonly peakMb: number | null
  /** The hand-maintained profile figure, or null when this unit is not in it yet. */
  readonly profileMb: number | null
  /** `peakMb - profileMb`, in MB. Null whenever either side is. */
  readonly deltaMb: number | null
  /** `peakMb / profileMb`, 3 dp. Null whenever either side is. */
  readonly ratio: number | null
  /** `MemoryPlan.peakRegressed` — the SAME verdict the run printed. Null when it has no inputs. */
  readonly regressed: boolean | null
}

/**
 * How this invocation was scoped.
 *
 * A plain string rather than a tagged union because the file is read by people with `grep` at least
 * as often as by code, and `"only=schema"` is legible where `{"scope":"only","unit":"schema"}` is a
 * second thing to explain.
 */
export const scopeLabel = (full: boolean, only: string | undefined): string =>
  only !== undefined ? `only=${only}` : full ? "full" : "default"

/** The series file. Under `tmp/`, which the app repo gitignores — the gate writes no tracked artifact. */
export const seriesPath = (repoRoot: string): string => join(repoRoot, "tmp", "peak-series.jsonl")

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** One row. Pure: every derived field is a function of the two numbers above it. */
export function buildRow(
  run: string,
  scope: string,
  observation: Observation,
  profile: Readonly<Record<string, number>>,
): Row {
  const peakMb = Number.isFinite(observation.peakMb) ? (observation.peakMb as number) : null
  const fromProfile = profile[observation.name]
  // A zero or negative profile entry is not a baseline, it is a typo — treat it as absent rather than
  // dividing by it. `readPeaks()` already filters these out; this holds if that ever stops being true.
  const profileMb = typeof fromProfile === "number" && Number.isFinite(fromProfile) && fromProfile > 0 ? fromProfile : null
  const comparable = peakMb !== null && profileMb !== null
  return {
    run,
    scope,
    unit: observation.name,
    kind: observation.kind,
    ok: observation.ok,
    ms: observation.ms,
    shards: observation.shards ?? 1,
    peakMb,
    profileMb,
    deltaMb: comparable ? peakMb - profileMb : null,
    ratio: comparable ? round3(peakMb / profileMb) : null,
    regressed: comparable ? peakRegressed(profileMb, peakMb) : null,
  }
}

/**
 * Rows for one run.
 *
 * ⚠️ **Test units only.** A typecheck unit is never sampled at all (`test.ts` takes a window only for
 * `kind === "test"`), so including them would append sixteen all-null rows per run — noise that makes
 * the file harder to read and says nothing. `kind` still rides each row so a typecheck row would be
 * unambiguous if that ever changes.
 */
export const buildRows = (
  run: string,
  scope: string,
  observations: readonly Observation[],
  profile: Readonly<Record<string, number>>,
): Row[] => observations.filter((o) => o.kind === "test").map((o) => buildRow(run, scope, o, profile))

/** JSONL: one row per line, trailing newline, so a plain `>>` append is well-formed. */
export const format = (rows: readonly Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"

export type AppendOutcome =
  | { readonly ok: true; readonly path: string; readonly rows: number }
  | { readonly ok: false; readonly path: string; readonly reason: string }

/**
 * Append the rows, or say why not.
 *
 * 🔴 **Never throws.** A full disk, a locked file, a `tmp/` that could not be created — every one of
 * them degrades to a returned reason. The gate's exit code is about the tests, and it must not
 * acquire a new way to go red that has nothing to do with them.
 */
export function append(path: string, rows: readonly Row[]): AppendOutcome {
  if (rows.length === 0) return { ok: true, path, rows: 0 }
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, format(rows), "utf8")
    return { ok: true, path, rows: rows.length }
  } catch (error) {
    return { ok: false, path, reason: error instanceof Error ? error.message : String(error) }
  }
}
