export * as UnjoinedChildren from "./unjoined-children"

/**
 * A fan-out that finished with a child nobody accounted for.
 *
 * 🔴 **The failure this exists for** (measured 2026-08-27, the delegated 100-file run `4623-S2`):
 * **`spawn:10` against `wait:9` and `exit:9`.** Ten children were started, nine were waited on, nine
 * exited. One was launched and never accounted for. The run completed anyway, reported success, and
 * **nothing surfaced it.**
 *
 * ⭐ **The nine successes are what hide the tenth.** A consolidator handed nine slices of ten
 * produces a plausible, complete-looking, WRONG answer — there is no ragged edge to notice, no error
 * to read, and the aggregate looks exactly like a finished job. That is why this is a harness check
 * and not something the model can be asked to remember: the one observation that would reveal it
 * (*"I spawned ten and joined nine"*) is a counting task across a transcript the model no longer
 * fully holds, performed by the very turn that already believes it is done.
 *
 * ⭐ **The harness enumerates GROUND TRUTH here, so it CHECKS rather than asks** — the principle
 * `unfinished-set.ts` applies to files, applied to children. Successful `spawn` outputs identify the
 * children created for the CURRENT user task; each child's durable row confirms the parent relation
 * and carries its `exit(result)`; terminal `wait` results say which the parent actually joined. The
 * difference is computed, never believed. Scoping by spawn output is load-bearing: a colleague chat
 * survives many user tasks, so `SessionStore.children` alone is an all-history inventory that would
 * revive yesterday's workers in today's answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 **THE DIVISION OF LABOUR WITH `tool/wait.ts`, and why this module does NOT judge liveness.**
 *
 * `wait.ts` already owns *"is this child dead or merely slow?"* — `deadChildMessage` reads the
 * execution-attempt row and tells a waiting parent that its child failed rather than being slow,
 * with the instruction to re-issue that slice. It is reached only from INSIDE a `wait` call, so the
 * child the parent never waits on is by construction outside everything it can see.
 *
 * This module answers the complementary question — *"which children did you forget?"* — and its
 * remedy is to send the parent to `wait`, which then delivers the liveness verdict. So the pair
 * composes: **this finds the forgotten child, `wait` diagnoses it.**
 *
 * ⚠️ **Deliberately NOT re-deriving alive/dead here.** Doing so would need
 * `SessionExecutionAttempt.Service` resolved inside the runner, and would put a second answer to a
 * question `wait` already answers — *two seams answering one question*, which `tool/spawn.ts` names
 * as ruling 6's forbidden shape, and a second copy is what drifts. What this module adds that `wait`
 * cannot is the **slice**: `wait`'s dead message says *"re-issue that slice yourself"* and has no way
 * to say WHICH, because the spawn prompt was never its to hold.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **PURE — no Effect, no db, no clock.** Same reason as `unfinished-set.ts` and
 * `harness-config.ts`: `runner/llm.ts` is the one file the default gate never executes
 * (`test/session-runner.test.ts` is win32-skipped), so a claim about behaviour inside it is
 * unverifiable on a Windows box. The runner supplies the enumerated children and the joined set;
 * every decision below is exercised directly.
 */

export type Disposition =
  /**
   * The child EXITED — it produced a result — and the parent never read it.
   *
   * The clearest form of the measured defect: work was done, paid for, and thrown away, while the
   * merge proceeded as though the slice had never been requested.
   */
  | "unjoined"
  /**
   * The child has not exited, and this check does not know whether it is working or dead.
   *
   * ⚠️ **Not a weaker verdict — a correctly SCOPED one.** `wait` is the seam that reads the
   * execution-attempt row, so the remedy is to call it. Guessing "dead" here would send the parent to
   * duplicate work a live child is doing, on the very device the fan-out exists to saturate; guessing
   * "alive" would restore the silence this module exists to break.
   */
  | "pending"

/** One child, as the runner enumerated it. */
export interface Child {
  readonly id: string
  /**
   * Did the child call `exit(result)`? Read from the child's own session row (`Session.Info.result`),
   * which is durable — unlike a `spawn` call in a transcript window that compaction can take back.
   */
  readonly exited: boolean
  /**
   * The prompt this child was spawned with — its SLICE.
   *
   * ⚠️ Optional because it IS accumulated from the parent's `spawn` tool calls, and that window does
   * shrink under compaction. When absent the message says *"re-issue its slice"* without naming it;
   * what it must never do is invent one. A restart aimed at a hallucinated slice is worse than the
   * silence it replaces.
   */
  readonly slice?: string | undefined
}

/** A child, plus what the harness concluded about it. */
export interface Verdict {
  readonly id: string
  readonly disposition: Disposition
  readonly slice?: string | undefined
}

/**
 * The children this turn never accounted for.
 *
 * A child is ACCOUNTED FOR when the parent joined it — called `wait` on its id and got an answer.
 * Both answers count: a completion is obviously accounting, and so is `wait` reporting the child
 * DEAD, because the parent was then told in as many words to re-issue that slice. What does not
 * count is never having asked.
 *
 * @param children children spawned by the current user task, intersected with
 *   `SessionStore.children` to confirm their durable parent relation.
 * @param joined ids the parent called `wait` on and got an answer for, accumulated across the whole
 *   request for the same reason `setOpened` is — one turn's window is not the request.
 */
