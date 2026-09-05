export * as JhController from "./controller"

import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Text = Schema.UndefinedOr(Schema.String)
const Counts = Schema.ReadonlyMap(Schema.String, Count)
const Names = Schema.ReadonlySet(Schema.String)
// The initial score is -Infinity. The JSON codec preserves that sentinel as a string instead of
// JSON.stringify's lossy null; other non-finite scores are never legitimate controller state.
const Score = Schema.Number.check(Schema.makeFilter((n) => Number.isFinite(n) || n === -Infinity))
const Scores = Schema.ReadonlyMap(Schema.String, Score)
const Files = Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String }))
export const Products = Schema.Struct({
  products: Schema.Array(
    Schema.Tuple([Schema.String, Schema.Struct({ command: Schema.String, sourceDigest: Schema.String })]),
  ),
  sources: Schema.Array(Schema.String),
})
export type Products = typeof Products.Type
export const Tests = Schema.Array(
  Schema.Struct({
    command: Schema.String,
    expect: Schema.optional(Schema.String),
    depsDigest: Schema.String,
    failures: Count,
    suspect: Schema.Boolean,
    unsanitized: Schema.Boolean,
  }),
)

// Every mutable controller field lives here. Required fields and a versioned decoder prevent an
// incomplete checkpoint from masquerading as a fresh, safe controller. Resources/callbacks and the
// completion-verifier latch are deliberately reconstructed; the latter must pass again on resume.
export const State = Schema.Struct({
  version: Schema.Literal(1),
  lastBlockReason: Text,
  lastRunOutput: Schema.String,
  staleness: Schema.UndefinedOr(Products),
  regression: Schema.UndefinedOr(Tests),
  bestScore: Score,
  bestSnapshot: Schema.UndefinedOr(Files),
  bestSuiteGreen: Schema.Int,
  lastSweepGreen: Count,
  scoreStagnant: Count,
  numericsArmed: Schema.Boolean,
  pendingNumericsHint: Text,
  dropStreak: Count,
  pendingDropRestore: Schema.Boolean,
  pendingOracleHint: Text,
  oracleHintArmed: Schema.Boolean,
  oracleDone: Schema.Boolean,
  lastGreenFiles: Schema.UndefinedOr(Schema.ReadonlyMap(Schema.String, Schema.String)),
  editMisses: Counts,
  coordLocked: Names,
  editMissesTotal: Counts,
  neverGreenFails: Schema.ReadonlyMap(
    Schema.String,
    Schema.Struct({ detail: Schema.String, count: Count, lastDigest: Schema.String }),
  ),
  neverGreenGrown: Names,
  scoreAtFirstFail: Scores,
  testFixGrown: Names,
  gateRejects: Counts,
  ladders: Schema.ReadonlyMap(
    Schema.String,
    Schema.Struct({
      sig: Schema.String,
      count: Count,
      stage: Schema.Literals(["tweak", "analyze", "targeted_fix", "rewrite"]),
      rewrites: Count,
    }),
  ),
  lastFixBest: Scores,
  analyzeNodes: Names,
  rederivePressure: Counts,
  rederived: Names,
  buildDamage: Count,
  autoRevertFailed: Schema.Boolean,
  pendingRevertMessage: Text,
  firedBudget: Schema.ReadonlySet(Schema.Finite),
  gateChecks: Count,
  gateSpentLogged: Schema.Boolean,
  goalCheckCache: Schema.ReadonlyMap(
    Schema.String,
    Schema.Struct({ achieved: Schema.Boolean, missing: Schema.String, evidenceFault: Schema.Boolean }),
  ),
  leaves: Schema.ReadonlyMap(
    Schema.String,
    Schema.Struct({
      errorCounts: Counts,
      lastFailDigest: Text,
      lastFailDetail: Schema.String,
      budget: Count,
    }),
  ),
  guard: Count,
  elapsedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type State = typeof State.Type
type Mutable<T> =
  T extends ReadonlyMap<infer K, infer V>
    ? Map<K, Mutable<V>>
    : T extends ReadonlySet<infer V>
      ? Set<V>
      : T extends ReadonlyArray<unknown>
        ? T
        : T extends object
          ? { -readonly [K in keyof T]: Mutable<T[K]> }
          : T
export type Controller = Mutable<State>
const codec = Schema.toCodecJson(State)
export const encode = Schema.encodeSync(codec)
export const decode = Schema.decodeUnknownSync(codec)
export const clone = (value: State): Controller => decode(encode(value)) as Controller

export const create = (): Controller => ({
  version: 1,
  lastBlockReason: undefined,
  lastRunOutput: "",
  staleness: undefined,
  regression: undefined,
  bestScore: -Infinity,
  bestSnapshot: undefined,
  bestSuiteGreen: -1,
  lastSweepGreen: 0,
  scoreStagnant: 0,
  numericsArmed: true,
  pendingNumericsHint: undefined,
  dropStreak: 0,
  pendingDropRestore: false,
  pendingOracleHint: undefined,
  oracleHintArmed: true,
  oracleDone: false,
  lastGreenFiles: undefined,
  editMisses: new Map(),
  coordLocked: new Set(),
  editMissesTotal: new Map(),
  neverGreenFails: new Map(),
  neverGreenGrown: new Set(),
  scoreAtFirstFail: new Map(),
  testFixGrown: new Set(),
  gateRejects: new Map(),
  ladders: new Map(),
  lastFixBest: new Map(),
  analyzeNodes: new Set(),
  rederivePressure: new Map(),
  rederived: new Set(),
  buildDamage: 0,
  autoRevertFailed: false,
  pendingRevertMessage: undefined,
  firedBudget: new Set(),
  gateChecks: 0,
  gateSpentLogged: false,
  goalCheckCache: new Map(),
  leaves: new Map(),
  guard: 0,
  elapsedMs: 0,
})
