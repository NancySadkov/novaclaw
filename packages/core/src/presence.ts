export * as Presence from "./presence"

import fs from "node:fs"
import fsp from "node:fs/promises"

/**
 * **Is it there? — the three-answer probe, and the one place the errno decision is made.**
 *
 * ── THE DEFECT CLASS, in one sentence ─────────────────────────────────────────────────────────────
 *
 * *An outcome that makes a claim about the SUBJECT when the evidence only supports a claim about the
 * INSTRUMENT.* `session/session-error.ts`'s `faultEvidence` owns that decision for a **session fault**
 * (`instrument` | `subject` | `stopped`, defaulting to the safe answer). This module owns it for the
 * other half of the product's evidence: **a look at the filesystem.** The two use the same vocabulary
 * on purpose — {@link evidenceOf} maps this module's answer onto that one's — because a reader who has
 * learned one has learned both, and because "which side of the line is this on?" must have exactly one
 * answer per product, not one per module.
 *
 * ── WHY A MODULE AND NOT A CONVENTION ─────────────────────────────────────────────────────────────
 *
 * `fs.existsSync` returns `false` for `EACCES`, `EPERM`, `ELOOP` and `EIO` **exactly as it does for
 * `ENOENT`**. So "I looked and it is not there" and "I could not look" arrive as one value, and every
 * sentence built from that value asserts the first while the evidence may only support the second.
 * Audited 2026-08-19, and the same collapse was found in six independent places, each of which had
 * grown its own user-facing accusation:
 *
 * | site | what the user was told |
 * |---|---|
 * | `session-worker/supervisor.ts` | *"Session working folder no longer exists"* |
 * | `session-worker/scratch-folder.ts` | *"This chat's folder is missing"* — and the live session was MOVED |
 * | `httpapi/middleware/workspace-routing.ts` | *"Directory does not exist"* → *"Project folder is missing"* |
 * | `session/runner/strict.ts` → `jh/verifier.ts` | *"file not found: …"*, as a failed verification |
 * | `local-model/runtime.ts` | *"This local model is not installed"* — plus a phantom 2.7 GB disk demand |
 * | `fs-util.ts` (`existsSafe`) | the collapse itself, offered as a library helper |
 *
 * Three of those files each carry a careful comment about ruling 2 **and make this mistake anyway**,
 * which is the argument against fixing it with a convention: the authors knew the rule, wrote it down,
 * and still reached for `existsSync`. `packages/core/test/presence-ledger.test.ts` is the other half —
 * a new presence oracle has to come here or be ledgered with a reason, so the safe answer is the
 * default and forgetting is caught rather than shipped.
 *
 * ── WHAT IS AND IS NOT DECIDED HERE ───────────────────────────────────────────────────────────────
 *
 * ⚠️ **Nothing here executes anything and nothing here writes anything.** It stats a path. It does not
 * resolve names on `PATH` (that is `util/which.ts`, whose own arm genuinely cannot discriminate — see
 * `recipe.ts`'s note at `resolveCommand`), and it does not decide what a CALLER should do with an
 * `unreadable`. That last part is deliberate: refusing, retrying and reporting are all legitimate, and
 * they differ per surface. What is NOT legitimate, anywhere, is calling it {@link Answer absent}.
 */

/**
 * The three answers. `absent` is the only one that licenses a sentence about the user's disk.
 *
 * - `present` — we stat'd it and it is there.
 * - `absent` — we stat'd it and the filesystem said *there is nothing at that name*. A claim about the
 *   SUBJECT, and the evidence supports it.
 * - `unreadable` — **our instrument failed.** A permission refusal, a symlink loop, an I/O error, a
 *   disconnected share. It licenses nothing at all about whether the thing exists.
 */
export type Answer = "present" | "absent" | "unreadable"

