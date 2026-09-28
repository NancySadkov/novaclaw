import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { AgentConfigStore } from "../agent-config-store"
import { AgentConfigTable } from "../agent-config/sql"
import type { Database } from "../database/database"
import { agentOf, sessionConfigChain } from "./config-resolve"
import { fromRow } from "./info"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

export const resolveSessionMode = Effect.fn("SessionMode.resolve")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const chain = yield* sessionConfigChain(sessionID, (id) =>
    db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(id)))
      .get()
      .pipe(
        Effect.map((row) => (row ? fromRow(row) : undefined)),
        Effect.orDie,
      ),
  )
  const agentID = agentOf(chain) ?? AgentV2.DEFAULT_COLLEAGUE_ID
  if (agentID === AgentV2.OWNER_ID) return "human" as const
  const row = yield* db
    .select()
    .from(AgentConfigTable)
    .where(eq(AgentConfigTable.name, agentID))
    .get()
    .pipe(Effect.orDie)
  const agent = AgentConfigStore.fold(row?.layers ?? [])
  const kind = AgentV2.kindOf(agent)
  if (kind !== "agent") return kind
  const shortChat =
    chain.findLast((item) => item.shortChat !== undefined)?.shortChat ??
    (agent?.kind === "agent" ? false : agent?.shortChat)
  return shortChat === true ? ("chat" as const) : ("agent" as const)
})
