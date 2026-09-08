export * as UnfinishedSet from "./unfinished-set"

import path from "node:path"

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
  "all",
  "both",
  "them all",
  "one by one",
  "list the",
] as const

/** One matcher per cue, anchored at WORD BOUNDARIES on both ends — see `asksForSet`. Every cue is
 *  letters and spaces, so nothing here needs regex-escaping and none is applied: a cue that ever
 *  carries punctuation must add it. */
const CUE_MATCHERS: readonly RegExp[] = COLLECTION_CUES.map((cue) => new RegExp(String.raw`\b${cue}\b`, "i"))

/**
 * Did the user ask about a SET?
 *
 * ⚠️ Read from the user's words only. Inferring it from the folder having many files would fire on
 * every question asked in a populated directory, which is most of them.
 *
 * 🔴 **Matched on WORDS, never on substrings, and this cost 835,145 input tokens to learn.** The cue
 * list was tested with `text.includes(cue)`, so `"all "` matched the middle of *"**C**all the"*,
 * *"Inst**all** the"*, *"Rec**all** the"*. Measured on the owner's instance 2026-08-21: a probe whose
 * whole prompt was *Call the colleague tool with op "list"…* was read as a request to describe a
 * folder, and the steer drove that session through twenty unrelated repository files —
 * `.oxlintrc.json`, `LICENSE`, `package.json` — before it was interrupted.
 *
 * ⚠️ The retired automatic continuation made this false positive expensive: it read as the user's
 * own instruction and repeated until its steer budget was spent. `call the`, `install the` and
 * `recall the` are ordinary phrasing for a coding agent, which is what made a substring test
 * expensive rather than merely imprecise.
 */
export const asksForSet = (userText: string): boolean => CUE_MATCHERS.some((matcher) => matcher.test(userText))

/** Words that name DELEGATION itself, rather than the set being worked through. */
const DELEGATION_CUES = [
  "spawn",
  "sub agent",
  "sub agents",
  "subagent",
  "subagents",
  "sub-agent",
  "sub-agents",
  "delegate",
  "in parallel",
  "fleet of",
  "workers",
] as const

const DELEGATION_MATCHERS: readonly RegExp[] = DELEGATION_CUES.map(
  (cue) => new RegExp(String.raw`\b${cue.replaceAll("-", "[- ]")}\b`, "i"),
)

/**
 * Did the user ASK for the work to be delegated?
 *
 * 🔴 **The exemption `asksForSet` needs, measured on Qwen3.6-35B 2026-08-22.** `llm.ts` withholds
 * `spawn` for the whole of a set request, for a good and measured reason: the harness is the
 * controller for a set, so a sub-agent becomes a second controller over the same work, and nine runs
 * of a 400-icon prompt showed every delegating run covering less in more time.
 *
 * But that gate reads the same cue in two different sentences. *"Describe each icon in this folder"*
 * is the case it was built for. *"Spawn a fleet of 6 sub-agents, each summarising a sixth of the
 * file"* also contains `each` — and there the delegation IS the instruction. Measured: the officer
 * called `spawn` six times, correctly, and every call came back **"Unknown tool: spawn"**, because
 * the tool had been withheld by the cue in the user's own order. It then concluded it had no such
 * tool and started reading files one at a time — the exact behaviour the gate exists to produce, in
 * the one case where the user asked for the opposite.
 *
 * ⚠️ WORD boundaries, never substrings. The cue list this sits beside cost 835,145 tokens to learn
 * that `"all "` matches the middle of *"Call the"*; `spawn` inside *"spawning"* is the same hazard in
 * miniature, and `-` is matched as either a hyphen or a space so "sub-agent" and "sub agent" both
 * count.
 */
export const asksToDelegate = (userText: string): boolean =>
  DELEGATION_MATCHERS.some((matcher) => matcher.test(userText))

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
 * going — so it must have a visible ceiling for the same reason `MAX_DRIVE_ROUNDS` does.
 *
 * 🔴 Raised 20 → 40 on 2026-08-20, against a measurement rather than a feeling: asked for 100 icons
 * the drive reached **71** and stopped at the ceiling, because the model opens ~3–4 files per steer
 * where the steer asks for ten. Twenty rounds therefore buys ~70 files, not 200. The primary bound is
 * now `requestedLimit` — the drive stops when the REQUEST is covered — which is what makes a higher
 * backstop safe rather than merely longer.
 */
