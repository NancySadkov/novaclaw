export * as SessionDrive from "./drive"

// The auto-prompt SELF-DRIVE (architecture.md "run until exit()"; todo.md Vision — sessions
// "auto-prompt themselves until they call exit()"). When an auto-prompting or goal-oriented
// session's drain runs out of input, the harness injects the next prompt itself — a
// provenance-prefixed steer (1N) — so the agent keeps working with nobody at the keyboard.
// The loop ends only when the agent calls `exit(result)` or an authority interrupts the drain.
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
}

export interface GoalContext {
  readonly goal?: string
  readonly steps: ReadonlyArray<{
    readonly text: string
    readonly status: string
    readonly verdict: { readonly check: string; readonly evidence: string } | null
  }>
}

export const initialState = (nowMs: number): DriveState => ({ rounds: 0, startedAt: nowMs })

export type DriveDecision = { readonly kind: "continue"; readonly message: string } | { readonly kind: "stop" }

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
      "Completion still requires your explicit `exit` call. Call the `exit` tool now with a concise result summary."
    )
  return (
    "You are an unattended goal-oriented session — no user is present and none will reply. " +
    (goal ? `Your durable goal is: ${goal}\n` : "Declare the durable `goal` component from the opening request.\n") +
    (next
      ? `Take the next unfinished plan step now: ${next.text}\n`
      : "Create a short ordered `plan` component set, then take its first concrete step.\n") +
    "Keep the goal and plan current through the `session` tool. A step is not verified merely because " +
    "you mark it completed; the kernel records a verdict only after its check runs. If the goal is " +
    "unreachable, call the `exit` tool with the evidence."
  )
}

/**
 * One drive decision at drain-end (queue empty). `continue` keeps an autonomous worker alive;
 * `stop` means an ordinary interactive turn is idle or `exit(result)` already landed.
 */
export const decide = (
  session: DriveSession | undefined,
  _state: DriveState,
  _nowMs: number,
  context?: GoalContext,
): DriveDecision => {
  const type = driveType(session)
  // exit(result) called — the terminal test (exit records "" for a bare exit, so `!== undefined`).
  // Checked before every self-drive arm: `exit` already published the sole completion event.
  if (session !== undefined && session.result !== undefined) return { kind: "stop" }
  if (session?.type === "sub-agent") return { kind: "continue", message: SUB_AGENT_CONTINUE }
  if (type === undefined) return { kind: "stop" }
  return { kind: "continue", message: type === "auto-prompting" ? AUTO_CONTINUE : goalContinue(context) }
}
