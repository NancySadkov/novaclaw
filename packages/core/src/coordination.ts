export * as Coordination from "./coordination"

import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { AgentV2 } from "./agent"
import { AgentTeamChat } from "./agent/team-chat"
import { AgentCoordinationTable } from "./coordination/sql"
import { TASK_MAX, taskOrNone, taskTooLongNotice } from "./coordination/task"
import type { Database } from "./database/database"

export { TASK_MAX, taskOrNone, taskTooLongNotice }

/**
 * The coordination task board — the store half plus the pure rendering.
 *
 * 🔴 A TASK IS A COMPONENT ON THE AGENT, and this is the whole reason the feature is not just a
 * `memo_set`. An officer declares what it is working on (or its superior assigns it), and the answer
 * must survive a "Clear chat" and reach the officer again after a compaction — which a per-session
 * value cannot do. The prompt renders it every epoch (see `PromptManager`), the board endpoint reads
 * it for the owner, and the `coordination` tool is the only writer.
 */

/** One officer's row on the board, as the owner and a superior read it. */
export interface Entry {
  readonly agent: AgentV2.ID
  readonly name?: string | undefined
  readonly title?: string | undefined
  readonly superior?: AgentV2.ID | undefined
  readonly task?: string | undefined
  /** Whether this officer's SUPERIOR broadcasts task changes to the tier. Absent = on. */
  readonly teamCoordination: boolean
}

export const get = (db: Database.Interface["db"], agent: string): Effect.Effect<string | undefined> =>
  db
    .select({ task: AgentCoordinationTable.task })
    .from(AgentCoordinationTable)
    .where(eq(AgentCoordinationTable.agent, agent))
    .get()
    .pipe(
      Effect.map((found) => found?.task),
      Effect.orDie,
    )

export const taskMap = (
  db: Database.Interface["db"],
  agents: readonly string[],
): Effect.Effect<ReadonlyMap<string, string>> =>
  agents.length === 0
    ? Effect.succeed(new Map<string, string>())
    : db
        .select()
        .from(AgentCoordinationTable)
        .where(inArray(AgentCoordinationTable.agent, [...agents]))
        .all()
        .pipe(
          Effect.map((rows) => new Map(rows.map((r) => [r.agent, r.task]))),
          Effect.orDie,
        )

export const put = (db: Database.Interface["db"], agent: string, task: string): Effect.Effect<void> => {
  const now = Date.now()
  return db
    .insert(AgentCoordinationTable)
    .values({ agent, task, time_created: now, time_updated: now })
    .onConflictDoUpdate({ target: AgentCoordinationTable.agent, set: { task, time_updated: now } })
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

/** Clearing DELETES the row, so "no task" is a state rather than an empty string. */
export const remove = (db: Database.Interface["db"], agent: string): Effect.Effect<void> =>
  db
    .delete(AgentCoordinationTable)
    .where(eq(AgentCoordinationTable.agent, agent))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

const entry = (agent: AgentV2.Info, tasks: ReadonlyMap<string, string>): Entry => ({
  agent: agent.id,
  ...(agent.name === undefined ? {} : { name: agent.name }),
  ...(agent.title === undefined ? {} : { title: agent.title }),
  ...(agent.superior === undefined ? {} : { superior: agent.superior }),
  ...(tasks.has(String(agent.id)) ? { task: tasks.get(String(agent.id)) } : {}),
  // Absent means ON: the feature has to work out of the box, and turning it off is the deliberate act.
  teamCoordination: agent.teamCoordination !== false,
})

/**
 * The officers under one supervisor, and the supervisor itself — the requirement's own shape:
 * *"for each officer under given supervisor (and supervisor itself) the tasks assigned to each
 * officer"*. The anchor is included first, then its direct reports in roster order.
 */
export const supervisorBoard = (
  roster: readonly AgentV2.Info[],
  tasks: ReadonlyMap<string, string>,
  supervisorID: string,
): readonly Entry[] => {
  const anchor = roster.find((agent) => String(agent.id) === supervisorID)
  if (anchor === undefined) return []
  return [anchor, ...AgentV2.directReports(supervisorID, roster)].map((agent) => entry(agent, tasks))
}

/**
 * The whole TEAM an officer belongs to: the officer, its superior, its peers, and its direct reports
 * — the same membership the Team Chat beside the board shows, so the two tabs cannot disagree about
 * who is on the team.
 */
export const teamBoard = (
  roster: readonly AgentV2.Info[],
  tasks: ReadonlyMap<string, string>,
  officerID: string,
): readonly Entry[] => {
  const members = new Set(AgentTeamChat.memberIDs(roster, officerID))
  return roster.filter((agent) => members.has(String(agent.id))).map((agent) => entry(agent, tasks))
}

/** The model-facing rendering of a board: one line per officer, tasks included. */
export const format = (entries: readonly Entry[], selfID: string): string => {
  if (entries.length === 0) return "No one to show — name a supervisor whose team you belong to."
  return entries
    .map((item) => {
      const role = item.title?.trim() || item.name?.trim() || item.agent
      const you = item.agent === selfID ? " (you)" : ""
      const coordination = item.teamCoordination ? "" : " · team coordination off"
      return `${item.agent} - ${role}${you}: ${taskOrNone(item.task)}${coordination}`
    })
    .join("\n")
}
