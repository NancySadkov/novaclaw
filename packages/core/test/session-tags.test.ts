import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionTags, normalizeTag } from "@novaclaw/core/session/tags"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionTags.node]), [[Location.node, current]]),
)

const sessionID = SessionV2.ID.make("ses_tags_test")

function setup() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        slug: "tags-test",
        directory: "/project",
        title: "tags test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

describe("normalizeTag", () => {
  it.effect("trims, rejects empty and over-long tags", () =>
    Effect.sync(() => {
      expect(normalizeTag("  research ")).toBe("research")
      expect(normalizeTag("   ")).toBeUndefined()
      expect(normalizeTag("x".repeat(65))).toBeUndefined()
      expect(normalizeTag("x".repeat(64))).toBe("x".repeat(64))
    }),
  )
})

describe("SessionTags", () => {
  it.effect("adds, lists, and removes tags, publishing the full list each time", () =>
    Effect.gen(function* () {
      yield* setup()
      const tags = yield* SessionTags.Service
      const events = yield* EventV2.Service
      const published: Array<{ sessionID: string; tags: ReadonlyArray<string> }> = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "session.tags.updated") {
            published.push(event.data as { sessionID: string; tags: ReadonlyArray<string> })
          }
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* tags.add(sessionID, " research ")
      yield* tags.add(sessionID, "research") // duplicate after normalization — no second row
      yield* tags.add(sessionID, "backend")
      expect(yield* tags.get(sessionID)).toEqual(["backend", "research"])

      yield* tags.remove(sessionID, "research")
      expect(yield* tags.get(sessionID)).toEqual(["backend"])

      expect(published.at(-1)).toEqual({ sessionID, tags: ["backend"] })
      expect(yield* tags.all()).toEqual({ [sessionID]: ["backend"] })
    }),
  )

  it.effect("set replaces the whole tag set normalized + deduped", () =>
    Effect.gen(function* () {
      yield* setup()
      const tags = yield* SessionTags.Service
      yield* tags.set(sessionID, [" a ", "b", "a", "", "x".repeat(80)])
      expect(yield* tags.get(sessionID)).toEqual(["a", "b"])
      yield* tags.set(sessionID, [])
      expect(yield* tags.get(sessionID)).toEqual([])
      expect(yield* tags.all()).toEqual({})
    }),
  )
})
