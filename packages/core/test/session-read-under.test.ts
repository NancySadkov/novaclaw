import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionRead } from "@novaclaw/core/session/read"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionV2 } from "@novaclaw/core/session"
import { testEffect } from "./lib/effect"

// T2 S4 (notes/entities.md): "a project's sessions" is the entity-free under-a-root query —
// exact directory or below it with a separator boundary, never a sibling sharing the prefix.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

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

      const all = yield* SessionRead.list(db)
      expect(all).toHaveLength(5)
    }),
  )
})
