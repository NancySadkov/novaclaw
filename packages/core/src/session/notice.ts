export * as SessionNotice from "./notice"

/**
 * The marker an instance stall notice's id carries.
 *
 * 🔴 A LEAF, with no imports, so the browser transcript can recognise a notice without pulling the
 * session/input/sql tree (which owns a database) into the renderer bundle — the same reason
 * `steer-provenance.ts` is a leaf. `colleague-stall.ts` re-exports both names, so nothing that already
 * spells them `ColleagueStall.<name>` has to change.
 *
 * The prefix is load-bearing twice there: the id is the memory of having told someone (a second sweep
 * derives the same one and the primary key refuses it), and it is how the hop walks recognise a notice
 * they must not read as a turn.
 */
export const NOTICE_PREFIX = "msg_stall_"

/** Is this message id an instance notice rather than somebody's turn? */
export const isNotice = (messageID: string | undefined): boolean =>
  typeof messageID === "string" && messageID.startsWith(NOTICE_PREFIX)
