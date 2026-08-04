// A2.1 ① — the lexical redundancy signal that lets `context-pack.ts` reclaim what the window
// ALREADY SAYS before it starts dropping what is merely old.
//
// The packer evicts on recency alone: over budget it drops the oldest whole messages first. That is
// blind to the shape of the overflow a real session produces — measured on this machine's own
// session store, one 23k-token session was 64% re-fetches of a page it had already fetched, byte
// for byte. Recency answers that by throwing away the oldest turn, which is where the task lives.
// This module answers the missing question: does this text say anything the window does not already
// say, said by the SAME call?
//
// Deliberately TOKENIZER-FREE, matching `util/token.ts`'s stance — no BPE, no dependency, no I/O,
// no Effect, and no `Message` import either: the wire and policy knowledge stays in
// `context-pack.ts` and this file stays pure text maths. It is textbook IR from decades back
// (w-shingling, Jaccard similarity, and the containment / overlap coefficient), written here from
// first principles.
//
// ⚠️ DETERMINISM IS THE WHOLE PROPERTY. Same history -> same packing, always: no randomness, no
// clock, no seeded hash, no iteration-order dependence (`Map` iteration is insertion order, set
// iteration only ever feeds an order-independent counter, and the one sort is over unique integer
// indices so no tie can reorder). A packer that packs differently on two runs turns every session
// bug into a heisenbug.

export * as ContextRedundancy from "./context-redundancy"

/**
 * Words per shingle (w-shingling). 5 is the classic near-duplicate width: long enough that ordinary
 * co-occurring words don't collide across unrelated texts, short enough that a single-line edit
 * perturbs only ~5 shingles out of hundreds.
 */
export const SHINGLE_SIZE = 5

/**
 * Jaccard cutoff for "these two are the same content" (symmetric, size-sensitive). At
 * `SHINGLE_SIZE = 5` one changed word breaks ~5 shingles, so two ~300-shingle tool results that
 * differ in a dozen scattered words still land ≈0.85 — while two genuinely different texts of the
 * same shape score far below 0.2 on 5-grams.
 */
export const SIMILARITY_THRESHOLD = 0.8

/**
 * Containment cutoff for "the older one adds nothing" — |candidate ∩ cover| / |candidate|, the
 * overlap coefficient. This is the ASYMMETRIC half: an older text is only ever declared redundant
 * when what it says is already present in the newer one. It catches what Jaccard misses (a
 * truncated earlier read subsumed by a later fuller one) and, crucially, refuses the reverse — a
 * newer SUBSET never justifies discarding the fuller older one. 0.9 rather than 1.0 tolerates the
 * handful of shingles that straddle a truncation boundary.
 */
export const COVERAGE_THRESHOLD = 0.9

/**
 * The minimum number of DISTINCT shingles a text must hold before it may be judged at all.
 *
 * ⚠️ A character/token floor is not an INFORMATION floor, and the two come apart badly on
 * repetition: 60 copies of one log line is ~700 estimated tokens but collapses to a handful of
 * distinct shingles, and a handful of shingles is trivially "covered" by anything that happens to
 * quote the same line. 32 is about a third of what ordinary text at the caller's token floor yields
 * (~512 chars ≈ ~100 words ≈ ~96 shingle positions); below it one accidental hash collision already
 * moves a ratio by >3%.
 */
export const MIN_SHINGLE_CARDINALITY = 32

/**
 * The minimum fraction of a text's shingle POSITIONS that must be distinct — the repetition-density
 * gate, and the second half of the cardinality guard. Cardinality alone misses a text long enough
 * to clear 32 while still being mostly repeats (a paged log, a JSON array of near-identical rows);
 * such a text's shingle set describes its *template*, not its content, so a similarity ratio
 * against it means nothing. 0.25 sits well under real prose/source (~0.5–1.0) and well over the
 * degenerate cases (a repeated log line measures ~0.02).
 */
