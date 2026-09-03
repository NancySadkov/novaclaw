/**
 * WHY A TURN ENDED WITHOUT SETTLING — in words the person running it can act on.
 *
 * `loop()` settles on exactly one event: `session.status` with `status.type === "idle"` for its own
 * session. If the event stream ends before that arrives, the run did NOT complete, and the CLI has
 * to say so rather than exit 0 on a turn that never happened.
 *
 * 🔴 There are two ways to get here and they need different words, because they send the reader to
 * different places:
 *
 *   - `disposed` — the server told us it was disposing this instance. Any accepted config WRITE
 *     disposes every instance (`handlers/global.ts` `configUpdate`); `server.instance.disposed` is a
 *     served bus event since 2026-09-03 (`schema/instance-event.ts`), so `loop()` records it for its
 *     own directory and reports it when the turn never settles. Nothing is wrong with the machine or
 *     the network; something reconfigured the server.
 *   - `stream-ended` — the stream simply stopped, with no reason given.
 *
 * ⚠️ The CLI already RECEIVED the disposal and threw it away. `loop()` filters every event on
 * `data.sessionID`, and the disposal carries only `{ directory }` — so it read as "not mine"
 * and was skipped a moment before the stream ended. The one event that explained the failure was in
 * hand, discarded, and then re-derived from scratch (2026-08-24) with a synchronous file probe.
 * That is what this module exists to prevent happening a second time.
 *
 * The policy lives here rather than in the closure so it is unit-tested — same reasoning as
 * `sessionErrorLines`.
 */
export type IncompleteReason = "disposed" | "stream-ended"

export const incompleteMessage = (reason: IncompleteReason): string =>
  reason === "disposed"
    ? "the server disposed this instance before the turn finished — the run did not complete. " +
      "A config change (from any client, including another window) disposes running instances."
    : "lost the event stream before the turn finished — the run did not complete"
