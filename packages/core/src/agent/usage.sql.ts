import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// What a colleague SPENT, minute by minute (owner, 2026-08-21) — the roster's work column inherits
// this from the chat list it replaces.
//
// 🔴 **A minute with no traffic is NEVER stored, and that is the whole design.** A row here means
// "this colleague produced tokens during this minute"; an absent row means nothing happened. Storing
// a zero would turn an ABSENCE into a MEASUREMENT — and a later reader summing or averaging the
// series would treat a sleeping instance as an idle-but-observed one. It also keeps the table
// proportional to work done rather than to wall-clock time: an instance left running for a month
// costs nothing here, where a zero-filled series would cost 43,200 rows per colleague.
//
// The unit is GENERATED tokens (output + reasoning) — what the model actually produced, the same
// figure the roster row shows. Prompt ingestion is not spend a person recognises as work.
export const AgentTokenMinuteTable = sqliteTable(
  "agent_token_minute",
  {
    /** The colleague this spend belongs to. A sub-agent's tokens land on its OFFICER: the nameless
     *  staff spend on their officer's behalf, and the roster shows one number per colleague. */
    agent: text().notNull(),
    /** Epoch MINUTES (ms / 60000), not milliseconds — the bucket is the key, so the key is the
     *  bucket. Storing a timestamp and rounding at read time invites two readers to round
     *  differently and disagree about which minute a step belonged to. */
    minute: integer().notNull(),
    generated: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.agent, table.minute] })],
)