export const MIN_SHINGLE_DENSITY = 0.25

/**
 * The ABSOLUTE ceiling on how much uniquely-held content one decision may cost, counted in shingles
 * the candidate holds and the cover does not (≈ one shingle per word position of novel text).
 *
 * ⚠️ Both ratio thresholds above are PROPORTIONAL, so the slack they grant grows without bound:
 * `COVERAGE_THRESHOLD`'s 0.9 is justified by "the few shingles that straddle a boundary" — a fixed
 * handful — but 10% of a 20k-token tool result is two thousand tokens of content nothing else in
 * the window holds. This conjunct pins the justification to the thing it actually justifies. 16 ≈
 * three boundaries, or a re-read of a file that changed by a line or two. Above it the older text
 * is not a duplicate, it is a different VERSION, and the window would lose a fact that is nowhere
 * else — ruling 2's worst outcome.
 */
export const MAX_UNIQUE_SHINGLES_LOST = 16

/**
 * The hard bound on pairwise work. Comparison is confined to a group of texts the caller has
 * already declared interchangeable (same tool, same input), and only the newest
 * `MAX_GROUP_MEMBERS` of such a group are considered — so the pass costs at most
 * `MAX_GROUP_MEMBERS * (MAX_GROUP_MEMBERS - 1) / 2` = 120 set intersections per group, whatever the
 * window holds. `pack()` is on the hot path of every turn; an unbounded O(n²) there is a per-turn
 * tax. Anything older than the newest 16 repetitions of one identical call is left to recency.
 */
export const MAX_GROUP_MEMBERS = 16

/**
 * Lexical words: lowercase, then split on everything that is not a letter, digit or underscore.
 * Punctuation is a separator rather than a signal — that keeps `src/foo.ts` and `src\foo.ts`
 * comparable and, more importantly, makes MINIFIED JSON (which `JSON.stringify` emits with no
 * whitespace at all) shingle properly instead of collapsing into one giant "word".
 *
 * Unicode-aware via `\p{L}`/`\p{N}`, so non-Latin prose keeps its words. ⚠️ Scripts written without
 * spaces (CJK) yield one token per punctuation-delimited run, which makes the signal coarse —
 * conservative in the safe direction: such texts must match near-exactly to read as duplicates.
 */
export const lexicalWords = (text: string): string[] => {
  const out: string[] = []
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) if (word.length > 0) out.push(word)
  return out
}

// FNV-1a, 32-bit. Shingles are stored HASHED (a `Set<number>`) rather than as joined strings: a 30k
// word tool result would otherwise hold ~30k strings of ~30 chars each — megabytes per message, on
// a path that runs every turn. Fully deterministic, no seed. A 32-bit collision only ever nudges a
// similarity score by one shingle out of hundreds.
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
const SEPARATOR = 0x20

