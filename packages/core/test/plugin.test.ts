import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { define } from "@novaclaw/plugin/v2/effect"
import { tool } from "@novaclaw/plugin"
import { AgentV2 } from "@novaclaw/core/agent"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginTools } from "@novaclaw/core/tool/plugin-tools"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

describe("PluginV2", () => {
  it.effect("waits for a plugin and returns immediately once active", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("waited")
      const waiting = yield* plugins.wait(id).pipe(Effect.forkChild)

      yield* plugins.add(id, () => Effect.void)
      yield* Fiber.join(waiting)
      yield* plugins.wait(id)
    }),
  )

  it.effect("propagates plugin activation defects to waiters", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("failed")
      const waiting = yield* plugins.wait(id).pipe(Effect.exit, Effect.forkChild)

      const added = yield* plugins.add(id, () => Effect.die("boom")).pipe(Effect.exit)
      const pending = yield* Fiber.join(waiting)
      const later = yield* plugins.wait(id).pipe(Effect.exit)

      expect(Exit.isFailure(added)).toBe(true)
      expect(Exit.isFailure(pending)).toBe(true)
      expect(Exit.isFailure(later)).toBe(true)
    }),
  )

  it.effect("adds, replaces, and removes plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      let description = "first"

      const managed = () =>
        define({
          id: "managed",
          effect: (ctx) =>
            ctx.agent
              .transform((agents) =>
                agents.update("configured", (agent) => {
                  agent.description = description
                }),
              )
              .pipe(Effect.asVoid),
        })

      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)

      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("first")

      description = "second"
      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)
      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("second")

      yield* plugins.remove(PluginV2.ID.make("managed"))
      expect(yield* agents.get(AgentV2.ID.make("configured"))).toBeUndefined()
    }),
  )

  // F1a plugin-tool parity: a V2 plugin registers a model-facing tool through
  // `ctx.tool.register`; the registration lives in the `PluginTools` store (where the
  // novaclaw ExternalToolSource aggregator picks it up) and dies with the plugin.
  it.effect("registers and unregisters plugin tools with the plugin lifetime", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const store = yield* PluginTools.Service

      const greeter = tool({
        description: "Greet someone",
        args: {},
        execute: async () => "hello",
      })

      const withTool = define({
        id: "with-tool",
        effect: (ctx) => ctx.tool.register("greeter", greeter).pipe(Effect.asVoid),
      })

      yield* plugins.add(PluginV2.ID.make("with-tool"), withTool.effect)
      const registered = yield* store.entries()
      expect([...registered.keys()]).toContain("greeter")
      expect(registered.get("greeter")?.definition).toBe(greeter)
      const identity = registered.get("greeter")?.identity

      // Replacing the plugin re-registers: the tool survives with a FRESH identity
      // (the old registration's scope closed, so its stale-call guard token retired).
      yield* plugins.add(PluginV2.ID.make("with-tool"), withTool.effect)
      const replaced = yield* store.entries()
      expect([...replaced.keys()]).toContain("greeter")
      expect(replaced.get("greeter")?.identity).not.toBe(identity)

      // Removing the plugin removes its tools.
      yield* plugins.remove(PluginV2.ID.make("with-tool"))
      expect((yield* store.entries()).size).toBe(0)
    }),
  )
})
