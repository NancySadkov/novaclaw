import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * What each colleague is CURRENTLY WORKING ON — one row per agent.
 *
 * 🔴 The owner's framing (2026-08-28): *"each agent has a single session as its component, and every
 * few hours if agent did some work we update the current task name + status, which we display in the
 * contacts app, just like normal chat apps display contact statuses."* Both the user and other
 * agents get quick feedback on any given agent without opening its chat.
 *
 * ⚠️ A component on the AGENT, not a field on its chat. The chat is itself a component
 * (`ses_<agent>`), and hanging "what are you doing" off the transcript is what the retired session
 * TITLE did — a per-conversation label that could not answer a question about the colleague. Keyed
 * by agent id so a lookup from Contacts is the roster's own key, with no session in the path.
 *
 * ⚠️ It stores only what must be REMEMBERED: the label and when it was derived. Whether the
 * colleague is busy right now is not stored — `session.status` already owns that truth and a second
 * copy would go stale exactly when it mattered (the process that would clear it is the one that
 * died). Contacts joins the two at read time.
 */
export const AgentStatusTable = sqliteTable("agent_status", {
  /** The agent id — the roster's key, and the same segment its chat id carries. */
  agent: text().primaryKey(),
  /**
   * One short line, in the user's own terms: *"reviewing the P2P handshake"*. Never a tool name,
   * never a session id.
   */
  task: text().notNull(),
  /**
   * The newest activity this label was derived FROM, as epoch millis — not when the label was
   * written.
   *
   * ⚠️ The distinction is what makes the refresh decidable. "When did we last write" cannot tell a
   * colleague who has been idle for a day from one who has been working the whole time, so a pass
   * keyed on it either re-summarises unchanged transcripts forever or goes stale. Keyed on the
   * activity it summarised, "is there anything newer than this?" is a single comparison.
   */
  observed: integer().notNull(),
  ...Timestamps,
})