export const MAX_STEER_ROUNDS = 40

/**
 * Consecutive rounds opening NOTHING new before the drive gives up.
 *
 * ⭐ This is the real safety, and it is why the round ceiling below can afford to scale. A count
 * ceiling cannot distinguish a model that is stuck from one that is merely busy — it stops both, at
 * the same arbitrary number. This stops the stuck one in three rounds and never stops the busy one.
 */
export const MAX_BARREN_ROUNDS = 3

/**
 * The most files this drive will ever enumerate, and the cap on the listing it reasons about.
 *
 * ⚠️ Was `MAX_STEER_ROUNDS * STEER_BATCH` = 400 — which happened to equal the size of the folder that
 * exposed all this, so a 400-file set sat exactly on a bound derived from something unrelated. The
 * enumeration limit is its own decision and now says so.
 */
export const MAX_ENUMERATED_SET = 1_000

/**
 * How many rounds this drive may take for a set of `available` files.
 *
 * One round yields roughly one file (the image floor is 1, so a turn ends after one picture), hence
 * a per-file ceiling with headroom for rounds that re-read or stall. Small sets keep the old flat 40
 * so nothing about the six-glyph case changes.
 */
export const roundCeiling = (available: number): number => Math.max(MAX_STEER_ROUNDS, available * 2)

/**
 * How many items the user asked for, when they said a number.
 *
 * 🔴 Measured 2026-08-20: told "describe each of the first 100 png files" in a folder of 400, the
 * drive worked toward the FOLDER — 200 drivable names — not toward the hundred that were asked for.
 * Even with rounds to spare it would have overshot the request, and a harness that keeps working
 * after the job is done is as wrong as one that stops early.
 *
 * ⚠️ Narrow on purpose. It reads an explicit COUNT ("the first 40 files", "10 images") and nothing
 * else — no inference from folder size, no guessing at "a few". An unparsed request means the whole
 * enumerated set, which is the previous behaviour exactly.
 */
export const requestedLimit = (userText: string): number | undefined => {
  const text = userText.toLowerCase()
  // "first 40", "first 100 png", "top 12"
  const ordinal = /\b(?:first|top|initial)\s+(\d{1,4})\b/.exec(text)
  if (ordinal?.[1]) return Number(ordinal[1])
  // "describe 10 images", "10 files" — a bare count immediately qualifying the things being asked for
  const bare = /\b(\d{1,4})\s+(?:of\s+the\s+)?(?:png|jpe?g|image|images|file|files|icon|icons|picture|pictures)\b/.exec(
    text,
  )
  if (bare?.[1]) return Number(bare[1])
  return undefined
}

/**
 * 🔴 **WHICH DIRECTORY THE SET LIVES IN — derived from what the model OPENED, not from the cwd.**
 *
 * Measured 2026-08-29, and it is a 100% reproducible defect, not an edge case. The drive built
 * `available` from `readListing(location.directory)` — a flat, non-recursive `readdir` of the
 * SESSION's working directory. The files a request names are routinely in a SUBdirectory (*"describe
 * every image in folder X"* is the ordinary shape), so the drive's world contained none of them.
 *
 * Every sample in the batch-file-planning sweep reported **`available: 2`** — with a 40-file corpus,
 * a 100-file corpus and a 400-file corpus alike, because 2 was the number of non-directory entries in
 * the session root. ⭐ A count that does not move when the subject quadruples is the instrument
 * talking, and that is how this was found.
 *
 * **And the now-retired drive fired on it.** After the model had correctly opened all 100 images it
 * was steered onto a directory junction and a log file from the session root.
 *
 * 🔴 **This is the mechanism behind the measured SHOWSTOPPER:** the drive
 * *"fabricated twenty ROOT files as user-requested work"*. The root files are the session root's
 * listing; that entry describes this function's absence.
 *
 * **The fix is the principle the drive already claims to follow** — where the harness can enumerate
 * ground truth it must CHECK, never guess. The model told us where the set is by opening it: the
 * modal directory of the paths it actually read.
 *
 * ⚠️ **Returns `undefined` when nothing has been opened, and the caller then keeps the old
 * behaviour.** That case is deliberately NOT changed here: `shouldContinue`'s zero-opened branch
 * exists for a measured failure (*"the model ran glob and bash ls, listed the folder, and finished
 * with zero reads"*), and the showstopper's own case — a request about TOOLS that was never about
 * files at all — also needs `asksForSet` tightened, which is a separate fix. Widening this one to
 * cover it would be guessing at two defects with one change.
 *
 * ⚠️ **MODAL, not first.** A model that reads one stray file outside the corpus (a README, its own
 * notes) must not move the whole set's directory; the majority of reads is the set.
 */
