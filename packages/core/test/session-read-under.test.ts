import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionRead } from "@novaclaw/core/session/read"
import { SessionStore } from "@novaclaw/core/session/store"
import { resolveSessionMode } from "@novaclaw/core/session/mode"
import { UsageStats } from "@novaclaw/core/usage-stats"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionLocationRecovery } from "@novaclaw/core/session/location-recovery"
import { testEffect } from "./lib/effect"

// T2 S4 (notes/entities.md): "a project's sessions" is the entity-free under-a-root query —
// exact directory or below it with a separator boundary, never a sibling sharing the prefix.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node])))

const seed = (db: Database.Interface["db"], id: string, directory: string) =>
  db
    .insert(SessionTable)
    .values({
      id: SessionV2.ID.make(id),
      slug: id,
      directory,
      title: id,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)

describe("SessionRead.list under", () => {
  it.effect("metadata and config reads never decode stored file patches", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const store = yield* SessionStore.Service
      const id = SessionV2.ID.make("ses_metadata")
      yield* seed(db, id, "C:/repo")
      yield* db
        .update(SessionTable)
        .set({
          summary_files: 10411,
          summary_additions: 10411,
          summary_diffs: sql`'not valid json'`,
        })
        .where(eq(SessionTable.id, id))
        .run()
        .pipe(Effect.orDie)
      const reads = [
        yield* SessionRead.get(db, id),
        ...(yield* SessionRead.list(db)),
        yield* store.get(id),
        ...(yield* UsageStats.allSessions()),
      ]
      for (const info of reads) {
        expect(info?.summary?.files).toBe(10411)
        expect(info?.summary?.diffs).toBeUndefined()
      }
      expect(yield* resolveSessionMode(db, id)).toBe("agent")
    }),
  )

  it.effect("saved patches are read explicitly without changing stored data", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const id = SessionV2.ID.make("ses_changes")
      yield* seed(db, id, "C:/repo")
      expect(yield* SessionRead.diff(db, id)).toEqual([])
      const diffs = [{ file: "src/main.ts", patch: "@@ -1 +1 @@\n-old\n+new\n", additions: 1, deletions: 1 }]
      yield* db
        .update(SessionTable)
        .set({ summary_files: 1, summary_diffs: diffs })
        .where(eq(SessionTable.id, id))
        .run()
        .pipe(Effect.orDie)
      expect((yield* SessionRead.get(db, id))?.summary?.diffs).toBeUndefined()
      expect(yield* SessionRead.diff(db, id)).toEqual(diffs)
      expect(yield* SessionRead.diff(db, SessionV2.ID.make("ses_missing"))).toBeUndefined()
    }),
  )

  it.effect("matches the root and true subdirectories, both separators, never siblings", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db, "ses_root", "C:\\repo")
      yield* seed(db, "ses_sub_win", "C:\\repo\\packages\\app")
      yield* seed(db, "ses_sub_posix", "C:\\repo/docs")
      yield* seed(db, "ses_sibling", "C:\\repo2")
      yield* seed(db, "ses_elsewhere", "D:\\other")

      const under = yield* SessionRead.list(db, { under: AbsolutePath.make("C:\\repo") })
      expect(under.map((s) => String(s.id)).sort()).toEqual(["ses_root", "ses_sub_posix", "ses_sub_win"])

      const exact = yield* SessionRead.list(db, { directory: AbsolutePath.make("C:\\repo") })
      expect(exact.map((s) => String(s.id))).toEqual(["ses_root"])

      const all = yield* SessionRead.list(db)
      expect(all).toHaveLength(5)
    }),
  )

  it.effect("finds a recovered session by the missing folder it moved out of", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db, "ses_recovered", "C:\\scratch\\ses_recovered")
      yield* seed(db, "ses_other", "D:\\other")
      yield* SessionLocationRecovery.record(db, SessionV2.ID.make("ses_recovered"), AbsolutePath.make("C:\\vanished"))

      const found = yield* SessionRead.list(db, { directory: AbsolutePath.make("C:\\vanished") })
      expect(found.map((session) => String(session.id))).toEqual(["ses_recovered"])

      yield* SessionLocationRecovery.clear(db, SessionV2.ID.make("ses_recovered"))
      expect(yield* SessionRead.list(db, { directory: AbsolutePath.make("C:\\vanished") })).toEqual([])
    }),
  )
})
