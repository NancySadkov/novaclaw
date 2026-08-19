// The Effect-shaped half of the loader's `PluginModule` union. Its promise-shaped sibling is
// `directory-plugin.ts`; both live in the one directory the loader reads (the INSTANCE config dir)
// so a single run covers both branches.
import { define, type Plugin } from "@novaclaw/plugin/v2/effect"
import { Effect } from "effect"

const plugin: Plugin = define({
  id: "effect-directory-plugin",
  effect: (ctx) =>
    ctx.agent
      .transform((agents) => {
        agents.update("effect-directory", (agent) => {
          agent.description = "Loaded from plugin directory as an Effect plugin"
          agent.mode = "subagent"
        })
      })
      .pipe(Effect.asVoid),
})

export default plugin
