export * as RecipeVerify from "./recipe-verify"

import fs from "node:fs/promises"
import path from "node:path"
import { UnknownReason } from "@novaclaw/schema/unknown-reason"

/**
 * **The deterministic success artifact for a cook** — the health-check recipes' verdict.
 *
 * AGENTS.md calls the bundled set *the install's health check* — *"a user can tell in one click whether
 * THEIR NovaClaw is actually working, a diagnostic that reads as a feature, not a test suite"*. Until now
 * the only output of a cook was **prose**: the agent said it had worked, a human read the chatter and
 * formed an impression, and nothing mechanical could read the outcome. An impression is not a health
 * check; it is a vibe. This module turns a cook into a **receipt**: one row per artifact the recipe says
 * it produces, each with an outcome the HARNESS determined by looking at the filesystem, plus one verdict.
 *
 * ── THE DESIGN DECISION, and why it went this way ──────────────────────────────────────────────────
 *
 * A recipe is a PROMPT and a cook is an agent doing open-ended work, so "did it succeed?" cannot be
 * answered by string-matching a transcript, and it must not be answered by asking a second model for an
 * opinion dressed as a fact (that is the model grading its own homework — the thing `jh`'s completion gate
 * exists to refuse, `jh/completion-gate.test.ts`). It can only be answered by a **postcondition the
 * harness checks itself**. So a recipe may declare, in one carried frontmatter line, the artifacts a
 * successful cook leaves behind:
 *
 *     produces: clean.csv, chart.html
 *
 * ── DOES A SECOND FRONTMATTER FIELD RE-OPEN RULING 14? No, and here is the argument ────────────────
 *
 * Ruling 14's headline reads *"exactly one machine-read field — `needs`"*, so this deserves an answer
 * rather than a shrug. Three things decide it, and none of them is a preference:
 *
 *  1. **The ruling's own operative law is a direction, not a count**: *"it may state what it NEEDS and may
 *     never state what it GETS."* What it rules out is named — `permissionMode`, `type`, `model`,
 *     `strict`, `minPosture` — and every member is a **grant**. `produces` is neither: it is the author
 *     describing their own artifact, with no path to `SessionConfig`, no composition with a privilege
 *     value, and nothing a hostile author gains by lying (declaring a file you did not produce marks your
 *     own recipe NOT WORKING).
 *  2. **The owner already drew this line for a second field.** Ruling 14's referred-questions block adds
 *     `collection` and says outright: *"This does not touch ruling 14: a collection is where a recipe
 *     lives, not what it is granted."* Same test, same answer. (`needs`' promotion to a modelled key
 *     is likewise sequenced *with* `collection` and `level` — the frontmatter was always
 *     expected to grow; what may never grow is the grant surface.)
 *  3. **Ruling 14 itself demands this feature.** Its justification quotes AGENTS.md's promise that a user
 *     can tell in one click whether their NovaClaw works, and rules: *"prose cannot keep it — prose is
 *     only legible after the model has already tried and failed."* It applied that to the pre-flight
 *     (`needs`); the identical argument applies to the post-condition, and the gap was filed in the
 *     same words — *"a cook's verdict is prose today, so nothing mechanical can read its
 *     outcome."* Leaving it prose is the ruling unenforced, not the ruling respected.
 *
 * So the count moves from one to two and the LAW is untouched. If a third field is ever proposed, the
 * test to apply is the owner's: *is this what the recipe is, or what the recipe is granted?*
 *
 * ⚠️ **The checkable vocabulary is CLOSED, and that is ruling 14, not taste.** A recipe is untrusted
 * input the moment it lands — *"it may state what it needs and may never state what it gets"*. The
 * obvious design (let the recipe supply a command whose exit code is the verdict) is an escalation
 * wearing a different hat: it is `permissionMode` in frontmatter with extra steps, and `novaclaw.json`
 * states the same rule for policies (*"may never contain or auto-run shell commands"*). So a `produces`
 * entry is **a plain relative file name and nothing else** — no command, no regex, no threshold, no
 * option. Everything else about a check comes from tables compiled into this file and keyed on the file's
 * own extension. The tightest possible grammar was chosen deliberately: a hostile recipe cannot express a
 * check at all, only name a file.
 *
 * What a stranger's `produces` line can therefore buy its author, in full: this module **stats one path
 * inside the folder that cook was already given, reads at most {@link READ_CAP} bytes of it, and reports
 * whether it exists, how big it is, and whether it matches its extension's shape.** That is strictly less
 * authority than `needs` already has (which stats absolute paths *outside* the work dir), and vastly less
 * than the cook itself had (`recipe.run` cooks with `permissionMode: "bypass"`).
 *
 * ⚠️ **Nothing here executes anything, and nothing here writes anything.** That is a stronger guarantee
 * than `needs`' "never executes a candidate", and it is the line this module will not cross. Compiling
 * `hello.c` would be a better check of a toolchain — and it would also be the harness running
 * model-produced, recipe-named code in order to grade it. `needs` already refuses a cook with no
 * compiler at the door; that is where toolchain authority belongs.
 *
 * ⭐ **Why not `jh/verifier.ts`, which already does exactly this shape.** jh is the same thesis — a
 * deterministic controller wrapped around a stochastic proposer, and its gate *"is ALWAYS the objective
 * check, never the model"* (jh.md §5 law 4). Two of its five check arms (`file_exists`,
 * `artifact_present`) are what a recipe postcondition needs, and the other three (`compile`, `run`,
 * `output_equals`) each take a **command** — precisely the field ruling 14 forbids a recipe to carry.
 * Reusing `verify` would mean threading a `JhProcessRunner.Runner` into a module whose entire safety
 * argument is that it cannot run anything, and then arguing about which arms a recipe may reach. The two
 * arms that don't execute are a stat and a byte read. So the THESIS is reused and the code is not, on
 * purpose; if the closed vocabulary ever grows an executing arm, that is the moment to invert this and
 * take jh's runner whole rather than grow a second one here.
 *
 * ⭐ **Why not `session/quality-check.ts`, which is the durable receipt store.** Its unit is *"one RUN of
 * one quality check"* and every row carries the `command` that ran plus an exit code whose NULL means "no
 * process existed". A check that inspects a file without running anything has no command and no exit
 * code, so storing one there would mean inventing a command string that never ran — fabricated evidence
 * on an evidence document, which is the exact failure that table's own header warns about. That store
 * belongs to the session receipt; this one is computed on demand and is a pure function of
 * the folder, so it needs no store at all: re-running it is cheaper than trusting a stale row.
 *
 * ── THE OUTCOMES: three, plus a fourth that is not a failure ───────────────────────────────────────
 *
 * The receipt must keep NOT WORKING (the instance is broken) apart from NOT
 * AVAILABLE (the model cannot do that), *"or the check blames the install for a model capability"*, and
 * ruling 2 requires that *"I could not check this"* never be collapsed into either. So:
 *
 * | outcome | verdict word | what it means |
 * |---|---|---|
 * | `met` | WORKING | the artifact is there and matches its shape |
 * | `unmet` | NOT WORKING | we looked, and it is missing / empty / not what its extension says |
 * | `unknown` + `not-applicable` | NOT AVAILABLE | the model that cooked cannot do this at all |
 * | `unknown` + `not-measured` / `measurement-failed` / `incomplete` | (no verdict) | we could not check |
 *
 * The four `unknown` reasons are `@novaclaw/schema/unknown-reason`'s shared vocabulary, not a fifth
 * private spelling of "we do not know" (`notes/reports/receipt-unknowns-vocabulary-2026-08-12.md`).
 *
 * ⚠️ **NOT AVAILABLE is derived from the INSTANCE's view of the model, never from the recipe.** A
 * declaration cannot request it, hint at it, or qualify itself with it — there is no syntax for that,
 * which is the point. The one member today is tool-calling: a model with `capabilities.tools === false`
 * cannot write a file at all, so reporting its cook as NOT WORKING would blame the install for a model
 * limit. `not-applicable` *stops the reader* (`UnknownReason.STOPS_THE_READER`) so it has to be EARNED,
 * and this is the one case where it is: there is genuinely nothing to measure.
 *
 * ⚠️ **A model we were told nothing about is `not-measured`, never `not-applicable`.** Caller passes no
 * `model` → we check the files normally. Caller passes a model whose capabilities we could not resolve →
 * that is an unmeasured fact, and filing it under the reason that tells a reader to stop asking would
 * silently close an open question. Same trap as the Windows enclosure probe in the report above.
 *
 * ── 🔴 `unmet` IS A CLAIM ABOUT THE SUBJECT, AND IT NEEDS THE INSTRUMENT TO HAVE WORKED ────────────
 *
 * **Measured 2026-08-18, and this is the defect the {@link CookOutcome} arm exists for.** Six cooks
 * "settled" in 47–57 s having written nothing, because the model endpoint had died mid-run
 * (`"finish":"error","error":{"message":"HTTP transport failed","_tag":"Transport"}`). Every declared
 * file was absent, so every row was `unmet`, so the verdict was `not-working` and the receipt read **NOT
 * WORKING — about: this NovaClaw**. It blamed the user's install for a dead endpoint.
 *
 * Nothing above was wrong about the *filesystem*: the files really were absent. The error is one step
 * earlier, in what absence MEANS. `unmet` says *"we looked, and the install did not do its job"* — and
 * that inference is only valid if the cook actually ran on this install. A cook that never reached the
 * model produced no evidence about this machine at all, so its empty folder is an unmeasured fact, not a
 * failed one. Ruling 2 in its exact words: *a check that cannot verify a claim must say "I could not
 * check this", never "missing"*.
 *
 * The rule this file now enforces, and the reason it is stated as a direction rather than as a special
 * case: **a cook's outcome may SOFTEN an `unmet` and may never overturn a `met`.** A file that is there
 * is positive evidence and no story about the instrument can take it away (a cook whose fourth turn died
 * on transport, having written everything on its second, really did work). A file that is *not* there is
 * only evidence when the instrument worked. So the folder is read first, exactly as before, and the cook
 * outcome is applied afterwards in one direction only — which is why this cannot regress into "a
 * transport error hides a real failure".
 *
 * Which reason each non-`ran` state maps to is `@novaclaw/schema/unknown-reason`'s table, not taste:
 * `blocked` is `measurement-failed` (*it ran and produced nothing usable → investigate the instrument*
 * — the model server is the instrument), and `stopped` is `incomplete` (*it started and did not finish;
 * any value is a FLOOR* — which is exactly what a half-finished folder is). Neither is `not-applicable`:
 * the question *"does this install work?"* is still wide open, and `not-applicable` would close it.
 *
 * ⚠️ **Deciding WHICH faults are instrument faults is deliberately NOT this file's job.**
 * `@novaclaw/core/session/session-error`'s `faultEvidence` owns that, because it already owns the closed
 * fault vocabulary and because every other surface with this shape must answer it the same way. This
 * module takes the answer as an input, so a new `ErrorTag` is classified once for the whole product.
 */

