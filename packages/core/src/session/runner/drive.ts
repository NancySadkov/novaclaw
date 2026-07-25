export * as SessionDrive from "./drive"

// The auto-prompt SELF-DRIVE (architecture.md "run until exit()"; todo.md Vision — sessions
// "auto-prompt themselves until they call exit()"). When an auto-prompting or goal-oriented
// session's drain runs out of input, the harness injects the next prompt itself — a
// provenance-prefixed steer (1N) — so the agent keeps working with nobody at the keyboard.
// The loop ends three ways:
//   · the agent calls `exit(result)` — the projector writes the result to the session row, and
//     `result !== undefined` is the established terminal test (session/execution/local.ts);
//   · a cap trips — the Vision requires budget/step caps + a watchdog on goal agents (the
//     paperclip-maximizer case): a per-drain ROUND cap and a WALL-CLOCK watchdog, after which
//     the drain ends with a visible notice (any new message re-arms a fresh drain);
//   · the user hits Stop — that interrupts the drain fiber itself, so it always wins.
//
// The drive keys on the session's OWN declared `type` column, never the resolved/inherited
// config walk: a spawned child (type "sub-agent") or a fork must not silently self-drive just
// because an unattended ancestor exists. Attendance semantics (Agent Jail, out-of-folder deny-fast)
// separately key on the chain ROOT — the two questions are different on purpose.
//
// PURE — no Effect, no db. The runner supplies the session row, the per-drain state, and the
// clock; this module answers "keep driving, pause with a notice, or stop".

/** Per-drain self-prompt round cap (the step cap). A fresh drain (any new message) re-arms. */
export const MAX_DRIVE_ROUNDS = 24
/** Per-drain wall-clock watchdog. Mirrors the CLI-run watchdog's order of magnitude (45 min). */
export const MAX_DRIVE_WALL_MS = 45 * 60 * 1000

export type DriveType = "auto-prompting" | "goal-oriented"

export interface DriveSession {
  readonly type?: string
  readonly result?: unknown
}

export interface DriveState {
  rounds: number
  readonly startedAt: number
}

export const initialState = (nowMs: number): DriveState => ({ rounds: 0, startedAt: nowMs })

export type DriveDecision =
  | { readonly kind: "continue"; readonly message: string }
  | { readonly kind: "cap"; readonly notice: string }
  | { readonly kind: "stop" }

/** The session's own drive type, if it declares one (undefined row/type = no drive). */
export const driveType = (session: DriveSession | undefined): DriveType | undefined =>
  session?.type === "auto-prompting" || session?.type === "goal-oriented" ? session.type : undefined

const AUTO_CONTINUE =
  "You are an unattended auto-prompting session — no user is present and none will reply. " +
  "Continue working on your task now: take the next concrete action. When the task is genuinely " +
  "finished, call the `exit` tool with a short result summary — that is how this session ends."

// ⚠️ "the goal you were given" was a lie the model could see through. Nothing hands a
// goal-oriented session a goal out of band — the goal IS the request that opened it, so a session
// spawned for a one-line question would hunt for a goal it never received, narrate that it couldn't
// find one, and exit with THAT as its result (observed live 2026-07-23 on the WhatsApp console:
// "No goal was assigned to this unattended session"). Point it at the real thing, and say plainly
// that an already-answered question is finished — self-driving exists to keep long work moving, not
// to manufacture work after the answer is in.
const GOAL_CONTINUE =
  "You are an unattended goal-oriented session — no user is present and none will reply. " +
  "Your goal is the request that opened this session (its first message). Check your progress " +
  "against that request, then take the next concrete action toward it. If the request was a " +
  "question and you have already answered it, you are done. When the goal is reached (or you can " +
  "prove it is unreachable), call the `exit` tool with a short result summary — for a question, " +
  "that summary is simply your answer. Calling `exit` is how this session ends."

const capNotice = (reason: string) =>
  `⏸️ Autonomous run paused ${reason} without calling exit. ` +
  "Review what it did so far — sending any message continues the run."

/**
 * One drive decision at drain-end (queue empty). `continue` → steer `message` and keep the
 * drain alive; `cap` → surface `notice` and let the drain end; `stop` → not a driven session
 * or it exited. The caller increments `state.rounds` on each `continue` it acts on.
 */
export const decide = (session: DriveSession | undefined, state: DriveState, nowMs: number): DriveDecision => {
  const type = driveType(session)
  if (type === undefined) return { kind: "stop" }
  // exit(result) called — the terminal test (exit records "" for a bare exit, so `!== undefined`).
  if (session !== undefined && session.result !== undefined) return { kind: "stop" }
  if (state.rounds >= MAX_DRIVE_ROUNDS) return { kind: "cap", notice: capNotice(`after ${state.rounds} self-prompted rounds`) }
  if (nowMs - state.startedAt >= MAX_DRIVE_WALL_MS)
    return { kind: "cap", notice: capNotice(`after ${Math.round((nowMs - state.startedAt) / 60_000)} minutes`) }
  return { kind: "continue", message: type === "auto-prompting" ? AUTO_CONTINUE : GOAL_CONTINUE }
}
