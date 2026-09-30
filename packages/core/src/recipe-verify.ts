export * as RecipeVerify from "./recipe-verify"

import fs from "node:fs/promises"
import path from "node:path"
import { UnknownReason } from "@novaclaw/schema/unknown-reason"
import { displayPath } from "./util/path"

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
      ? {
          declared: check.declared,
          outcome: "unknown" as const,
          reason,
          ...(check.looked ? { looked: check.looked } : {}),
          checked: why,
        }
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
      `Anything missing from ${displayPath(receipt.directory)} is work that never happened rather than work that ` +
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
  const couldNot = unsure.length > 0 ? ` I could not check: ${list(unsure.map((check) => clip(check.declared)))}.` : ""

  if (receipt.verdict === "working")
    return (
      `${name} — WORKING. I checked ${met.length === 1 ? "the artifact" : `all ${met.length} artifacts`} ` +
      `it says it produces: ${list(verified)}.${couldNot}`
    )

  return (
    `${name} — NOT WORKING. It says it produces ${list(unmet.map((check) => clip(check.declared)))}, and in ` +
    `${displayPath(receipt.directory)} ${findings(unmet)}.` +
    (met.length > 0 ? ` (${list(verified)} did arrive.)` : "") +
    couldNot +
    ` Run the “Install health check” recipe to see what this machine can do, or open that folder and read ` +
    `the chat to see where the cook stopped.`
  )
}