// =============================================================================
// The receipt
// =============================================================================

/** What we determined about ONE declared artifact. `unknown` is not a failure — see the header. */
export type Outcome = "met" | "unmet" | "unknown"

export interface Check {
  /** The author's own words, verbatim. Messages quote the recipe, never our paraphrase of it. */
  readonly declared: string
  readonly outcome: Outcome
  /** Present exactly when `outcome === "unknown"` — WHY we do not know, in the shared vocabulary. */
  readonly reason?: UnknownReason.Reason
  /** The path actually inspected, relative to the work dir. Absent when we did not look. */
  readonly looked?: string
  /**
   * What the probe ACTUALLY verified, in words — "exists and is not empty" is a weaker claim than
   * "exists, is not empty, and begins with a PNG header", and a reader must be able to tell which one
   * they were given. `agent-jail.ts`'s `probeCommand` lesson: report the observation, not only the verdict.
   */
  readonly checked: string
  readonly bytes?: number
}

/** The one word a person reads. Spelled exactly as the bundled health check's own table spells it. */
export type Verdict = "working" | "not-working" | "not-available" | "unknown"

export interface Receipt {
  readonly recipe: string
  readonly directory: string
  readonly verdict: Verdict
  readonly checks: readonly Check[]
  readonly at: number
  /** What the cook itself did, when the caller could tell us. Absent = we were not told. */
  readonly cook?: CookOutcome
}

