export * as UnfinishedSet from "./unfinished-set"

/**
 * A turn that answered about SOME of a set and stopped.
 *
 * 🔴 **The failure this exists for** (measured 2026-08-20, the six-glyph corpus). Asked *"please
 * describe each glyph here"*, the model opened ONE image, described it correctly, and ended the turn.
 * 1 of 6. It is not the image budget — the folder listing reached the model, the cap is now known in
 * advance, and eviction never happened. The turn simply stopped.
 *
 * ⚠️ **Nothing in the harness could catch it.** `shouldReground` is the backstop for a finished turn,
 * and it requires `REGROUND_TOOL_CALLS = 8` tool calls before it will nudge — it exists for a LONG
 * turn ending over-confidently. A turn that quits after one call is the opposite shape and fell
 * through every check.
 *
 * ⭐ This is the jh thesis applied literally: the harness owns decomposition and per-step
 * verification, the model proposes one atomic action. The harness enumerated the folder itself (the
 * grounding listing), so it — not the model — can see that five of six files were never opened.
 *
 * ⚠️ **Deliberately narrow, because a wrong nudge is worse than none.** It fires only when all four
 * hold: the user's own words asked for a SET, the folder holds several matching files, the model
 * opened at least one but not all, and it has not been nudged before. A user asking about one
 * picture in a folder of six must never be told they missed five.
 */

/** Words that mean "all of them" rather than "one of them". Matched on the USER's own message. */
const COLLECTION_CUES = [
  "each",
  "every",
  "all of",
  "all the",
  "all ",
  "both",
  "them all",
  "one by one",
  "list the",
] as const

/**
 * Did the user ask about a SET?
 *
 * ⚠️ Read from the user's words only. Inferring it from the folder having many files would fire on
 * every question asked in a populated directory, which is most of them.
 */
export const asksForSet = (userText: string): boolean => {
  const text = userText.toLowerCase()
  return COLLECTION_CUES.some((cue) => text.includes(cue))
}

/**
 * How many files ONE steer asks for.
 *
 * 🔴 The first version asked for everything remaining, and against a 400-file folder that read
 * "Open each remaining one" with 399 outstanding — an instruction that cannot land. A batch can:
 * the model opens ten, the drain ends, and the next steer asks for the next ten.
 */
export const STEER_BATCH = 10

/**
 * How many times the harness will steer one request.
 *
 * ⚠️ A bound, not a target. This is an automatic drive — the user asked once and the harness keeps
 * going — so it must have a visible ceiling for the same reason `MAX_DRIVE_ROUNDS` does. At
 * `STEER_BATCH` files a round it covers 200 files, which is past every set measured here and short
 * of an unbounded loop over a photo library.
 */
export const MAX_STEER_ROUNDS = 20

export interface Coverage {
  /** Files the harness listed for this folder — the set the user could have meant. */
  readonly available: ReadonlyArray<string>
  /** Files the model actually opened this turn. */
  readonly opened: ReadonlyArray<string>
}

/** Basename, lowercased — the two sides come from different places (a listing and a tool argument). */
const leaf = (path: string): string => {
  const parts = path.split(/[\\/]/)
  return (parts[parts.length - 1] ?? path).toLowerCase()
}

/**
 * The files the user's set includes that this turn never opened.
 *
 * Compared by BASENAME on purpose: the listing carries bare names while a `read` argument carries
 * whatever path the model wrote — absolute, relative, or with the other separator. Matching the full
 * strings would report every file as untouched.
 */
export const untouched = (coverage: Coverage): ReadonlyArray<string> => {
  const opened = new Set(coverage.opened.map(leaf))
  return coverage.available.filter((name) => !opened.has(leaf(name)))
}

/**
 * Should the harness steer the turn back to the rest of the set?
 *
 * Every clause is a case that must NOT fire:
 *  · `asked` — the user wanted one thing; finishing it is not a failure.
 *  · `opened.length > 0` — a turn that opened NOTHING is a different fault (it never started), and
 *    belongs to the tool-discovery nudges rather than here.
 *  · `remaining.length > 0` — nothing left means the work is done.
 *  · `available.length > 1` — one file is not a set.
 */
export const shouldContinue = (input: {
  readonly asked: boolean
  readonly coverage: Coverage
  /** How many times this request has already been steered. Bounded by `MAX_STEER_ROUNDS`. */
  readonly rounds: number
}): boolean => {
  if (!input.asked) return false
  // ⚠️ The ceiling on an AUTOMATIC drive. The user asked once; everything after the first steer is
  // the harness deciding to continue, so it stops at a stated bound rather than running while files
  // remain. A set larger than the drive can cover ends partially done and SAYS so — which is a
  // better answer than either an unbounded loop or the silence this used to give.
  if (input.rounds >= MAX_STEER_ROUNDS) return false
  if (input.coverage.available.length <= 1) return false
  if (input.coverage.opened.length === 0) return false
  return untouched(input.coverage).length > 0
}

/**
 * What the model is told. Names the files, because "you missed some" is not actionable and the
 * measured failure is a model that believed it was finished.
 */
export const continueMessage = (remaining: ReadonlyArray<string>, opened: number): string => {
  // ⭐ The NEXT BATCH, not the whole remainder. A model asked for ten files opens ten; asked for 399
  // it stops, argues, or invents — all three were measured on 2026-08-20.
  const batch = remaining.slice(0, STEER_BATCH)
  const after = remaining.length - batch.length
  return (
    `Not finished: you have opened ${opened} file${opened === 1 ? "" : "s"} and ${remaining.length} remain. ` +
    `Open these ${batch.length} next, one at a time, and say what each shows: ${batch.join(", ")}. ` +
    (after > 0 ? `Then continue with the remaining ${after}. ` : "") +
    `Do not describe a file you have not opened, and do not stop to ask which files to do — they are named above.`
  )
}
