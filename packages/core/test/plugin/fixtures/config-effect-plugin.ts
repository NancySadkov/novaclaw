import { define, type Plugin } from "@novaclaw/plugin/v2/effect"
import { Effect } from "effect"

const plugin: Plugin = define({
  id: "config-effect-plugin",
  effect: (ctx) =>
    ctx.agent
      .declare([{ id: "effect-configured", set: { description: ctx.options.description, mode: "subagent" } }])
      .pipe(Effect.asVoid),
})

export default plugin
