export * as ConfigExternalPlugin from "./external"

import type { Plugin as EffectPlugin } from "@novaclaw/plugin/v2/effect"
import type { Plugin as PromisePlugin } from "@novaclaw/plugin/v2/promise"
import { Log } from "@novaclaw/schema/log"
import { Cause, Effect, Schema } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../config"
import { Flag } from "../../flag/flag"
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
//
// `--pure` / `NOVACLAW_PURE` ("run without external plugins") is enforced HERE, at the one place
// third-party code enters the process. It used to gate the V1 loader; when that arm was deleted the
// flag would have become a lie (it is advertised in every CLI --help), so it moved with the
// capability it names. Internal plugins are unaffected — they are first-party, not external.
// Read through `Flag` (process.env at call time) rather than `RuntimeFlags`: `--pure` is mirrored
// into the environment by the CLI middleware precisely so every child process inherits it, and core
// has no dependency on the novaclaw package's flag service.
export const Plugin = define({
  id: "config-plugin",
  effect: Effect.fn(function* (ctx) {
    if (Flag.NOVACLAW_PURE) {
      yield* Effect.logDebug("skipping external plugins (--pure)")
      return
    }
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

          // `tryPromise`, not `promise`: an entrypoint that throws on import is an ORDINARY failure of
          // third-party code, not a defect in ours. Typed here so the tap below reports it as a plugin
          // fault rather than an anonymous die.
          const mod = yield* Effect.tryPromise(() => import(entrypoint))
          const value = (yield* Schema.decodeUnknownEffect(PluginModule)(mod)).default
          const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
          yield* ctx.plugin.add({
            id: plugin.id,
            effect: (host) => plugin.effect({ ...host, options: ref.options ?? {} }),
          })
        }).pipe(
          // ⚠️ One broken plugin must never take the others down — but it must never vanish either.
          // Before the V1 arm was deleted, a failed load surfaced through it; this loader swallowed
          // everything with `ignoreCause`, so a user's broken plugin failed INVISIBLY. Ruling 2: a
          // fault is never described falsely, and "silently absent" is the falsest description there
          // is. `tapCause` sees defects too, so an import that throws is reported like any other
          // fault. A warn log is the right surface: this loader is instance-wide, not per-session,
          // and core has no session-event bridge to publish to.
          Effect.tapCause((cause) =>
            Log.event("plugin.external.load.failed", {
              "plugin.package": ref.package,
              "plugin.cause": Cause.pretty(cause),
            }),
          ),
          Effect.ignoreCause,
        )
      }
    }).pipe(Effect.forkScoped({ startImmediately: true }))
  }),
})
