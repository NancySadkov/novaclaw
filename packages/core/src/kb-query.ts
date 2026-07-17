export * as KbQuery from "./kb-query"

// KB-E — the pure query engine behind the `kb` tool (design: notes/kb-query-language.md §4;
// validated at 96% on the qwen harness by script/kb/nova-query-eval.ts, which this ports).
//
// Six ops over an in-memory triple index — find · get · predicates · neighbors · count ·
// match — where the ENGINE owns label→slug resolution, joins, and predicate enumeration.
// The five design rules baked in:
//   1. entities are addressed BY LABEL — the model never authors an id/slug it can't recall;
//   2. predicates are a closed-vocabulary PICK — an unknown predicate error lists the valid ones;
//   3. a hop is "from THIS entity, follow one predicate" (`neighbors`); `match` stays the
//      declarative escape hatch with engine-side label-aware joins;
//   4. results are LINEARIZED text lines, never nested JSON;
//   5. errors are readable and carry nearest valid alternatives, so the model's retry IS the
//      repair loop (a wrong query is result text upstream, never an infra failure).
//
// Pure over an injected fact list: no services, no IO — the tool layer feeds it the active
// fact set (KB-A facade today; the KB-C SPARQL compiler replaces the FEED, not this surface).

import { Schema } from "effect"

export interface Triple {
  readonly s: string
  readonly p: string
  readonly o: string
}

// Above this many active facts the in-process index/match approach is the wrong tool — the
// caller should refuse with a readable error instead of OOMing (the KB-C engine hook).
export const MAX_FACTS = 200_000

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const NEAREST = 5

// --- the op vocabulary (doubles as the tool's input schema) -----------------------------------

export const Pattern = Schema.Tuple([Schema.String, Schema.String, Schema.String]).annotate({
  description: 'A [subject, predicate, object] pattern; each term is a label/value or a "?variable".',
})
export type Pattern = typeof Pattern.Type

// One flat struct discriminated by `op` (the shape the eval validated): a closed op enum plus
// per-op fields, with op-specific requirements enforced by `exec` as readable repair text —
// a missing field must feed the model's retry, not surface as a schema-decode failure.
export const Op = Schema.Struct({
  op: Schema.Literals(["find", "get", "predicates", "neighbors", "count", "match"]).annotate({
    description:
      "find = look up entities by (partial) label · get = all facts of one entity · predicates = the valid predicates on an entity · neighbors = one hop from an entity along a predicate · count = how many matches · match = conjunctive pattern query.",
  }),
  label: Schema.String.pipe(Schema.optional).annotate({
    description: 'find: the (partial) display name to look up, e.g. "Korvath Dreyne".',
  }),
  entity: Schema.String.pipe(Schema.optional).annotate({
    description: "get/predicates/neighbors: the entity, by display name (the engine resolves names to ids).",
  }),
  predicate: Schema.String.pipe(Schema.optional).annotate({
    description: 'neighbors: the predicate to follow, e.g. "member_of". Omit to follow every predicate.',
  }),
  direction: Schema.Literals(["out", "in"])
    .pipe(Schema.optional)
    .annotate({
      description:
        'neighbors: "out" (default) follows the entity\'s own facts; "in" finds entities pointing AT it.',
    }),
  find: Schema.Array(Schema.String)
    .pipe(Schema.optional)
    .annotate({
      description: 'match: the "?variables" to return, e.g. ["?city"]. Defaults to every variable bound.',
    }),
  where: Schema.Array(Pattern)
    .pipe(Schema.optional)
    .annotate({
      description:
        'match/count: the patterns to satisfy together — chain them to join, e.g. [["Korvath Dreyne","member_of","?band"],["?band","origin_city","?city"]].',
    }),
  limit: Schema.Int.pipe(Schema.optional).annotate({
    description: "Maximum result lines (default 100).",
  }),
}).annotate({ identifier: "KbQuery.Op" })
export type Op = typeof Op.Type