const hashShingle = (words: ReadonlyArray<string>, from: number, size: number): number => {
  let hash = FNV_OFFSET
  for (let w = from; w < from + size; w++) {
    const word = words[w]!
    for (let i = 0; i < word.length; i++) {
      hash ^= word.charCodeAt(i)
      hash = Math.imul(hash, FNV_PRIME)
    }
    // Fold in the join, so ["ab","c"] and ["a","bc"] are different shingles.
    hash ^= SEPARATOR
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * A text's shingle set together with how many shingle POSITIONS produced it. The two differ only by
 * repetition, which is exactly what `MIN_SHINGLE_DENSITY` measures: `set.size / positions` is the
 * fraction of the text that is not a repeat of itself.
 */
export interface ShingleProfile {
  readonly set: ReadonlySet<number>
  /** Shingle positions before de-duplication. 0 for a text with no lexical words. */
  readonly positions: number
}

/**
 * The set of hashed `SHINGLE_SIZE`-word shingles of `text`, with its position count. A text shorter
 * than one shingle degenerates to a SINGLE shingle over all of its words — i.e. short texts must
 * match (normalized-)exactly to read as duplicates, never fuzzily.
 *
 * ⚠️ TOTAL by contract: it judges nothing and rejects nothing. Eligibility (cardinality, density,
 * size) is `findRedundant`'s and the caller's business, so this stays a pure description of a text.
 */
export const shingleProfile = (text: string): ShingleProfile => {
  const words = lexicalWords(text)
  const out = new Set<number>()
  if (words.length === 0) return { set: out, positions: 0 }
  if (words.length < SHINGLE_SIZE) {
    out.add(hashShingle(words, 0, words.length))
    return { set: out, positions: 1 }
  }
  const positions = words.length - SHINGLE_SIZE + 1
  for (let i = 0; i < positions; i++) out.add(hashShingle(words, i, SHINGLE_SIZE))
  return { set: out, positions }
}

/** The shingle set alone — see `shingleProfile`. */
export const shingles = (text: string): ReadonlySet<number> => shingleProfile(text).set

// Iterate the SMALLER set and probe the larger — the count is a sum, so it does not depend on
// either set's iteration order.
const intersectionSize = (a: ReadonlySet<number>, b: ReadonlySet<number>): number => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let count = 0
  for (const value of small) if (large.has(value)) count++
  return count
}

/** Jaccard similarity |A ∩ B| / |A ∪ B|. 0 when either side is empty. */
export const jaccard = (a: ReadonlySet<number>, b: ReadonlySet<number>): number => {
  if (a.size === 0 || b.size === 0) return 0
  const intersection = intersectionSize(a, b)
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Containment / overlap coefficient: how much of `candidate` is already present in `cover`
 * (|candidate ∩ cover| / |candidate|). Asymmetric ON PURPOSE — `coverage(a, b)` answers "is `a`
 * redundant given `b`?", which is a different question from `coverage(b, a)`.
 */
export const coverage = (candidate: ReadonlySet<number>, cover: ReadonlySet<number>): number => {
  if (candidate.size === 0 || cover.size === 0) return 0
  return intersectionSize(candidate, cover) / candidate.size
}

/** The numbers behind one redundancy decision — reported verbatim by `findRedundant`. */
export interface RedundancyVerdict {
  readonly redundant: boolean
  readonly jaccard: number
  readonly coverage: number
  /** Shingles the candidate holds that `cover` does not — what the decision would cost. */
  readonly uniqueLost: number
}

/**
 * Is `candidate` redundant given `cover`? Two independent routes, both textbook, both nameable on
 * their own:
 *  - **near-duplicate** — `jaccard >= SIMILARITY_THRESHOLD`: mutually almost the same content;
 *  - **subsumption** — `coverage >= COVERAGE_THRESHOLD`: everything the candidate says is already
 *    in what we keep.
 *
 * …and one veto that applies to BOTH: `uniqueLost <= MAX_UNIQUE_SHINGLES_LOST`. Both ratios are
 * proportional, so on a large text their slack is a large absolute amount of unique content; the
 * veto is what keeps "near-duplicate" from meaning "differs by a whole function".
 */
export const redundancyVerdict = (candidate: ReadonlySet<number>, cover: ReadonlySet<number>): RedundancyVerdict => {
  const similarity = jaccard(candidate, cover)
  const overlap = coverage(candidate, cover)
  const uniqueLost = candidate.size - intersectionSize(candidate, cover)
  const matched = similarity >= SIMILARITY_THRESHOLD || overlap >= COVERAGE_THRESHOLD
  return {
    redundant: matched && uniqueLost <= MAX_UNIQUE_SHINGLES_LOST,
    jaccard: similarity,
    coverage: overlap,
    uniqueLost,
  }
}

/** `redundancyVerdict(...).redundant` — see there for the routes and the veto. */
export const isRedundant = (candidate: ReadonlySet<number>, cover: ReadonlySet<number>): boolean =>
  redundancyVerdict(candidate, cover).redundant

/**
 * One comparable text, as the pass sees it. Deliberately NOT a `Message` — the similarity logic
 * stays generic and the wire policy stays in `context-pack.ts`, where it belongs.
 *
 * `key` is the IDENTITY GATE and it is the difference between this design and one that silently
 * loses facts: only texts whose keys are EQUAL are ever compared. The caller sets it to the
 * identity of the thing that produced the text (for us: tool name + the owning call's input), so
 * two reads of two DIFFERENT files can never collapse into one no matter how alike their contents
 * are. A lexical score alone cannot tell "the same file twice" from "two files that look alike",
 * and that distinction is not recoverable after the fact.
 */
export interface RedundancyItem {
  readonly key: string
  readonly text: string
}

/** One decision, with the numbers that produced it — so a later slice can report it verbatim. */
export interface Redundancy {
  readonly index: number
  /** The item whose content makes `index` redundant. Always NEWER (a higher index) than `index`. */
  readonly retainedIndex: number
  readonly jaccard: number
  readonly coverage: number
  /** Shingles this decision costs the window — bounded by `MAX_UNIQUE_SHINGLES_LOST`. */
  readonly uniqueLost: number
}

/**
 * Which items are redundant, newest-wins, within identity groups.
 *
 * `items[i] === undefined` means "not a candidate and not a cover" — the caller's own eligibility
 * gate (size, shape, safety). Items are grouped by `key`; a group of one is never shingled at all,
 * which is what keeps the common case (every tool call distinct) near-free. Inside a group we walk
 * covers newest-first and mark every OLDER live member each one subsumes; an item already marked
 * never covers anything (we do not justify keeping X by a text we are also discarding), which makes
 * the pass idempotent — run it on its own output and it finds nothing.
 *
 * Returns ascending by index.
 */
export const findRedundant = (items: ReadonlyArray<RedundancyItem | undefined>): Redundancy[] => {
  const groups = new Map<string, number[]>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item === undefined) continue
    const members = groups.get(item.key)
    if (members === undefined) groups.set(item.key, [i])
    else members.push(i)
  }

  const out: Redundancy[] = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    // Bounded work: only the newest MAX_GROUP_MEMBERS repetitions of one identical call.
    const window = members.length > MAX_GROUP_MEMBERS ? members.slice(-MAX_GROUP_MEMBERS) : members

    const sets = new Map<number, ReadonlySet<number>>()
    for (const index of window) {
      // Two independent information floors, applied on the CANDIDATE and COVER side alike because
      // an uninformative shingle set is as dangerous held by the keeper as by the discarded:
      //   cardinality — the set must be big enough for a ratio over it to mean anything;
      //   density     — and it must describe the text, not just the text's template.
      const { set, positions } = shingleProfile(items[index]!.text)
      if (set.size < MIN_SHINGLE_CARDINALITY) continue
      if (set.size < positions * MIN_SHINGLE_DENSITY) continue
      sets.set(index, set)
    }
    if (sets.size < 2) continue

    const marked = new Set<number>()
    for (let cover = window.length - 1; cover >= 1; cover--) {
      const retainedIndex = window[cover]!
      const retained = sets.get(retainedIndex)
      if (retained === undefined || marked.has(retainedIndex)) continue
      for (let position = cover - 1; position >= 0; position--) {
        const index = window[position]!
        if (marked.has(index)) continue
        const candidate = sets.get(index)
        if (candidate === undefined) continue
        const verdict = redundancyVerdict(candidate, retained)
        if (!verdict.redundant) continue
        marked.add(index)
        out.push({
          index,
          retainedIndex,
          jaccard: verdict.jaccard,
          coverage: verdict.coverage,
          uniqueLost: verdict.uniqueLost,
        })
      }
    }
  }
  // Unique integer keys — a total order, so no tie can reorder between two runs.
  out.sort((a, b) => a.index - b.index)
  return out
}
