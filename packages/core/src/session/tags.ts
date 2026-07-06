export * as SessionTags from "./tags"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { SessionTags } from "@novaclaw/schema/session-tags"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { SessionTagTable } from "./sql"

export const Event = SessionTags.Event

export const MAX_TAG_LENGTH = 64

/** Trim + bound a tag; undefined = not a usable tag (empty after trim, or over-long). */
export function normalizeTag(tag: string): string | undefined {
  const value = tag.trim()
  if (!value || value.length > MAX_TAG_LENGTH) return undefined
  return value
}

export interface Interface {
  readonly add: (sessionID: SessionSchema.ID, tag: string) => Effect.Effect<void>
  readonly remove: (sessionID: SessionSchema.ID, tag: string) => Effect.Effect<void>
  /** Replace the full tag set (normalized, deduped) — the HTTP surface's idempotent write. */
  readonly set: (sessionID: SessionSchema.ID, tags: ReadonlyArray<string>) => Effect.Effect<void>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<string>>
  readonly all: () => Effect.Effect<Readonly<Record<string, ReadonlyArray<string>>>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionTags") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const get = Effect.fn("SessionTags.get")(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select({ tag: SessionTagTable.tag })
        .from(SessionTagTable)
        .where(eq(SessionTagTable.session_id, sessionID))
        .orderBy(asc(SessionTagTable.tag))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => row.tag)
    })

    const publish = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      yield* events.publish(Event.Updated, { sessionID, tags: yield* get(sessionID) })
    })

    const add = Effect.fn("SessionTags.add")(function* (sessionID: SessionSchema.ID, tag: string) {
      const value = normalizeTag(tag)
      if (!value) return
      yield* db
        .insert(SessionTagTable)
        .values({ session_id: sessionID, tag: value })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* publish(sessionID)
    })

    const remove = Effect.fn("SessionTags.remove")(function* (sessionID: SessionSchema.ID, tag: string) {
      const value = normalizeTag(tag)
      if (!value) return
      yield* db
        .delete(SessionTagTable)
        .where(and(eq(SessionTagTable.session_id, sessionID), eq(SessionTagTable.tag, value)))
        .run()
        .pipe(Effect.orDie)
      yield* publish(sessionID)
    })

    const set = Effect.fn("SessionTags.set")(function* (
      sessionID: SessionSchema.ID,
      tags: ReadonlyArray<string>,
    ) {
      const values = [...new Set(tags.map(normalizeTag).filter((tag): tag is string => tag !== undefined))].sort()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(SessionTagTable).where(eq(SessionTagTable.session_id, sessionID)).run()
            if (values.length === 0) return
            yield* tx
              .insert(SessionTagTable)
              .values(values.map((tag) => ({ session_id: sessionID, tag })))
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* events.publish(Event.Updated, { sessionID, tags: values })
    })

    const all = Effect.fn("SessionTags.all")(function* () {
      const rows = yield* db
        .select({ session_id: SessionTagTable.session_id, tag: SessionTagTable.tag })
        .from(SessionTagTable)
        .orderBy(asc(SessionTagTable.tag))
        .all()
        .pipe(Effect.orDie)
      const out: Record<string, string[]> = {}
      for (const row of rows) (out[row.session_id] ??= []).push(row.tag)
      return out
    })

    return Service.of({ add, remove, set, get, all })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))

// Global (instance-wide) — tags are entity data on sessions, not per-location state; deps are
// both global, and the /api/tag map endpoint has no location context.
export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