export const setDirectory = (openedPaths: readonly string[]): string | undefined => {
  const counts = new Map<string, number>()
  for (const raw of openedPaths) {
    // Normalise separators before splitting: the model writes whichever it likes, and on win32 both
    // appear in one transcript.
    const parts = raw.replaceAll("\\", "/").split("/")
    if (parts.length < 2) continue
    const directory = parts.slice(0, -1).join("/")
    if (directory === "") continue
    counts.set(directory, (counts.get(directory) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [directory, count] of counts)
    if (count > bestCount) {
      best = directory
      bestCount = count
    }
  return best
}

/** Resolve the modal corpus directory in the same location namespace as the read tool. */
export const resolveSetDirectory = (locationDirectory: string, attemptedPaths: readonly string[]): string => {
  const directory = setDirectory(attemptedPaths)
  return directory === undefined ? locationDirectory : path.resolve(locationDirectory, directory)
}

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
 * Anything shaped like a filename in the request's own words.
 *
 * ⚠️ Deliberately LOOSE, because it is not the filter. `scopeAvailable` intersects what this returns
 * with the folder the harness enumerated, so a false match ("0.2.0", "e.g.", a sentence-ending word
 * followed by an extension-shaped token) simply fails to appear in the listing and costs nothing. A
 * precise pattern would instead start MISSING names, and a missed name silently widens a child's set
 * back to its parent's whole corpus — the failure this exists to close.
 *
 * ⚠️ Paths are kept whole and reduced to their basename by `scopeAvailable`, for the same reason
 * `untouched` compares by basename: the request writes whichever separator it likes.
 *
 * 🔴 **TOKENISED FIRST, THEN MATCHED ANCHORED — never a global scan.** Measured 2026-09-01: the
 * unanchored form `[A-Za-z0-9_\-./\\]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8}\b` took **5.7 seconds** on a
 * 100 KB run of `a/`, because a failing match restarts one character later and rescans to the end —
 * quadratic. A pasted directory tree is exactly that input, and this runs on the latch path of an
 * ordinary turn. Splitting on the characters a filename cannot contain makes it linear: 164 KB of
 * realistic prose measured 4.9 ms before and after.
 */
const NAME_SEPARATOR = /[^A-Za-z0-9_\-./\\]+/
/** Anchored: a token is a name or it is not, with no restart position to explore. */
const NAME_TOKEN = /^[A-Za-z0-9_\-./\\]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8}$/

/** The files the request NAMES, in the order it named them. */
export const requestedNames = (userText: string): ReadonlyArray<string> => {
  const found: string[] = []
  const seen = new Set<string>()
  for (const token of userText.split(NAME_SEPARATOR)) {
    // ⚠️ Trailing punctuation is the sentence's, not the name's. A list ending "…, icon_100.png."
    // is the ordinary shape of a request, and dropping its last file would leave one child short.
    const candidate = token.replace(/[./\\]+$/, "")
    if (!NAME_TOKEN.test(candidate)) continue
    const name = leaf(candidate)
    if (seen.has(name)) continue
    seen.add(name)
    found.push(candidate)
  }
  return found
}

/**
 * 🔴 **THE SET IS WHAT THE REQUEST MAKES AUTHORITATIVE — the folder is only the fallback.**
 *
 * Measured 2026-08-31 on the ten-worker scheduler fan-out (`notes/reports/holo31-scheduler-cuda-crash-2026-08-31.md`):
 * ten delegated children were each given ten of a hundred files, and every one of them was driven
 * against **all one hundred**. The drive enumerates the modal directory the children read from, and
 * that directory is their parent's whole corpus — so after global coverage reached 100/100, seven
 * children were still being steered through work their siblings had already done. Delegation
 * converted one traversal into ten, which is the opposite of the reason to delegate.
 *
 * ⚠️ **A COUNT is not an assignment, and that is the second half of the same defect.** `requestedLimit`
 * was applied as `listing.slice(0, limit)` — a prefix. A child told "these ten files" got the
 * alphabetically first ten, which is the correct slice for exactly one of ten children and wrong for
 * the other nine. A prefix answers "how many", never "which".
 *
 * **The order of authority**, most specific first:
 *
 *  1. **The names the request carries**, intersected with the enumerated listing. The listing is
 *     still the ground truth about what exists; the request decides which of it is this session's job.
 *  2. **A count**, as before — the request said how many but not which, so the prefix is all there is.
 *  3. **The whole listing** — nothing narrowed it, which is the ordinary single-session case and is
 *     unchanged.
 *
 * ⚠️ **Two named files are the floor.** A request that mentions one file in passing has not
 * enumerated a set, and `shouldContinue` already declines a set of one.
 *
 * ⚠️ **A count LARGER than the names means the names were examples.** *"Describe each of the 400 png
 * files; start with icon_001.png and icon_002.png"* names two and asks for four hundred. Letting two
 * example names shrink that request to two files would be this defect pointing the other way.
 */
export const scopeAvailable = (input: {
  /** Every file the harness enumerated in the set's directory. */
  readonly listing: ReadonlyArray<string>
  /** Files the request named — `requestedNames` of the latched user text. */
  readonly named: ReadonlyArray<string>
  /** The count the request asked for, when it stated one — `requestedLimit`. */
  readonly limit: number | undefined
}): ReadonlyArray<string> => {
  const named = new Set(input.named.map(leaf))
  // Listing ORDER, not the order they were named: the steer reads better in the folder's own order,
  // and the listing is the side that is ground truth.
  const assigned = input.listing.filter((entry) => named.has(leaf(entry)))
  if (assigned.length >= 2 && (input.limit === undefined || input.limit <= assigned.length)) return assigned
  if (input.limit !== undefined) return input.listing.slice(0, input.limit)
  return input.listing
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
  /** How many times this request has already been steered. Bounded by `roundCeiling`. */
  readonly rounds: number
  /** Consecutive rounds that opened nothing new. Bounded by `MAX_BARREN_ROUNDS`. */
  readonly barren?: number
}): boolean => {
  if (!input.asked) return false
  // ⭐ Stop when steering stops WORKING, which is a different question from how long it has run. A
  // model that has ignored three consecutive batches will ignore the fourth.
  if ((input.barren ?? 0) >= MAX_BARREN_ROUNDS) return false
  // ⚠️ The ceiling on an AUTOMATIC drive. The user asked once; everything after the first steer is
  // the harness deciding to continue, so it stops at a stated bound rather than running while files
  // remain. The bound is proportional to the set now: a flat 40 meant a 400-file request finished a
  // tenth of the job and reported itself partially done.
  if (input.rounds >= roundCeiling(input.coverage.available.length)) return false
  if (input.coverage.available.length <= 1) return false
  // 🔴 The zero case is IN, changed 2026-08-20. This used to `return false` when nothing had been
  // opened, reasoning that a turn which never started belongs to the tool-discovery nudges. Measured
  // twice that day: asked for 400 icons the model ran `glob` and `bash ls`, listed the folder, and
  // finished with zero reads — it had found its tools, it simply never opened one, and no other
  // check in the harness reacted. The run produced nothing.
  //
  // ⚠️ What made the old clause defensible was the fear of nagging a model that CANNOT start. That
  // case is now DETECTED rather than assumed: three rounds opening nothing new trips
  // `MAX_BARREN_ROUNDS` above and the drive stops. Enumeration is the precondition that makes this
  // safe — `available` naming the files means the world is known and only the opening is missing.
  return untouched(input.coverage).length > 0
}
