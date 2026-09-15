/**
 * Which arguments `script/test.ts` understands — and which it must REFUSE rather than ignore.
 *
 * ─── why this module exists ──────────────────────────────────────────────────────────────────────
 *
 * 🔴 **An unrecognized argument used to run the WHOLE suite.** `--help` and `--list` are read by
 * nothing in the runner, so both fell straight through to the fast tier and started a full 23-unit
 * run. Measured 2026-09-15, twice in one session: the second left a stray `bun` that then REFUSED
 * three unrelated units with "another heavy job is already running on this machine", and a
 * `typecheck` run was blocked behind it. Cost: a full tier plus a strays hunt, for a command that
 * meant "show me the flags".
 *
 * ⭐ An ignored flag is worse than a rejected one, because the wrong call is the SHORTER one to
 * type. `--only core` — a space where an `=` belongs — is not a typo anyone notices making, and it
 * did the same thing. So the recognized set is stated once, here, and anything else refuses.
 *
 * ⚠️ **The decision is a PURE function, deliberately, and that is the fix's second half.**
 * `script/test.ts` executes at import — it sweeps strays and enforces the memory gate before its
 * first statement returns — so it cannot be imported by a test, and a spawn-based probe would have
 * to launch the very suite it is checking. Keeping `unrecognizedArguments` pure puts the whole
 * decision on a seam a guard test can call directly, with no process and no side effect. The
 * side-effecting half (print usage, abort) stays in the runner, where it belongs.
 *
 * ⚠️ `--force` is deliberately ACCEPTED and deliberately INERT for this suite. `heavy-guard.ts`
 * reads it for the build guard, and `test.ts`'s `enforceTestMemory` passes `allowOverride: false`
 * so a safety refusal cannot be turned into an OOM by adding a word to a test command
 * (`heavy-guard.ts:21`). Refusing it here would break a documented command; honouring it would
 * break the guard; the honest thing is to accept the word and let the guard keep its ruling.
 */

/** The flags this runner implements and the usage text prints, other than `--only=<unit>`. */
export const DOCUMENTED_FLAGS: ReadonlySet<string> = new Set(["--full", "--help", "-h"])

/**
 * ⚠️ Accepted because other scripts in this repo read it, and deliberately INERT for this suite.
 * `heavy-guard.ts` reads `--force` for the build guard, and `test.ts`'s `enforceTestMemory` passes
 * `allowOverride: false` so a safety refusal cannot be turned into an OOM by adding a word to a test
 * command (`heavy-guard.ts:21`). Refusing it here would break a documented command; honouring it
 * would break the guard; the honest thing is to accept the word and let the guard keep its ruling.
 *
 * 🔴 It is NOT in the usage text, on purpose: printing a flag that does nothing here would advertise
 * a lever the user cannot pull, which is the same defect as a setting that lies about being in force.
 */
export const ACCEPTED_INERT_FLAGS: ReadonlySet<string> = new Set(["--force"])

/** Everything this runner accepts without complaint: the union of the two sets above. */
export const FLAGS: ReadonlySet<string> = new Set([...DOCUMENTED_FLAGS, ...ACCEPTED_INERT_FLAGS])

/** `--only=<unit>`. The `=` is required: `--only core` is refused by name, not silently ignored. */
export const ONLY_PREFIX = "--only="

export const isOnly = (argument: string): boolean => argument.startsWith(ONLY_PREFIX)

export const isFull = (argv: readonly string[]): boolean => argv.includes("--full")

export const isHelp = (argv: readonly string[]): boolean => argv.includes("--help") || argv.includes("-h")

/**
 * Every argument this runner does NOT understand, in the order given.
 *
 * Empty means "start the run". Anything else must abort: the caller prints `USAGE` and exits 2
 * rather than falling through to a full-suite run the caller never asked for.
 */
export const unrecognizedArguments = (argv: readonly string[]): string[] =>
  argv.filter((argument) => !FLAGS.has(argument) && !isOnly(argument))

/** The unit named by `--only=`, or `undefined`. An empty value is treated as absent. */
export const only = (argv: readonly string[]): string | undefined => {
  const named = argv.find(isOnly)?.slice(ONLY_PREFIX.length)
  return named === undefined || named.length === 0 ? undefined : named
}

export const USAGE: string = [
  "Usage: bun run test [--only=<unit>] [--full]",
  "",
  "  (no flag)        the fast tier — every unit. The loop's default.",
  "  --only=<unit>    one unit: core, llm, schema, app:unit, novaclaw, typecheck, …",
  "                   --only=typecheck is the 19 checks (~1 min) and is what a push needs.",
  "  --full           the RELEASE tier (16-25 min). Off the development loop by owner",
  "                   directive: a release cut, or a failure you cannot explain from the diff.",
  "",
  "  --help           this text.",
  "",
  "Anything else is refused rather than ignored — an unrecognized flag would otherwise run the",
  "whole suite instead of the one unit you asked for.",
].join("\n")

/** The refusal sentence, so the message and its guard test cannot drift apart. */
export const refusal = (unrecognized: readonly string[]): string =>
  `\n\x1b[31mUnrecognized argument${unrecognized.length > 1 ? "s" : ""}: ` +
  `${unrecognized.join(" ")}\x1b[0m\n\n` +
  `Refusing to start: an ignored flag would silently run the WHOLE suite rather than the unit\n` +
  `you asked for. If you meant one unit, the form is \`--only=<unit>\` — with an equals sign.\n\n` +
  `${USAGE}\n`
