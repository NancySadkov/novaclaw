import { EOL } from "os"
import { Effect } from "effect"
import * as InstancePath from "@novaclaw/core/database/instance-path"
import { effectCmd } from "../../effect-cmd"

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show portable configuration",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.config")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    process.stdout.write(JSON.stringify(InstancePath.mapValues(config, InstancePath.store, InstancePath.preserveProjectDirectory), null, 2) + EOL)
  }),
})
