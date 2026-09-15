import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { Location } from "@novaclaw/core/location"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionV2 } from "@novaclaw/core/session"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

/**
 * 🔴 THE OFFICER'S MODEL IS RESPECTED — the keystone's half of the owner's report (2026-09-15):
 * *"user picked model in the officer's settings is not respected … usually the default model is
 * picked."*
 *
 * This pins the RESOLUTION: a colleague's configured model is a LAYER under the session entity
 * (`AgentDefaults.fold`), and a chat that declares none of its own resolves to THAT, not to the
 * instance default. The other half — what the turn does when the chosen model cannot serve — is
 * `session-runner-model-ran.test.ts`.
 *
 * ⚠️ It is an integration test rather than another `AgentDefaults.fold` unit because the defect
 * class is a MISSING JOIN: the fold existed, and nothing handed its answer to the reader. The
 * measured instance that produced the report had the model stored correctly and the row carrying
 * none, so a unit on either half would have passed while the officer still ran the default.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-officer-model-")))

const current = Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) })))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      FSUtil.node,
      SessionStore.node,
      SessionEffectiveConfig.node,
      AgentV2.node,
      AgentConfigStore.node,
    ]),
    [[Location.node, current]],
  ),
)

describe("an officer's configured model", () => {
  it.effect("resolves to the officer's model, not the instance default", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const agents = yield* AgentConfigStore.Service
      yield* agents.setLayers("marshal", [ConfigAgent.Info.make({ model: "chosen-provider/chosen-model" })])
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make("ses_marshal"),
          slug: "marshal",
          directory: root,
          title: "marshal",
          version: "test",
          agent: "marshal",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const effective = yield* SessionEffectiveConfig.Service
      const resolved = yield* effective.resolve(SessionV2.ID.make("ses_marshal"))
      expect(resolved.model).toEqual({ providerID: "chosen-provider", id: "chosen-model" })
    }),
  )
})