/**
 * What happened to the COOK, as distinct from what is in the folder — see the header's third block.
 *
 * ⚠️ **`ran` is a claim and `undefined` is not.** A caller that knows the cook reached the model and
 * finished says `ran`; a caller that has no idea says nothing and gets today's behaviour unchanged. They
 * are not the same, and collapsing them would make "I did not ask" indistinguishable from "I asked and
 * it was fine" — which is the shape of mistake this whole arm is about.
 */
export interface CookOutcome {
  /**
   * `ran` — it reached the model and did (or failed to do) its work HERE, so the folder is evidence.
   * `blocked` — it never got that far: the model server was unreachable, the account was rejected,
   *   offline mode refused the request. The folder is evidence about nothing.
   * `stopped` — a person stopped it. Whatever is in the folder is a floor, not an outcome.
   */
  readonly state: "ran" | "blocked" | "stopped"
  /**
   * A calm sentence naming what happened, already free of transport noise — in practice
   * `sessionErrorDisplay(...).headline`. Shown to the user verbatim, so it must never carry an errno or
   * a stack frame; when it is absent a house sentence is used instead.
   */
  readonly why?: string
}

/**
 * What the INSTANCE knows about the model that cooked. Deliberately not `ModelV2.Info`: this module must
 * stay a pure function of a folder plus two booleans, so it can be tested without a catalog, and so that
 * growing the capability table here cannot drag a service dependency in behind it.
 */