/**
 * The only two errno codes that mean *there is nothing at that name*.
 *
 * ⚠️ **The set may never grow on a hunch.** Every code added here converts an instrument failure into
 * an accusation, so a new member needs the same evidence a new `faultEvidence` arm needs. `EACCES`,
 * `EPERM`, `ELOOP`, `EIO`, `EBUSY`, `ENAMETOOLONG` and whatever a network filesystem invents are all
 * out — and so is an errno we have never heard of, which is why {@link fromErrno} treats an unknown
 * code as unreadable rather than as a miss.
 */
export const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"])

/**
 * The errno decision, exported on its own so it can be asserted directly and reused by a caller that
 * already holds an error (rather than forcing a second stat).
 *
 * ⚠️ **The default is the safe answer, deliberately** — the same shape as `faultEvidence`'s: an errno
 * nobody has classified has NOT earned the right to tell a user their file is gone. The safe direction
 * is always to claim LESS about the subject's machine, never more.
 */
export const fromErrno = (code: string | undefined): "absent" | "unreadable" =>
  code !== undefined && ABSENT_CODES.has(code) ? "absent" : "unreadable"

/** What a {@link Reading} is evidence ABOUT — `session-error.ts`'s vocabulary, so the two agree. */
export const evidenceOf = (answer: Answer): "subject" | "instrument" =>
  answer === "unreadable" ? "instrument" : "subject"

export interface Reading {
  readonly answer: Answer
  /** The errno, when the probe failed. Present exactly when `answer === "unreadable"`. */
  readonly code?: string
  /** Only meaningful when `present` — a caller that needs "a FILE is there" must check it. */
  readonly isFile?: boolean
  readonly isDirectory?: boolean
  readonly bytes?: number
}

const fromStat = (stat: fs.Stats): Reading => ({
  answer: "present",
  isFile: stat.isFile(),
  isDirectory: stat.isDirectory(),
  bytes: stat.size,
})

const fromError = (error: unknown): Reading => {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined
  const answer = fromErrno(code)
  return answer === "absent" ? { answer } : { answer, ...(code === undefined ? {} : { code }) }
}

/** Stat a path and classify the result. **Never throws** — the failure IS one of the answers. */
export const read = (target: string): Reading => {
  try {
    return fromStat(fs.statSync(target))
  } catch (error) {
    return fromError(error)
  }
}

/** {@link read}, off the main thread. Same three answers, same guarantees. */
export const readAsync = async (target: string): Promise<Reading> => {
  try {
    return fromStat(await fsp.stat(target))
  } catch (error) {
    return fromError(error)
  }
}

/** Just the answer, for a caller that needs no detail. The drop-in replacement for `existsSync`. */
export const probe = (target: string): Answer => read(target).answer

/**
 * **The replacement for `existsSync(p)` in a guard**, and the name says exactly what it decides.
 *
 * `true` means *the filesystem told us there is nothing there*. It is deliberately NOT the negation of
 * "present": a path we could not read answers `false` here **and** `false` to {@link isPresent}, so a
 * caller cannot get to "it is missing" by inverting the happy case. That is the whole ergonomic point
 * — the old `!existsSync(p)` was a single negation away from a false accusation, and this is not.
 *
 * (`session/runner/memory-correction.ts` shipped this exact function, under this exact name, for this
 * exact reason. It is the working precedent, generalised.)
 */
export const isConfirmedAbsent = (target: string): boolean => probe(target) === "absent"

/** `true` only when we actually saw it. An unreadable path is not present and not absent. */
export const isPresent = (target: string): boolean => probe(target) === "present"

/**
 * The clause a message uses for an `unreadable`, in house voice: say what we did, name the errno so
 * the claim is checkable by hand, and **assert nothing about whether the thing is there**.
 *
 * Kept here rather than at each call site so the wording cannot drift into an accusation one surface at
 * a time — and because `agent-jail.ts`'s `probeCommand` lesson is to report the OBSERVATION, not only
 * the verdict, and the errno is the observation.
 */
export const couldNotRead = (target: string, reading: Reading): string =>
  `I could not read ${target} (${reading.code ?? "the check itself failed"}), so I cannot tell whether it is still there`