export const unaccounted = (input: {
  readonly children: readonly Child[]
  readonly joined: ReadonlySet<string>
}): readonly Verdict[] =>
  input.children
    .filter((child) => !input.joined.has(child.id))
    .map((child) => ({
      id: child.id,
      disposition: child.exited ? ("unjoined" as const) : ("pending" as const),
      ...(child.slice === undefined ? {} : { slice: child.slice }),
    }))

/**
 * How many times the harness will steer one request back to its children.
 *
 * 🔴 **A bound, not a target — and the reason it is SMALL.** This drive fires at the end of a turn
 * that believes it is finished, and its instruction is *go join / re-issue*. Unlike the set drive,
 * whose work is bounded by the folder, a restart can itself spawn a child that fails, producing
 * another unaccounted child, producing another steer. The bound is explicit: *"A restart that
 * itself fails must not loop."*
 *
 * Three rounds is one join, one replacement, and one last look — past that the fan-out is not
 * recovering and the honest move is to stop, which is what a hard ceiling delivers. Same shape as
 * `FinishRecovery.MAX_RECOVERIES` and for the same reason: an informational nudge does not converge
 * a mechanism that is actually broken.
 */
export const MAX_RESTART_ROUNDS = 3

/** A wait accounts for a child only after the tool has established a terminal outcome. */
export const isTerminalWaitResult = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "terminal" in result && result.terminal === true

/**
 * The most children one message will name.
 *
 * `session/spawner.ts` caps a fan-out at `MAX_SPAWN_CHILDREN` 16, so a full one could put sixteen
 * ids and sixteen slices into a single steer. Naming a handful and counting the rest is what
 * `UnfinishedSet.STEER_BATCH` settled for files, and the argument carries: an instruction that
 * cannot land is not an instruction.
 */
export const NAME_LIMIT = 5

/** How much of a slice is echoed back. Enough to identify the work, never the whole prompt again. */
const SLICE_ECHO = 160

/**
 * Should the harness steer the turn back to its unaccounted children?
 *
 *  · `unaccounted.length > 0` — nothing forgotten means nothing to say.
 *  · `rounds < MAX_RESTART_ROUNDS` — the bound above.
 *
 * ⚠️ There is deliberately no "only if the user asked for delegation" clause, and that is the
 * difference from `UnfinishedSet.shouldContinue`. A set drive can fire on a user who wanted ONE
 * thing, so it reads the user's words first. This cannot: the parent SPAWNED the children itself, so
 * the evidence that the work was delegated is the delegation. Reading the prompt for a cue here
 * would only reintroduce the substring hazard that cost 835,145 tokens, for no gain.
 */
export const shouldRestart = (input: {
  readonly unaccounted: readonly Verdict[]
  /** How many times this request has already been steered here. Bounded by `MAX_RESTART_ROUNDS`. */
  readonly rounds: number
}): boolean => {
  if (input.rounds >= MAX_RESTART_ROUNDS) return false
  return input.unaccounted.length > 0
}

const truncate = (text: string): string =>
  text.length <= SLICE_ECHO ? text : text.slice(0, SLICE_ECHO).trimEnd() + "…"

const line = (verdict: Verdict): string => {
  const slice = verdict.slice === undefined ? "" : ` — its slice was: ${truncate(verdict.slice)}`
  return verdict.disposition === "unjoined"
    ? `${verdict.id} FINISHED and you never read its result — call wait("${verdict.id}")${slice}`
    : `${verdict.id} never reported back — call wait("${verdict.id}"), which will say whether it is ` +
        `still working or died; if it died, spawn a fresh replacement session${slice}`
}

/**
 * What the model is told.
 *
 * 🔴 **It leads with the ARITHMETIC, because the arithmetic is the thing the model could not do.**
 * *"You spawned 10 children and read the results of 9"* is a fact the harness counted and the model
 * demonstrably did not — and unlike *"check your children"*, it cannot be satisfied by looking and
 * concluding everything is fine. The measured run's entire failure was believing the set was covered.
 *
 * ⚠️ **And it forbids the answer the model would otherwise give.** Told it is missing a slice at the
 * end of a long fan-out, the cheap moves are to write the summary anyway with a caveat, or to
 * describe the missing slice from the other children's output. Both produce the complete-looking
 * wrong answer this check exists to prevent, so both are named.
 */
export const restartMessage = (input: {
  readonly spawned: number
  readonly joined: number
  readonly unaccounted: readonly Verdict[]
}): string => {
  const named = input.unaccounted.slice(0, NAME_LIMIT)
  const after = input.unaccounted.length - named.length
  const one = input.unaccounted.length === 1
  return (
    `Not finished: you spawned ${input.spawned} child session${input.spawned === 1 ? "" : "s"} and read the ` +
    `result of ${input.joined}. ${input.unaccounted.length} ${one ? "child is" : "children are"} unaccounted ` +
    `for, so part of this work has no result behind it:\n` +
    named.map((verdict) => `- ${line(verdict)}`).join("\n") +
    (after > 0 ? `\n- …and ${after} more, same treatment.` : "") +
    `\nDo this before you answer. Do not summarise a slice from what the other children reported, and ` +
    `do not deliver the merged answer with a note that some part is missing — a merge that silently ` +
    `drops a slice looks exactly like a complete one, which is why you are being told to close this.`
  )
}
