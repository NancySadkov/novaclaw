import type { Fire } from "@/utils/calendar-api"

/**
 * What a fire record's status is allowed to CLAIM.
 *
 * 🔴 NC-REL-027 (partial) — `spawned` was rendered as "ran". It does not mean that. The scheduler
 * sets it when `launch` returns a session id, and the spawner returns that id after durable input
 * admission and a coordinator wake — before the worker has resolved the model or the agent, and
 * long before any generation. A schedule pointing at a mistyped model shows "ran" and produced
 * nothing.
 *
 * ⚠️ This is a WORDING fix, and it is the whole fix only because the calendar genuinely does not
 * know more than this. The session's terminal outcome is not on the session record — it would have
 * to be derived from its messages — so projecting real success/failure into history is a separate
 * piece of work, tracked as the other half of NC-REL-027. Calling the wake "started" is not a
 * softer way of saying "ran": it is the strongest claim the data supports.
 *
 * ⚠️ Deliberately NOT a lookup keyed by status string. The union is closed and small, and a
 * `Record<string, string>` would silently render a new status as `undefined` — the same class of
 * quiet lie this exists to remove.
 *
 * ⚠️ The status type is DERIVED from `Fire` rather than restated here. The app does not depend on
 * `@novaclaw/protocol` (the renderer dependency ledger refused the import, correctly), so the
 * nearest real type is the app's own client model — and a hand-copied union would be one more
 * thing that goes stale in silence. A new status makes this switch non-exhaustive at compile time.
 */
export function fireStatusLabel(status: Fire["status"], outcome: Fire["outcome"] = "pending"): string {
  switch (outcome) {
    case "succeeded":
      return "completed"
    case "failed":
      return "failed"
    case "interrupted":
      return "interrupted"
    case "pending":
      break
  }
  switch (status) {
    case "spawned":
      return "started"
    case "skipped":
      return "skipped"
    case "error":
      return "error"
  }
}
