import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { AgentRemoval } from "@novaclaw/core/agent/removal"
import { AgentV2 } from "@novaclaw/core/agent"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { testEffect } from "./lib/effect"

/**
 * REMOVING NOVA'S ROW RESTORES THE BRIEF — IT MUST NOT RETIRE NOVA.
 *
 * Deleting the governing agent's config row is deliberately ALLOWED: Nova is seeded in code, so the
 * row is an OVERRIDE and removing it restores the shipped brief. Refusing that would make a stale
 * override permanently unremovable through the API.
 *
 * But the same call announced a removal, and `AgentRemoval.node` turns an announcement into
 * `AgentRetire.everything` — chats archived, the private cabinet set aside, usage cleared. So the
 * documented repair for a stale override quietly RETIRED the governing agent, leaving a Nova on the
 * roster with its history filed away underneath it.
 */

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      AgentConfigStore.node,
      CatalogStore.node,
      CommandConfigStore.node,
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
      SkillConfigStore.node,
    ]),
  ),
)

/**
 * Capture what an instance graph's listener would have been told to retire.
 *
 * Generic over `R`: the body runs `ConfigStoreWrite.remove`, which needs six stores. Typing it
 * `never` compiled the call sites only because the requirement was inferred away at the yield —
 * the tests PASSED while `--only=typecheck` went red in four packages.
 */
const announcements = <R>(body: (seen: string[]) => Effect.Effect<void, never, R>) =>
  Effect.gen(function* () {
    const seen: string[] = []
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* AgentRemoval.register((id) => Effect.sync(() => void seen.push(id)))
        yield* body(seen)
      }),
    )
    return seen
  })

describe("removing an agent's config row", () => {
  it.effect("🔴 NOVA's removal announces NOTHING — the repair is not a retirement", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      yield* store.setLayers(AgentV2.NOVA_ID, [{ system: "a stale override" } as never])

      const seen = yield* announcements((_) =>
        ConfigStoreWrite.remove([["agents", AgentV2.NOVA_ID]]).pipe(Effect.orDie, Effect.asVoid),
      )

      // The row is gone — the repair worked and the shipped brief is restored…
      expect((yield* store.agents())[AgentV2.NOVA_ID] ?? []).toEqual([])
      // …and nothing was told to archive its chats or set its cabinet aside.
      expect(seen).toEqual([])
    }),
  )

  it.effect("🔴 an ordinary colleague's removal DOES announce — the control", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      yield* store.setLayers("theron", [{ system: "a real colleague" } as never])

      const seen = yield* announcements((_) =>
        ConfigStoreWrite.remove([["agents", "theron"]]).pipe(Effect.orDie, Effect.asVoid),
      )

      // Without this the fix could be "never announce", which would leak every retired colleague's
      // cabinet, spend and chats onto the next officer drawn on that name.
      expect(seen).toEqual(["theron"])
    }),
  )
})
