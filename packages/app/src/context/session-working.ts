import type { SessionStatus } from "@novaclaw/sdk/v2/client"

/**
 * Is this session's status one where the agent is actually doing something?
 *
 * ⚠️ An ALLOWLIST, deliberately, not `!== "idle"`. `SessionStatus` is a closed set of four —
 * `idle | busy | retry | exited` (`packages/schema/src/session-status-event.ts`) — and `exited` is
 * TERMINAL. Under the old `(type ?? "idle") !== "idle"` test an exited session read as working
 * FOREVER: its spinner never stopped, its composer stayed disabled, and Chats kept it in the
 * needs-attention set. Ported from https://github.com/NancySadkov/novaclaw/pull/10 by
 * @DassaultFalconKing.
 *
 * The allowlist is also the safer direction for a set that may grow. A future status this file has
 * not seen reads as *settled*, which leaves the UI usable; the old predicate defaulted the unknown
 * case to *working*, which is the state that disables controls. When a fifth member lands, the
 * exhaustiveness test in `session-working.test.ts` fails and names it.
 *
 * ⚠️ ONE implementation on purpose. This was two byte-similar copies — `server-session.ts` and
 * `global-sync/child-store.ts` — and the bug above was present in both, which is the argument.
 */
export function isSessionWorking(status: SessionStatus | undefined): boolean {
  const type = status?.type
  return type === "busy" || type === "retry"
}
