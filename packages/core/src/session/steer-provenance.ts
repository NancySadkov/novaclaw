// 1N (codehamr A1) — every harness-injected steer carries this provenance prefix. A ~30B model
// reads a bare mid-turn injected message as an *empty user turn* and just stops; naming the note
// as an automated check (not the user speaking) keeps it acting. The prefix doubles as the steer
// MARKER across the system: title generation, Strict, context-pack, and the session-ui renderer
// all detect steers by it (it is the only steer fact that survives into the durable message text).
//
// This module is PURE and dependency-free ON PURPOSE — the session-ui renderer imports it into
// the browser bundle to fold steers out of the transcript, so nothing server-only (db, Effect,
// drizzle) may ever be imported here. The injection machinery lives in `session/input.ts`.
export const STEER_PROVENANCE_PREFIX = "[Automated NovaClaw check — not a message from your user.] "

/** Prepend the 1N provenance prefix unless the text already carries it (idempotent). */
export const applySteerProvenance = (text: string) =>
  text.startsWith(STEER_PROVENANCE_PREFIX) ? text : STEER_PROVENANCE_PREFIX + text

/** Whether a user-role message text is a harness-injected steer rather than the user speaking. */
export const isSteerText = (text: string) => text.startsWith(STEER_PROVENANCE_PREFIX)

/** The steer body without the provenance prefix (for display — the model still sees the full text). */
export const stripSteerProvenance = (text: string) =>
  text.startsWith(STEER_PROVENANCE_PREFIX) ? text.slice(STEER_PROVENANCE_PREFIX.length) : text