export interface CookingModel {
  /** How to name it to the user — the model id is fine. */
  readonly label: string
  /** `capabilities.tools`. `false` means it cannot call a tool, so it cannot have written any file. */
  readonly tools: boolean
}

// =============================================================================
// Declarations: a plain relative file name, and nothing else
// =============================================================================

/** Nothing beyond this is read, so a hostile entry cannot make us read a large file. */
export const READ_CAP = 4 * 1024 * 1024

/**
 * Reduce a declared entry to a relative path inside the work dir, or `undefined` if it is not one.
 *
 * ⚠️ **This is the containment boundary and it rejects rather than clamps.** An entry naming
 * `../../.ssh/id_rsa` is not "absent" — answering `unmet` would be a fault described falsely (ruling 2)
 * AND would answer a question about a file outside the cook's folder. It is refused, reported as
 * `unknown`, and the receipt says why. Absolute paths, drive letters, UNC prefixes, `..` in any segment
 * and control characters are all out; a subfolder (`dist/index.html`) is in, because recipes legitimately
 * produce one.
 */
export const relativeInside = (entry: string): string | undefined => {
  const trimmed = entry.trim()
  if (trimmed === "" || trimmed.length > 200) return undefined
  // oxlint-disable-next-line no-control-regex -- a NUL truncates a path at the syscall, so it is refused here
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  if (/^[a-zA-Z]:/.test(trimmed)) return undefined
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return undefined
  const segments = trimmed
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
  if (segments.length === 0 || segments.length > 8) return undefined
  if (segments.some((segment) => segment === "..")) return undefined
  return segments.join("/")
}

