export * as AgentRetirement from "./retirement"

import { desc, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { AgentRetirementTable } from "./retirement.sql"

type Db = Database.Interface["db"]

export const latest = (db: Db, agent: string): Effect.Effect<number | undefined> =>
  db
    .select({ retiredAt: AgentRetirementTable.retired_at })
    .from(AgentRetirementTable)
    .where(eq(AgentRetirementTable.agent, agent))
    .orderBy(desc(AgentRetirementTable.retired_at), desc(AgentRetirementTable.id))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.retiredAt),
    )

export const nextCreatedAt = (db: Db, agent: string, now: number): Effect.Effect<number> =>
  latest(db, agent).pipe(Effect.map((retiredAt) => Math.max(now, (retiredAt ?? -1) + 1)))

export const record = (db: Db, agent: string, retiredAt: number): Effect.Effect<void> =>
  db
    .insert(AgentRetirementTable)
    .values({ agent, retired_at: retiredAt })
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
