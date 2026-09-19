import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { AgentConfigStore } from "../src/agent-config-store"
import { ConfigAgent } from "../src/config/agent"
import { Location } from "../src/location"
import { SessionEffectiveConfig } from "../src/session/effective-config"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { SessionSchema } from "../src/session/schema"
import { WorkerProfile } from "../src/session/worker-profile"
import { AbsolutePath } from "../src/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const directory = import.meta.dir
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      SessionEffectiveConfig.node,
      AgentConfigStore.node,
    ]),
    [[Location.node, current]],
  ),
)

describe("worker prototypes narrow inherited authority", () => {
  for (const [owner, prototype, expected] of [
    ["plan", "yolo", "plan"],
    ["yolo", "plan", "plan"],
    ["ask", "bypass", "ask"],
  ] as const) {
    it.effect(`${owner} officer and ${prototype} prototype resolve to ${expected}, including descendants`, () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const agents = yield* AgentConfigStore.Service
        yield* agents.setLayers("parent", [ConfigAgent.Info.make({ permissionMode: owner })])
        const parent = SessionSchema.ID.make("ses_parent")
        const child = SessionSchema.ID.make("ses_child")
        const grandchild = SessionSchema.ID.make("ses_grandchild")
        for (const row of [
          { id: parent, agent: "parent" },
          {
            id: child,
            parent_id: parent,
            metadata: { [WorkerProfile.KEY]: { version: 1, prototypeID: "recipe", permissionMode: prototype } },
          },
          // A deeper worker's wider recipe must not erase the restriction at its parent.
          {
            id: grandchild,
            parent_id: child,
            metadata: { [WorkerProfile.KEY]: { version: 1, prototypeID: "wide", permissionMode: "yolo" } },
          },
        ])
          yield* db
            .insert(SessionTable)
            .values({ ...row, slug: row.id, directory, title: "authority", version: "test" })
            .run()
            .pipe(Effect.orDie)
        const effective = yield* SessionEffectiveConfig.Service
        expect((yield* effective.resolve(parent)).permissionMode).toBe(owner)
        expect((yield* effective.resolve(child)).permissionMode).toBe(expected)
        expect((yield* effective.resolve(grandchild)).permissionMode).toBe(expected)
      }),
    )
  }

  it.effect("prototype tool grants cannot erase officer or ancestor denials", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const agents = yield* AgentConfigStore.Service
      yield* agents.setLayers("parent", [ConfigAgent.Info.make({ tools: { bash: false, read: true } })])
      const parent = SessionSchema.ID.make("ses_parent")
      const child = SessionSchema.ID.make("ses_child")
      const grandchild = SessionSchema.ID.make("ses_grandchild")
      for (const row of [
        { id: parent, agent: "parent" },
        {
          id: child,
          parent_id: parent,
          metadata: { [WorkerProfile.KEY]: { version: 1, prototypeID: "recipe", tools: { bash: true, read: false } } },
        },
        {
          id: grandchild,
          parent_id: child,
          metadata: { [WorkerProfile.KEY]: { version: 1, prototypeID: "wide", tools: { bash: true, read: true } } },
        },
      ])
        yield* db
          .insert(SessionTable)
          .values({ ...row, slug: row.id, directory, title: "tools", version: "test" })
          .run()
          .pipe(Effect.orDie)
      const effective = yield* SessionEffectiveConfig.Service
      expect((yield* effective.resolve(parent)).tools).toEqual({ bash: false, read: true })
      expect((yield* effective.resolve(child)).tools).toEqual({ bash: false, read: false })
      expect((yield* effective.resolve(grandchild)).tools).toEqual({ bash: false, read: false })
    }),
  )
})
