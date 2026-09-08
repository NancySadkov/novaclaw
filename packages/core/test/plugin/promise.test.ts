import { describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { Effect } from "effect"
import { AppRegistry } from "@novaclaw/core/app-registry"
import { AgentV2 } from "@novaclaw/core/agent"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginHost } from "@novaclaw/core/plugin/host"
import { PluginPromise } from "@novaclaw/core/plugin/promise"
import { define } from "@novaclaw/plugin/v2/promise"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("fromPromise", () => {
  it.effect("bridges declarative app registration into the persisted instance launcher", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const root = yield* Effect.promise(() => mkdtemp(`${os.tmpdir()}\\novaclaw-plugin-app-`))
      try {
        const host = yield* PluginHost.make(plugin, { app: { root } })
        const promisePlugin = define({
          id: "promise-app",
          setup: async (ctx) => {
            await ctx.app.declare([
              {
                id: "daily-brief",
                title: "Daily brief",
                open: { type: "prompt", value: "Prepare my daily brief." },
              },
            ])
          },
        })

        yield* PluginPromise.fromPromise(promisePlugin).effect(host)

        const manifests = yield* Effect.promise(() => AppRegistry.listApps({ root }))
        expect(manifests).toHaveLength(1)
        expect(manifests[0]).toMatchObject({
          id: "daily-brief",
          title: "Daily brief",
          source: "plugin",
          open: { type: "prompt", value: "Prepare my daily brief." },
        })
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
      }
    }),
  )

  it.effect("loads a promise plugin and registers a transform hook", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = define({
        id: "promise-example",
        setup: async (ctx) => {
          expect(ctx.options.mode).toBe("strict")
          await ctx.agent.declare([
            { id: "reviewer", set: { description: "Reviews code", mode: "subagent" } },
          ])
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect({ ...host, options: { mode: "strict" } })

      expect(yield* agents.get(AgentV2.ID.make("reviewer"))).toMatchObject({
        description: "Reviews code",
        mode: "subagent",
      })
    }),
  )

  it.effect("disposes a hook registration on request", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = define({
        id: "promise-dispose",
        setup: async (ctx) => {
          const registration = await ctx.agent.declare([{ id: "temp", set: { description: "temporary" } }])
          await registration.dispose()
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect(host)

      expect(yield* agents.get(AgentV2.ID.make("temp"))).toBeUndefined()
    }),
  )
})
