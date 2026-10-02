import { describe, expect } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { testEffect } from "./lib/effect"

// 🔴 The `configure` door onto the same takeover the `colleague` tool refuses: an agent writing
// `agents.<id>.superior` from inside the instance must not be able to move an officer the owner
// holds, nor hand an officer TO the owner. Measured live 2026-10-02 (`lacedaemon`, superior `owner`,
// reassigned to `nova`, which then addressed it directly).
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SettingsConfigStore.node,
      CatalogStore.node,
      AgentConfigStore.node,
      CommandConfigStore.node,
      ReferenceConfigStore.node,
    ]),
  ),
)

const decodeInfo = Schema.decodeUnknownSync(Config.Info)
const superiorOf = (store: AgentConfigStore.Interface, id: string) =>
  Effect.map(store.agents(), (all) => AgentConfigStore.fold(all[id] ?? [])?.superior)

describe("an in-instance config write cannot move an officer the owner holds", () => {
  it.effect("refuses the takeover and the hand-to-owner; the operator keeps their own right", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      // The owner places an officer under themselves — their own surface.
      yield* ConfigStoreWrite.apply(decodeInfo({ agents: { lacedaemon: { superior: "owner" } } }), {
        writer: "operator",
      })

      const taken = yield* ConfigStoreWrite.apply(
        decodeInfo({ agents: { lacedaemon: { superior: "nova" } } }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(taken)).toBe(true)
      expect(yield* superiorOf(store, "lacedaemon")).toBe("owner")

      const handed = yield* ConfigStoreWrite.apply(
        decodeInfo({ agents: { probe: { superior: "owner" } } }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(handed)).toBe(true)

      // The owner may still reorganize their own officers.
      yield* ConfigStoreWrite.apply(decodeInfo({ agents: { lacedaemon: { superior: "nova" } } }), {
        writer: "operator",
      })
      expect(yield* superiorOf(store, "lacedaemon")).toBe("nova")
    }),
  )
})
