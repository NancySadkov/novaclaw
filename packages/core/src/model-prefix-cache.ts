export * as ModelPrefixCache from "./model-prefix-cache"

import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { asc, eq, lte } from "drizzle-orm"
import type { Database } from "./database/database"
import { ModelPrefixCacheTable } from "./model-prefix-cache.sql"

export const DEFAULT_TTL_MINUTES = 5
const MAX_ENTRIES_PER_MODEL = 8
const MAX_BYTES_PER_MODEL = 16 * 1024 * 1024

export interface Observation {
  readonly promptBytes: number
  readonly matchedPrefixBytes: number
  readonly expectedCachedTokens: number
  readonly comparedEntries: number
  readonly ttlMinutes: number
  readonly observedAt: number
}

export interface Entry {
  readonly prompt: string
  readonly bytes: number
  readonly expiresAt: number
}

const bytes = (value: string) => new TextEncoder().encode(value)

/** Exact UTF-8 byte-prefix length. Unicode code points are never mistaken for bytes. */
export const commonPrefixBytes = (left: string, right: string): number => {
  const a = bytes(left)
  const b = bytes(right)
  const end = Math.min(a.length, b.length)
  let index = 0
  while (index < end && a[index] === b[index]) index++
  return index
}

/** The provider-facing prompt shape, before credentials and transport metadata are added. */
export const serialize = (request: {
  readonly system?: unknown
  readonly messages?: unknown
  readonly tools?: unknown
}): string => JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools })

export const compare = (entries: readonly Entry[], prompt: string, promptTokens: number) => {
  const promptBytes = bytes(prompt).length
  const matchedPrefixBytes = entries.reduce(
    (longest, entry) => Math.max(longest, commonPrefixBytes(entry.prompt, prompt)),
    0,
  )
  return {
    promptBytes,
    matchedPrefixBytes,
    expectedCachedTokens:
      promptBytes === 0 ? 0 : Math.max(0, Math.floor(promptTokens * (matchedPrefixBytes / promptBytes))),
    comparedEntries: entries.length,
  }
}

/**
 * Compare one outgoing prompt with this model's still-live recent prompts, then atomically add it.
 * Its own SQLite table is shared by session workers, so two officers do not maintain two false
 * answers about what the same server cache may still contain. Keeping this out of runtime_setting
 * matters: Config.entries() reads that whole table on every turn, while a prompt can be megabytes.
 */
export const observe = Effect.fn("ModelPrefixCache.observe")(function* (
  db: Database.Interface["db"],
  input: {
    readonly model: string
    readonly prompt: string
    readonly promptTokens: number
    readonly ttlMinutes?: number
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  const ttlMinutes =
    input.ttlMinutes !== undefined && Number.isFinite(input.ttlMinutes) && input.ttlMinutes > 0
      ? input.ttlMinutes
      : DEFAULT_TTL_MINUTES
  const measured = yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* tx.delete(ModelPrefixCacheTable).where(lte(ModelPrefixCacheTable.expiresAt, now))
        const active = yield* tx
          .select({
            prompt: ModelPrefixCacheTable.prompt,
            bytes: ModelPrefixCacheTable.bytes,
            expiresAt: ModelPrefixCacheTable.expiresAt,
          })
          .from(ModelPrefixCacheTable)
          .where(eq(ModelPrefixCacheTable.model, input.model))
          .orderBy(asc(ModelPrefixCacheTable.timeCreated))
        const result = compare(active, input.prompt, input.promptTokens)
        const next = [
          { prompt: input.prompt, bytes: result.promptBytes, expiresAt: now + ttlMinutes * 60_000 },
          ...active.reverse(),
        ]
        let retainedBytes = 0
        const retained = next.filter((entry, index) => {
          if (index >= MAX_ENTRIES_PER_MODEL) return false
          retainedBytes += entry.bytes
          return retainedBytes <= MAX_BYTES_PER_MODEL || index === 0
        })
        yield* tx.delete(ModelPrefixCacheTable).where(eq(ModelPrefixCacheTable.model, input.model))
        if (retained.length > 0)
          yield* tx.insert(ModelPrefixCacheTable).values(
            retained.map((entry, index) => ({
              id: randomUUID(),
              model: input.model,
              prompt: entry.prompt,
              bytes: entry.bytes,
              expiresAt: entry.expiresAt,
              timeCreated: now - index,
            })),
          )
        return result
      }),
    { behavior: "immediate" },
  )

  return {
    ...measured,
    ttlMinutes,
    observedAt: now,
  } satisfies Observation
})
