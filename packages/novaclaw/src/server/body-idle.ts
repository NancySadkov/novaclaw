/**
 * Put an IDLE clock on a request body read — and take it off the moment the body ends.
 *
 * 🔴 **NC-SEC-005 — the body read had no clock of any kind.** The byte half is guarded
 * (`HttpIncomingMessage.MaxBodySize` at 64 MiB below every route) and the header phase is guarded
 * (`headersTimeout`). Between them sat the body: `requestTimeout = 0` frees the whole-request clock so
 * SSE can be infinite, and nothing replaced it on the request side. One authenticated client could
 * send headers and then dribble a body forever, holding a connection per request — a byte ceiling
 * does not expire, so 64 MiB delivered one byte a minute is inside every limit that existed.
 *
 * ⚠️ **IDLE, not total, and that is what keeps SSE alive.** It fires only when NO bytes arrive for the
 * window, and it is cleared when the body ends — so a streaming RESPONSE, whose request body finished
 * immediately, is never on this clock. A total body deadline would re-break precisely what
 * `requestTimeout = 0` was set to fix: the "connection lost — reconnecting…" blips minutes apart
 * during healthy turns.
 *
 * ⚠️ Extracted so it can be TESTED. The arming lives on a real socket, and the server harness in this
 * package calls handlers in-process (`app().request(...)`) — a test through that door would arm
 * nothing and pass. Everything here is the decision; `server.ts` only supplies the real request.
 */

/** The bits of a Node request this needs — narrowed so a test can supply them. */
export type IdleRequest = {
  readonly method?: string | undefined
  setTimeout: (ms: number, callback?: () => void) => unknown
  once: (event: string, listener: () => void) => unknown
}

export type IdleResponse = {
  readonly writableEnded: boolean
  destroy: () => unknown
}

export function armBodyIdle(req: IdleRequest, res: IdleResponse, idleMs: number): boolean {
  // ⚠️ Only methods that CARRY a body. A GET holding an SSE stream must not arm a socket timeout it
  // would then have to race.
  if (idleMs <= 0) return false
  if (req.method === "GET" || req.method === "HEAD") return false
  req.setTimeout(idleMs, () => {
    if (!res.writableEnded) res.destroy()
  })
  // Cleared on BOTH: `end` for a body that completed, `close` for one that died mid-flight. Leaving it
  // armed would put the HANDLER's own work on a clock meant for the peer — a slow tool call would look
  // like a slow uploader.
  const clear = () => req.setTimeout(0)
  req.once("end", clear)
  req.once("close", clear)
  return true
}
