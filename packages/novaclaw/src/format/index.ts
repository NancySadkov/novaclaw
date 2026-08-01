import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { serviceUse } from "@novaclaw/core/effect/service-use"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@novaclaw/core/process"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { mergeDeep } from "remeda"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { errorMessage } from "@/util/error"
import * as Formatter from "./formatter"
import { Log } from "@novaclaw/schema/log"

export const Status = Schema.Struct({
  name: Schema.String,
  extensions: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
}).annotate({ identifier: "FormatterStatus" })
export type Status = Schema.Schema.Type<typeof Status>

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly file: (filepath: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Format") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const appProcess = yield* AppProcess.Service
    const flags = yield* RuntimeFlags.Service

    // v0.2.0-prep B7 tier-3: the formatter table below is DERIVED from `cfg.formatter` at build
    // time, so editing formatters in Settings used to take effect only when the whole instance was
    // destroyed. `makeRematerializable` declares that re-deriving it is safe — this initializer owns
    // no external resource (the `commands` map memoizes "is this binary usable" probes, which are
    // simply re-taken lazily) and registers no finalizer, so closing the superseded entry's scope
    // destroys nothing. Contrast `MCP.state`, which does and therefore must not carry the marker.
    const state = yield* InstanceState.makeRematerializable(
      Effect.fn("Format.state")(function* (ctx) {
        const commands: Record<string, string[] | false> = {}
        const formatters: Record<string, Formatter.Info> = {}

        async function getCommand(item: Formatter.Info) {
          let cmd = commands[item.name]
          if (cmd === false || cmd === undefined) {
            cmd = await item.enabled({ ...ctx, experimentalOxfmt: flags.experimentalOxfmt })
            commands[item.name] = cmd
          }
          return cmd
        }

        async function isEnabled(item: Formatter.Info) {
          const cmd = await getCommand(item)
          return cmd !== false
        }

        async function getFormatter(ext: string) {
          const matching = Object.values(formatters).filter((item) => item.extensions.includes(ext))
          const checks = await Promise.all(
            matching.map(async (item) => {
              const cmd = await getCommand(item)
              return {
                item,
                cmd,
              }
            }),
          )
          return checks
            .filter((x): x is { item: Formatter.Info; cmd: string[] } => x.cmd !== false)
            .map((x) => ({ item: x.item, cmd: x.cmd }))
        }

        function formatFile(filepath: string) {
          return Effect.gen(function* () {
            yield* Log.event("format.file.start", { "format.file": filepath })
            const formatters = yield* Effect.promise(() => getFormatter(path.extname(filepath)))

            if (!formatters.length) return false

            for (const { item, cmd } of formatters) {
              yield* Log.event("format.command.run", {
                "format.file": filepath,
                "format.command": JSON.stringify(cmd),
              })
              const replaced = cmd.map((x) => x.replace("$FILE", filepath))
              const dir = yield* InstanceState.directory
              const result = yield* appProcess
                .run(
                  ChildProcess.make(replaced[0]!, replaced.slice(1), {
                    cwd: dir,
                    env: item.environment,
                    extendEnv: true,
                    stdin: "ignore",
                    stdout: "ignore",
                    stderr: "ignore",
                  }),
                )
                .pipe(
                  Effect.catch((error) =>
                    Log.event("format.file.spawn.failed", {
                      "format.file": filepath,
                      "format.command": JSON.stringify(cmd),
                      "format.environment": JSON.stringify(item.environment),
                      "format.cause": errorMessage(error.cause ?? error),
                    }).pipe(Effect.as(undefined)),
                  ),
                )
              if (result && result.exitCode !== 0) {
                yield* Log.event("format.file.format.failed", {
                  "format.file": filepath,
                  "format.command": JSON.stringify(cmd),
                  "format.environment": JSON.stringify(item.environment),
                })
              }
            }

            return true
          })
        }

        const cfg = yield* config.get()

        if (!cfg.formatter) {
          yield* Log.event("format.registry.init.disabled", {})
          yield* Log.event("format.registry.init", {})
          return {
            formatters,
            isEnabled,
            formatFile,
          }
        }

        for (const item of Object.values(Formatter)) {
          formatters[item.name] = item
        }

        if (cfg.formatter !== true) {
          for (const [name, item] of Object.entries(cfg.formatter)) {
            const builtIn = Formatter[name as keyof typeof Formatter]

            // Ruff and uv are both the same formatter, so disabling either should disable both.
            if (["ruff", "uv"].includes(name) && (cfg.formatter.ruff?.disabled || cfg.formatter.uv?.disabled)) {
              // TODO combine formatters so shared backends like Ruff/uv don't need linked disable handling here.
              delete formatters.ruff
              delete formatters.uv
              continue
            }
            if (item.disabled) {
              delete formatters[name]
              continue
            }
            const info = mergeDeep(builtIn ?? { extensions: [] }, item)

            formatters[name] = {
              ...info,
              name,
              extensions: info.extensions ?? [],
              enabled: builtIn && !info.command ? builtIn.enabled : async (_context) => info.command ?? false,
            }
          }
        }

        yield* Log.event("format.registry.init", {})

        return {
          formatters,
          isEnabled,
          formatFile,
        }
      }),
    )

    // Fired from `ConfigStoreWrite.apply` when a write consumed `formatter`, AFTER the
    // `instance_config` domain has re-derived the document this reads (`RELOAD_DOMAINS` order is the
    // contract that guarantees it). Scoped to this layer, so a disposed instance graph deregisters.
    yield* ConfigStoreWrite.registerReload("formatter", () => InstanceState.rematerializeAll(state))

    const init = Effect.fn("Format.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("Format.status")(function* () {
      const { formatters, isEnabled } = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const formatter of Object.values(formatters)) {
        const isOn = yield* Effect.promise(() => isEnabled(formatter))
        result.push({
          name: formatter.name,
          extensions: formatter.extensions,
          enabled: isOn,
        })
      }
      return result
    })

    const file = Effect.fn("Format.file")(function* (filepath: string) {
      const { formatFile } = yield* InstanceState.get(state)
      return yield* formatFile(filepath)
    })

    return Service.of({ init, status, file })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, AppProcess.node, RuntimeFlags.node],
})

export * as Format from "."