// --- the index ---------------------------------------------------------------------------------

export interface Index {
  readonly triples: ReadonlyArray<Triple>
  readonly slugSet: ReadonlySet<string>
  /** lowercased display name (from `name` facts) → slug */
  readonly nameToSlug: ReadonlyMap<string, string>
  /** slug → display name — "labels out": subjects/slugs render as names wherever one exists */
  readonly slugToName: ReadonlyMap<string, string>
  readonly bySubject: ReadonlyMap<string, ReadonlyArray<Triple>>
  readonly predicates: ReadonlySet<string>
}

export function buildIndex(triples: ReadonlyArray<Triple>): Index {
  const slugSet = new Set<string>()
  const nameToSlug = new Map<string, string>()
  const slugToName = new Map<string, string>()
  const bySubject = new Map<string, Triple[]>()
  const predicates = new Set<string>()
  for (const t of triples) {
    slugSet.add(t.s)
    predicates.add(t.p)
    const list = bySubject.get(t.s)
    if (list) list.push(t)
    else bySubject.set(t.s, [t])
    if (t.p === "name") {
      if (!nameToSlug.has(t.o.toLowerCase())) nameToSlug.set(t.o.toLowerCase(), t.s)
      if (!slugToName.has(t.s)) slugToName.set(t.s, t.o)
    }
  }
  return { triples, slugSet, nameToSlug, slugToName, bySubject, predicates }
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/** slug → display name where one exists; every output line goes through this ("labels out"). */
export const labelOf = (index: Index, value: string): string => index.slugToName.get(value) ?? value

// Resolve a value used as a SUBJECT to its canonical slug: pass slugs through; map names → slug.
// This hides the name→slug indirection that killed every human query language on 2-hop.
const toSubject = (index: Index, value: string): string => {
  if (index.slugSet.has(value)) return value
  const bySlug = slugify(value)
  if (index.slugSet.has(bySlug)) return bySlug
  return index.nameToSlug.get(value.toLowerCase()) ?? value
}

export function resolveEntity(
  index: Index,
  value: string,
): { ok: true; slug: string } | { ok: false; nearest: ReadonlyArray<string> } {
  const slug = toSubject(index, value)
  if (index.slugSet.has(slug)) return { ok: true, slug }
  return { ok: false, nearest: nearestLabels(index, value) }
}

// Levenshtein-lite candidate ranking: exact → slug-exact → prefix → contains → shared word,
// deterministic (score, then label). Scans display names — the vocabulary the model speaks.
function nearestLabels(index: Index, value: string): string[] {
  const query = value.toLowerCase()
  const querySlug = slugify(value)
  const queryWords = new Set(query.split(/[^a-z0-9]+/).filter((w) => w.length > 2))
  const scored: Array<{ label: string; score: number }> = []
  for (const [lower, slug] of index.nameToSlug) {
    const label = index.slugToName.get(slug) ?? lower
    let score: number
    if (lower === query) score = 0
    else if (slugify(lower) === querySlug && querySlug !== "") score = 1
    else if (lower.startsWith(query)) score = 2
    else if (lower.includes(query)) score = 3
    else {
      const words = lower.split(/[^a-z0-9]+/)
      if (!words.some((w) => queryWords.has(w))) continue
      score = 4
    }
    scored.push({ label, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
    .slice(0, NEAREST)
    .map((entry) => entry.label)
}

// --- the conjunctive matcher (ported verbatim from the validated eval) --------------------------

const isVar = (term: string) => term.startsWith("?")

const factsOf = (index: Index, subject: string): ReadonlyArray<Triple> =>
  index.bySubject.get(toSubject(index, subject)) ?? []

// Conjunctive match with LABEL-AWARE subject resolution: a bound/const subject that is a name
// resolves to its slug before matching, so multi-hop joins through name→slug just work.
function computeBindings(index: Index, where: ReadonlyArray<Pattern>): Array<Record<string, string>> {
  let bindings: Array<Record<string, string>> = [{}]
  for (const [ps, pp, po] of where) {
    const next: Array<Record<string, string>> = []
    for (const binding of bindings) {
      const subjVal = isVar(ps) ? binding[ps] : ps
      const candidates = subjVal !== undefined ? factsOf(index, subjVal) : index.triples
      for (const t of candidates) {
        const nb = { ...binding }
        if (!unify(index, ps, t.s, nb, true)) continue
        if (!unify(index, pp, t.p, nb, false)) continue
        if (!unify(index, po, t.o, nb, false)) continue
        next.push(nb)
      }
    }
    bindings = next
  }
  return bindings
}

function runMatch(index: Index, where: ReadonlyArray<Pattern>, find: ReadonlyArray<string>, limit: number): string[] {
  const bindings = computeBindings(index, where)
  const out: string[] = []
  const seen = new Set<string>()
  for (const binding of bindings) {
    for (const variable of find.length ? find : Object.keys(binding)) {
      const value = binding[variable]
      if (value === undefined) continue
      const labeled = labelOf(index, value)
      if (!seen.has(variable + "\x00" + labeled)) {
        seen.add(variable + "\x00" + labeled)
        out.push(labeled)
      }
    }
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

function unify(index: Index, term: string, value: string, binding: Record<string, string>, subjectPos: boolean): boolean {
  if (isVar(term)) {
    const bound = binding[term]
    if (bound === undefined) {
      binding[term] = value
      return true
    }
    return subjectPos ? toSubject(index, bound) === toSubject(index, value) : bound === value
  }
  return subjectPos ? toSubject(index, term) === toSubject(index, value) : term === value
}

// --- exec ----------------------------------------------------------------------------------------

export type Result = { ok: true; lines: ReadonlyArray<string> } | { ok: false; error: string }

const failure = (error: string): Result => ({ ok: false, error })
const success = (lines: ReadonlyArray<string>): Result => ({ ok: true, lines })

const unknownEntity = (index: Index, value: string, nearest: ReadonlyArray<string>): string =>
  nearest.length
    ? `Unknown entity "${value}". Nearest labels: ${nearest.join(" · ")}.`
    : `Unknown entity "${value}" and nothing similar — use {"op":"find","label":...} with a shorter fragment.`

const clampLimit = (limit: number | undefined) =>
  Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)), MAX_LIMIT)

export function exec(index: Index, op: Op): Result {
  const limit = clampLimit(op.limit)
  switch (op.op) {
    case "find": {
      if (op.label === undefined) return failure('The op "find" needs a "label" field: {"op":"find","label":"Korvath Dreyne"}.')
      const query = op.label.toLowerCase()
      const querySlug = slugify(op.label)
      const scored: Array<{ label: string; score: number }> = []
      for (const [lower, slug] of index.nameToSlug) {
        const label = index.slugToName.get(slug) ?? lower
        if (lower === query) scored.push({ label, score: 0 })
        else if (slugify(lower) === querySlug && querySlug !== "") scored.push({ label, score: 1 })
        else if (lower.startsWith(query)) scored.push({ label, score: 2 })
        else if (lower.includes(query)) scored.push({ label, score: 3 })
      }
      if (scored.length === 0) {
        const nearest = nearestLabels(index, op.label)
        return failure(
          nearest.length
            ? `No entity label matches "${op.label}". Nearest labels: ${nearest.join(" · ")}.`
            : `No entity label matches "${op.label}" — try a shorter fragment.`,
        )
      }
      return success(
        scored
          .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
          .slice(0, limit)
          .map((entry) => entry.label),
      )
    }
    case "get": {
      if (op.entity === undefined) return failure('The op "get" needs an "entity" field: {"op":"get","entity":"The Velvet Corvids"}.')
      const resolved = resolveEntity(index, op.entity)
      if (!resolved.ok) return failure(unknownEntity(index, op.entity, resolved.nearest))
      return success(
        factsOf(index, resolved.slug)
          .slice(0, limit)
          .map((t) => `${t.p}: ${labelOf(index, t.o)}`),
      )
    }
    case "predicates": {
      if (op.entity === undefined)
        return failure('The op "predicates" needs an "entity" field: {"op":"predicates","entity":"The Velvet Corvids"}.')
      const resolved = resolveEntity(index, op.entity)
      if (!resolved.ok) return failure(unknownEntity(index, op.entity, resolved.nearest))
      return success([...new Set(factsOf(index, resolved.slug).map((t) => t.p))].sort())
    }
    case "neighbors": {
      if (op.entity === undefined)
        return failure(
          'The op "neighbors" needs an "entity" field: {"op":"neighbors","entity":"Korvath Dreyne","predicate":"member_of"}.',
        )
      const resolved = resolveEntity(index, op.entity)
      if (!resolved.ok) return failure(unknownEntity(index, op.entity, resolved.nearest))
      const direction = op.direction ?? "out"
      if (direction === "out") {
        const facts = factsOf(index, resolved.slug)
        if (op.predicate !== undefined && !facts.some((t) => t.p === op.predicate)) {
          const valid = [...new Set(facts.map((t) => t.p))].sort()
          return failure(
            `"${labelOf(index, resolved.slug)}" has no predicate "${op.predicate}". Its predicates: ${valid.join(" · ")}.`,
          )
        }
        const out: string[] = []
        const seen = new Set<string>()
        for (const t of facts) {
          if (op.predicate !== undefined && t.p !== op.predicate) continue
          const labeled = labelOf(index, t.o)
          if (seen.has(labeled)) continue
          seen.add(labeled)
          out.push(labeled)
          if (out.length >= limit) break
        }
        return success(out)
      }
      if (op.predicate !== undefined && !index.predicates.has(op.predicate)) {
        const valid = [...index.predicates].sort().filter((p) => p.includes(slugify(op.predicate ?? "")) || slugify(op.predicate ?? "").includes(p))
        return failure(
          valid.length
            ? `No predicate "${op.predicate}" in this KB. Did you mean: ${valid.slice(0, NEAREST).join(" · ")}?`
            : `No predicate "${op.predicate}" in this KB. Valid predicates: ${[...index.predicates].sort().slice(0, 20).join(" · ")}.`,
        )
      }
      const slug = resolved.slug
      const out: string[] = []
      const seen = new Set<string>()
      for (const t of index.triples) {
        if (op.predicate !== undefined && t.p !== op.predicate) continue
        if (toSubject(index, t.o) !== slug) continue
        const labeled = labelOf(index, t.s)
        if (seen.has(labeled)) continue
        seen.add(labeled)
        out.push(labeled)
        if (out.length >= limit) break
      }
      return success(out)
    }
    case "count": {
      if (op.where === undefined || op.where.length === 0)
        return failure('The op "count" needs a "where" field: {"op":"count","where":[["?b","genre","doom metal"]]}.')
      // Count distinct RAW binding values (the eval's semantics) — labeling is for display only.
      return success([String(new Set(rawMatch(index, op.where, op.find ?? [])).size)])
    }
    case "match": {
      if (op.where === undefined || op.where.length === 0)
        return failure(
          'The op "match" needs a "where" field: {"op":"match","find":["?city"],"where":[["Korvath Dreyne","member_of","?band"],["?band","origin_city","?city"]]}.',
        )
      return success(runMatch(index, op.where, op.find ?? [], limit))
    }
  }
}

// The eval's count path: distinct raw values across bindings, unbounded by the display limit.
function rawMatch(index: Index, where: ReadonlyArray<Pattern>, find: ReadonlyArray<string>): string[] {
  const out: string[] = []
  for (const binding of computeBindings(index, where))
    for (const variable of find.length ? find : Object.keys(binding)) {
      const value = binding[variable]
      if (value !== undefined) out.push(value)
    }
  return out
}
