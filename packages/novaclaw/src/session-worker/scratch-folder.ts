import { Global } from "@novaclaw/core/global"
import { Presence } from "@novaclaw/core/presence"
import { AbsolutePath } from "@novaclaw/core/schema"
import type { SessionSchema } from "@novaclaw/core/session/schema"
import fs from "node:fs"
import path from "node:path"

/**
 * Where a session runs when its own working folder has gone.
 *
 * 🔴 **The vision law this serves is "never breaks in your hands — degrade and recover".** A working
 * directory can vanish under a live session: deleted, renamed, an unmounted share, an ejected volume,
 * or a git worktree removed by the `worktree remove` path. Before this, the worker refused to start
 * (`session-worker/supervisor.ts` probes the folder first, deliberately, so the fault names the
 * folder rather than blaming the interpreter) and the session was ISOLATED after repeated failures —
 * legible, but stopped, waiting for a human to restore the folder or repoint the session.
 *
 * ⚠️ **The queued prompt was the real casualty.** Measured 2026-08-07: the prompt is accepted with
 * `200` and an `admittedSeq`, then the worker cannot start, and the row stays `promoted_seq = NULL`
 * with **no `user` message ever written** — so the user's words live in `session_input` and nowhere
 * they can be seen. Recovering the session is what lets that input be promoted normally.
 *
 * **Stable per session, deliberately.** The path is keyed on the session id, so a session that loses
 * its folder twice returns to the SAME scratch directory and anything the agent wrote there is still
 * present. A fresh directory per incident would quietly discard the agent's own work — which is the
 * failure this whole mechanism exists to prevent, one level up.
 */
export const scratchDirectory = (sessionID: SessionSchema.ID): string =>
  path.join(Global.Path.data, "scratch", sessionID)

/**
 * The directory a session should actually run in: its own if it is there, a scratch folder if not.
 *
 * Returns the ORIGINAL path unchanged in the normal case, so callers can compare identity to decide
 * whether anything happened — no separate "did it move" flag to fall out of step with the answer.
 *
 * ⚠️ **Creation failure is not fatal here.** If the scratch folder cannot be made, this returns the
 * original (missing) path and the supervisor's existing guard refuses the spawn with its clear
 * message. That is strictly the old behaviour, which is the right thing to degrade to: a recovery
 * mechanism must never turn a stopped session into a crashed one.
 */
export const workingDirectory = (sessionID: SessionSchema.ID, directory: string): AbsolutePath => {
  // ⚠️ **Only a CONFIRMED absence may move a session** (`@novaclaw/core/presence`). This used to test
  // `existsSync`, which answers `false` for `EACCES`, `EPERM`, `ELOOP` and `EIO` exactly as it does for
  // `ENOENT` — so a project folder that had merely lost read permission, or lived on a share that was
  // erroring rather than unmounted, silently RELOCATED a live session and durably wrote the
  // `missing_working_folder` component, which tells the user their folder "is no longer there".
  //
  // 🔴 The direction matters and it is the reverse of the usual degrade. Everywhere else the safe move
  // is to keep going; here "keeping going" is itself the destructive act, because it detaches the
  // session from the user's real work. So an `unreadable` returns the ORIGINAL path and the
  // supervisor's guard refuses the spawn with a sentence that names the errno and claims nothing —
  // which is exactly the behaviour this function's own header calls "the right thing to degrade to".
  if (!Presence.isConfirmedAbsent(directory)) return AbsolutePath.make(directory)
  const scratch = scratchDirectory(sessionID)
  try {
    fs.mkdirSync(scratch, { recursive: true })
    return AbsolutePath.make(scratch)
  } catch {
    return AbsolutePath.make(directory)
  }
}
