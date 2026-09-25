export * as AgentTeamChat from "./team-chat"

import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { AgentV2 } from "../agent"
import { ColleagueNote } from "../session/colleague-note"
import { SessionMessage } from "../session/message"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { AgentRetirementTable } from "./retirement.sql"

type Db = Database.Interface["db"]

export interface Message {
  readonly id: SessionMessage.ID
  readonly sender: AgentV2.ID
  readonly recipient: AgentV2.ID
  readonly turn: "ask" | "answer" | "announce"
  readonly text: string
  readonly created: number
}

export interface StoredMessage {
  readonly id: unknown
  readonly recipient: string | null
  readonly created: number
  readonly data: unknown
}

export interface Page {
  readonly data: readonly Message[]
  readonly cursor: {
    readonly older?: string
    readonly latest?: string
  }
}

export interface ListInput {
  readonly limit?: number
  readonly before?: string
  readonly after?: string
}

interface Cursor {
  readonly created: number
  readonly id: SessionMessage.ID
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export const encodeCursor = (message: Pick<Message, "created" | "id">): string =>
  `${message.created}:${encodeURIComponent(message.id)}`

export const decodeCursor = (value: string | undefined): Cursor | undefined => {
  if (!value) return undefined
  const separator = value.indexOf(":")
  if (separator < 1) return undefined
  const created = Number(value.slice(0, separator))
  if (!Number.isFinite(created)) return undefined
  try {
    return { created, id: SessionMessage.ID.make(decodeURIComponent(value.slice(separator + 1))) }
  } catch {
    return undefined
  }
}

export const memberIDs = (roster: readonly AgentV2.Info[], officerID: string): readonly string[] => {
  const officer = roster.find((agent) => String(agent.id) === officerID)
  if (!officer || !AgentV2.isColleague(officer) || AgentV2.kindOf(officer) !== "agent") return []

  const members = new Set([officerID])
  let added = true
  while (added) {
    added = false
    for (const candidate of roster) {
      const id = String(candidate.id)
      if (members.has(id) || !AgentV2.isColleague(candidate) || AgentV2.kindOf(candidate) !== "agent") continue
      const superior = AgentV2.resolveSuperior(id, candidate.superior, roster, { includePaused: true })
      if (!superior || !members.has(String(superior.id))) continue
      members.add(id)
      added = true
    }
  }
  return [...members]
}

export const project = (rows: readonly StoredMessage[], members: readonly string[]): readonly Message[] => {
  const team = new Set(members)
  return rows.flatMap((row) => {
    if (row.recipient === null) return []
    const data = row.data as {
      readonly sender?: unknown
      readonly turn?: unknown
      readonly text?: unknown
    }
    if (
      typeof data.sender !== "string" ||
      !team.has(data.sender) ||
      !team.has(row.recipient) ||
      (data.turn !== "ask" && data.turn !== "answer" && data.turn !== "announce") ||
      typeof data.text !== "string"
    )
      return []
    return [
      {
        id: SessionMessage.ID.make(String(row.id)),
        sender: AgentV2.ID.make(data.sender),
        recipient: AgentV2.ID.make(row.recipient),
        turn: data.turn,
        text: ColleagueNote.stripReplyNote(data.text),
        created: row.created,
      } satisfies Message,
    ]
  })
}

export const list = (
  db: Db,
  roster: readonly AgentV2.Info[],
  officerID: string,
  input: ListInput = {},
): Effect.Effect<Page> => {
  const members = memberIDs(roster, officerID)
  if (members.length === 0) return Effect.succeed({ data: [], cursor: {} } satisfies Page)
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT))
  const after = decodeCursor(input.after)
  const before = after ? undefined : decodeCursor(input.before)
  const boundary = after
    ? or(
        gt(SessionMessageTable.time_created, after.created),
        and(eq(SessionMessageTable.time_created, after.created), gt(SessionMessageTable.id, after.id)),
      )
    : before
      ? or(
          lt(SessionMessageTable.time_created, before.created),
          and(eq(SessionMessageTable.time_created, before.created), lt(SessionMessageTable.id, before.id)),
        )
      : undefined
  const ascending = after !== undefined
  return Effect.gen(function* () {
    const cutoffs = new Map<string, number>()
    for (const row of yield* db
      .select({ id: AgentRetirementTable.agent, retiredAt: sql<number>`max(${AgentRetirementTable.retired_at})` })
      .from(AgentRetirementTable)
      .where(inArray(AgentRetirementTable.agent, members))
      .groupBy(AgentRetirementTable.agent)
      .all()
      .pipe(Effect.orDie)) {
      cutoffs.set(row.id, Math.max(cutoffs.get(row.id) ?? 0, row.retiredAt))
    }
    const sender = sql<string>`json_extract(${SessionMessageTable.data}, '$.sender')`
    const senderSession = sql<string | null>`json_extract(${SessionMessageTable.data}, '$.senderSessionID')`
    const recipientIdentity = or(
      ...members.map((id) => {
        const cutoff = cutoffs.get(id)
        return cutoff === undefined
          ? eq(SessionTable.agent, id)
          : and(eq(SessionTable.agent, id), gt(SessionTable.time_created, cutoff))
      }),
    )
    const senderIdentity = or(
      ...members.map((id) => {
        const cutoff = cutoffs.get(id)
        return cutoff === undefined
          ? eq(sender, id)
          : and(
              eq(sender, id),
              or(
                gt(SessionMessageTable.time_created, cutoff),
                sql`EXISTS (
                  SELECT 1 FROM ${SessionTable} AS sender_session
                  WHERE sender_session.id = ${senderSession}
                    AND sender_session.agent = ${id}
                    AND sender_session.time_created > ${cutoff}
                )`,
              ),
            )
      }),
    )
    const rows = yield* db
      .select({
        id: SessionMessageTable.id,
        recipient: SessionTable.agent,
        created: SessionMessageTable.time_created,
        data: SessionMessageTable.data,
      })
      .from(SessionMessageTable)
      .innerJoin(SessionTable, eq(SessionTable.id, SessionMessageTable.session_id))
      .where(
        and(
          eq(SessionMessageTable.type, "colleague"),
          inArray(SessionTable.agent, members),
          inArray(sender, members),
          recipientIdentity,
          senderIdentity,
          boundary,
        ),
      )
      .orderBy(
        ascending ? asc(SessionMessageTable.time_created) : desc(SessionMessageTable.time_created),
        ascending ? asc(SessionMessageTable.id) : desc(SessionMessageTable.id),
      )
      .limit(limit + 1)
      .all()
      .pipe(Effect.orDie)
    const hasOlder = !ascending && rows.length > limit
    const selected = rows.slice(0, limit)
    const data = project(ascending ? selected : selected.toReversed(), members)
    const oldest = ascending ? undefined : selected.at(-1)
    const latest = ascending ? selected.at(-1) : selected[0]
    return {
      data,
      cursor: {
        ...(hasOlder && oldest
          ? { older: encodeCursor({ id: SessionMessage.ID.make(String(oldest.id)), created: oldest.created }) }
          : {}),
        ...(latest
          ? { latest: encodeCursor({ id: SessionMessage.ID.make(String(latest.id)), created: latest.created }) }
          : input.after
            ? { latest: input.after }
            : {}),
      },
    } satisfies Page
  })
}
