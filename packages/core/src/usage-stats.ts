export * as UsageStats from "./usage-stats"

import { DateTime, Effect } from "effect"
import { Database } from "./database/database"
import { SessionTable } from "./session/sql"
import { fromRow } from "./session/info"
import { SessionMessageRead } from "./session/message-read"

/**
 * Token, cost and tool usage rolled up across an instance's sessions.
 *
 * 🔴 **This lived in `novaclaw/src/cli/cmd/stats.ts` until 2026-09-04, which is why it is being
 * moved rather than written.** Principle 7 — one UI, for humans — says an analytics dashboard is an
 * app in the shell, never a developer surface. The numbers could not move to a page while the only code that produced them lived inside a CLI command
 * that printed ASCII bar charts: `packages/app` cannot import `packages/novaclaw`, and even if it
 * could, the aggregation was interleaved with `console.log`.
 *
 * So the fold moves to `core`, where the CLI, an HTTP route and anything else can all reach it, and
 * the CLI keeps only its rendering. **The command is not deleted yet** — principle 1 says withholding
 * a migration because the thing it replaces still works is the broken shape, but it also says to
 * build the replacement first: the entry is explicit that the page comes before the deletion, in that
 * order. This commit is the seam that makes the page possible; nothing about the CLI's output
 * changes.
 *
 * ⚠️ Reads the DATABASE directly rather than an HTTP surface, and must: it walks every session's
 * message list, which is the one query shape the message API is not built to serve in bulk.
 */

export interface SessionStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

export const allSessions = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) => fromRow(row))
})

export const aggregate = Effect.fn("UsageStats.aggregate")(function* (
  days?: number,
  projectFilter?: string,
  currentRoot?: string,
) {
  const { db } = yield* Database.Service
  const sessions = yield* allSessions()
  const MS_IN_DAY = 24 * 60 * 60 * 1000

  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const windowDays = (() => {
    if (days === undefined) return
    if (days === 0) return 1
    return days
  })()

  let filteredSessions =
    cutoffTime > 0 ? sessions.filter((session) => DateTime.toEpochMillis(session.time.updated) >= cutoffTime) : sessions

  // T3 (entities.md): sessions carry no project — the scope is a directory root.
  const underRoot = (directory: string, root: string) =>
    directory === root || directory.startsWith(root + "\\") || directory.startsWith(root + "/")
  if (projectFilter !== undefined) {
    if (projectFilter === "") {
      if (!currentRoot) throw new Error("current root required when the folder filter is empty")
      filteredSessions = filteredSessions.filter((session) => underRoot(session.location.directory, currentRoot))
    } else {
      filteredSessions = filteredSessions.filter((session) => underRoot(session.location.directory, projectFilter))
    }
  }

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: Date.now(),
      latest: Date.now(),
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }

  if (filteredSessions.length > 1000) {
    console.log(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...`)
  }

  if (filteredSessions.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  let earliestTime = Date.now()
  let latestTime = 0

  const sessionTotalTokens: number[] = []

  const results = yield* Effect.forEach(
    filteredSessions,
    (session) =>
      Effect.gen(function* () {
        // F1c-0 — the native transcript (a decode failure counts the session as empty, the
        // same degrade V1 applied to a missing message store).
        const messages = yield* SessionMessageRead.list(db, { sessionID: session.id }).pipe(
          Effect.catchTag("Session.MessageDecodeError", () => Effect.succeed([])),
        )

        const sessionCost = session.cost ?? 0
        const sessionTokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        let sessionToolUsage: Record<string, number> = {}
        let sessionModelUsage: Record<
          string,
          {
            messages: number
            tokens: { input: number; output: number; cache: { read: number; write: number } }
            cost: number
          }
        > = {}

        for (const message of messages) {
          if (message.type === "assistant") {
            const modelKey = `${message.model.providerID}/${message.model.id}`
            if (!sessionModelUsage[modelKey]) {
              sessionModelUsage[modelKey] = {
                messages: 0,
                tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              }
            }
            sessionModelUsage[modelKey].messages++
            sessionModelUsage[modelKey].cost += message.cost || 0

            if (message.tokens) {
              sessionModelUsage[modelKey].tokens.input += message.tokens.input || 0
              sessionModelUsage[modelKey].tokens.output +=
                (message.tokens.output || 0) + (message.tokens.reasoning || 0)
              sessionModelUsage[modelKey].tokens.cache.read += message.tokens.cache?.read || 0
              sessionModelUsage[modelKey].tokens.cache.write += message.tokens.cache?.write || 0
            }

            for (const item of message.content) {
              if (item.type === "tool" && item.name) {
                sessionToolUsage[item.name] = (sessionToolUsage[item.name] || 0) + 1
              }
            }
          }
        }

        return {
          messageCount: messages.length,
          sessionCost,
          sessionTokens,
          sessionTotalTokens:
            sessionTokens.input +
            sessionTokens.output +
            sessionTokens.reasoning +
            sessionTokens.cache.read +
            sessionTokens.cache.write,
          sessionToolUsage,
          sessionModelUsage,
          earliestTime: DateTime.toEpochMillis(cutoffTime > 0 ? session.time.updated : session.time.created),
          latestTime: DateTime.toEpochMillis(session.time.updated),
        }
      }),
    { concurrency: 20 },
  )

  for (const result of results) {
    earliestTime = Math.min(earliestTime, result.earliestTime)
    latestTime = Math.max(latestTime, result.latestTime)
    sessionTotalTokens.push(result.sessionTotalTokens)

    stats.totalMessages += result.messageCount
    stats.totalCost += result.sessionCost
    stats.totalTokens.input += result.sessionTokens.input
    stats.totalTokens.output += result.sessionTokens.output
    stats.totalTokens.reasoning += result.sessionTokens.reasoning
    stats.totalTokens.cache.read += result.sessionTokens.cache.read
    stats.totalTokens.cache.write += result.sessionTokens.cache.write

    for (const [tool, count] of Object.entries(result.sessionToolUsage)) {
      stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count
    }

    for (const [model, usage] of Object.entries(result.sessionModelUsage)) {
      if (!stats.modelUsage[model]) {
        stats.modelUsage[model] = {
          messages: 0,
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }
      }
      stats.modelUsage[model].messages += usage.messages
      stats.modelUsage[model].tokens.input += usage.tokens.input
      stats.modelUsage[model].tokens.output += usage.tokens.output
      stats.modelUsage[model].tokens.cache.read += usage.tokens.cache.read
      stats.modelUsage[model].tokens.cache.write += usage.tokens.cache.write
      stats.modelUsage[model].cost += usage.cost
    }
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = windowDays ?? rangeDays
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write
  stats.tokensPerSession = filteredSessions.length > 0 ? totalTokens / filteredSessions.length : 0
  sessionTotalTokens.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
})
