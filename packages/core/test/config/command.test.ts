import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { CommandV2 } from "@novaclaw/core/command"
import type { ConfigCommand } from "@novaclaw/core/config/command"
import { Config } from "@novaclaw/core/config"
import { ConfigCommandPlugin } from "@novaclaw/core/config/plugin/command"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([CommandV2.node, FSUtil.node])))
const decode = Schema.decodeUnknownSync(Config.Info)

// Config→SQLite steps 3 + 8c: the plugin reads config-borne commands from the instance-wide
// store (pre-populated here — the import seeds fill it at boot; documents are never read).
const memoryStore = () => {
  const layers = new Map<string, ConfigCommand.Info[]>()
  return CommandConfigStore.Service.of({
    commands: () => Effect.sync(() => Object.fromEntries(layers)),
    setLayers: (name, next) =>
      Effect.sync(() => {
        layers.set(name, [...next])
      }),
    removeCommand: (name) =>
      Effect.sync(() => {
        layers.delete(name)
      }),
    isEmpty: () => Effect.sync(() => layers.size === 0),
  })
}

describe("ConfigCommandPlugin.Plugin", () => {
  it.live("loads inline and file-based commands in config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands", "nested"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "commands", "review.md"),
              `---
description: File review
agent: reviewer
model: anthropic/claude
variant: high
subtask: true
---
Review files`,
            )
            await fs.writeFile(path.join(tmp.path, "commands", "nested", "docs.md"), "Write docs")
            await fs.writeFile(path.join(tmp.path, "commands", "empty.md"), "")
          })

          const store = memoryStore()
          yield* store.setLayers("review", [decode({ commands: { review: { template: "Inline review" } } }).commands!.review])

          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(CommandConfigStore.Service, store),
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) })]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            CommandV2.Info.make({
              name: "review",
              template: "Review files",
              description: "File review",
              agent: "reviewer",
              model: {
                providerID: ProviderV2.ID.make("anthropic"),
                id: ModelV2.ID.make("claude"),
                variant: ModelV2.VariantID.make("high"),
              },
              subtask: true,
            }),
            CommandV2.Info.make({ name: "empty", template: "" }),
            CommandV2.Info.make({ name: "nested/docs", template: "Write docs" }),
          ])
        }),
      ),
    ),
  )
})
