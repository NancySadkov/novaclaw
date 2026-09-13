export * as SessionDrive from "./drive"

// The auto-prompt SELF-DRIVE (architecture.md "run until exit()"). When an auto-prompting or
// goal-oriented session's drain runs out of input, the harness injects the next prompt itself — a
// provenance-prefixed steer — so the agent keeps working with nobody at the keyboard. Auto-prompting
// sessions end on accepted `exit(result)`. Goal-oriented officers do not: accepted exit closes one
// work unit and sleeps them, while only Stop (an authority interrupt) ends the officer.
// Resource governors may pace, reroute, or restart work; they do not acquire completion authority.
//
// The drive keys on the session's OWN declared `type` column, never the resolved/inherited
// config walk: a spawned child (type "sub-agent") or a fork must not silently self-drive just
// because an unattended ancestor exists. Attendance semantics (Agent Jail, out-of-folder deny-fast)
// separately key on the chain ROOT — the two questions are different on purpose.
//
// PURE — no Effect, no db. The runner supplies the session row, the per-drain state, and the
// clock; this module answers "keep driving or stop".

export type DriveType = "auto-prompting" | "goal-oriented"

export interface DriveSession {
  readonly type?: string
  readonly result?: unknown
}

export interface DriveState {
  rounds: number
  readonly startedAt: number
  stagnantRounds: number
  progressKey?: string
}

export interface GoalContext {
  readonly goal?: string
  /** This drain just accepted an explicit exit, closing one goal-check cycle without killing it. */
  readonly acceptedExit?: boolean
  readonly steps: ReadonlyArray<{
    readonly text: string
    readonly status: string
    readonly verdict: { readonly check: string; readonly evidence: string } | null
  }>
}

export const initialState = (nowMs: number): DriveState => ({ rounds: 0, startedAt: nowMs, stagnantRounds: 0 })

export type DriveDecision =
  | { readonly kind: "continue"; readonly message: string }
  | { readonly kind: "sleep"; readonly milliseconds: number; readonly message: string }
  | { readonly kind: "idle" }
  | { readonly kind: "terminated" }

/** The session's own drive type, if it declares one (undefined row/type = no drive). */
export const driveType = (session: DriveSession | undefined): DriveType | undefined =>
  session?.type === "auto-prompting" || session?.type === "goal-oriented" ? session.type : undefined

const AUTO_CONTINUE =
  "You are an unattended auto-prompting session — no user is present and none will reply. " +
  "Continue working on your task now: take the next concrete action. When the task is genuinely " +
  "finished, call the `exit` tool with a short result summary — that is how this session ends."

const SUB_AGENT_CONTINUE =
  "You are a delegated worker and your parent remains waiting for your result. You have not called `exit`, " +
  "so this worker is not complete. Continue the assigned task, or if it is genuinely finished call the `exit` " +
  "tool with a short result summary."

// ⚠️ "the goal you were given" was a lie the model could see through. Nothing hands a
// goal-oriented session a goal out of band — the goal IS the request that opened it, so a session
// spawned for a one-line question would hunt for a goal it never received, narrate that it couldn't
// find one, and exit with THAT as its result (observed live 2026-07-23 on the WhatsApp console:
// "No goal was assigned to this unattended session"). Point it at the real thing, and say plainly
// that an already-answered question is finished — self-driving exists to keep long work moving, not
// to manufacture work after the answer is in.
const goalContinue = (context: GoalContext | undefined) => {
  const goal = context?.goal?.trim()
  const next = context?.steps.find((step) => step.status !== "completed" || step.verdict === null)
  if (goal && context?.steps.length && !next)
    return (
      `The evaluation record has accepted every plan step for this goal: ${goal}\n` +
      "Close this work unit with an explicit `exit` call and a concise result summary. The officer will sleep until new steering arrives or the ten-minute recheck wakes it."
    )
  return (
    "You are an unattended goal-oriented session — no user is present and none will reply. " +
    (goal ? `Your durable goal is: ${goal}\n` : "Declare the durable `goal` component from the opening request.\n") +
    (next
      ? `Take the next unfinished plan step now: ${next.text}\n`
      : "Create a short ordered `plan` component set, then take its first concrete step.\n") +
    "Keep the goal and plan current through the `session` tool. A step is not verified merely because " +
    "you mark it completed; the kernel records a verdict only after its check runs. If the goal is " +
    "reached, call the `exit` tool to checkpoint this work unit. The officer remains alive until Stop. " +
    "If an external condition prevents progress for now, say what you are waiting for; the harness will " +
    "pause without consuming model capacity and try again later."
  )
}

export const UNATTENDED_SLEEP_MS = 10 * 60_000
const STAGNANT_ROUNDS_BEFORE_SLEEP = 6

const progressKey = (context: GoalContext | undefined): string =>
  JSON.stringify((context?.steps ?? []).map((step) => [step.status, step.verdict?.check ?? null]))

/**
 * One drive decision at drain-end (queue empty). `continue` keeps an autonomous worker alive;
 * `idle` means an ordinary interactive turn has drained without terminating the session;
 * `terminated` means a terminal result already exists on the session row. A goal-oriented accepted
 * exit never writes that result. Keeping those states distinct prevents a missing live signal from
 * being relabelled as an agent ending.
 */
export const decide = (
  session: DriveSession | undefined,
  state: DriveState,
  _nowMs: number,
  context?: GoalContext,
): DriveDecision => {
  const type = driveType(session)
  // A terminal result ends auto-prompting runs. It cannot end a goal-oriented officer: that type is
  // alive until Stop, even if a stale result survived a type switch or an older build.
  if (session !== undefined && session.result !== undefined && session.type !== "goal-oriented")
    return { kind: "terminated" }
  if (session?.type === "sub-agent") return { kind: "continue", message: SUB_AGENT_CONTINUE }
  if (type === undefined) return { kind: "idle" }
  if (type === "goal-oriented") {
    if (context?.acceptedExit === true)
      return {
        kind: "sleep",
        milliseconds: UNATTENDED_SLEEP_MS,
        message:
          "Ten minutes have passed since your last accepted exit. Re-check the environment and the durable goal now, then continue with the next concrete action or request another checkpoint with `exit`.",
      }
    const key = progressKey(context)
    if (state.progressKey === key) state.stagnantRounds++
    else {
      state.progressKey = key
      state.stagnantRounds = 0
    }
    if (state.stagnantRounds >= STAGNANT_ROUNDS_BEFORE_SLEEP)
      return {
        kind: "sleep",
        milliseconds: UNATTENDED_SLEEP_MS,
        message:
          "Ten minutes have passed. Re-check the environment and the durable goal now. Continue with the next " +
          "concrete action if progress is possible; if the goal is reached, checkpoint the work unit with `exit`.",
      }
  }
  return { kind: "continue", message: type === "auto-prompting" ? AUTO_CONTINUE : goalContinue(context) }
}