// =============================================================================
// The shape table — keyed on the EXTENSION, owned by this file
// =============================================================================
//
// "The file exists" is a weak postcondition: an agent that writes a one-byte `chart.html` passes it, and
// a health check that green-lights a placeholder is worse than none. So each extension carries the
// strongest claim that can be made by READING the bytes and nothing else. The table is keyed on the
// extension rather than on anything the recipe says, which is what keeps the vocabulary closed — a recipe
// names a file, and the file's own name selects the check.
//
// ⚠️ Nothing here judges CONTENT QUALITY. `.c` deliberately has no rule: "a C file must contain `main`"
// would report NOT WORKING for a recipe that produces a library, and a false NOT WORKING is the fault
// described falsely that ruling 2 rules out. When in doubt the rule is omitted and the row reports the
// weaker claim it actually made.

interface Shape {
  /** What this rule verifies, phrased as the claim the receipt will make. */
  readonly describe: string
  /** Given the file's bytes (already known non-empty), does it match? */
  readonly ok: (bytes: Buffer) => boolean
}

const startsWith = (bytes: Buffer, magic: readonly number[]) =>
  bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)

const text = (bytes: Buffer) => bytes.subarray(0, 64 * 1024).toString("utf8")

const html: Shape = {
  describe: "exists and is an HTML document",
  ok: (bytes) => /<html\b|<!doctype\s+html/i.test(text(bytes)),
}

/** A delimited file has a header and at least one row — two non-blank lines carrying the delimiter. */
const rows = (bytes: Buffer, delimiter: string): boolean => {
  const lines = text(bytes)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  return lines.length >= 2 && lines[0]!.includes(delimiter)
}

