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

// 🔴 **"Declare the durable `goal` component" was a harness steer that told an agent to author its own
// objective, and it is GONE (owner, 2026-09-16: *"The goal is something user or agent's Superior officer
// sets. Agent can't set its own goal (i.e. no set your durable goal nudges)"*). Two things were wrong
// with it at once: the authority model — an objective a colleague can rewrite is one it can walk away
// from — and the mechanics, because the write it named is `session_privileged` and a default install
// converts that to a DENY, so the line asked for something the agent could not do.
//
// The comment that used to justify it ("Nothing hands a goal-oriented session a goal out of band — the
// goal IS the request that opened it") was true before the durable goal existed and false since: the
// user's Goal field writes `agents.<id>.goal`, which is now the goal's only home, and the runner prefers
// it over the per-session component. A session with no goal is a session nobody gave one; the honest
// instruction is to work the request that opened it and say so.
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
    // The goal itself is in the system prompt now (owner, 2026-09-16), so this steer does not repeat
    // it: two copies of the objective in one request is how the two drift apart.
    (goal
      ? "Your durable goal is set out at the end of your system prompt. Work it.\n"
      : "No durable goal is set for this session. Work the request that opened it, then `exit` with a short result summary.\n") +
    (next
      ? `Take the next unfinished plan step now: ${next.text}\n`
      : "Create a short ordered `plan` component set, then take its first concrete step.\n") +
    "Keep the plan current through the `session` tool. A step is not verified merely because " +
    "you mark it completed; the kernel records a verdict only after its check runs. If the goal is " +
    "reached, call the `exit` tool to checkpoint this work unit. The officer remains alive until Stop. " +
    "If an external condition prevents progress for now, say what you are waiting for; the harness will " +
    "pause without consuming model capacity and try again later."
  )
}

export const UNATTENDED_SLEEP_MS = 10 * 60_000
const STAGNANT_ROUNDS_BEFORE_SLEEP = 6

/**
 * THE objective a goal-oriented session works to — one precedence, two readers.
 *
 * 🔴 Owner, 2026-09-16: *"The goal is something user or agent's Superior officer sets."* So the
 * ASSIGNED goal is the officer's configured one (`agents.<id>.goal`, which the user and a superior write
 * through the operator's own surface); the per-session component is the kernel's narrower carrier and is
 * consulted only when the role has no brief. That is the order this function encodes.
 *
 * ⚠️ **It exists because the same question is asked twice** — once by the drain, to decide whether a
 * session has stalled against its objective, and once when the system prompt is composed, to show the
 * model what it is for. Two copies of a precedence are two answers that drift — the defect that
 * retired the hand-kept prompt block lists — and a session steering by one goal while being shown
 * another is worse than either alone.
 */
export const assignedGoal = (input: {
  readonly officerGoal: string | undefined
  readonly component: unknown
}): string | undefined => {
  if (typeof input.officerGoal === "string" && input.officerGoal.trim()) return input.officerGoal
  const value = input.component
  return typeof value === "object" && value !== null && "text" in value ? String(value.text) : undefined
}

/**
 * Is this session UNATTENDED — i.e. does the goal belong in its context?
 *
 * 🔴 Owner, 2026-09-16: *"Switching agent from Interactive mode to Unattended or back should take
 * immediate effects with adding/removing goal to its context, even if that will lead to prompt prefix
 * cache misses."*
 *
 * ⚠️ **The officer's own standing choice wins over the session's stamped `type`, and that is the whole
 * point.** `operationMode` is read per turn from the agent record, so a config write takes effect on the
 * next turn; the `type` column is stamped at session CREATION, so on its own it would make the switch
 * wait for the UI's compensating `switchType` call — which is a second request that silently no-ops when
 * there is no chat, folder or connection. When the role declares nothing, the chat's classification is
 * the only statement there is. A chat-level difference loses to the role here on purpose: the goal is
 * the object of the ROLE, and a role that works unattended owns its objective in every chat it has.
 */
export const unattendedMode = (input: {
  readonly operationMode: "interactive" | "unattended" | undefined
  readonly sessionType: string | undefined
}): boolean =>
  input.operationMode === "unattended" || (input.operationMode === undefined && input.sessionType === "goal-oriented")

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
