import type { MemoryRow } from "@/utils/memory-api"
import { defaultLens, lensAdmits, lensByID, type LensID } from "@/utils/memory-lens"

/**
 * WHAT THE USER IS LOOKING FOR — one filter, read by both the Remembered list and the Map.
 *
 * 🔴 Shared for the reason this page has already learned twice. The roster was fetched separately by
 * two surfaces and they disagreed about who existed; the memory-health signal was asked by one tab and
 * not the other, so one said "unavailable" while the other reported an empty cabinet. A filter is the
 * same shape of hazard and worse, because disagreement is silent: List and Map would each show a
 * different subset of one cabinet and nothing on screen would say they were answering different
 * questions.
 *
 * ⚠️ **It filters what is LOADED, and the surfaces already say what that is.** The list fetches 500
 * rows and reports how many are not listed; the map asks for a slice and reports what the server left
 * out. Searching the whole STORE is a retrieval question — ranking, embeddings, the `memory/search`
 * endpoint — and answering it here would quietly turn a filter into a search engine whose results the
 * graph could not draw. What must never happen is a confident "no matches" over a partial load, so
 * `describeScope` exists to make the boundary a sentence rather than an assumption.
 */
export interface MemoryFilter {
  /** Free text. Empty means "no text filter", never "match nothing". */
  readonly query: string
  /** Which kinds to admit. Empty set means NOTHING passes — that is a real state the chips can reach. */
  readonly kinds: ReadonlySet<string>
  /**
   * WHICH LIFECYCLE LENS is in force (`utils/memory-lens.ts`).
   *
   * 🔴 This field replaces `status: "active" | "all"`, which was **INERT** — `matches()` never read
   * it and no caller ever passed `includeInvalid`, so the header's toggle changed its own label and
   * nothing else. It was not an unfinished feature; it was a control that could not work, which
   * teaches a false model of the app and is strictly worse than not offering one. The lens is read
   * in two places now: here, by `matches()`, and by the list's fetch, which asks the server for the
   * lens's status set instead of over-fetching and hiding the remainder.
   */
  readonly lens: LensID
}

/**
 * The kinds the CHIPS control — not every kind the store has.
 *
 * 🔴 The difference is load-bearing. A `claim` is a kind too, and it has no chip: the chips are the
 * Map's three shapes, and giving claims a fourth shape is a separate piece of work. What must not
 * happen in the meantime is that the absence of a chip HIDES them — a control that does not exist
 * cannot be switched off by the user, so it must not be switched off on their behalf. `matches()`
 * therefore gates only on this list and admits anything outside it.
 */
export const ALL_KINDS: readonly string[] = ["entity", "episode", "passage"]

/**
 * The default a surface opens with: everything the store considers current, passages folded away.
 *
 * 🔴 **`claim` is here, and its absence was a real hole.** The Map asks `kinds.has(kind)` for EVERY
 * memory kind, while `ALL_KINDS` — the chips — names only three. So `claim` was never in the set and
 * never had a chip to put it there: every claim on the canvas was collapsed into a hub, and the claim
 * inspector (its identity, its timeline, and Archive/Restore) was reachable only by finding the hub
 * and pressing "Show every claim". Measured in the running app on 2026-08-26, on a store holding two
 * claims and nothing else: `4 memories · 4 links`, `3 hidden`, and selecting a claim from the
 * Remembered list switched to the Map with no inspector at all, because the id was not among the
 * projected nodes.
 *
 * A claim is the thing this app is ABOUT — "what NovaClaw treats as true right now" is a list of
 * them — so it is visible by default, unlike `passage` (bulk source text) and `source` (citation
 * scaffolding), both of which stay folded and stay revealable through their hub.
 */
export const defaultFilter = (): MemoryFilter => ({
  query: "",
  kinds: new Set(DEFAULT_KINDS),
  lens: defaultLens(),
})

/** The kinds a surface opens with. Named so `isNarrowed` can compare against it rather than a count. */
export const DEFAULT_KINDS: readonly string[] = ["entity", "episode", "claim"]

/**
 * Is the filter doing anything at all? Drives whether a surface bothers to report counts.
 *
 * ⚠️ Compared against `DEFAULT_KINDS` rather than against a literal size. The old form asserted
 * `kinds.size !== 2`, so adding one kind to the default made every surface report itself as narrowed
 * forever — a magic number about a set is a claim that goes stale the first time the set changes.
 */
export const isNarrowed = (filter: MemoryFilter): boolean =>
  filter.query.trim().length > 0 ||
  filter.lens !== defaultLens() ||
  filter.kinds.size !== DEFAULT_KINDS.length ||
  DEFAULT_KINDS.some((kind) => !filter.kinds.has(kind))

/**
 * Does one memory match the text?
 *
 * Case-insensitive, matched against the NAME and the TEXT — the two things a person can see. Not
 * against the id: nobody types `mem_0375fa4180015YK5c81emlzz3f`, and matching it would make a search
 * for "mem" return the entire cabinet.
 *
 * ⚠️ Every whitespace-separated term must appear (AND, not OR). "dragon manual" means both, which is
 * what someone narrowing a list intends; OR would make each extra word widen the result and the
 * control would feel broken.
 */
export function matchesQuery(row: Pick<MemoryRow, "name" | "text">, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = `${row.name ?? ""}\n${row.text ?? ""}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/**
 * Does one memory pass the whole filter?
 *
 * ⚠️ **The lens gates before the kind, and the kind before the text.** Cheapest and most decisive
 * first, but the ORDER also states the reading: a superseded claim is not "a match that happens to
 * be retired", it is outside the question the user asked. `status` is optional in the parameter
 * type only so a caller holding a partial row (the graph's hub members, a test fixture) can still
 * ask — an absent status reads as `active`, because a filter may narrow and may never erase what it
 * cannot classify.
 */
export function matches(
  row: Pick<MemoryRow, "name" | "text" | "kind"> & { readonly status?: string },
  filter: MemoryFilter,
): boolean {
  if (!lensAdmits(lensByID(filter.lens), row.status)) return false
  // ⚠️ Only a kind with a CHIP can be hidden by the chips. A `claim` has no chip yet, and the old
  // `kinds.has(row.kind)` hid every one of them from the Remembered list — the surface whose entire
  // job is answering "what do you remember", with the store's first-class unit of memory invisible
  // in it and no control on screen that could have brought them back.
  if (ALL_KINDS.includes(row.kind) && !filter.kinds.has(row.kind)) return false
  return matchesQuery(row, filter.query)
}

/**
 * One sentence naming what the result is a result OF — shown whenever the filter narrowed something
 * AND the surface is holding less than the store does.
 *
 * "No matches" over a partial load is the empty cabinet in a new costume: true of what was searched,
 * false as an answer to the question the user asked.
 */
export function describeScope(input: {
  readonly loaded: number
  readonly total: number | undefined
}): string | undefined {
  const total = input.total
  if (total === undefined || total <= input.loaded) return undefined
  return `Searched the ${input.loaded} loaded here, not all ${total}.`
}

/** Toggle one kind, returning a NEW set — the chips are the only writer of this field. */
export function toggleKind(filter: MemoryFilter, kind: string): MemoryFilter {
  const kinds = new Set(filter.kinds)
  if (kinds.has(kind)) kinds.delete(kind)
  else kinds.add(kind)
  return { ...filter, kinds }
}
