export * as ConfigExternalPlugin from "./external"

import type { Plugin as EffectPlugin } from "@novaclaw/plugin/v2/effect"
import type { Plugin as PromisePlugin } from "@novaclaw/plugin/v2/promise"
import { Effect, Schema } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { Location } from "../../location"
import { Npm } from "../../npm"
import { define } from "../../plugin/internal"
import { PluginConfigSeed } from "../../plugin-config-seed"
import { PluginConfigStore } from "../../plugin-config-store"
import { PluginPromise } from "../../plugin/promise"

const PluginModule = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare<EffectPlugin["effect"]>(
        (input): input is EffectPlugin["effect"] => typeof input === "function",
      ),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare<PromisePlugin["setup"]>(
        (input): input is PromisePlugin["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

// Config→SQLite step 5: config-borne external plugin specs come from the instance-wide
// `PluginConfigStore` (normalized package + options), not from `config.entries()`. Plugin FILES
// dropped under `{plugin,plugins}/` in config dirs stay filesystem-walked (the D2 analog —
// user-dropped modules, not settings).
export const Plugin = define({
  id: "config-plugin",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const store = yield* PluginConfigStore.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    yield* Effect.gen(function* () {
      const entries = yield* config.entries()

      const configured: { package: string; options?: Record<string, any> }[] = []
      for (const stored of yield* store.plugins()) configured.push(stored)

      for (const entry of entries) {
        if (entry.type === "directory") {
          const files = yield* fs
            .glob("{plugin,plugins}/*.{ts,js}", {
              cwd: entry.path,
              absolute: true,
              include: "file",
              dot: true,
              symlink: true,
            })
            .pipe(Effect.orElseSucceed(() => []))
          files.sort()
          for (const file of files) configured.push({ package: file })
        }
      }

      for (const ref of configured) {
        yield* Effect.gen(function* () {
          const entrypoint = path.isAbsolute(ref.package)
            ? pathToFileURL(ref.package).href
            : (yield* npm.add(ref.package)).entrypoint
          if (!entrypoint) return

          const mod = yield* Effect.promise(() => import(entrypoint))
          const value = (yield* Schema.decodeUnknownEffect(PluginModule)(mod)).default
          const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
          yield* ctx.plugin.add({
            id: plugin.id,
            effect: (host) => plugin.effect({ ...host, options: ref.options ?? {} }),
          })
        }).pipe(Effect.ignoreCause)
      }
    }).pipe(Effect.forkScoped({ startImmediately: true }))
  }),
})