const SHAPES: Readonly<Record<string, Shape>> = {
  html,
  htm: html,
  svg: { describe: "exists and is an SVG image", ok: (bytes) => /<svg[\s>]/i.test(text(bytes)) },
  json: {
    describe: "exists and parses as JSON",
    ok: (bytes) => {
      try {
        JSON.parse(bytes.toString("utf8"))
        return true
      } catch {
        return false
      }
    },
  },
  csv: { describe: "exists and has a header row and at least one data row", ok: (bytes) => rows(bytes, ",") },
  tsv: { describe: "exists and has a header row and at least one data row", ok: (bytes) => rows(bytes, "\t") },
  md: { describe: "exists and is not blank", ok: (bytes) => text(bytes).trim().length > 0 },
  txt: { describe: "exists and is not blank", ok: (bytes) => text(bytes).trim().length > 0 },
  png: { describe: "exists and begins with a PNG header", ok: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  jpg: { describe: "exists and begins with a JPEG header", ok: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { describe: "exists and begins with a JPEG header", ok: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  gif: { describe: "exists and begins with a GIF header", ok: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  webp: {
    describe: "exists and begins with a WebP header",
    ok: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  bmp: { describe: "exists and begins with a BMP header", ok: (b) => startsWith(b, [0x42, 0x4d]) },
}

/** Everything the table does not know. Still a COMPLETED check — we verified exactly what we claim. */
const ANY: Shape = { describe: "exists and is not empty", ok: () => true }

const shapeFor = (relative: string): Shape => {
  const extension = path.extname(relative).slice(1).toLowerCase()
  return SHAPES[extension] ?? ANY
}

// =============================================================================
// The probe
// =============================================================================

const unknown = (declared: string, reason: UnknownReason.Reason, checked: string): Check => ({
  declared,
  outcome: "unknown",
  reason,
  checked,
})

const checkOne = async (directory: string, declared: string): Promise<Check> => {
  const relative = relativeInside(declared)
  if (relative === undefined)
    return unknown(
      declared,
      "not-measured",
      "I did not look: that is not a plain file name inside the folder this recipe cooked in",
    )
  const full = path.join(directory, relative)
  const stat = await fs.stat(full).then(
    (value) => ({ value }),
    (error: NodeJS.ErrnoException) => ({ error }),
  )
  if ("error" in stat) {
    if (stat.error.code === "ENOENT" || stat.error.code === "ENOTDIR")
      return { declared, outcome: "unmet", looked: relative, checked: "there is nothing at that name" }
    // A locked or unreadable path is the INSTRUMENT failing, not the cook — never reported as missing.
    return unknown(declared, "measurement-failed", `I could not read that path (${stat.error.code ?? "unknown error"})`)
  }
  if (!stat.value.isFile())
    return { declared, outcome: "unmet", looked: relative, checked: "there is a folder, not a file, at that name" }
  const bytes = stat.value.size
  if (bytes === 0) return { declared, outcome: "unmet", looked: relative, checked: "the file is there but it is empty" }

  const shape = shapeFor(relative)
  // A file too large to read is reported on the weaker claim rather than guessed at. It is also, at that
  // size, unambiguously not the empty placeholder the shape rules exist to catch.
  if (shape === ANY || bytes > READ_CAP)
    return { declared, outcome: "met", looked: relative, checked: ANY.describe, bytes }
  const content = await fs.readFile(full).catch(() => undefined)
  if (content === undefined)
    return unknown(declared, "measurement-failed", "the file is there, but I could not read it back")
  return {
    declared,
    outcome: shape.ok(content) ? "met" : "unmet",
    looked: relative,
    checked: shape.ok(content) ? shape.describe : `it is there, but it is not what \`${relative}\` should be`,
    bytes,
  }
}

export interface Input {
  /** The recipe's display name — receipts are read by people. */
  readonly recipeName: string
  /** Where the cook happened. */
  readonly directory: string
  /** The `produces:` entries, in the order the author wrote them. */
  readonly declares: readonly string[]
  /** What the instance knows about the model that cooked, when it knows anything. */
  readonly model?: CookingModel
  /** What the cook itself did, when the caller could tell us. See {@link CookOutcome}. */
  readonly cook?: CookOutcome
  readonly now?: () => number
}

// =============================================================================
// The one-directional softening: an `unmet` needs the instrument to have worked
// =============================================================================

/**
 * The reason each non-`ran` state files under, from `@novaclaw/schema/unknown-reason`'s table. Kept as
 * data so the mapping is assertable rather than buried in a branch — the vocabulary module's own point.
 */
const REASON_FOR: Readonly<Record<"blocked" | "stopped", UnknownReason.Reason>> = {
  /** The instrument ran and produced nothing usable → *investigate the instrument*. */
  blocked: "measurement-failed",
  /** It started and did not finish → whatever is in the folder is a FLOOR. */
  stopped: "incomplete",
}

/**
 * Used when the caller had no sentence of its own. A SENTENCE, matching what `sessionErrorDisplay`
 * hands over, so the two are interchangeable wherever `why` is printed. Never accuses.
 */
const HOUSE_REASON: Readonly<Record<"blocked" | "stopped", string>> = {
  blocked: "The model never answered.",
  stopped: "It was stopped before it finished.",
}

/** A caller's sentence is untrusted for punctuation only — the words themselves are used verbatim. */
const period = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)

/**
 * Re-file every `unmet` row as `unknown` when the cook could not have produced evidence about the host.
 *
 * ⚠️ **One direction only, and that is the safety argument.** `met` and every existing `unknown` pass
 * through untouched, so this can only ever move a receipt from "your install failed" towards "I could not
 * tell" — never the reverse. A transport error can therefore never HIDE a genuine failure: it can only
 * stop us from asserting one we did not witness.
 *
 * `looked` is carried forward on purpose. The path we inspected is a true fact about what we did, and a
 * reader who wants to open the folder themselves still needs it; dropping it would make the honest answer
 * less useful than the false one it replaces.
 */
const soften = (checks: readonly Check[], cook: CookOutcome | undefined): readonly Check[] => {
  if (cook === undefined || cook.state === "ran") return checks
  const reason = REASON_FOR[cook.state]
  const why = period(cook.why?.trim() || HOUSE_REASON[cook.state])
  return checks.map((check) =>
    check.outcome === "unmet"
      ? { declared: check.declared, outcome: "unknown" as const, reason, ...(check.looked ? { looked: check.looked } : {}), checked: why }
      : check,
  )
}

/**
 * Read the folder and produce the receipt. Idempotent, side-effect-free, and a pure function of
 * (folder, declarations, model) — so it can be run again at any time and cannot itself be the thing that
 * broke. Never throws: an unreadable anything becomes an `unknown` row, because a health check that
 * crashes has told the user nothing.
 */
export const verify = async (input: Input): Promise<Receipt> => {
  const at = (input.now ?? Date.now)()
  const base = { recipe: input.recipeName, directory: input.directory, at, ...(input.cook ? { cook: input.cook } : {}) }

  // ── NOT AVAILABLE ─────────────────────────────────────────────────────────────────────────────────
  // A model that cannot call tools cannot have written a file, so every declaration is unmeasurable
  // rather than unmet. This arm exists so the health check never blames the install for a model limit
  // and it is checked FIRST because its answer makes the filesystem irrelevant.
  if (input.model !== undefined && !input.model.tools)
    return {
      ...base,
      verdict: input.declares.length === 0 ? "unknown" : "not-available",
      checks: input.declares.map((declared) =>
        unknown(declared, "not-applicable", `${input.model!.label} cannot call tools, so it cannot write a file`),
      ),
    }

  const reachable = await fs.stat(input.directory).then(
    (stat) => stat.isDirectory(),
    () => false,
  )
  if (!reachable)
    return {
      ...base,
      verdict: "unknown",
      checks: input.declares.map((declared) =>
        unknown(declared, "not-measured", "there is no folder to look in — nothing has cooked here"),
      ),
    }

  const checks: Check[] = []
  for (const declared of input.declares) checks.push(await checkOne(input.directory, declared))
  // ⚠️ The folder is read FIRST and the cook's outcome applied afterwards, never the other way round —
  // see the header. A blocked cook that nevertheless left every artifact behind still reads WORKING,
  // because a file that is there is positive evidence and no story about the instrument removes it.
  const softened = soften(checks, input.cook)
  return { ...base, verdict: verdictOf(softened), checks: softened }
}

/**
 * One word from many rows.
 *
 * `unmet` dominates: a cook that produced four of five artifacts did not work. `met` beats a leftover
 * `unknown` because we did verify something and nothing contradicted it. A receipt with nothing but
 * `unknown` rows — including the empty one, a recipe that declares no postcondition at all — is
 * `"unknown"` and NEVER `"working"`: "I have no way to tell" is the honest answer, and calling it success
 * is exactly the vibe this module replaced.
 */
export const verdictOf = (checks: readonly Check[]): Verdict => {
  if (checks.some((check) => check.outcome === "unmet")) return "not-working"
  if (checks.some((check) => check.outcome === "met")) return "working"
  if (checks.some((check) => check.reason === "not-applicable")) return "not-available"
  return "unknown"
}

// =============================================================================
// The sentence a person reads
// =============================================================================

/** A stranger's declaration is untrusted text on its way into the UI; keep it a phrase, not a wall. */
const clip = (value: string) => (value.length > 60 ? `${value.slice(0, 59)}…` : value)

const list = (values: readonly string[]) =>
  values.length <= 1 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`

/**
 * The findings for a set of rows, collapsed when they all say the same thing.
 *
 * Two missing files used to render as *"there is nothing at that name and there is nothing at that
 * name"*, which reads as a bug in the tool rather than a fault in the cook — and a health check that
 * looks broken cannot tell anyone their install is broken.
 */
const findings = (checks: readonly Check[]): string => {
  const distinct = [...new Set(checks.map((check) => check.checked))]
  if (distinct.length === 1) return distinct[0]!
  return checks.map((check) => `${check.looked ?? clip(check.declared)} — ${check.checked}`).join("; ")
}

/**
 * The receipt in prose — house style: say what was checked, then teach the way forward.
 *
 * ⚠️ **Ruling 2 is enforced by construction here, not by care.** The absence sentence is built ONLY from
 * rows whose outcome is `unmet`; an `unknown` row can only ever reach the separate *"I could not check"*
 * clause, which asserts nothing about the host. A receipt whose rows are all `unknown` therefore cannot
 * emit the words "did not find" at all — pinned by its own test, because it is the invariant that makes
 * the whole artifact trustworthy: a check that lies when it is unsure is worse than no check.
 */
export const summary = (receipt: Receipt): string => {
  const unmet = receipt.checks.filter((check) => check.outcome === "unmet")
  const met = receipt.checks.filter((check) => check.outcome === "met")
  const unsure = receipt.checks.filter((check) => check.outcome === "unknown")
  const notApplicable = unsure.filter((check) => check.reason === "not-applicable")
  const name = `“${receipt.recipe}”`

  if (receipt.verdict === "not-available")
    return (
      `${name} — NOT AVAILABLE. ${notApplicable[0]?.checked ?? "This model cannot produce files"}, so there ` +
      `is nothing here for me to check. That is a limit of the model you cooked with, not a fault in this ` +
      `NovaClaw — run it again with a model that can use tools.`
    )

  // ── The cook never got to exercise this install ────────────────────────────────────────────────────
  // 🔴 The sentence that used to read "NOT WORKING — about: this NovaClaw" when an endpoint died. It
  // must do three things in this order: say we could not check, name what stopped it, and say what to do.
  // It must NOT contain a word about the install being at fault — that is the whole defect — and the
  // `not-working` arm below is now unreachable for a blocked cook by construction (`soften` leaves no
  // `unmet` row), so this is a sentence for a state, not a second guess at the same state.
  const declaresNothing = receipt.checks.length === 0
  const hint =
    ` (This recipe also names no files a finished cook leaves behind, so add a “produces:” line and I ` +
    `can check it properly next time.)`
  if (receipt.cook?.state === "blocked" && receipt.verdict === "unknown")
    return (
      `${name} — I could not check this cook. ${period(receipt.cook.why?.trim() || HOUSE_REASON.blocked)} ` +
      `The recipe never got to run on this computer, so there is nothing here for me to judge — and ` +
      `nothing here says anything is wrong with this NovaClaw. Start the model server again, or pick a ` +
      `model that is running, and cook it once more.` +
      (declaresNothing ? hint : "")
    )

  if (receipt.cook?.state === "stopped" && receipt.verdict === "unknown")
    return (
      `${name} — I could not check this cook. ${period(receipt.cook.why?.trim() || HOUSE_REASON.stopped)} ` +
      `Anything missing from ${receipt.directory} is work that never happened rather than work that ` +
      `failed, so this tells us nothing about this NovaClaw either way. Run it again and let it finish.` +
      (declaresNothing ? hint : "")
    )

  if (receipt.verdict === "unknown")
    return declaresNothing
      ? `${name} — I cannot say whether this cook worked: the recipe does not name anything it produces. ` +
          `Add a “produces:” line naming the files a finished cook leaves behind (for example ` +
          `“produces: report.md”) and I can check it for you next time.`
      : `${name} — I could not check this cook: ${findings(unsure)}.`

  const verified = met.map((check) => `${check.looked} (${check.checked})`)
  const couldNot =
    unsure.length > 0 ? ` I could not check: ${list(unsure.map((check) => clip(check.declared)))}.` : ""

  if (receipt.verdict === "working")
    return `${name} — WORKING. I checked ${met.length === 1 ? "the artifact" : `all ${met.length} artifacts`} ` +
      `it says it produces: ${list(verified)}.${couldNot}`

  return (
    `${name} — NOT WORKING. It says it produces ${list(unmet.map((check) => clip(check.declared)))}, and in ` +
    `${receipt.directory} ${findings(unmet)}.` +
    (met.length > 0 ? ` (${list(verified)} did arrive.)` : "") +
    couldNot +
    ` Run the “Install health check” recipe to see what this machine can do, or open that folder and read ` +
    `the chat to see where the cook stopped.`
  )
}
